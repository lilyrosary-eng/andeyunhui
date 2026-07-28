//! 进程内 GPU RGBA 缩放/裁剪（阶段二核心）
//!
//! ## 架构与限制（2026-07-28，第 27–28 轮）
//! 早期「在 WGC 设备上下文渲染」「跨设备共享 WGC 帧纹理」两种方案在用户机器上均失败：
//! - 在 WGC（windows-capture 内部）设备上下文渲染 → 自检全零（命令被 DWM 丢弃）；
//! - `OpenSharedResource` 跨设备映射 WGC 帧 → `0x80070057`，因为 **WGC 帧纹理未带
//!   `D3D11_RESOURCE_MISC_SHARED*` 标志，不可共享**（`windows-capture` 用自有 D3D 设备
//!   创建帧池，纹理默认不共享）。
//!
//! 故本机实际走 CPU 兜底：读取 WGC 帧 RGBA（33MB@4K 读回不可避免）→ 在捕获侧把帧缩到
//! (out_w,out_h)（GPU 不可用时用 `rgba_resize_crop_nearest` 最近邻缩放）→ 喂 ffmpeg。
//! `MiscFlags` 预筛在帧纹理不可共享时立即回退，避免无意义地建设备 / 自检后运行时失败。
//!
//! 本模块仍保留跨设备共享实现：在「WGC 帧纹理可共享」的机器上（部分驱动 / 配置），它能把
//! 4K→1080p 缩放搬到显卡、只读回 8MB，是更优路径；不可共享时干净降级，无副作用。
//! - `Map(DO_NOT_WAIT)`：GPU 未就绪立即返回、复用上一帧，捕获回调线程零 GPU 同步 → 不拖垮 DWM；
//! - 映射/渲染失败时返回 Err，调用方永久回退 RGBA CPU 读回，杜绝绿屏。

use std::collections::VecDeque;
use std::sync::OnceLock;

use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0,
    D3D_FEATURE_LEVEL_11_1, ID3DBlob, D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST,
};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::{
    IDXGIAdapter, IDXGIDevice, IDXGIKeyedMutex, IDXGIResource, DXGI_ERROR_WAS_STILL_DRAWING,
};
use windows::core::{Interface, PCSTR, Result};

/// staging 环形池槽数：3 槽（三缓冲）配合非阻塞读回，读回延迟约 1 帧。
const STAGING_COUNT: usize = 3;

/// 跨设备共享的 WGC 帧纹理（本设备上的一份映射）及其 keyed mutex。
struct SharedFrame {
    /// 来源帧的 COM 指针标识（转为 usize，使类型满足 Send），用于判断是否需要重新映射（每帧可能换新纹理）。
    src_ptr: usize,
    tex: ID3D11Texture2D,
    /// 跨设备 keyed mutex（WGC 帧为共享关键互斥纹理时有；用于 Acquire/Release 同步写入权）。
    km: Option<IDXGIKeyedMutex>,
}

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

/// 像素着色器：按裁剪常量只采样子矩形并缩放到输出尺寸，输出 RGBA。
/// bgra=true 时 `c.bgr` 把 WGC 的 BGRA 还原为标准 RGBA；否则 `c.rgb`。
fn build_ps_rgba(crop: Option<(f32, f32, f32, f32)>, bgra: bool) -> String {
    let (ox, oy, sw, sh) = crop.unwrap_or((0.0, 0.0, 1.0, 1.0));
    let pick = if bgra { "c.bgr" } else { "c.rgb" };
    format!(
        r#"
Texture2D tex : register(t0);
SamplerState samp : register(s0);
static const float2 ORIGIN = float2({ox}, {oy});
static const float2 SCALE = float2({sw}, {sh});
float4 PS(float4 pos : SV_Position, float2 uv : TEXCOORD0) : SV_Target {{
    float2 suv = ORIGIN + uv * SCALE;
    float4 c = tex.Sample(samp, suv);
    return float4({pick}, 1.0);
}}
"#
    )
}

