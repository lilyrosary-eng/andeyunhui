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

/// Y 通道像素着色器：输出 BT.709 全范围→受限范围亮度到 R8_UNORM
fn build_ps_y(crop: Option<(f32, f32, f32, f32)>, bgra: bool) -> String {
    let (ox, oy, sw, sh) = crop.unwrap_or((0.0, 0.0, 1.0, 1.0));
    let pick = if bgra { "bgr" } else { "rgb" };
    format!(
        r#"
Texture2D tex : register(t0);
SamplerState samp : register(s0);
static const float2 ORIGIN = float2({ox}, {oy});
static const float2 SCALE = float2({sw}, {sh});
float4 PS(float4 pos : SV_Position, float2 uv : TEXCOORD0) : SV_Target {{
    float2 suv = ORIGIN + uv * SCALE;
    float4 c = tex.Sample(samp, suv);
    float y = dot(float3(0.2126, 0.7152, 0.0722), c.{pick});
    y = y * (219.0/255.0) + (16.0/255.0);
    return float4(y, 0, 0, 1);
}}
"#
    )
}

/// UV 通道像素着色器（half-res）：输出受限范围 U/V 到 R8G8_UNORM
fn build_ps_uv(crop: Option<(f32, f32, f32, f32)>, bgra: bool, tw: u32, th: u32) -> String {
    let (ox, oy, sw, sh) = crop.unwrap_or((0.0, 0.0, 1.0, 1.0));
    let pick = if bgra { "bgr" } else { "rgb" };
    let tx = 1.0_f64 / tw as f64;
    let ty = 1.0_f64 / th as f64;
    format!(
        r#"
Texture2D tex : register(t0);
SamplerState samp : register(s0);
static const float2 ORIGIN = float2({ox}, {oy});
static const float2 SCALE = float2({sw}, {sh});
static const float2 TEXEL = float2({tx}, {ty});
float4 PS(float4 pos : SV_Position, float2 uv : TEXCOORD0) : SV_Target {{
    float2 suv = ORIGIN + uv * SCALE;
    float3 c00 = tex.Sample(samp, suv).{pick};
    float3 c01 = tex.Sample(samp, suv + float2(TEXEL.x, 0)).{pick};
    float3 c10 = tex.Sample(samp, suv + float2(0, TEXEL.y)).{pick};
    float3 c11 = tex.Sample(samp, suv + float2(TEXEL.x, TEXEL.y)).{pick};
    float3 avg = (c00 + c01 + c10 + c11) * 0.25;
    float y = dot(float3(0.2126, 0.7152, 0.0722), avg);
    float u = 0.5 + 0.5 * (avg.b - y) / (1.0 - 0.0722);
    float v = 0.5 + 0.5 * (avg.r - y) / (1.0 - 0.2126);
    u = u * (224.0/255.0) + (16.0/255.0);
    v = v * (224.0/255.0) + (16.0/255.0);
    return float4(u, v, 0, 1);
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
    /// 不做背面剔除的光栅化器状态（见 create_cull_none_rs 的说明：默认状态会把全屏三角整片剔除）
    rs: ID3D11RasterizerState,
    out_w: u32,
    out_h: u32,
    in_w: u32,
    in_h: u32,
    broken: bool,
    free_slots: Vec<usize>,
    pending: VecDeque<usize>,
    /// 跨设备共享的 WGC 帧纹理（按需映射，按来源指针缓存）。
    shared: Option<SharedFrame>,
    // ── NV12 直接输出（R8 Y + R8G8 UV，替代 RGBA 渲染）──
    ps_y: ID3D11PixelShader,
    ps_uv: ID3D11PixelShader,
    rt_y: ID3D11Texture2D,
    rtv_y: ID3D11RenderTargetView,
    staging_y: Vec<ID3D11Texture2D>,
    rt_uv: ID3D11Texture2D,
    rtv_uv: ID3D11RenderTargetView,
    staging_uv: Vec<ID3D11Texture2D>,
    pub nv12_buf: Vec<u8>,
}

/// 创建「不做背面剔除」的光栅化器状态（**GPU 路径能否出画面全系于它**）。
///
/// 为什么必须显式创建：全屏三角形的顶点是 `(-1,-1) / (3,-1) / (-1,3)`，在 y 轴向下的屏幕空间里
/// 其缠绕方向是**逆时针**；而 D3D11 默认光栅化器状态为 `CullMode=BACK` +
/// `FrontCounterClockwise=FALSE`（只保留顺时针面）→ **整个三角形被背面剔除，Draw 一个像素都不写**。
/// `ClearRenderTargetView` 不走光栅化，所以症状是极具迷惑性的「清屏有值、渲染全零、且调试层零报错」。
///
/// 历史影响：本项目 GpuNv12Converter / GpuSameDeviceScaler / wgc_native 全用同一条 VS + 默认状态，
/// 于是所有 GPU 路径都静默失败，并被误判为「设备不能渲染（命令被 DWM 丢弃）」而长期弃用，
/// 只能退回「CPU 整帧读回 + 逐像素缩放」——这正是录屏卡顿的总根因。
unsafe fn create_cull_none_rs(device: &ID3D11Device) -> Result<ID3D11RasterizerState> {
    let desc = D3D11_RASTERIZER_DESC {
        FillMode: D3D11_FILL_SOLID,
        CullMode: D3D11_CULL_NONE,
        FrontCounterClockwise: false.into(),
        DepthBias: 0,
        DepthBiasClamp: 0.0,
        SlopeScaledDepthBias: 0.0,
        DepthClipEnable: true.into(),
        ScissorEnable: false.into(),
        MultisampleEnable: false.into(),
        AntialiasedLineEnable: false.into(),
    };
    let mut rs = None;
    device.CreateRasterizerState(&desc, Some(&mut rs))?;
    rs.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))
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
            let rs = create_cull_none_rs(&device)?;

            // NV12 像素着色器和渲染目标（Y: R8, UV: R8G8 half-res）
            let mut ps_y_blob = None;
            compile_hlsl(&build_ps_y(crop_norm, bgra), "PS", "ps_4_0", &mut ps_y_blob)?;
            let ps_y_blob = ps_y_blob.unwrap();
            let ps_y_code = std::slice::from_raw_parts(ps_y_blob.GetBufferPointer() as *const u8, ps_y_blob.GetBufferSize());
            let mut ps_y = None;
            device.CreatePixelShader(ps_y_code, None, Some(&mut ps_y))?;
            let ps_y = ps_y.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;

            let mut ps_uv_blob = None;
            compile_hlsl(&build_ps_uv(crop_norm, bgra, in_w, in_h), "PS", "ps_4_0", &mut ps_uv_blob)?;
            let ps_uv_blob = ps_uv_blob.unwrap();
            let ps_uv_code = std::slice::from_raw_parts(ps_uv_blob.GetBufferPointer() as *const u8, ps_uv_blob.GetBufferSize());
            let mut ps_uv = None;
            device.CreatePixelShader(ps_uv_code, None, Some(&mut ps_uv))?;
            let ps_uv = ps_uv.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;

            // Y 渲染目标 R8_UNORM
            let rt_y = create_tex(&device, out_w, out_h, DXGI_FORMAT_R8_UNORM, D3D11_BIND_RENDER_TARGET, D3D11_USAGE_DEFAULT, 0)?;
            let mut rtv_y = None;
            device.CreateRenderTargetView(Some(&rt_y as &ID3D11Resource), None, Some(&mut rtv_y))?;
            let rtv_y = rtv_y.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;

            // UV 渲染目标 R8G8_UNORM（half-res）
            let uv_w = (out_w + 1) / 2;
            let uv_h = (out_h + 1) / 2;
            let rt_uv = create_tex(&device, uv_w, uv_h, DXGI_FORMAT_R8G8_UNORM, D3D11_BIND_RENDER_TARGET, D3D11_USAGE_DEFAULT, 0)?;
            let mut rtv_uv = None;
            device.CreateRenderTargetView(Some(&rt_uv as &ID3D11Resource), None, Some(&mut rtv_uv))?;
            let rtv_uv = rtv_uv.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;

            // Staging ring buffers（GPU→CPU 读回）
            let mut staging_y = Vec::with_capacity(STAGING_COUNT);
            let mut staging_uv = Vec::with_capacity(STAGING_COUNT);
            for _ in 0..STAGING_COUNT {
                staging_y.push(create_tex(&device, out_w, out_h, DXGI_FORMAT_R8_UNORM, D3D11_BIND_FLAG(0), D3D11_USAGE_STAGING, D3D11_CPU_ACCESS_READ.0 as u32)?);
                staging_uv.push(create_tex(&device, uv_w, uv_h, DXGI_FORMAT_R8G8_UNORM, D3D11_BIND_FLAG(0), D3D11_USAGE_STAGING, D3D11_CPU_ACCESS_READ.0 as u32)?);
            }

            let nv12_buf = vec![0u8; (out_w * out_h + out_w * out_h / 2) as usize];

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
                rs,
                out_w,
                out_h,
                in_w,
                in_h,
                broken: false,
                free_slots,
                pending: VecDeque::with_capacity(STAGING_COUNT),
                shared: None,
                ps_y,
                ps_uv,
                rt_y,
                rtv_y,
                staging_y,
                rt_uv,
                rtv_uv,
                staging_uv,
                nv12_buf,
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
        // ★ 必须绑 CULL_NONE：全屏三角在 y 向下屏幕空间是逆时针，默认状态会把它整片剔除
        self.ctx.RSSetState(Some(&self.rs));
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

    /// 把 WGC 帧渲染为 NV12（Y R8 + UV R8G8 half-res），GPU 转换，读回 ~3MB（含 RGB→YUV）。
    /// 返回 `Ok(true)`=nv12 已写入 out_buf；`Ok(false)`=GPU 未就绪。与 `convert` 互斥单帧调用。
    pub fn convert_to_nv12(&mut self, src: &ID3D11Texture2D) -> Result<bool> {
        if self.broken {
            return Err(windows::core::Error::from(windows::Win32::Foundation::E_FAIL));
        }
        // 复用 cross-device shared texture mapping（与 convert() 相同逻辑）
        unsafe {
            let src_ptr = src.as_raw() as usize;
            let need_remap = self.shared.as_ref().map_or(true, |s| s.src_ptr != src_ptr);
            if need_remap {
                let res: IDXGIResource = src.cast().map_err(|e| { self.broken = true; e })?;
                let h = res.GetSharedHandle().map_err(|e| { self.broken = true; e })?;
                let mut shared: Option<ID3D11Texture2D> = None;
                self.device.OpenSharedResource(h, &mut shared).map_err(|e| { self.broken = true; e })?;
                let shared = shared.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
                let km = shared.cast::<IDXGIKeyedMutex>().ok();
                self.shared = Some(SharedFrame { src_ptr, tex: shared, km });
            }
            let shared = &self.shared.as_ref().unwrap().tex;
            let km = self.shared.as_ref().unwrap().km.clone();
            if let Some(km) = &km { let _ = km.AcquireSync(0, 16); }
            self.ctx.CopyResource(Some(&self.input_tex as &ID3D11Resource), Some(shared as &ID3D11Resource));
            if let Some(km) = &km { let _ = km.ReleaseSync(0); }
            self.ctx.Flush();
        }

        // Pass 1: Y (full-res, R8_UNORM)
        unsafe {
            self.set_state();
            self.ctx.OMSetRenderTargets(Some(&[Some(self.rtv_y.clone())]), None);
            self.ctx.RSSetViewports(Some(&[D3D11_VIEWPORT {
                TopLeftX: 0.0, TopLeftY: 0.0, Width: self.out_w as f32, Height: self.out_h as f32,
                MinDepth: 0.0, MaxDepth: 1.0,
            }]));
            self.ctx.VSSetShader(Some(&self.vs), None);
            self.ctx.PSSetShader(Some(&self.ps_y), None);
            self.ctx.PSSetShaderResources(0, Some(&[Some(self.input_srv.clone())]));
            self.ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            self.ctx.Draw(3, 0);
            self.ctx.CopyResource(Some(&self.staging_y[0] as &ID3D11Resource), Some(&self.rt_y as &ID3D11Resource));
        }

        // Pass 2: UV (half-res, R8G8_UNORM)
        let uv_w = (self.out_w + 1) / 2;
        let uv_h = (self.out_h + 1) / 2;
        unsafe {
            self.ctx.OMSetRenderTargets(Some(&[Some(self.rtv_uv.clone())]), None);
            self.ctx.RSSetViewports(Some(&[D3D11_VIEWPORT {
                TopLeftX: 0.0, TopLeftY: 0.0, Width: uv_w as f32, Height: uv_h as f32,
                MinDepth: 0.0, MaxDepth: 1.0,
            }]));
            self.ctx.VSSetShader(Some(&self.vs), None);
            self.ctx.PSSetShader(Some(&self.ps_uv), None);
            self.ctx.PSSetShaderResources(0, Some(&[Some(self.input_srv.clone())]));
            self.ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            self.ctx.Draw(3, 0);
            self.ctx.CopyResource(Some(&self.staging_uv[0] as &ID3D11Resource), Some(&self.rt_uv as &ID3D11Resource));
            self.ctx.Flush();
        }

        // Map readback Y + UV (non-blocking), assemble NV12
        let y_size = (self.out_w * self.out_h) as usize;
        let uv_size = y_size / 2;
        unsafe {
            // Read Y
            let mut m = D3D11_MAPPED_SUBRESOURCE::default();
            match self.ctx.Map(Some(&self.staging_y[0] as &ID3D11Resource), 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32, Some(&mut m)) {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAS_STILL_DRAWING => return Ok(false),
                Err(e) => return Err(e),
            }
            let p = m.pData as *const u8;
            let pitch = m.RowPitch as usize;
            self.nv12_buf.clear();
            self.nv12_buf.reserve(y_size + uv_size);
            for row in 0..self.out_h as usize {
                self.nv12_buf.extend_from_slice(std::slice::from_raw_parts(p.add(row * pitch), self.out_w as usize));
            }
            self.ctx.Unmap(Some(&self.staging_y[0] as &ID3D11Resource), 0);

            // Read UV
            match self.ctx.Map(Some(&self.staging_uv[0] as &ID3D11Resource), 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32, Some(&mut m)) {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAS_STILL_DRAWING => return Ok(false),
                Err(e) => return Err(e),
            }
            let p = m.pData as *const u8;
            let pitch = m.RowPitch as usize;
            for row in 0..uv_h as usize {
                self.nv12_buf.extend_from_slice(std::slice::from_raw_parts(p.add(row * pitch), (uv_w * 2) as usize));
            }
            self.ctx.Unmap(Some(&self.staging_uv[0] as &ID3D11Resource), 0);
        }
        Ok(true)
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
    /// 不做背面剔除的光栅化器状态（见 create_cull_none_rs 的说明：默认状态会把全屏三角整片剔除）
    rs: ID3D11RasterizerState,
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
            let rs = create_cull_none_rs(device)?;

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
                rs,
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
        // ★ 必须绑 CULL_NONE：全屏三角在 y 向下屏幕空间是逆时针，默认状态会把它整片剔除
        self.ctx.RSSetState(Some(&self.rs));
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

// ===========================================================================
// 子进程（ffmpeg 管道）路径的取帧→NV12 策略
// ===========================================================================
//
// 为什么需要：实测（2026-09-21 探针）区域录制 3282x1868 时，WGC 回调每帧耗时均 736ms
// （其中 CPU 最近邻缩放 597ms、阻塞整帧读回 140ms），把捕获拖到 1.1fps：
// 整机卡（回调长期占住帧池、GPU 同步饿死 DWM）+ 输出卡（11 个真实帧被复制成 576 帧）。
// 根因是旧流程「CPU 整帧读回 → 逐像素 f64 最近邻缩放 → 喂 RGBA 给 ffmpeg 再让 ffmpeg
// 做 RGBA→NV12」把全部重活压在捕获回调线程上。
//
// 业界做法（OBS / Windows Game Bar）是：回调里只做「取帧 + GPU 拷贝」，缩放与色彩转换留在
// GPU，编码器直接吃 NV12。下面两个策略即照此实现，二选一（首帧惰性决定，失败自动降级）：
//   1. `GpuSameDeviceNv12Scaler`：同设备 GPU 缩放 + GPU BGRA→NV12，CPU 只读回 ~3MB/帧；
//   2. `CpuNv12Fallback`：GPU 路不可用时的兜底——复用一张 staging 纹理（不再每帧新建 24MB
//      纹理）+ 预计算映射表（去掉每像素 f64 除法）在 CPU 上直接产出 NV12。
// 二者产出的都是 ffmpeg `-pix_fmt nv12` 可直接消费的紧凑 NV12（Y 全分辨率 + UV 半分辨率）。

/// 同设备 NV12 转换/缩放器（子进程路径的主路径）。
///
/// 与 `GpuNv12Converter` 的关键区别：**不做跨设备共享**。WGC 帧纹理默认不带
/// `D3D11_RESOURCE_MISC_SHARED` 标志，`OpenSharedResource` 必然 `0x80070057`（实测本机
/// 第一帧就失败）；而帧纹理与「帧自带 device/context」天然同设备，直接 `CopyResource` +
/// 渲染即可，没有任何共享步骤，因此没有「共享失败」这一失败模式。
///
/// 单帧流程：`CopyResource(input ← WGC帧)` → Pass1 全屏三角形写 Y（R8 全分辨率）→
/// Pass2 写 UV（R8G8 半分辨率）→ 阻塞 `Map` 读回两平面并拼装紧凑 NV12（~3MB@1080p）。
/// `Map` 必须阻塞：它保证 `CopyResource` 已经真正读完 WGC 帧纹理，否则 WGC 归还帧后
/// 该纹理会被下一帧复用，GPU 再读就是脏数据（历史「黑屏/噪点」的成因）。
pub struct GpuSameDeviceNv12Scaler {
    ctx: ID3D11DeviceContext,
    input_tex: ID3D11Texture2D,
    input_srv: ID3D11ShaderResourceView,
    vs: ID3D11VertexShader,
    ps_y: ID3D11PixelShader,
    ps_uv: ID3D11PixelShader,
    sampler: ID3D11SamplerState,
    /// 不做背面剔除的光栅化器状态（见 create_cull_none_rs 的说明：默认状态会把全屏三角整片剔除）
    rs: ID3D11RasterizerState,
    rt_y: ID3D11Texture2D,
    rtv_y: ID3D11RenderTargetView,
    staging_y: ID3D11Texture2D,
    rt_uv: ID3D11Texture2D,
    rtv_uv: ID3D11RenderTargetView,
    staging_uv: ID3D11Texture2D,
    out_w: u32,
    out_h: u32,
    broken: bool,
    /// 仅前几帧做全零检测（真实黑屏画面不该永久禁用 GPU 路）
    ok_frames: u32,
    /// 诊断：判死时的细节（如全零样本），供调用方写入探针日志
    pub last_fail_detail: String,
}

impl GpuSameDeviceNv12Scaler {
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
            let crop_norm = crop.map(|(cx, cy, cw, ch)| {
                (
                    cx as f32 / in_w as f32,
                    cy as f32 / in_h as f32,
                    (cw as f32).max(1.0) / in_w as f32,
                    (ch as f32).max(1.0) / in_h as f32,
                )
            });
            let mut vs_blob = None;
            compile_hlsl(VS_HLSL, "VS", "vs_4_0", &mut vs_blob)?;
            let mut ps_y_blob = None;
            compile_hlsl(&build_ps_y(crop_norm, bgra), "PS", "ps_4_0", &mut ps_y_blob)?;
            let mut ps_uv_blob = None;
            compile_hlsl(
                &build_ps_uv(crop_norm, bgra, in_w, in_h),
                "PS",
                "ps_4_0",
                &mut ps_uv_blob,
            )?;
            let vs_code = std::slice::from_raw_parts(
                vs_blob.as_ref().unwrap().GetBufferPointer() as *const u8,
                vs_blob.as_ref().unwrap().GetBufferSize(),
            );
            let mut vs = None;
            device.CreateVertexShader(vs_code, None, Some(&mut vs))?;
            let vs = vs.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
            let ps_y_code = std::slice::from_raw_parts(
                ps_y_blob.as_ref().unwrap().GetBufferPointer() as *const u8,
                ps_y_blob.as_ref().unwrap().GetBufferSize(),
            );
            let mut ps_y = None;
            device.CreatePixelShader(ps_y_code, None, Some(&mut ps_y))?;
            let ps_y =
                ps_y.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
            let ps_uv_code = std::slice::from_raw_parts(
                ps_uv_blob.as_ref().unwrap().GetBufferPointer() as *const u8,
                ps_uv_blob.as_ref().unwrap().GetBufferSize(),
            );
            let mut ps_uv = None;
            device.CreatePixelShader(ps_uv_code, None, Some(&mut ps_uv))?;
            let ps_uv =
                ps_uv.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;

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

            // Y 平面：全分辨率 R8
            let rt_y = create_tex(
                device,
                out_w,
                out_h,
                DXGI_FORMAT_R8_UNORM,
                D3D11_BIND_RENDER_TARGET,
                D3D11_USAGE_DEFAULT,
                0,
            )?;
            let mut rtv_y = None;
            device.CreateRenderTargetView(&rt_y, None, Some(&mut rtv_y))?;
            let rtv_y =
                rtv_y.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
            let staging_y = create_tex(
                device,
                out_w,
                out_h,
                DXGI_FORMAT_R8_UNORM,
                D3D11_BIND_FLAG(0),
                D3D11_USAGE_STAGING,
                D3D11_CPU_ACCESS_READ.0 as u32,
            )?;

            // UV 平面：半分辨率 R8G8
            let uv_w = (out_w + 1) / 2;
            let uv_h = (out_h + 1) / 2;
            let rt_uv = create_tex(
                device,
                uv_w,
                uv_h,
                DXGI_FORMAT_R8G8_UNORM,
                D3D11_BIND_RENDER_TARGET,
                D3D11_USAGE_DEFAULT,
                0,
            )?;
            let mut rtv_uv = None;
            device.CreateRenderTargetView(&rt_uv, None, Some(&mut rtv_uv))?;
            let rtv_uv =
                rtv_uv.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
            let staging_uv = create_tex(
                device,
                uv_w,
                uv_h,
                DXGI_FORMAT_R8G8_UNORM,
                D3D11_BIND_FLAG(0),
                D3D11_USAGE_STAGING,
                D3D11_CPU_ACCESS_READ.0 as u32,
            )?;

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
            let rs = create_cull_none_rs(device)?;

            Ok(Self {
                ctx: ctx.clone(),
                input_tex,
                input_srv,
                vs,
                ps_y,
                ps_uv,
                sampler,
                rs,
                rt_y,
                rtv_y,
                staging_y,
                rt_uv,
                rtv_uv,
                staging_uv,
                out_w,
                out_h,
                broken: false,
                ok_frames: 0,
                last_fail_detail: String::new(),
            })
        }
    }

    /// 一帧：`src` 为本设备上的 WGC 帧纹理。
    /// `Ok(true)`=out 写入一帧紧凑 NV12；`Ok(false)`=GPU 未就绪（本帧无产出，复用上一帧）。
    pub fn convert(&mut self, src: &ID3D11Texture2D, out: &mut Vec<u8>) -> Result<bool> {
        if self.broken {
            return Err(windows::core::Error::from(windows::Win32::Foundation::E_FAIL));
        }
        let uv_w = (self.out_w + 1) / 2;
        let uv_h = (self.out_h + 1) / 2;
        unsafe {
            // 同设备直拷（帧纹理与 input_tex 同尺寸同格式）
            self.ctx.CopyResource(
                Some(&self.input_tex as &ID3D11Resource),
                Some(src as &ID3D11Resource),
            );
            self.set_state();

            // Pass 1：Y（全分辨率）
            self.ctx
                .OMSetRenderTargets(Some(&[Some(self.rtv_y.clone())]), None);
            self.ctx.RSSetViewports(Some(&[D3D11_VIEWPORT {
                TopLeftX: 0.0,
                TopLeftY: 0.0,
                Width: self.out_w as f32,
                Height: self.out_h as f32,
                MinDepth: 0.0,
                MaxDepth: 1.0,
            }]));
            self.ctx.VSSetShader(Some(&self.vs), None);
            self.ctx.PSSetShader(Some(&self.ps_y), None);
            self.ctx
                .PSSetShaderResources(0, Some(&[Some(self.input_srv.clone())]));
            self.ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            self.ctx.Draw(3, 0);
            self.ctx.CopyResource(
                Some(&self.staging_y as &ID3D11Resource),
                Some(&self.rt_y as &ID3D11Resource),
            );

            // Pass 2：UV（半分辨率）
            self.ctx
                .OMSetRenderTargets(Some(&[Some(self.rtv_uv.clone())]), None);
            self.ctx.RSSetViewports(Some(&[D3D11_VIEWPORT {
                TopLeftX: 0.0,
                TopLeftY: 0.0,
                Width: uv_w as f32,
                Height: uv_h as f32,
                MinDepth: 0.0,
                MaxDepth: 1.0,
            }]));
            self.ctx.VSSetShader(Some(&self.vs), None);
            self.ctx.PSSetShader(Some(&self.ps_uv), None);
            self.ctx.Draw(3, 0);
            self.ctx.CopyResource(
                Some(&self.staging_uv as &ID3D11Resource),
                Some(&self.rt_uv as &ID3D11Resource),
            );
            self.ctx.Flush();

            let y_size = (self.out_w * self.out_h) as usize;
            let uv_size = y_size / 2;
            out.clear();
            out.reserve(y_size + uv_size);

            // 阻塞 Map：保证 CopyResource 已真正读完 WGC 帧纹理（WGC 随即复用该纹理）
            let mut m = D3D11_MAPPED_SUBRESOURCE::default();
            self.ctx
                .Map(
                    Some(&self.staging_y as &ID3D11Resource),
                    0,
                    D3D11_MAP_READ,
                    0,
                    Some(&mut m),
                )
                .map_err(|e| {
                    self.broken = true;
                    e
                })?;
            let p = m.pData as *const u8;
            let pitch = m.RowPitch as usize;
            for row in 0..self.out_h as usize {
                out.extend_from_slice(std::slice::from_raw_parts(
                    p.add(row * pitch),
                    self.out_w as usize,
                ));
            }
            self.ctx.Unmap(Some(&self.staging_y as &ID3D11Resource), 0);

            let mut m2 = D3D11_MAPPED_SUBRESOURCE::default();
            self.ctx
                .Map(
                    Some(&self.staging_uv as &ID3D11Resource),
                    0,
                    D3D11_MAP_READ,
                    0,
                    Some(&mut m2),
                )
                .map_err(|e| {
                    self.broken = true;
                    e
                })?;
            let p2 = m2.pData as *const u8;
            let pitch2 = m2.RowPitch as usize;
            for row in 0..uv_h as usize {
                out.extend_from_slice(std::slice::from_raw_parts(
                    p2.add(row * pitch2),
                    (uv_w * 2) as usize,
                ));
            }
            self.ctx
                .Unmap(Some(&self.staging_uv as &ID3D11Resource), 0);

            // 仅前 3 帧做全零检测：全零说明渲染管线静默失效（历史「渲染命令被丢弃」故障），
            // 立即判死并让调用方永久回退 CPU 兜底；此后黑屏内容属正常画面，不误杀。
            // 注：真·黑屏画面在 BT.709 limited 下是 Y=16 / UV=128，绝非全零 → 全零必然是「Draw 没跑」
            // 或「staging 未被写入」，故该判据不会误杀（调用方会用 err_text 把首字节样本记入探针日志）。
            if self.ok_frames < 3 && out.iter().all(|&b| b == 0) {
                let y_size = (self.out_w * self.out_h) as usize;
                self.last_fail_detail = format!(
                    "全零自检未过（Draw 疑似被丢弃）：Y首字节={:?} UV首字节={:?} 已产出帧数={}",
                    &out[..8.min(out.len())],
                    &out[y_size.min(out.len())..(y_size + 8).min(out.len())],
                    self.ok_frames
                );
                self.broken = true;
                return Err(windows::core::Error::from(windows::Win32::Foundation::E_FAIL));
            }
            self.ok_frames = self.ok_frames.saturating_add(1);
            Ok(true)
        }
    }

    #[inline]
    unsafe fn set_state(&self) {
        self.ctx.IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        self.ctx.IASetInputLayout(None);
        self.ctx.GSSetShader(None, None);
        // ★ 必须绑 CULL_NONE：全屏三角在 y 向下屏幕空间是逆时针，默认状态会把它整片剔除
        self.ctx.RSSetState(Some(&self.rs));
        self.ctx.OMSetBlendState(None, None, u32::MAX);
        self.ctx.OMSetDepthStencilState(None, 0);
    }
}

/// GPU 路不可用时的 CPU 兜底：**仍产出 NV12**（与 GPU 路格式一致，ffmpeg 端参数无需切换），
/// 但把旧实现的两处灾难性开销去掉：
/// 1. 不再每帧调用 `frame.buffer()`（其内部每帧新建一张 24MB staging 纹理 + 阻塞 Map）——
///    改为自持一张复用 staging 纹理，只 CopyResource + Map；
/// 2. 不再每像素做 f64 除法——改用启动时预计算的最近邻映射表（xmap/ymap），每帧只查表；
/// 并在同一次遍历里融合写 Y 与 UV（避免两遍扫描与中间 RGBA 缓冲）。
pub struct CpuNv12Fallback {
    ctx: ID3D11DeviceContext,
    staging: ID3D11Texture2D,
    out_w: u32,
    out_h: u32,
    /// 输出 x/y → 源坐标的最近邻映射（含裁剪偏移），整段录制期间不变
    xmap: Vec<u32>,
    ymap: Vec<u32>,
    /// 源像素 RGBA 字节序偏移（BGRA=红在 2，RGBA=红在 0）
    r_off: usize,
    g_off: usize,
    b_off: usize,
    /// 诊断：上一帧「阻塞 Map 读回」耗时（μs）——定位 GPU 同步是否才是真凶
    pub last_map_us: u64,
    /// 诊断：上一帧「查表 + Y/UV 转换循环」耗时（μs）——未优化构建下这段会非常慢
    pub last_loop_us: u64,
}

impl CpuNv12Fallback {
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
            let staging = create_tex(
                device,
                in_w,
                in_h,
                input_fmt,
                D3D11_BIND_FLAG(0),
                D3D11_USAGE_STAGING,
                D3D11_CPU_ACCESS_READ.0 as u32,
            )?;
            let (ox, oy, cw, ch) = match crop {
                Some((cx, cy, cw, ch)) => (
                    (cx as usize).min(in_w as usize),
                    (cy as usize).min(in_h as usize),
                    (cw as usize).min((in_w as usize).saturating_sub((cx as usize).min(in_w as usize))),
                    (ch as usize).min((in_h as usize).saturating_sub((cy as usize).min(in_h as usize))),
                ),
                None => (0, 0, in_w as usize, in_h as usize),
            };
            let dw = out_w.max(1) as usize;
            let dh = out_h.max(1) as usize;
            let cw = cw.max(1);
            let ch = ch.max(1);
            // 最近邻映射：与旧 rgba_resize_crop_nearest 的取点规则一致（格心对齐），但不含除法
            let xmap = (0..dw)
                .map(|x| {
                    let fx = (x as f64 + 0.5) / dw as f64;
                    ((ox as f64 + fx * cw as f64).floor() as usize).min(in_w as usize - 1) as u32
                })
                .collect();
            let ymap = (0..dh)
                .map(|y| {
                    let fy = (y as f64 + 0.5) / dh as f64;
                    ((oy as f64 + fy * ch as f64).floor() as usize).min(in_h as usize - 1) as u32
                })
                .collect();
            let (r_off, g_off, b_off) = if input_fmt == DXGI_FORMAT_B8G8R8A8_UNORM
                || input_fmt == DXGI_FORMAT_B8G8R8A8_UNORM_SRGB
                || input_fmt == DXGI_FORMAT_B8G8R8X8_UNORM
            {
                (2usize, 1usize, 0usize)
            } else {
                (0usize, 1usize, 2usize)
            };
            Ok(Self {
                ctx: ctx.clone(),
                staging,
                out_w,
                out_h,
                xmap,
                ymap,
                r_off,
                g_off,
                b_off,
                last_map_us: 0,
                last_loop_us: 0,
            })
        }
    }

    /// 一帧：`src` 为本设备上的 WGC 帧纹理，`out` 收到紧凑 NV12（Y 全分辨率 + UV 半分辨率）。
    pub fn convert(&mut self, src: &ID3D11Texture2D, out: &mut Vec<u8>) -> Result<bool> {
        let dw = self.out_w as usize;
        let dh = self.out_h as usize;
        if dw == 0 || dh == 0 || dw % 2 != 0 || dh % 2 != 0 {
            return Err(windows::core::Error::from(windows::Win32::Foundation::E_INVALIDARG));
        }
        unsafe {
            self.ctx.CopyResource(
                Some(&self.staging as &ID3D11Resource),
                Some(src as &ID3D11Resource),
            );
            let t_map = std::time::Instant::now();
            let mut m = D3D11_MAPPED_SUBRESOURCE::default();
            // 阻塞 Map：既是读回，也保证 CopyResource 已读完 WGC 帧纹理
            self.ctx
                .Map(
                    Some(&self.staging as &ID3D11Resource),
                    0,
                    D3D11_MAP_READ,
                    0,
                    Some(&mut m),
                )?;
            let base = m.pData as *const u8;
            let pitch = m.RowPitch as usize;
            self.last_map_us = t_map.elapsed().as_micros() as u64;
            let y_size = dw * dh;
            let uv_size = y_size / 2;
            out.clear();
            out.resize(y_size + uv_size, 0);
            let (y_plane, uv_plane) = out.split_at_mut(y_size);
            let (r_off, g_off, b_off) = (self.r_off, self.g_off, self.b_off);
            // 按 2x2 输出块遍历：一次取足 4 个源像素 → 写 4 个 Y 与 1 个 UV（BT.709 limited，
            // 与 GPU 着色器 / 进程内编码器 feed_rgba 的系数完全一致，三条路径颜色统一）
            for by in 0..dh / 2 {
                let sy0 = self.ymap[by * 2] as usize;
                let sy1 = self.ymap[by * 2 + 1] as usize;
                let row0 = base.add(sy0 * pitch);
                let row1 = base.add(sy1 * pitch);
                let y_row0 = by * 2 * dw;
                let y_row1 = (by * 2 + 1) * dw;
                for bx in 0..dw / 2 {
                    let sx0 = self.xmap[bx * 2] as usize;
                    let sx1 = self.xmap[bx * 2 + 1] as usize;
                    let mut rs = 0i32;
                    let mut gs = 0i32;
                    let mut bs = 0i32;
                    for (row, sx, y_row, y_col) in [
                        (row0, sx0, y_row0, bx * 2),
                        (row0, sx1, y_row0, bx * 2 + 1),
                        (row1, sx0, y_row1, bx * 2),
                        (row1, sx1, y_row1, bx * 2 + 1),
                    ] {
                        let p = row.add(sx * 4);
                        let r = *p.add(r_off) as i32;
                        let g = *p.add(g_off) as i32;
                        let b = *p.add(b_off) as i32;
                        rs += r;
                        gs += g;
                        bs += b;
                        let yv = ((47 * r + 157 * g + 16 * b + 128) >> 8) + 16;
                        y_plane[y_row + y_col] = clamp_u8(yv);
                    }
                    let r = rs >> 2;
                    let g = gs >> 2;
                    let b = bs >> 2;
                    let u = ((-26 * r - 87 * g + 112 * b + 128) >> 8) + 128;
                    let v = ((112 * r - 102 * g - 10 * b + 128) >> 8) + 128;
                    let o = (by * (dw / 2) + bx) * 2;
                    uv_plane[o] = clamp_u8(u);
                    uv_plane[o + 1] = clamp_u8(v);
                }
            }
            self.ctx.Unmap(Some(&self.staging as &ID3D11Resource), 0);
            // t_map 起于 Map 之前，此刻 elapsed = Map 阻塞 + 转换循环；减去 Map 即得循环耗时
            self.last_loop_us =
                (t_map.elapsed().as_micros() as u64).saturating_sub(self.last_map_us);
            Ok(true)
        }
    }
}

