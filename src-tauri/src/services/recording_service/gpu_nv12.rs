//! 进程内 GPU RGBA→NV12 转码（全屏/区域录制的缩放与裁剪，阶段二核心）
//!
//! 旧实现用 D3D11 Video Processor 做 RGBA→NV12 同时缩放，但大量机器的默认 D3D11 设备
//! 不支持 Video Processor（`nv12_in_process_supported()` 返回 false），导致整条 GPU 路径失效、
//! 回退到 4K 整帧 RGBA 读回，是「卡顿」的真源。
//!
//! 本实现改用 D3D11 渲染管线 + 全屏三角形 + 线性采样器在 GPU 上把帧转成 NV12：
//! - 亮度 Y 写入 R8 渲染目标（全分辨率），色度 UV 写入 R8G8 渲染目标（半分辨率），两遍 Draw；
//! - 区域录制时通过裁剪常量让着色器只采样子矩形，避免「整帧 33MB 读回 + CPU 裁剪」；
//! - 超大源（>1080p）直接缩到 1080p；最终只读回 ~3.1MB(NV12) / 4K 约 11.7MB(NV12)，
//!   彻底消除 33MB 4K 整帧读回 + CPU 缩放/裁剪 + ffmpeg 端 RGBA→YUV 软/硬转换。
//! 渲染管线（Draw）是所有 D3D11 硬件的基线能力，不依赖 Video Processor，兼容性远好于旧方案。
//! 输出 NV12 直接喂 ffmpeg 编码器（nvenc/qsv 原生消费 nv12），零 CPU 色彩转换。
//!
//! ## 方案 A 修复（撕裂 + 操作卡/鼠标变慢），2026-07-28
//! 1) **撕裂根因**：对 WGC 复用共享帧纹理 `frame.as_raw_texture()` 做 `CopyResource` 仅是「入队」，
//!    真正执行被延迟到之后某次 flush；WGC/DWM 可能在那之前已用下一帧覆盖该纹理 → 拷入
//!    「半旧半新」→ 输出单帧水平错位（撕裂）。修复：拷贝后立即 `Flush()`，趁源纹理仍是本帧时
//!    强制提交拷贝，消除竞争窗口。`Flush` 只提交命令、不等待 GPU 完成，不引入 CPU 阻塞。
//! 2) **操作卡根因**：原实现每帧在 WGC 捕获回调线程内同步 `Map`（flags=0）读回，该 `Map`
//!    强制等待 GPU 完成全部在队工作，每秒 30-60 次周期性冻住同机 DWM 合成 → 系统级输入延迟
//!    （鼠标变慢）。修复：staging 改为 3 槽环形池，本帧结果拷入空闲槽入队；读回改用
//!    `Map(DO_NOT_WAIT)` **非阻塞**取最早已就绪的槽——GPU 未就绪立即返回、绝不等待，
//!    捕获回调线程零 GPU 同步 → DWM 合成节奏不再被打断。读回延迟约 1 帧，录屏内容无感知差异。
//!    `convert` 返回 `Ok(true)`=本帧向 out 产出了一帧；`Ok(false)`=GPU 未就绪、本帧无产出
//!    （调用方应跳过 latest 更新、复用上一帧）。

use std::collections::VecDeque;
use std::sync::OnceLock;

use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1, ID3DBlob};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::DXGI_ERROR_WAS_STILL_DRAWING;
use windows::core::{PCSTR, Result};

/// staging 环形池槽数：3 槽（三缓冲）配合非阻塞读回，读回延迟约 1 帧。
const STAGING_COUNT: usize = 3;

/// 全屏三角形顶点着色器（无顶点缓冲，用 SV_VertexID 生成；uv 已做 Y 翻转匹配纹理左上原点）。
const VS_HLSL: &str = r#"
struct VSOut { float4 pos : SV_Position; float2 uv : TEXCOORD0; };
VSOut VS(uint id : SV_VertexID) {
    float2 p = float2((id == 1) ? 3.0f : -1.0f, (id == 2) ? 3.0f : -1.0f);
    VSOut o;
    o.pos = float4(p, 0.0, 1.0);
    o.uv = float2((p.x + 1.0) * 0.5, 1.0 - (p.y + 1.0) * 0.5);
    return o;
}
"#;