pub struct GpuNv12Converter {
    /// 我们自建的 D3D11 设备（与 WGC 同 GPU 适配器），所有渲染/读回都在它上面执行。
    device: ID3D11Device,
    ctx: ID3D11DeviceContext,
    input_tex: ID3D11Texture2D,
    input_srv: ID3D11ShaderResourceView,
    rt: ID3D11Texture2D,
    rtv: ID3D11RenderTargetView,
    staging: Vec<ID3D11Texture2D>,
    vs: ID3D11VertexShader,
    ps: ID3D11PixelShader,
    sampler: ID3D11SamplerState,
    out_w: u32,
    out_h: u32,
    in_w: u32,
    in_h: u32,
    broken: bool,
    free_slots: Vec<usize>,
    pending: VecDeque<usize>,
    /// 跨设备共享的 WGC 帧纹理（按需映射，按来源指针缓存）。
    shared: Option<SharedFrame>,
}

unsafe fn create_tex(
    device: &ID3D11Device,
    w: u32,
    h: u32,
    fmt: DXGI_FORMAT,
    bind: D3D11_BIND_FLAG,
    usage: D3D11_USAGE,
    cpu_access: u32,
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
        Usage: usage,
        BindFlags: bind.0 as u32,
        CPUAccessFlags: cpu_access,
        MiscFlags: 0,
    };
    let mut tex = None;
    device.CreateTexture2D(&desc, None, Some(&mut tex))?;
    tex.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))
}