#[inline]
fn clamp_u8(v: i32) -> u8 {
    v.clamp(0, 255) as u8
}

/// **功能级** NV12 渲染自检：真正塞一帧纯红进去，跑完整「GPU 缩放 + BT.709 色彩转换」，
/// 检查产出的 Y/UV 是否为纯红应有的值。
///
/// 与 `probe_nv12` 的关键区别：后者只验证 `GpuNv12Converter::new` **构造成功**（着色器能编译、
/// 纹理能创建），完全不能证明 `Draw` 真的写出了像素。本机历史上多次出现「构造成功但产出全零
/// （渲染命令被静默丢弃）」的失败，只有功能级自检能抓到——这也是为什么横幅里的
/// 「GPU 转换器探针 通过」曾长期给人「GPU 路可用」的错误安全感。
///
/// 纯红 (255,0,0,255) 在 BT.709 limited 下的期望值：Y≈63、U≈102、V≈240；
/// 若三者全 0，即可判定 Draw 未写出（设备或管线问题），而非画面本身是黑的。
pub(crate) fn probe_nv12_render_functional() -> String {
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
            return "❌ 自检失败：D3D11CreateDevice 失败".into();
        }
        let (dev, ctx) = match (dev, ctx) {
            (Some(d), Some(c)) => (d, c),
            _ => return "❌ 自检失败：设备/上下文为空".into(),
        };

        // 纯红 64x64 源纹理
        let (fw, fh) = (64u32, 64u32);
        let mut pixels = vec![0u8; (fw * fh * 4) as usize];
        for px in pixels.chunks_exact_mut(4) {
            px.copy_from_slice(&[255, 0, 0, 255]);
        }
        let src = match create_tex(
            &dev,
            fw,
            fh,
            DXGI_FORMAT_R8G8B8A8_UNORM,
            D3D11_BIND_SHADER_RESOURCE,
            D3D11_USAGE_DEFAULT,
            0,
        ) {
            Ok(t) => t,
            Err(e) => return format!("❌ 自检失败：源纹理创建失败 {e}"),
        };
        ctx.UpdateSubresource(
            Some(&src as &ID3D11Resource),
            0,
            None,
            pixels.as_ptr() as *const core::ffi::c_void,
            fw * 4,
            0,
        );

        let mut scaler = match GpuSameDeviceNv12Scaler::new(
            &dev,
            &ctx,
            fw,
            fh,
            fw,
            fh,
            DXGI_FORMAT_R8G8B8A8_UNORM,
            None,
        ) {
            Ok(s) => s,
            Err(e) => return format!("❌ 自检失败：缩放器创建失败 {e:?}"),
        };
        let mut out: Vec<u8> = Vec::new();
        match scaler.convert(&src, &mut out) {
            Ok(true) => {
                let y = out.first().copied().unwrap_or(0);
                let uv_off = (fw * fh) as usize;
                let u = out.get(uv_off).copied().unwrap_or(0);
                let v = out.get(uv_off + 1).copied().unwrap_or(0);
                let ok = y.abs_diff(63) <= 6 && u.abs_diff(102) <= 6 && v.abs_diff(240) <= 6;
                format!(
                    "{} 功能性自检：Y={} U={} V={}（期望 Y≈63 U≈102 V≈240）",
                    if ok { "✅" } else { "❌" },
                    y, u, v
                )
            }
            Ok(false) => "❌ 自检失败：GPU 未就绪（Ok(false)）".into(),
            Err(e) => format!("❌ 自检失败：convert 报错 {e:?}"),
        }
    }
}