/// 像素着色器（亮度 Y）：按裁剪常量只采样子矩形并缩放到输出尺寸，输出 BT.709 限幅 Y。
fn build_ps_y(crop: Option<(f32, f32, f32, f32)>) -> String {
    let (ox, oy, sw, sh) = crop.unwrap_or((0.0, 0.0, 1.0, 1.0));
    format!(
        r#"
Texture2D tex : register(t0);
SamplerState samp : register(s0);
static const float2 ORIGIN = float2({ox}, {oy});
static const float2 SCALE = float2({sw}, {sh});
float4 PS(float4 pos : SV_Position, float2 uv : TEXCOORD0) : SV_Target {{
    float2 suv = ORIGIN + uv * SCALE;
    float3 c = tex.Sample(samp, suv).rgb;
    float y = 0.2126*c.r + 0.7152*c.g + 0.0722*c.b;
    return float4(16.0/255.0 + (219.0/255.0)*y, 0.0, 0.0, 1.0);
}}
"#
    )
}

/// 像素着色器（色度 UV）：同裁剪采样，输出 BT.709 限幅 U/V（R8G8 平面）。
fn build_ps_uv(crop: Option<(f32, f32, f32, f32)>) -> String {
    let (ox, oy, sw, sh) = crop.unwrap_or((0.0, 0.0, 1.0, 1.0));
    format!(
        r#"
Texture2D tex : register(t0);
SamplerState samp : register(s0);
static const float2 ORIGIN = float2({ox}, {oy});
static const float2 SCALE = float2({sw}, {sh});
float4 PS(float4 pos : SV_Position, float2 uv : TEXCOORD0) : SV_Target {{
    float2 suv = ORIGIN + uv * SCALE;
    float3 c = tex.Sample(samp, suv).rgb;
    float y = 0.2126*c.r + 0.7152*c.g + 0.0722*c.b;
    float pb = -0.1146*c.r - 0.3855*c.g + 0.5003*c.b;
    float pr = 0.5001*c.r - 0.4542*c.g - 0.0459*c.b;
    return float4(0.5020 + 0.8784*pb, 0.5020 + 0.8784*pr, 0.0, 1.0);
}}
"#
    )
}

pub struct GpuNv12Converter {
    ctx: ID3D11DeviceContext,
    input_tex: ID3D11Texture2D,
    input_srv: ID3D11ShaderResourceView,
    /// Y 渲染目标（R8，out_w×out_h）+ 视图：着色器第一遍把亮度写入。
    rt_y: ID3D11Texture2D,
    rtv_y: ID3D11RenderTargetView,
    /// UV 渲染目标（R8G8，out_w/2×out_h/2）+ 视图：着色器第二遍把色度写入。
    rt_uv: ID3D11Texture2D,
    rtv_uv: ID3D11RenderTargetView,
    /// Y/UV 各 STAGING_COUNT 槽环形池，配合 DO_NOT_WAIT 非阻塞读回
    staging_y: Vec<ID3D11Texture2D>,
    staging_uv: Vec<ID3D11Texture2D>,
    vs: ID3D11VertexShader,
    ps_y: ID3D11PixelShader,
    ps_uv: ID3D11PixelShader,
    sampler: ID3D11SamplerState,
    out_w: u32,
    out_h: u32,
    in_w: u32,
    in_h: u32,
    /// 渲染管线自检 / 运行时发现产出全零 → 标记失效，调用方回退 RGBA，从根本杜绝绿屏
    broken: bool,
    /// 空闲槽下标（可写入新一帧缩放结果）
    free_slots: Vec<usize>,
    /// 已提交 GPU 拷贝、等待 CPU 读回的槽下标（FIFO，front 最旧最可能就绪）
    pending: VecDeque<usize>,
}

unsafe fn create_tex(
    device: &ID3D11Device,
    w: u32,
    h: u32,
    fmt: DXGI_FORMAT,
    bind: D3D11_BIND_FLAG,
) -> Result<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: w,
        Height: h,
        MipLevels: 1,
        ArraySize: 1,
        Format: fmt,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: bind.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let mut tex = None;
    device.CreateTexture2D(&desc, None, Some(&mut tex))?;
    tex.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))
}