unsafe fn compile_hlsl(src: &str, entry: &str, target: &str, blob: &mut Option<ID3DBlob>) -> Result<()> {
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
    /// `device` 仅用于取其与 WGC 同 GPU 的适配器；`src_misc_flags` 是 WGC 帧纹理的
    /// `D3D11_TEXTURE2D_DESC.MiscFlags`，用于预筛「帧纹理是否可跨设备共享」。
    pub fn new(
        device: &ID3D11Device,
        src_misc_flags: u32,
        in_w: u32,
        in_h: u32,
        out_w: u32,
        out_h: u32,
        input_fmt: DXGI_FORMAT,
        crop: Option<(u32, u32, u32, u32)>,
    ) -> Result<Self> {
        unsafe {
            // 跨设备共享预筛：WGC 帧纹理须带 D3D11_RESOURCE_MISC_SHARED* 标志才能 OpenSharedResource
            // 映射进本设备。本机（windows-capture 用内部 D3D 设备创建帧池、未带共享标志）的帧纹理不可
            // 共享，OpenSharedResource 必失败（0x80070057）。这里先预筛，避免无意义地建设备 / 自检后
            // 又运行时回退，日志更直接、不误导。
            const SHARED: u32 = D3D11_RESOURCE_MISC_SHARED.0 as u32;
            const SHARED_KM: u32 = D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0 as u32;
            const SHARED_NT: u32 = D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0 as u32;
            if src_misc_flags & (SHARED | SHARED_KM | SHARED_NT) == 0 {
                eprintln!(
                    "[GPU缩放] WGC 帧纹理非共享（MiscFlags=0x{:X}），跨设备 GPU 缩放不可用，回退 CPU 读回",
                    src_misc_flags
                );
                return Err(windows::core::Error::from(windows::Win32::Foundation::E_FAIL));
            }
            // 取 WGC 设备所在适配器，自建同 GPU 设备——跨设备共享（OpenSharedResource）要求同源适配器。
            let adapter: Option<IDXGIAdapter> = match device.cast::<IDXGIDevice>() {
                Ok(d) => match d.GetAdapter() {
                    Ok(a) => Some(a),
                    Err(e) => {
                        eprintln!("[GPU缩放] 取 WGC 适配器失败，改默认适配器: {e}");
                        None
                    }
                },
                Err(e) => {
                    eprintln!("[GPU缩放] 设备转 IDXGIDevice 失败，改默认适配器: {e}");
                    None
                }
            };
            let mut dev = None;
            let mut ctx = None;
            let feature_levels = [D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1];
            // 多线程序列化是 D3D11 默认行为（仅 SINGLETHREADED 才关闭），故此处不必显式加标志。
            let flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
            let hr = match &adapter {
                Some(a) => D3D11CreateDevice(
                    Some(a),
                    D3D_DRIVER_TYPE_UNKNOWN,
                    HMODULE::default(),
                    flags,
                    Some(&feature_levels),
                    D3D11_SDK_VERSION,
                    Some(&mut dev),
                    None,
                    Some(&mut ctx),
                ),
                None => D3D11CreateDevice(
                    None,
                    D3D_DRIVER_TYPE_HARDWARE,
                    HMODULE::default(),
                    flags,
                    Some(&feature_levels),
                    D3D11_SDK_VERSION,
                    Some(&mut dev),
                    None,
                    Some(&mut ctx),
                ),
            };
            hr.map_err(|e| {
                eprintln!("[GPU缩放] 自建 D3D11 设备失败（回退 CPU 读回）: {e}");
                e
            })?;
            let device = dev.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
            let ctx = ctx.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;

            // 输入纹理格式若为 BGRA，着色器内做 bgr 还原；其余（含 RGBA）按 rgb。
            let bgra = matches!(
                input_fmt,
                DXGI_FORMAT_B8G8R8A8_UNORM
                    | DXGI_FORMAT_B8G8R8A8_UNORM_SRGB
                    | DXGI_FORMAT_B8G8R8X8_UNORM
            );

            let mut vs_blob = None;
            compile_hlsl(VS_HLSL, "VS", "vs_4_0", &mut vs_blob)?;
            let crop_norm = crop.map(|(cx, cy, cw, ch)| {
                let ox = cx as f32 / in_w as f32;
                let oy = cy as f32 / in_h as f32;
                let sw = (cw as f32).max(1.0) / in_w as f32;
                let sh = (ch as f32).max(1.0) / in_h as f32;
                (ox, oy, sw, sh)
            });
            let mut ps_blob = None;
            compile_hlsl(&build_ps_rgba(crop_norm, bgra), "PS", "ps_4_0", &mut ps_blob)?;
            let vs_blob = vs_blob.unwrap();
            let vs_code = std::slice::from_raw_parts(
                vs_blob.GetBufferPointer() as *const u8,
                vs_blob.GetBufferSize(),
            );
            let mut vs = None;
            device.CreateVertexShader(vs_code, None, Some(&mut vs))?;
            let vs = vs.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
            let ps_blob = ps_blob.unwrap();
            let ps_code = std::slice::from_raw_parts(
                ps_blob.GetBufferPointer() as *const u8,
                ps_blob.GetBufferSize(),
            );
            let mut ps = None;
            device.CreatePixelShader(ps_code, None, Some(&mut ps))?;
            let ps = ps.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;

            let input_tex = create_tex(
                &device,
                in_w,
                in_h,
                input_fmt,
                D3D11_BIND_SHADER_RESOURCE,
                D3D11_USAGE_DEFAULT,
                0,
            )?;
            let mut srv = None;
            device.CreateShaderResourceView(&input_tex, None, Some(&mut srv))?;
            let input_srv = srv.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;

            let rt = create_tex(
                &device,
                out_w,
                out_h,
                DXGI_FORMAT_R8G8B8A8_UNORM,
                D3D11_BIND_RENDER_TARGET,
                D3D11_USAGE_DEFAULT,
                0,
            )?;
            let mut rtv = None;
            device.CreateRenderTargetView(&rt, None, Some(&mut rtv))?;
            let rtv = rtv.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;

            let mut staging = Vec::with_capacity(STAGING_COUNT);
            let mut free_slots = Vec::with_capacity(STAGING_COUNT);
            for i in 0..STAGING_COUNT {
                let t = create_tex(
                    &device,
                    out_w,
                    out_h,
                    DXGI_FORMAT_R8G8B8A8_UNORM,
                    D3D11_BIND_FLAG(0),
                    D3D11_USAGE_STAGING,
                    D3D11_CPU_ACCESS_READ.0 as u32,
                )?;
                staging.push(t);
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
                device,
                ctx,
                input_tex,
                input_srv,
                rt,
                rtv,
                staging,
                vs,
                ps,
                sampler,
                out_w,
                out_h,
                in_w,
                in_h,
                broken: false,
                free_slots,
                pending: VecDeque::with_capacity(STAGING_COUNT),
                shared: None,
            };
            // 自检：用**本（自建）设备**渲染一帧白屏、阻塞读回，验证 Draw 真能向渲染目标写出非全零。
            // 关键修正：渲染在自建设备上执行（WGC 设备上下文在本机被 DWM 丢弃命令、自检必全零），
            // 故本自检在绝大多数机器上应通过，从而真正启用 GPU 缩放路径。
            if !me.verify() {
                eprintln!("[GPU缩放] 自检失败：自建设备渲染管线产出全零，回退 RGBA 读回（不启用 GPU 路径）");
                return Err(windows::core::Error::from(windows::Win32::Foundation::E_FAIL));
            }
            eprintln!("[GPU缩放] 自检通过：自建设备 D3D11 缩放渲染管线可用，启用 GPU 路径（跨设备共享 WGC 帧 + DO_NOT_WAIT）");
            Ok(me)
        }
    }

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
            self.set_state();
            self.ctx
                .OMSetRenderTargets(Some(&[Some(self.rtv.clone())]), None);
            let vp = D3D11_VIEWPORT {
                TopLeftX: 0.0,
                TopLeftY: 0.0,
                Width: self.out_w as f32,
                Height: self.out_h as f32,
                MinDepth: 0.0,
                MaxDepth: 1.0,
            };
            self.ctx.RSSetViewports(Some(&[vp]));
            let clear = [1.0f32, 1.0, 1.0, 1.0];
            self.ctx.ClearRenderTargetView(Some(&self.rtv), &clear);
            self.ctx.VSSetShader(Some(&self.vs), None);
            self.ctx.PSSetShader(Some(&self.ps), None);
            self.ctx
                .PSSetShaderResources(0, Some(&[Some(self.input_srv.clone())]));
            self.ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            self.ctx.Draw(3, 0);
            if let Some(slot) = self.free_slots.first() {
                self.ctx.CopyResource(
                    Some(&self.staging[*slot] as &ID3D11Resource),
                    Some(&self.rt as &ID3D11Resource),
                );
            }
            self.ctx.Flush();
            let slot = *self.free_slots.first().unwrap();
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            if self
                .ctx
                .Map(
                    Some(&self.staging[slot] as &ID3D11Resource),
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
                (self.out_w as usize) * (self.out_h as usize) * 4,
            );
            let nonzero = slice.iter().any(|&b| b != 0);
            self.ctx.Unmap(Some(&self.staging[slot] as &ID3D11Resource), 0);
            nonzero
        }
    }

    #[inline]
    unsafe fn set_state(&self) {
        self.ctx.IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        self.ctx.IASetInputLayout(None);
        self.ctx.GSSetShader(None, None);
        self.ctx.RSSetState(None);
        self.ctx.OMSetBlendState(None, None, u32::MAX);
        self.ctx.OMSetDepthStencilState(None, 0);
    }

    /// 把 WGC 帧纹理 `src`（在 WGC 设备）跨设备映射到本设备并缩放/裁剪到 RGBA。
    /// 返回 `Ok(true)`=out 已写入一帧；`Ok(false)`=GPU 未就绪、本帧无产出（调用方复用上一帧）；
    /// `Err`=映射/渲染失败（调用方永久回退 CPU 读回）。
    pub fn convert(&mut self, src: &ID3D11Texture2D, out: &mut Vec<u8>) -> Result<bool> {
        unsafe {
            if self.broken {
                return Err(windows::core::Error::from(windows::Win32::Foundation::E_FAIL));
            }
            // 跨设备映射 WGC 帧纹理（按来源指针缓存；每帧可能换新纹理则需重映射）。
            let src_ptr = src.as_raw() as usize;
            let need_remap = self.shared.as_ref().map_or(true, |s| s.src_ptr != src_ptr);
            if need_remap {
                let res: IDXGIResource = match src.cast() {
                    Ok(r) => r,
                    Err(e) => {
                        eprintln!("[GPU缩放] 帧纹理无法转为 IDXGIResource（跨设备共享不可用），回退 CPU: {e}");
                        self.broken = true;
                        return Err(e);
                    }
                };
                let h = match res.GetSharedHandle() {
                    Ok(h) => h,
                    Err(e) => {
                        eprintln!("[GPU缩放] 取共享句柄失败（帧纹理非共享），回退 CPU: {e}");
                        self.broken = true;
                        return Err(e);
                    }
                };
                let mut shared: Option<ID3D11Texture2D> = None;
                if let Err(e) = self.device.OpenSharedResource(h, &mut shared) {
                    eprintln!("[GPU缩放] OpenSharedResource 失败，回退 CPU: {e}");
                    self.broken = true;
                    return Err(e);
                }
                let shared = shared
                    .ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
                let km = shared.cast::<IDXGIKeyedMutex>().ok();
                self.shared = Some(SharedFrame {
                    src_ptr,
                    tex: shared,
                    km,
                });
                eprintln!(
                    "[GPU缩放] WGC 帧跨设备映射成功（keyed-mutex={}）",
                    self.shared.as_ref().unwrap().km.is_some()
                );
            }
            let shared = &self.shared.as_ref().unwrap().tex;
            let km = self.shared.as_ref().unwrap().km.clone();

            // 跨设备同步：短暂等待 WGC 释放本帧写入权（keyed mutex），拷贝入本设备输入纹理；
            // 超时仅放宽为偶发撕裂风险，绝不长时间阻塞捕获线程 / DWM 合成。
            if let Some(km) = &km {
                let _ = km.AcquireSync(0, 16);
            }
            self.ctx.CopyResource(
                Some(&self.input_tex as &ID3D11Resource),
                Some(shared as &ID3D11Resource),
            );
            if let Some(km) = &km {
                let _ = km.ReleaseSync(0);
            }
            self.ctx.Flush();

            // 渲染：单遍全屏三角形把输入缩放/裁剪到 RGBA 渲染目标。
            self.set_state();
            self.ctx
                .OMSetRenderTargets(Some(&[Some(self.rtv.clone())]), None);
            let vp = D3D11_VIEWPORT {
                TopLeftX: 0.0,
                TopLeftY: 0.0,
                Width: self.out_w as f32,
                Height: self.out_h as f32,
                MinDepth: 0.0,
                MaxDepth: 1.0,
            };
            self.ctx.RSSetViewports(Some(&[vp]));
            self.ctx
                .ClearRenderTargetView(Some(&self.rtv), &[0.0f32, 0.0, 0.0, 1.0]);
            self.ctx.VSSetShader(Some(&self.vs), None);
            self.ctx.PSSetShader(Some(&self.ps), None);
            self.ctx
                .PSSetShaderResources(0, Some(&[Some(self.input_srv.clone())]));
            self.ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            self.ctx.Draw(3, 0);

            // 拷入空闲 staging 槽并入队（无空闲槽则本帧不入队，但仍尝试读回最早槽排空流水线）。
            if let Some(slot) = self.free_slots.pop() {
                self.ctx.CopyResource(
                    Some(&self.staging[slot] as &ID3D11Resource),
                    Some(&self.rt as &ID3D11Resource),
                );
                self.pending.push_back(slot);
            }
            self.ctx.Flush();

            // 非阻塞读回最早入队的槽：Map(DO_NOT_WAIT) 在 GPU 未就绪时立即返回，绝不等待。
            // 关键：WAS_STILL_DRAWING 时槽必须**留在 pending 队列**等下一帧回调再收——
            // 旧实现把槽弹出丢弃，等于每帧都在「刚下完拷贝命令就立刻 Map」→ 必然还在画 →
            // 永远 Ok(false) → 永远零产出（原生 WGC「2.5s 零帧看门狗」即由此触发）。
            let Some(&slot) = self.pending.front() else {
                return Ok(false);
            };
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            match self.ctx.Map(
                Some(&self.staging[slot] as &ID3D11Resource),
                0,
                D3D11_MAP_READ,
                D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32,
                Some(&mut mapped),
            ) {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAS_STILL_DRAWING => {
                    // GPU 还在写该槽：保留在 pending，本帧无产出（pacer 复用上一帧）。
                    return Ok(false);
                }
                Err(e) => {
                    self.pending.pop_front();
                    self.free_slots.push(slot);
                    return Err(e);
                }
            }
            let w = self.out_w as usize;
            let h = self.out_h as usize;
            let total = w * h * 4;
            out.clear();
            out.reserve(total);
            let src_ptr = mapped.pData as *const u8;
            let pitch = mapped.RowPitch as usize;
            for y in 0..h {
                out.extend_from_slice(std::slice::from_raw_parts(src_ptr.add(y * pitch), w * 4));
            }
            self.ctx.Unmap(Some(&self.staging[slot] as &ID3D11Resource), 0);
            self.pending.pop_front();
            self.free_slots.push(slot);

            if out.iter().all(|&b| b == 0) {
                eprintln!("[GPU缩放] 运行时检测到全零帧，GPU 渲染管线静默失败，回退 RGBA 读回");
                self.broken = true;
                return Err(windows::core::Error::from(windows::Win32::Foundation::E_FAIL));
            }
            Ok(true)
        }
    }
}