#[cfg(test)]
mod nv12_pipeline_tests {
    use super::*;

    /// 进一步隔离：Draw 到底卡在「顶点/光栅化/状态」还是「采样 SRV」。
    ///
    /// 阶段 2 已证明「Clear → R8 RT → staging → Map」链路正常，阶段 3 证明整条 Draw 写不出像素。
    /// 本测试用**不采样的常量 PS** 与**采样 PS** 对比，把问题锁进更小的一环；
    /// 并尝试开 D3D11 调试层（若系统装了 Graphics Tools）直接读出官方报错。
    #[test]
    fn nv12_draw_isolation() {
        const PS_CONST: &str = r#"
float4 PS(float4 pos : SV_Position, float2 uv : TEXCOORD0) : SV_Target {
    return float4(0.25, 0, 0, 1);
}
"#;
        unsafe {
            // 优先带调试层创建设备（拿得到官方报错就一次定位）
            let mut dev = None;
            let mut ctx = None;
            let dbg_ok = D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_DEBUG,
                Some(&[D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1]),
                D3D11_SDK_VERSION,
                Some(&mut dev),
                None,
                Some(&mut ctx),
            )
            .is_ok();
            if !dbg_ok {
                println!("[隔离] 调试层不可用（未装 Graphics Tools），退化为普通设备");
                D3D11CreateDevice(
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
                .expect("create device");
            }
            let dev = dev.unwrap();
            let ctx = ctx.unwrap();
            let (fw, fh) = (64u32, 64u32);

            // 源纹理（纯红）+ R8 RT + staging
            let src = create_tex(
                &dev,
                fw,
                fh,
                DXGI_FORMAT_R8G8B8A8_UNORM,
                D3D11_BIND_SHADER_RESOURCE,
                D3D11_USAGE_DEFAULT,
                0,
            )
            .unwrap();
            let mut px = vec![0u8; (fw * fh * 4) as usize];
            for c in px.chunks_exact_mut(4) {
                c.copy_from_slice(&[255, 0, 0, 255]);
            }
            ctx.UpdateSubresource(
                Some(&src as &ID3D11Resource),
                0,
                None,
                px.as_ptr() as *const core::ffi::c_void,
                fw * 4,
                0,
            );
            let mut srv = None;
            dev.CreateShaderResourceView(&src, None, Some(&mut srv))
                .unwrap();
            let srv = srv.unwrap();
            let rt = create_tex(
                &dev,
                fw,
                fh,
                DXGI_FORMAT_R8_UNORM,
                D3D11_BIND_RENDER_TARGET,
                D3D11_USAGE_DEFAULT,
                0,
            )
            .unwrap();
            let mut rtv = None;
            dev.CreateRenderTargetView(&rt, None, Some(&mut rtv)).unwrap();
            let rtv = rtv.unwrap();
            let stg = create_tex(
                &dev,
                fw,
                fh,
                DXGI_FORMAT_R8_UNORM,
                D3D11_BIND_FLAG(0),
                D3D11_USAGE_STAGING,
                D3D11_CPU_ACCESS_READ.0 as u32,
            )
            .unwrap();

            let mut vs_blob = None;
            compile_hlsl(VS_HLSL, "VS", "vs_4_0", &mut vs_blob).expect("编译 VS");
            let vs_blob = vs_blob.unwrap();
            let mut vs = None;
            dev.CreateVertexShader(
                std::slice::from_raw_parts(
                    vs_blob.GetBufferPointer() as *const u8,
                    vs_blob.GetBufferSize(),
                ),
                None,
                Some(&mut vs),
            )
            .expect("CreateVertexShader");
            let vs = vs.unwrap();

            let mut ps_blob = None;
            compile_hlsl(PS_CONST, "PS", "ps_4_0", &mut ps_blob).expect("编译常量 PS");
            let ps_blob = ps_blob.unwrap();
            let mut ps_const = None;
            dev.CreatePixelShader(
                std::slice::from_raw_parts(
                    ps_blob.GetBufferPointer() as *const u8,
                    ps_blob.GetBufferSize(),
                ),
                None,
                Some(&mut ps_const),
            )
            .expect("CreatePixelShader(常量)");
            let ps_const = ps_const.unwrap();

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
            dev.CreateSamplerState(&sd, Some(&mut sampler)).unwrap();
            let sampler = sampler.unwrap();

            // ★ 假设：全屏三角形在 y 向下的屏幕空间是逆时针，而默认光栅化器状态
            //   （CullMode=BACK + FrontCounterClockwise=FALSE）只保留顺时针 → 整三角形被剔除。
            //   绑一个 CULL_NONE 的光栅化器状态对照验证。
            let rsd = D3D11_RASTERIZER_DESC {
                FillMode: D3D11_FILL_SOLID,
                CullMode: D3D11_CULL_NONE,
                FrontCounterClockwise: false.into(),
                DepthBias: 0,
                DepthBiasClamp: 0.0,
                SlopeScaledDepthBias: 0.0,
                DepthClipEnable: true.into(),
                ScissorEnable: false.into(),
                MultisampleEnable: false.into(),
                AntialiasedLineEnable: false.into(),
            };
            let mut rs_none = None;
            dev.CreateRasterizerState(&rsd, Some(&mut rs_none))
                .expect("CreateRasterizerState(CULL_NONE)");
            let rs_none = rs_none.unwrap();
            println!("[隔离] 已创建 CULL_NONE 光栅化器状态，下一步用它与默认状态对照");

            // 与 scaler 完全一致的状态设置 + Draw
            let draw_and_read = |ps: &ID3D11PixelShader, bind_srv: bool| -> u8 {
                ctx.ClearRenderTargetView(Some(&rtv), &[0.0f32, 0.0, 0.0, 1.0]);
                ctx.IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
                ctx.IASetInputLayout(None);
                ctx.GSSetShader(None, None);
                ctx.RSSetState(None);
                ctx.OMSetBlendState(None, None, u32::MAX);
                ctx.OMSetDepthStencilState(None, 0);
                ctx.OMSetRenderTargets(Some(&[Some(rtv.clone())]), None);
                ctx.RSSetViewports(Some(&[D3D11_VIEWPORT {
                    TopLeftX: 0.0,
                    TopLeftY: 0.0,
                    Width: fw as f32,
                    Height: fh as f32,
                    MinDepth: 0.0,
                    MaxDepth: 1.0,
                }]));
                ctx.VSSetShader(Some(&vs), None);
                ctx.PSSetShader(Some(ps), None);
                if bind_srv {
                    ctx.PSSetShaderResources(0, Some(&[Some(srv.clone())]));
                    ctx.PSSetSamplers(0, Some(&[Some(sampler.clone())]));
                }
                ctx.Draw(3, 0);
                // 读回管线状态：Draw 写不出像素最常见的原因就是「视口为空」（Clear 不需要视口，
                // 故 Clear 正常而 Draw 全无输出时，第一嫌疑就是这里）
                // ⚠️ pNumViewports 是「入参=调用方提供的数组容量 / 出参=实际视口数」，
// 入参必须传 1（我们的容量），传 0 会拿不到真实数量（踩过一次，误判「视口=0」）。
                let mut nvp: u32 = 1;
                let mut vp_out = D3D11_VIEWPORT::default();
                ctx.RSGetViewports(&mut nvp, Some(&mut vp_out));
                let mut rts: [Option<ID3D11RenderTargetView>; 1] = [None];
                ctx.OMGetRenderTargets(Some(&mut rts), None);
                let nrt = if rts[0].is_some() { 1 } else { 0 };
                println!(
                    "[隔离] 管线状态：视口数={nvp} 视口={}x{} 绑定RTV数={nrt} 拓扑/输入布局已设",
                    vp_out.Width, vp_out.Height
                );
                ctx.CopyResource(
                    Some(&stg as &ID3D11Resource),
                    Some(&rt as &ID3D11Resource),
                );
                let mut m = D3D11_MAPPED_SUBRESOURCE::default();
                ctx.Map(
                    Some(&stg as &ID3D11Resource),
                    0,
                    D3D11_MAP_READ,
                    0,
                    Some(&mut m),
                )
                .expect("map");
                let v = *(m.pData as *const u8);
                ctx.Unmap(Some(&stg as &ID3D11Resource), 0);
                v
            };

            let a = draw_and_read(&ps_const, false);
            println!("[隔离] 常量 PS（不采样）→ 首字节={a}（期望 ≈64；0 = 光栅化/状态环节有问题）");
            if dbg_ok {
                dump_d3d_debug_messages(&dev, "常量 PS Draw 之后");
            }
            let b = draw_and_read(&ps_const, true);
            println!("[隔离] 常量 PS（绑 SRV）→ 首字节={b}（应与上一行相同；不同说明 SRV 绑定有副作用）");

            // ★ 对照实验：绑 CULL_NONE 光栅化器状态后再画一次（其余完全不变）
            ctx.ClearRenderTargetView(Some(&rtv), &[0.0f32, 0.0, 0.0, 1.0]);
            ctx.IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            ctx.IASetInputLayout(None);
            ctx.GSSetShader(None, None);
            ctx.RSSetState(Some(&rs_none)); // ← 唯一的差异
            ctx.OMSetBlendState(None, None, u32::MAX);
            ctx.OMSetDepthStencilState(None, 0);
            ctx.OMSetRenderTargets(Some(&[Some(rtv.clone())]), None);
            ctx.RSSetViewports(Some(&[D3D11_VIEWPORT {
                TopLeftX: 0.0,
                TopLeftY: 0.0,
                Width: fw as f32,
                Height: fh as f32,
                MinDepth: 0.0,
                MaxDepth: 1.0,
            }]));
            ctx.VSSetShader(Some(&vs), None);
            ctx.PSSetShader(Some(&ps_const), None);
            ctx.Draw(3, 0);
            ctx.CopyResource(
                Some(&stg as &ID3D11Resource),
                Some(&rt as &ID3D11Resource),
            );
            let mut m4 = D3D11_MAPPED_SUBRESOURCE::default();
            ctx.Map(
                Some(&stg as &ID3D11Resource),
                0,
                D3D11_MAP_READ,
                0,
                Some(&mut m4),
            )
            .expect("map cullnone");
            let c = *(m4.pData as *const u8);
            ctx.Unmap(Some(&stg as &ID3D11Resource), 0);
            println!(
                "[隔离] ★ 常量 PS + CULL_NONE → 首字节={c}（期望 ≈64；若此处变 64 → 确认根因是背面剔除）"
            );

            // ── 追加诊断：读回 IA/VS/PS 关键状态 + 换 RGBA8 渲染目标对照 ──
            let topo = ctx.IAGetPrimitiveTopology();
            let mut vs_out: Option<ID3D11VertexShader> = None;
            let mut nci_vs = 0u32;
            ctx.VSGetShader(&mut vs_out, None, Some(&mut nci_vs));
            let mut ps_out: Option<ID3D11PixelShader> = None;
            let mut nci_ps = 0u32;
            ctx.PSGetShader(&mut ps_out, None, Some(&mut nci_ps));
            let has_il = ctx.IAGetInputLayout().is_ok();
            println!(
                "[隔离] 状态读回：拓扑={}（TRIANGLELIST=4）VS已绑={} PS已绑={} 输入布局={}",
                topo.0,
                vs_out.is_some(),
                ps_out.is_some(),
                has_il
            );

            // 换 RGBA8 渲染目标再画一次：区分「R8 格式不支持被 PS 写入」与「几何/光栅化问题」
            let rt2 = create_tex(
                &dev,
                fw,
                fh,
                DXGI_FORMAT_R8G8B8A8_UNORM,
                D3D11_BIND_RENDER_TARGET,
                D3D11_USAGE_DEFAULT,
                0,
            )
            .unwrap();
            let mut rtv2 = None;
            dev.CreateRenderTargetView(&rt2, None, Some(&mut rtv2)).unwrap();
            let rtv2 = rtv2.unwrap();
            let stg2 = create_tex(
                &dev,
                fw,
                fh,
                DXGI_FORMAT_R8G8B8A8_UNORM,
                D3D11_BIND_FLAG(0),
                D3D11_USAGE_STAGING,
                D3D11_CPU_ACCESS_READ.0 as u32,
            )
            .unwrap();
            ctx.ClearRenderTargetView(Some(&rtv2), &[0.0f32, 0.0, 0.0, 1.0]);
            ctx.IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            ctx.IASetInputLayout(None);
            ctx.GSSetShader(None, None);
            ctx.RSSetState(None);
            ctx.OMSetBlendState(None, None, u32::MAX);
            ctx.OMSetDepthStencilState(None, 0);
            ctx.OMSetRenderTargets(Some(&[Some(rtv2.clone())]), None);
            ctx.RSSetViewports(Some(&[D3D11_VIEWPORT {
                TopLeftX: 0.0,
                TopLeftY: 0.0,
                Width: fw as f32,
                Height: fh as f32,
                MinDepth: 0.0,
                MaxDepth: 1.0,
            }]));
            ctx.VSSetShader(Some(&vs), None);
            ctx.PSSetShader(Some(&ps_const), None);
            ctx.Draw(3, 0);
            ctx.CopyResource(
                Some(&stg2 as &ID3D11Resource),
                Some(&rt2 as &ID3D11Resource),
            );
            let mut m3 = D3D11_MAPPED_SUBRESOURCE::default();
            ctx.Map(
                Some(&stg2 as &ID3D11Resource),
                0,
                D3D11_MAP_READ,
                0,
                Some(&mut m3),
            )
            .expect("map rgba");
            println!(
                "[隔离] 常量 PS → RGBA8 渲染目标 首像素={:?}（期望 ≈[64,0,0,255]；若此处有值而 R8 为 0 → 是 R8 格式问题）",
                &std::slice::from_raw_parts(m3.pData as *const u8, 4)
            );
            ctx.Unmap(Some(&stg2 as &ID3D11Resource), 0);
        }
    }