unsafe fn compile_hlsl(
    src: &str,
    entry: &str,
    target: &str,
    blob: &mut Option<ID3DBlob>,
) -> Result<()> {
    // D3DCompile 要求入口名/目标名是 null 结尾的 ANSI 串；&str 不带 null 结尾，
    // 必须用 CString 包一层，否则读到越界字节、找不到入口点 → 编译失败 → GPU 缩放失效。
    let entry_c = std::ffi::CString::new(entry)
        .map_err(|_| windows::core::Error::from(windows::Win32::Foundation::E_INVALIDARG))?;
    let target_c = std::ffi::CString::new(target)
        .map_err(|_| windows::core::Error::from(windows::Win32::Foundation::E_INVALIDARG))?;
    let mut err_blob: Option<ID3DBlob> = None;
    D3DCompile(
        src.as_ptr() as *const core::ffi::c_void,
        src.len(),
        PCSTR::null(),
        None,
        None,
        PCSTR::from_raw(entry_c.as_ptr() as *const u8),
        PCSTR::from_raw(target_c.as_ptr() as *const u8),
        0,
        0,
        blob,
        Some(&mut err_blob),
    )
    .map_err(|e| {
        if let Some(err) = err_blob {
            let msg = String::from_utf8_lossy(std::slice::from_raw_parts(
                err.GetBufferPointer() as *const u8,
                err.GetBufferSize(),
            ));
            eprintln!("[GPU缩放] HLSL 编译失败: {msg}");
        }
        e
    })?;
    Ok(())
}