/// 方案 A（原生 WGC）的同设备缩放器：帧池建在「本设备」上，WGC 帧纹理与渲染管线同设备，
/// 无需任何跨设备共享/keyed-mutex——直接 `CopyResource` + 单遍全屏三角形缩放/裁剪 +
/// `Map(DO_NOT_WAIT)` 非阻塞读回小尺寸 RGBA（4K→1080p 时读回从 33MB 降到 8MB）。
/// 与 `GpuNv12Converter` 的区别：设备/上下文由调用方（wgc_native）提供且与帧同源，
/// 故没有「共享失败」这一失败模式；全零检测仅在前几帧做（防止真实黑屏误杀）。
pub struct GpuSameDeviceScaler {
    ctx: ID3D11DeviceContext,
    input_tex: ID3D11Texture2D,
    input_srv: ID3D11ShaderResourceView,
    rt: ID3D11Texture2D,
    rtv: ID3D11RenderTargetView,
    staging: Vec<ID3D11Texture2D>,
    vs: ID3D11VertexShader,
    ps: ID3D11PixelShader,
    sampler: ID3D11SamplerState,
    out_w: u32,
    out_h: u32,
    in_w: u32,
    in_h: u32,
    broken: bool,
    free_slots: Vec<usize>,
    pending: VecDeque<usize>,
    /// 已成功产出的帧数：仅前几帧做全零检测（黑屏内容不该永久禁用 GPU 路）。
    ok_frames: u32,
}