    /// 打印 D3D11 调试层里已累积的消息（能直接看到 Draw 为何被丢弃）
    unsafe fn dump_d3d_debug_messages(dev: &ID3D11Device, when: &str) {
        let iq: ID3D11InfoQueue = match dev.cast() {
            Ok(q) => q,
            Err(_) => {
                println!("[调试层] 无法获取 ID3D11InfoQueue");
                return;
            }
        };
        let n = iq.GetNumStoredMessages();
        println!("[调试层] {when}: 共 {n} 条消息");
        for i in 0..n.min(12) {
            let mut msg = D3D11_MESSAGE::default();
            let mut len = 0usize;
            if iq.GetMessage(i, Some(&mut msg), &mut len).is_err() {
                continue;
            }
            let text = if msg.pDescription.is_null() {
                String::new()
            } else {
                String::from_utf8_lossy(std::slice::from_raw_parts(
                    msg.pDescription as *const u8,
                    msg.DescriptionByteLength,
                ))
                .trim_end_matches('\0')
                .to_string()
            };
            println!("[调试层] #{}: {}", i, text);
        }
        iq.ClearStoredMessages();
    }

    /// 渲染管线**逐阶段二分**：把「源数据→拷贝→Map」「Clear→R8 渲染目标→staging→Map」
    /// 「完整 VS+PS Draw」三段分开验证，定位全零发生在哪一环。
    ///
    /// 背景：功能性自检发现，即便在**我们自己新建的设备**上、喂纯红源纹理，
    /// `convert` 产出的 Y/UV 也是全零 → 说明「windows-capture 设备不能渲染」是误判，
    /// 真正的问题在这段渲染代码里。本测试就是为它准备的可重复、可离线的调试入口。
    ///
    /// 运行：`cargo test -p andeyunhui --lib nv12_pipeline -- --nocapture`
    #[test]
    fn nv12_pipeline_stage_bisect() {
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
                println!("[二分] 无法创建设备（测试环境不支持 D3D11）");
                return;
            }
            let dev = dev.unwrap();
            let ctx = ctx.unwrap();
            let (fw, fh) = (64u32, 64u32);