impl GpuNv12Converter {
    pub fn new(
        device: &ID3D11Device,
        ctx: &ID3D11DeviceContext,
        in_w: u32,
        in_h: u32,
        out_w: u32,
        out_h: u32,
        input_fmt: DXGI_FORMAT,
        crop: Option<(u32, u32, u32, u32)>,
    ) -> Result<Self> {
        unsafe {
            let mut vs_blob = None;
            compile_hlsl(VS_HLSL, "VS", "vs_4_0", &mut vs_blob)?;
            // 裁剪归一化：区域录制只采样子矩形；全屏 crop=None → 原点(0,0) 缩放(1,1)
            let crop_norm = crop.map(|(cx, cy, cw, ch)| {
                let ox = cx as f32 / in_w as f32;
                let oy = cy as f32 / in_h as f32;
                let sw = (cw as f32).max(1.0) / in_w as f32;
                let sh = (ch as f32).max(1.0) / in_h as f32;
                (ox, oy, sw, sh)
            });
            let mut ps_y_blob = None;
            compile_hlsl(&build_ps_y(crop_norm), "PS", "ps_4_0", &mut ps_y_blob)?;
            let mut ps_uv_blob = None;
            compile_hlsl(&build_ps_uv(crop_norm), "PS", "ps_4_0", &mut ps_uv_blob)?;
            let vs_blob = vs_blob.unwrap();
            let ps_y_blob = ps_y_blob.unwrap();
            let ps_uv_blob = ps_uv_blob.unwrap();

            let vs_code = std::slice::from_raw_parts(
                vs_blob.GetBufferPointer() as *const u8,
                vs_blob.GetBufferSize(),
            );
            let mut vs = None;
            device.CreateVertexShader(vs_code, None, Some(&mut vs))?;
            let vs = vs.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
            let ps_y_code = std::slice::from_raw_parts(
                ps_y_blob.GetBufferPointer() as *const u8,
                ps_y_blob.GetBufferSize(),
            );
            let mut ps_y = None;
            device.CreatePixelShader(ps_y_code, None, Some(&mut ps_y))?;
            let ps_y = ps_y.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
            let ps_uv_code = std::slice::from_raw_parts(
                ps_uv_blob.GetBufferPointer() as *const u8,
                ps_uv_blob.GetBufferSize(),
            );
            let mut ps_uv = None;
            device.CreatePixelShader(ps_uv_code, None, Some(&mut ps_uv))?;
            let ps_uv = ps_uv.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;

            // 输入纹理（源帧拷贝目标，可作为 SRV）
            let input_tex = create_tex(
                device,
                in_w,
                in_h,
                input_fmt,
                D3D11_BIND_SHADER_RESOURCE,
            )?;
            let mut srv = None;
            device.CreateShaderResourceView(&input_tex, None, Some(&mut srv))?;
            let input_srv = srv.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;

            // Y 渲染目标（R8，out_w×out_h）
            let rt_y = create_tex(
                device,
                out_w,
                out_h,
                DXGI_FORMAT_R8_UNORM,
                D3D11_BIND_RENDER_TARGET,
            )?;
            let mut rtv_y = None;
            device.CreateRenderTargetView(&rt_y, None, Some(&mut rtv_y))?;
            let rtv_y = rtv_y.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;

            // UV 渲染目标（R8G8，out_w/2×out_h/2）
            let uvw = (out_w / 2).max(1);
            let uvh = (out_h / 2).max(1);
            let rt_uv = create_tex(
                device,
                uvw,
                uvh,
                DXGI_FORMAT_R8G8_UNORM,
                D3D11_BIND_RENDER_TARGET,
            )?;
            let mut rtv_uv = None;
            device.CreateRenderTargetView(&rt_uv, None, Some(&mut rtv_uv))?;
            let rtv_uv = rtv_uv.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;

            // Y/UV 各 STAGING_COUNT 槽环形池，供 DO_NOT_WAIT 非阻塞读回
            let mut staging_y = Vec::with_capacity(STAGING_COUNT);
            let mut staging_uv = Vec::with_capacity(STAGING_COUNT);
            let mut free_slots = Vec::with_capacity(STAGING_COUNT);
            for i in 0..STAGING_COUNT {
                let mut ty = None;
                device.CreateTexture2D(
                    &D3D11_TEXTURE2D_DESC {
                        Width: out_w,
                        Height: out_h,
                        MipLevels: 1,
                        ArraySize: 1,
                        Format: DXGI_FORMAT_R8_UNORM,
                        SampleDesc: DXGI_SAMPLE_DESC {
                            Count: 1,
                            Quality: 0,
                        },
                        Usage: D3D11_USAGE_STAGING,
                        BindFlags: 0,
                        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                        MiscFlags: 0,
                    },
                    None,
                    Some(&mut ty),
                )?;
                staging_y.push(ty.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?);

                let mut tuv = None;
                device.CreateTexture2D(
                    &D3D11_TEXTURE2D_DESC {
                        Width: uvw,
                        Height: uvh,
                        MipLevels: 1,
                        ArraySize: 1,
                        Format: DXGI_FORMAT_R8G8_UNORM,
                        SampleDesc: DXGI_SAMPLE_DESC {
                            Count: 1,
                            Quality: 0,
                        },
                        Usage: D3D11_USAGE_STAGING,
                        BindFlags: 0,
                        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                        MiscFlags: 0,
                    },
                    None,
                    Some(&mut tuv),
                )?;
                staging_uv.push(tuv.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?);
                free_slots.push(i);
            }

            let sd = D3D11_SAMPLER_DESC {
                Filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR,
                AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
                AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
                AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
                MipLODBias: 0.0,
                MaxAnisotropy: 1,
                ComparisonFunc: D3D11_COMPARISON_NEVER,
                BorderColor: [0.0f32; 4],
                MinLOD: 0.0,
                MaxLOD: f32::MAX,
            };
            let mut sampler = None;
            device.CreateSamplerState(&sd, Some(&mut sampler))?;
            let sampler = sampler.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;

            let me = Self {
                ctx: ctx.clone(),
                input_tex,
                input_srv,
                rt_y,
                rtv_y,
                rt_uv,
                rtv_uv,
                staging_y,
                staging_uv,
                vs,
                ps_y,
                ps_uv,
                sampler,
                out_w,
                out_h,
                in_w,
                in_h,
                broken: false,
                free_slots,
                pending: VecDeque::with_capacity(STAGING_COUNT),
            };
            // 自检：用本设备/上下文/格式渲染一帧白屏、阻塞读回，验证 Draw 真能向渲染目标写出
            // 非全零 NV12。若仍全零 → 本机该 D3D11 管线静默失败（Draw 被丢弃 / 设备不兼容等），
            // 返回 Err 使调用方回退 RGBA 读回，从根本杜绝「纯绿视频」。这是把上次「探针只建管线不
            // 查渲染结果」的漏洞补上。
            if !me.verify() {
                eprintln!("[GPU缩放] 自检失败：渲染管线产出全零，回退 RGBA 读回（不启用 GPU 路径）");
                return Err(windows::core::Error::from(windows::Win32::Foundation::E_FAIL));
            }
            eprintln!("[GPU缩放] 自检通过：D3D11 缩放渲染管线可用，启用 GPU 路径");
            Ok(me)
        }
    }