impl GpuSameDeviceScaler {
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
            let bgra = matches!(
                input_fmt,
                DXGI_FORMAT_B8G8R8A8_UNORM
                    | DXGI_FORMAT_B8G8R8A8_UNORM_SRGB
                    | DXGI_FORMAT_B8G8R8X8_UNORM
            );
            let mut vs_blob = None;
            compile_hlsl(VS_HLSL, "VS", "vs_4_0", &mut vs_blob)?;
            let crop_norm = crop.map(|(cx, cy, cw, ch)| {
                (
                    cx as f32 / in_w as f32,
                    cy as f32 / in_h as f32,
                    (cw as f32).max(1.0) / in_w as f32,
                    (ch as f32).max(1.0) / in_h as f32,
                )
            });
            let mut ps_blob = None;
            compile_hlsl(&build_ps_rgba(crop_norm, bgra), "PS", "ps_4_0", &mut ps_blob)?;
            let vs_blob = vs_blob.unwrap();
            let vs_code = std::slice::from_raw_parts(
                vs_blob.GetBufferPointer() as *const u8,
                vs_blob.GetBufferSize(),
            );
            let mut vs = None;
            device.CreateVertexShader(vs_code, None, Some(&mut vs))?;
            let vs = vs.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
            let ps_blob = ps_blob.unwrap();
            let ps_code = std::slice::from_raw_parts(
                ps_blob.GetBufferPointer() as *const u8,
                ps_blob.GetBufferSize(),
            );
            let mut ps = None;
            device.CreatePixelShader(ps_code, None, Some(&mut ps))?;
            let ps = ps.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;