            // ── 阶段 1：源纹理填充 → staging → Map（验证「写入源 + 拷贝 + 读回」链路）──
            let src = create_tex(
                &dev,
                fw,
                fh,
                DXGI_FORMAT_R8G8B8A8_UNORM,
                D3D11_BIND_SHADER_RESOURCE,
                D3D11_USAGE_DEFAULT,
                0,
            )
            .expect("源纹理");
            let mut px = vec![0u8; (fw * fh * 4) as usize];
            for c in px.chunks_exact_mut(4) {
                c.copy_from_slice(&[255, 0, 0, 255]);
            }
            ctx.UpdateSubresource(
                Some(&src as &ID3D11Resource),
                0,
                None,
                px.as_ptr() as *const core::ffi::c_void,
                fw * 4,
                0,
            );
            let stg = create_tex(
                &dev,
                fw,
                fh,
                DXGI_FORMAT_R8G8B8A8_UNORM,
                D3D11_BIND_FLAG(0),
                D3D11_USAGE_STAGING,
                D3D11_CPU_ACCESS_READ.0 as u32,
            )
            .expect("staging(RGBA)");
            ctx.CopyResource(
                Some(&stg as &ID3D11Resource),
                Some(&src as &ID3D11Resource),
            );
            let mut m = D3D11_MAPPED_SUBRESOURCE::default();
            ctx.Map(
                Some(&stg as &ID3D11Resource),
                0,
                D3D11_MAP_READ,
                0,
                Some(&mut m),
            )
            .expect("map staging");
            println!(
                "[阶段1] 源→staging→Map 前4字节={:?}（期望 [255,0,0,255]）",
                &std::slice::from_raw_parts(m.pData as *const u8, 4)
            );
            ctx.Unmap(Some(&stg as &ID3D11Resource), 0);

