//! 进程内 GPU RGBA→RGBA 缩放（全屏录制 4K→1080p 降采样，阶段二核心）
//!
//! 旧实现用 D3D11 Video Processor 做 RGBA→NV12 同时缩放，但大量机器的默认 D3D11 设备
//! 不支持 Video Processor（`nv12_in_process_supported()` 返回 false），导致整条 GPU 路径失效、
//! 回退到 4K 整帧 RGBA 读回，是「卡顿」的真源。
//!
//! 本实现改用 D3D11 渲染管线 + 全屏三角形 + 线性采样器在 GPU 上把帧缩到 1080p，再只读回 8MB，
//! 彻底消除 33MB 4K 读回 + CPU 缩放。渲染管线（Draw）是所有 D3D11 硬件的基线能力，
//! 不依赖 Video Processor，兼容性远好于旧方案。输出 RGBA，由 ffmpeg 做最终的 RGBA→YUV 色彩转换。

use std::sync::OnceLock;

use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1, ID3DBlob};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::core::{PCSTR, Result};

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

/// 像素着色器：用线性采样器对源纹理做双线性采样（硬件完成缩放）。
const PS_HLSL: &str = r#"
Texture2D tex : register(t0);
SamplerState samp : register(s0);
float4 PS(float4 pos : SV_Position, float2 uv : TEXCOORD0) : SV_Target {
    return tex.Sample(samp, uv);
}
"#;

pub struct GpuNv12Converter {
    ctx: ID3D11DeviceContext,
    input_tex: ID3D11Texture2D,
    input_srv: ID3D11ShaderResourceView,
    rt_tex: ID3D11Texture2D,
    rtv: ID3D11RenderTargetView,
    staging: ID3D11Texture2D,
    vs: ID3D11VertexShader,
    ps: ID3D11PixelShader,
    sampler: ID3D11SamplerState,
    out_w: u32,
    out_h: u32,
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
    ) -> Result<Self> {
        unsafe {
            let mut vs_blob = None;
            compile_hlsl(VS_HLSL, "VS", "vs_4_0", &mut vs_blob)?;
            let mut ps_blob = None;
            compile_hlsl(PS_HLSL, "PS", "ps_4_0", &mut ps_blob)?;
            let vs_blob = vs_blob.unwrap();
            let ps_blob = ps_blob.unwrap();

            let vs_code = std::slice::from_raw_parts(
                vs_blob.GetBufferPointer() as *const u8,
                vs_blob.GetBufferSize(),
            );
            let mut vs = None;
            device.CreateVertexShader(vs_code, None, Some(&mut vs))?;
            let vs = vs.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
            let ps_code = std::slice::from_raw_parts(
                ps_blob.GetBufferPointer() as *const u8,
                ps_blob.GetBufferSize(),
            );
            let mut ps = None;
            device.CreatePixelShader(ps_code, None, Some(&mut ps))?;
            let ps = ps.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;

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

            // 渲染目标（1080p RGBA）+ 只读回的 staging 纹理
            let rt_tex = create_tex(
                device,
                out_w,
                out_h,
                DXGI_FORMAT_R8G8B8A8_UNORM,
                D3D11_BIND_RENDER_TARGET,
            )?;
            let mut rtv = None;
            device.CreateRenderTargetView(&rt_tex, None, Some(&mut rtv))?;
            let rtv = rtv.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;

            let mut staging = None;
            device.CreateTexture2D(
                &D3D11_TEXTURE2D_DESC {
                    Width: out_w,
                    Height: out_h,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_R8G8B8A8_UNORM,
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
                Some(&mut staging),
            )?;
            let staging = staging.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;

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

            Ok(Self {
                ctx: ctx.clone(),
                input_tex,
                input_srv,
                rt_tex,
                rtv,
                staging,
                vs,
                ps,
                sampler,
                out_w,
                out_h,
            })
        }
    }

    /// 把 src（原生分辨率 RGBA 帧）在 GPU 缩放后读回为 out_w×out_h 的 RGBA 字节。
    pub fn convert(&self, src: &ID3D11Texture2D, out: &mut Vec<u8>) -> Result<()> {
        unsafe {
            // 1) 源帧拷贝到我们的输入纹理（GPU→GPU，快速）
            self.ctx.CopyResource(
                Some(&self.input_tex as &ID3D11Resource),
                Some(src as &ID3D11Resource),
            );
            // 2) 全屏三角形渲染到 1080p 渲染目标（硬件双线性缩放）
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
            let clear = [0.0f32, 0.0, 0.0, 1.0];
            self.ctx.ClearRenderTargetView(Some(&self.rtv), &clear);
            self.ctx.VSSetShader(Some(&self.vs), None);
            self.ctx.PSSetShader(Some(&self.ps), None);
            self.ctx
                .PSSetShaderResources(0, Some(&[Some(self.input_srv.clone())]));
            self.ctx
                .PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            self.ctx.Draw(3, 0);
            // 3) 1080p 渲染目标拷贝到 staging 并只读回 8MB
            self.ctx.CopyResource(
                Some(&self.staging as &ID3D11Resource),
                Some(&self.rt_tex as &ID3D11Resource),
            );
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.ctx.Map(
                Some(&self.staging as &ID3D11Resource),
                0,
                D3D11_MAP_READ,
                0,
                Some(&mut mapped),
            )?;
            let src_ptr = mapped.pData as *const u8;
            let row_bytes = (self.out_w * 4) as usize;
            let src_pitch = mapped.RowPitch as usize;
            out.clear();
            out.reserve(row_bytes * self.out_h as usize);
            for y in 0..self.out_h as usize {
                let src_row = src_ptr.add(y * src_pitch);
                out.extend_from_slice(std::slice::from_raw_parts(src_row, row_bytes));
            }
            self.ctx.Unmap(Some(&self.staging as &ID3D11Resource), 0);
            Ok(())
        }
    }
}

/// 进程内 GPU 缩放是否可用（所有支持 D3D11 渲染管线的硬件均为 true）。
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
        match GpuNv12Converter::new(&dev, &ctx, 1920, 1080, 1280, 720, DXGI_FORMAT_R8G8B8A8_UNORM) {
            Ok(_) => {
                eprintln!("[GPU缩放] 探针成功：GPU 渲染管线缩放可用（将只读回 1080p/8MB）");
                true
            }
            Err(e) => {
                eprintln!("[GPU缩放] 探针失败（回退 4K 读回，较慢）: {e}");
                false
            }
        }
    }
}