            let input_tex = create_tex(
                device,
                in_w,
                in_h,
                input_fmt,
                D3D11_BIND_SHADER_RESOURCE,
                D3D11_USAGE_DEFAULT,
                0,
            )?;
            let mut srv = None;
            device.CreateShaderResourceView(&input_tex, None, Some(&mut srv))?;
            let input_srv =
                srv.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;

            let rt = create_tex(
                device,
                out_w,
                out_h,
                DXGI_FORMAT_R8G8B8A8_UNORM,
                D3D11_BIND_RENDER_TARGET,
                D3D11_USAGE_DEFAULT,
                0,
            )?;
            let mut rtv = None;
            device.CreateRenderTargetView(&rt, None, Some(&mut rtv))?;
            let rtv = rtv.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;

            let mut staging = Vec::with_capacity(STAGING_COUNT);
            let mut free_slots = Vec::with_capacity(STAGING_COUNT);
            for i in 0..STAGING_COUNT {
                staging.push(create_tex(
                    device,
                    out_w,
                    out_h,
                    DXGI_FORMAT_R8G8B8A8_UNORM,
                    D3D11_BIND_FLAG(0),
                    D3D11_USAGE_STAGING,
                    D3D11_CPU_ACCESS_READ.0 as u32,
                )?);
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
            let sampler =
                sampler.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;

            Ok(Self {
                ctx: ctx.clone(),
                input_tex,
                input_srv,
                rt,
                rtv,
                staging,
                vs,
                ps,
                sampler,
                out_w,
                out_h,
                in_w,
                in_h,
                broken: false,
                free_slots,
                pending: VecDeque::with_capacity(STAGING_COUNT),
                ok_frames: 0,
            })
        }
    }

    #[inline]
    unsafe fn set_state(&self) {
        self.ctx.IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        self.ctx.IASetInputLayout(None);
        self.ctx.GSSetShader(None, None);
        self.ctx.RSSetState(None);
        self.ctx.OMSetBlendState(None, None, u32::MAX);
        self.ctx.OMSetDepthStencilState(None, 0);
    }

    pub fn input_size(&self) -> (u32, u32) {
        (self.in_w, self.in_h)
    }

    /// 同设备缩放：`src` 是本设备上的 WGC 帧纹理（帧池建在本设备）。
    /// `Ok(true)`=out 写入一帧；`Ok(false)`=GPU 未就绪（复用上一帧）；`Err`=渲染失败（调用方回退 CPU）。
    pub fn scale(&mut self, src: &ID3D11Texture2D, out: &mut Vec<u8>) -> Result<bool> {
        unsafe {
            if self.broken {
                return Err(windows::core::Error::from(windows::Win32::Foundation::E_FAIL));
            }
            // 同设备直拷（帧纹理与 input_tex 同尺寸同格式；帧池尺寸 = item 尺寸）。
            self.ctx.CopyResource(
                Some(&self.input_tex as &ID3D11Resource),
                Some(src as &ID3D11Resource),
            );

            self.set_state();
            self.ctx
                .OMSetRenderTargets(Some(&[Some(self.rtv.clone())]), None);
            let vp = D3D11_VIEWPORT {
                TopLeftX: 0.0,
                TopLeftY: 0.0,
                Width: self.out_w as f32,
                Height: self.out_h as f32,
                MinDepth: 0.0,
                MaxDepth: 1.0,
            };
            self.ctx.RSSetViewports(Some(&[vp]));
            self.ctx
                .ClearRenderTargetView(Some(&self.rtv), &[0.0f32, 0.0, 0.0, 1.0]);
            self.ctx.VSSetShader(Some(&self.vs), None);
            self.ctx.PSSetShader(Some(&self.ps), None);
            self.ctx
                .PSSetShaderResources(0, Some(&[Some(self.input_srv.clone())]));
            self.ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            self.ctx.Draw(3, 0);

            if let Some(slot) = self.free_slots.pop() {
                self.ctx.CopyResource(
                    Some(&self.staging[slot] as &ID3D11Resource),
                    Some(&self.rt as &ID3D11Resource),
                );
                self.pending.push_back(slot);
            }
            self.ctx.Flush();

            // 阻塞读回「本帧」所在槽（队尾 = 当前帧）：Map 阻塞会强制 GPU 把整条命令流
            // （CopyResource(WGC帧→input_tex) → Draw → CopyResource(rt→staging)）全部执行完，
            // 确保在 process 返回、调用方 Close 该 WGC 帧之前，帧纹理已被安全拷出。否则 Close 后
            // WGC 回收该纹理，异步命令读到回收后的脏数据 → 全黑/噪点（本次 40s/90MB 黑屏根因）。
            let Some(&slot) = self.pending.back() else {
                return Ok(false);
            };
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.ctx
                .Map(
                    Some(&self.staging[slot] as &ID3D11Resource),
                    0,
                    D3D11_MAP_READ,
                    0,
                    Some(&mut mapped),
                )
                .map_err(|e| {
                    self.pending.pop_back();
                    self.free_slots.push(slot);
                    e
                })?;
            let w = self.out_w as usize;
            let h = self.out_h as usize;
            let total = w * h * 4;
            out.clear();
            out.reserve(total);
            let src_ptr = mapped.pData as *const u8;
            let pitch = mapped.RowPitch as usize;
            for y in 0..h {
                out.extend_from_slice(std::slice::from_raw_parts(src_ptr.add(y * pitch), w * 4));
            }
            self.ctx.Unmap(Some(&self.staging[slot] as &ID3D11Resource), 0);
            self.pending.pop_back();
            self.free_slots.push(slot);

            // 仅前 3 帧做全零检测（验证管线真的在写出）；此后黑屏内容属正常画面，不误杀。
            if self.ok_frames < 3 && out.iter().all(|&b| b == 0) {
                eprintln!("[GPU缩放] 同设备渲染前几帧全零，管线静默失败，回退 CPU 读回");
                self.broken = true;
                return Err(windows::core::Error::from(windows::Win32::Foundation::E_FAIL));
            }
            self.ok_frames = self.ok_frames.saturating_add(1);
            Ok(true)
        }
    }
}

/// 进程内 GPU 转 RGBA 是否可用。探针用临时 D3D11 设备构建完整渲染管线并实测一次，
/// 避免对不支持的驱动误启用。运行时若创建/映射失败会自动回退到「读回整帧 + ffmpeg scale」。
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
        match GpuNv12Converter::new(
            &dev,
            D3D11_RESOURCE_MISC_SHARED.0 as u32, // 模拟「帧纹理可共享」，仅用于验证本机 D3D11 渲染管线
            1920,
            1080,
            1280,
            720,
            DXGI_FORMAT_R8G8B8A8_UNORM,
            None,
        ) {
            Ok(_) => {
                eprintln!("[GPU缩放] 探针成功：GPU 渲染管线可用（将只读回 RGBA）");
                true
            }
            Err(e) => {
                eprintln!("[GPU缩放] 探针失败（回退 RGBA 读回，较慢）: {e}");
                false
            }
        }
    }
}