            // ── 阶段 2：Clear(0.5) → R8 渲染目标 → staging → Map（验证 RT 链路本身）──
            let rt = create_tex(
                &dev,
                fw,
                fh,
                DXGI_FORMAT_R8_UNORM,
                D3D11_BIND_RENDER_TARGET,
                D3D11_USAGE_DEFAULT,
                0,
            )
            .expect("R8 RT");
            let mut rtv = None;
            dev.CreateRenderTargetView(&rt, None, Some(&mut rtv))
                .expect("RTV");
            let rtv = rtv.unwrap();
            let stgy = create_tex(
                &dev,
                fw,
                fh,
                DXGI_FORMAT_R8_UNORM,
                D3D11_BIND_FLAG(0),
                D3D11_USAGE_STAGING,
                D3D11_CPU_ACCESS_READ.0 as u32,
            )
            .expect("staging(R8)");
            ctx.ClearRenderTargetView(Some(&rtv), &[0.5f32, 0.0, 0.0, 1.0]);
            ctx.CopyResource(
                Some(&stgy as &ID3D11Resource),
                Some(&rt as &ID3D11Resource),
            );
            let mut m2 = D3D11_MAPPED_SUBRESOURCE::default();
            ctx.Map(
                Some(&stgy as &ID3D11Resource),
                0,
                D3D11_MAP_READ,
                0,
                Some(&mut m2),
            )
            .expect("map staging(R8)");
            println!(
                "[阶段2] Clear(0.5)→R8 RT→staging→Map 首字节={}（期望 ≈128）",
                *(m2.pData as *const u8)
            );
            ctx.Unmap(Some(&stgy as &ID3D11Resource), 0);

            // ── 阶段 3：完整 VS+PS_y/PS_uv（经 GpuSameDeviceNv12Scaler::convert）──
            let mut scaler = GpuSameDeviceNv12Scaler::new(
                &dev,
                &ctx,
                fw,
                fh,
                fw,
                fh,
                DXGI_FORMAT_R8G8B8A8_UNORM,
                None,
            )
            .expect("scaler");
            let mut out: Vec<u8> = Vec::new();
            let r = scaler.convert(&src, &mut out);
            let uv_off = (fw * fh) as usize;
            println!(
                "[阶段3] convert ok={:?} 产出={}B Y首={:?} UV首={:?} 判死细节={:?}",
                r.is_ok(),
                out.len(),
                &out[..8.min(out.len())],
                if out.len() >= uv_off + 8 {
                    &out[uv_off..uv_off + 8]
                } else {
                    &[]
                },
                scaler.last_fail_detail
            );
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