    /// 把 src（原生分辨率 RGBA 帧）在 GPU 转 NV12（可缩放/裁剪），并**非阻塞**读回最早已就绪的
    /// 历史帧拼成连续 NV12 字节流到 out。
    /// 返回 `Ok(true)`=out 已写入一帧（可送 latest）；`Ok(false)`=GPU 未就绪、本帧无产出
    /// （调用方应复用上一帧 latest，不要写入空数据）。
    /// 自检：用白屏填充输入纹理，走与 `convert` 完全一致的两遍渲染 + **阻塞**读回，
    /// 验证 Draw 真能向 R8/R8G8 渲染目标写出非全零数据。返回 true=该 D3D11 管线在本机可用。
    /// 仅用于 `new()` 末尾一次性判定；不走非阻塞路径（自检本就期望立即可用）。
    fn verify(&self) -> bool {
        unsafe {
            let n = (self.in_w as usize) * (self.in_h as usize) * 4;
            let white = vec![0xFFu8; n];
            self.ctx.UpdateSubresource(
                &self.input_tex,
                0,
                None,
                white.as_ptr() as *const core::ffi::c_void,
                self.in_w * 4,
                0,
            );
            self.ctx
                .IASetPrimitiveTopology(windows::Win32::Graphics::Direct3D::D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            self.ctx.IASetInputLayout(None);
            self.ctx.GSSetShader(None, None);
            self.ctx.RSSetState(None);
            self.ctx.OMSetBlendState(None, None, u32::MAX);
            self.ctx.OMSetDepthStencilState(None, 0);
            // Y 遍
            self.ctx
                .OMSetRenderTargets(Some(&[Some(self.rtv_y.clone())]), None);
            let vp = D3D11_VIEWPORT {
                TopLeftX: 0.0,
                TopLeftY: 0.0,
                Width: self.out_w as f32,
                Height: self.out_h as f32,
                MinDepth: 0.0,
                MaxDepth: 1.0,
            };
            self.ctx.RSSetViewports(Some(&[vp]));
            let clear = [0.0f32; 4];
            self.ctx.ClearRenderTargetView(Some(&self.rtv_y), &clear);
            self.ctx.VSSetShader(Some(&self.vs), None);
            self.ctx.PSSetShader(Some(&self.ps_y), None);
            self.ctx
                .PSSetShaderResources(0, Some(&[Some(self.input_srv.clone())]));
            self.ctx
                .PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            self.ctx.Draw(3, 0);
            // UV 遍
            self.ctx
                .OMSetRenderTargets(Some(&[Some(self.rtv_uv.clone())]), None);
            let vp_uv = D3D11_VIEWPORT {
                TopLeftX: 0.0,
                TopLeftY: 0.0,
                Width: (self.out_w / 2).max(1) as f32,
                Height: (self.out_h / 2).max(1) as f32,
                MinDepth: 0.0,
                MaxDepth: 1.0,
            };
            self.ctx.RSSetViewports(Some(&[vp_uv]));
            self.ctx.ClearRenderTargetView(Some(&self.rtv_uv), &clear);
            self.ctx.PSSetShader(Some(&self.ps_uv), None);
            self.ctx.Draw(3, 0);
            // 拷到 staging[0]
            self.ctx.CopyResource(
                Some(&self.staging_y[0] as &ID3D11Resource),
                Some(&self.rt_y as &ID3D11Resource),
            );
            self.ctx.CopyResource(
                Some(&self.staging_uv[0] as &ID3D11Resource),
                Some(&self.rt_uv as &ID3D11Resource),
            );
            self.ctx.Flush();
            // 阻塞读回 Y 平面，检查非全零
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            if self
                .ctx
                .Map(
                    Some(&self.staging_y[0] as &ID3D11Resource),
                    0,
                    D3D11_MAP_READ,
                    0,
                    Some(&mut mapped),
                )
                .is_err()
            {
                return false;
            }
            let slice = std::slice::from_raw_parts(
                mapped.pData as *const u8,
                (self.out_w as usize) * (self.out_h as usize),
            );
            let nonzero = slice.iter().any(|&b| b != 0);
            self.ctx.Unmap(Some(&self.staging_y[0] as &ID3D11Resource), 0);
            nonzero
        }
    }

    pub fn convert(&mut self, src: &ID3D11Texture2D, out: &mut Vec<u8>) -> Result<bool> {
        unsafe {
            // 运行时兜底：自检或上一帧已确认本管线静默失败 → 直接报错让调用方回退 RGBA，
            // 绝不产出哪怕一帧绿屏。
            if self.broken {
                return Err(windows::core::Error::from(windows::Win32::Foundation::E_FAIL));
            }
            // 1) 源帧拷贝到我们的输入纹理（GPU→GPU）。拷贝后立即 Flush 提交命令：
            //    WGC 帧纹理是被复用的共享纹理，若拷贝滞留命令队列、执行前源已被下一帧覆盖，
            //    则拷入「半旧半新」内容 → 输出撕裂。Flush 只提交不等待，无 CPU 阻塞。
            self.ctx.CopyResource(
                Some(&self.input_tex as &ID3D11Resource),
                Some(src as &ID3D11Resource),
            );
            self.ctx.Flush();
            // 2) 第一遍：亮度 Y 渲染到 R8 目标（全分辨率，硬件双线性缩放/裁剪）。
            //    ⚠️ 必须显式设置图元拓扑：D3D11 默认 UNDEFINED，此时 Draw 被静默丢弃
            //    （不报错），渲染目标停留在 Clear 的 0 → 输出全零 NV12 = 纯绿视频。
            //    上下文与 WGC 库共享，其状态可能被外部改动，故每次 convert 都重设。
            self.ctx
                .IASetPrimitiveTopology(windows::Win32::Graphics::Direct3D::D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            self.ctx.IASetInputLayout(None);
            self.ctx.GSSetShader(None, None);
            self.ctx.RSSetState(None);
            self.ctx.OMSetBlendState(None, None, u32::MAX);
            self.ctx.OMSetDepthStencilState(None, 0);
            self.ctx
                .OMSetRenderTargets(Some(&[Some(self.rtv_y.clone())]), None);
            let vp = D3D11_VIEWPORT {
                TopLeftX: 0.0,
                TopLeftY: 0.0,
                Width: self.out_w as f32,
                Height: self.out_h as f32,
                MinDepth: 0.0,
                MaxDepth: 1.0,
            };
            self.ctx.RSSetViewports(Some(&[vp]));
            let clear = [0.0f32, 0.0, 0.0, 1.0];
            self.ctx.ClearRenderTargetView(Some(&self.rtv_y), &clear);
            self.ctx.VSSetShader(Some(&self.vs), None);
            self.ctx.PSSetShader(Some(&self.ps_y), None);
            self.ctx
                .PSSetShaderResources(0, Some(&[Some(self.input_srv.clone())]));
            self.ctx
                .PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            self.ctx.Draw(3, 0);
            // 3) 第二遍：色度 UV 渲染到 R8G8 目标（半分辨率）
            self.ctx
                .OMSetRenderTargets(Some(&[Some(self.rtv_uv.clone())]), None);
            let vp_uv = D3D11_VIEWPORT {
                TopLeftX: 0.0,
                TopLeftY: 0.0,
                Width: (self.out_w / 2).max(1) as f32,
                Height: (self.out_h / 2).max(1) as f32,
                MinDepth: 0.0,
                MaxDepth: 1.0,
            };
            self.ctx.RSSetViewports(Some(&[vp_uv]));
            self.ctx.ClearRenderTargetView(Some(&self.rtv_uv), &clear);
            self.ctx.PSSetShader(Some(&self.ps_uv), None);
            self.ctx.Draw(3, 0);
            // 4) 两平面各拷入一块空闲 staging 槽并入队（无空闲槽则本帧结果丢弃——
            //    说明 GPU 读回积压，丢帧优于阻塞回调线程）
            if let Some(slot) = self.free_slots.pop() {
                self.ctx.CopyResource(
                    Some(&self.staging_y[slot] as &ID3D11Resource),
                    Some(&self.rt_y as &ID3D11Resource),
                );
                self.ctx.CopyResource(
                    Some(&self.staging_uv[slot] as &ID3D11Resource),
                    Some(&self.rt_uv as &ID3D11Resource),
                );
                self.pending.push_back(slot);
            }
            self.ctx.Flush();
            // 5) 非阻塞读回最早入队的槽：Map(DO_NOT_WAIT) 在 GPU 未就绪时立即返回
            //    DXGI_ERROR_WAS_STILL_DRAWING 而不等待 → 捕获回调线程零 GPU 同步，
            //    不再周期性冻住 DWM 合成（鼠标变慢的根因）。
            let Some(&slot) = self.pending.front() else {
                return Ok(false);
            };
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            match self.ctx.Map(
                Some(&self.staging_y[slot] as &ID3D11Resource),
                0,
                D3D11_MAP_READ,
                D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32,
                Some(&mut mapped),
            ) {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAS_STILL_DRAWING => {
                    // GPU 尚未完成该槽拷贝：本帧不产出，下一帧再试（槽保留在队首）
                    return Ok(false);
                }
                Err(e) => return Err(e),
            }
            let mut mapped_uv = D3D11_MAPPED_SUBRESOURCE::default();
            match self.ctx.Map(
                Some(&self.staging_uv[slot] as &ID3D11Resource),
                0,
                D3D11_MAP_READ,
                D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32,
                Some(&mut mapped_uv),
            ) {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAS_STILL_DRAWING => {
                    self.ctx.Unmap(Some(&self.staging_y[slot] as &ID3D11Resource), 0);
                    return Ok(false);
                }
                Err(e) => {
                    self.ctx.Unmap(Some(&self.staging_y[slot] as &ID3D11Resource), 0);
                    return Err(e);
                }
            }
            // 6) 拼装连续 NV12：Y 平面(out_w×out_h) + UV 平面(out_w×out_h/2)
            let w = self.out_w as usize;
            let h = self.out_h as usize;
            let total = w * h + w * h / 2;
            out.clear();
            out.reserve(total);
            // Y 平面（R8 staging，按真实 RowPitch 逐行拷入，每行 w 字节）
            let y_src = mapped.pData as *const u8;
            let y_pitch = mapped.RowPitch as usize;
            for y in 0..h {
                out.extend_from_slice(std::slice::from_raw_parts(y_src.add(y * y_pitch), w));
            }
            self.ctx.Unmap(Some(&self.staging_y[slot] as &ID3D11Resource), 0);
            // UV 平面（R8G8 staging，每行 w 字节 = w/2 个 R8G8 像素 ×2）
            let uv_src = mapped_uv.pData as *const u8;
            let uv_pitch = mapped_uv.RowPitch as usize;
            let uvh = h / 2;
            for y in 0..uvh {
                out.extend_from_slice(std::slice::from_raw_parts(uv_src.add(y * uv_pitch), w));
            }
            self.ctx.Unmap(Some(&self.staging_uv[slot] as &ID3D11Resource), 0);
            self.pending.pop_front();
            self.free_slots.push(slot);
            // 运行时兜底：若本帧 NV12 全部为零（渲染静默失败的真实信号），标记失效并回退 RGBA，
            // 避免产出哪怕一帧绿屏。着色器对黑屏也会写出 Y≈16，故全零必为 Draw 未执行。
            if out.iter().all(|&b| b == 0) {
                eprintln!("[GPU缩放] 运行时检测到全零帧，GPU 渲染管线静默失败，回退 RGBA 读回");
                self.broken = true;
                return Err(windows::core::Error::from(windows::Win32::Foundation::E_FAIL));
            }
            Ok(true)
        }
    }
}

/// 进程内 GPU 转 NV12 是否可用（所有支持 D3D11 渲染管线的硬件均为 true）。
/// 探针用临时 D3D11 设备构建完整「全屏三角形 + 线性采样」管线并实测一次转换，
/// 避免对不支持的驱动误启用。运行时若创建失败会自动回退到「读回 4K + ffmpeg scale」。
static NV12_IN_PROCESS: OnceLock<bool> = OnceLock::new();

pub(crate) fn nv12_in_process_supported() -> bool {
    *NV12_IN_PROCESS.get_or_init(|| probe_nv12(1920, 1080, DXGI_FORMAT_R8G8B8A8_UNORM))
}

pub(crate) fn probe_nv12(_w: u32, _h: u32, _fmt: DXGI_FORMAT) -> bool {
    unsafe {
        let mut dev = None;
        let mut ctx = None;
        if D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&[D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1]),
            D3D11_SDK_VERSION,
            Some(&mut dev),
            None,
            Some(&mut ctx),
        )
        .is_err()
        {
            return false;
        }
        let dev = match dev {
            Some(d) => d,
            None => return false,
        };
        let ctx = match ctx {
            Some(c) => c,
            None => return false,
        };
        match GpuNv12Converter::new(&dev, &ctx, 1920, 1080, 1280, 720, DXGI_FORMAT_R8G8B8A8_UNORM, None) {
            Ok(_) => {
                eprintln!("[GPU缩放] 探针成功：GPU 渲染管线转 NV12 可用（将只读回 NV12）");
                true
            }
            Err(e) => {
                eprintln!("[GPU缩放] 探针失败（回退 RGBA 读回，较慢）: {e}");
                false
            }
        }
    }
}
