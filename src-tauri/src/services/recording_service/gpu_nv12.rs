//! 进程内 GPU RGBA→NV12 转码（全屏/区域录制的缩放与裁剪，阶段二核心）
//!
//! 旧实现用 D3D11 Video Processor 做 RGBA→NV12 同时缩放，但大量机器的默认 D3D11 设备
//! 不支持 Video Processor（`nv12_in_process_supported()` 返回 false），导致整条 GPU 路径失效、
//! 回退到 4K 整帧 RGBA 读回，是「卡顿」的真源。
//!
//! 本实现改用 D3D11 渲染管线 + 全屏三角形 + 线性采样器在 GPU 上把帧转成 NV12。
//!
//! ## 极致优化（2026-07-28）：分离设备 + 独立工作线程，捕获线程零 GPU 同步
//! 游戏里「微卡/粘滞/不跟手」的真源是：WGC 捕获回调线程内同步跑完了 Draw + 拷回 + `Map`
//! 读回，一旦被拖住就周期性冻住同机 DWM 合成 → 系统级输入延迟。帧纹理由 OS 在 WGC 所用
//! 设备上产出、不可跨设备直接共享，因此本实现让转换器跑在**自建的独立 D3D11 设备**（同显卡
//! 适配器）上，并用「自建可共享 + 键控互斥体的桥接纹理」接收帧：
//! - 捕获线程：仅 `AcquireSync(0,0)`（非阻塞，抢不到即丢帧）+ 一次 GPU→GPU 拷贝 src→bridge
//!   + `ReleaseSync(1)`，**不做任何 Draw / 读回 / 阻塞**，WGC 回调瞬时返回。
//! - 独立工作线程（自有设备/上下文）：`AcquireSync(1)` 后做两遍 Draw + 拷回 + **阻塞** Map
//!   读回，产出 NV12 推入输出队列。阻塞发生在工作线程，绝不占用捕获线程。
//! 这正是 OBS 在 N 卡上的做法（编码器与捕获同卡，无跨卡搬运），与之前失败的 MF 跨卡方案两码事。
//! 多层回退：桥接初始化失败 → 回退 RGBA；运行期产出全零 → 自检标记失效，调用方回退 RGBA，
//! 从根本杜绝绿屏。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use windows::core::{Interface, PCSTR, Result};
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::Win32::Graphics::Direct3D::{
    D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST, D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0,
    D3D_FEATURE_LEVEL_11_1, ID3DBlob,
};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::{IDXGIDevice, IDXGIKeyedMutex, IDXGIResource};

/// 工作线程输出队列容量：最多缓存 3 帧已转换结果，超出丢最旧（录屏内容无感知）。
const MAX_OUTPUT: usize = 3;
/// 工作线程等待信号的轮询超时（ms）：兼顾 60fps 唤醒粒度与低占用。
const WORK_POLL_MS: u64 = 20;
/// 工作线程 AcquireSync(1) 等待捕获侧 ReleaseSync(1) 的超时（ms）：超时即跳过本帧，不死锁。
const WORK_TIMEOUT_MS: u32 = 1000;

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
    /// 捕获侧（WGC 设备/上下文）：仅做一帧极快的 GPU 拷贝 src→bridge，不阻塞、不同步
    capture_ctx: ID3D11DeviceContext,
    /// 桥接纹理（建在捕获设备，可共享 + 键控互斥）：捕获线程写入、工作线程读取
    capture_bridge: ID3D11Texture2D,
    bridge_mutex: IDXGIKeyedMutex,
    /// 工作侧（自建独立 D3D11 设备，跑在独立线程）：Draw + 读回全部在此，绝不占捕获线程
    work_ctx: ID3D11DeviceContext,
    /// 桥接纹理在工作设备上的共享视图（着色器采样源）
    input_tex: ID3D11Texture2D,
    input_srv: ID3D11ShaderResourceView,
    /// Y 渲染目标（R8，out_w×out_h）+ 视图：着色器第一遍把亮度写入。
    rt_y: ID3D11Texture2D,
    rtv_y: ID3D11RenderTargetView,
    /// UV 渲染目标（R8G8，out_w/2×out_h/2）+ 视图：着色器第二遍把色度写入。
    rt_uv: ID3D11Texture2D,
    rtv_uv: ID3D11RenderTargetView,
    /// 工作线程独占的单槽 staging（无环形池；阻塞读回发生在工作线程）
    staging_y: ID3D11Texture2D,
    staging_uv: ID3D11Texture2D,
    vs: ID3D11VertexShader,
    ps_y: ID3D11PixelShader,
    ps_uv: ID3D11PixelShader,
    sampler: ID3D11SamplerState,
    out_w: u32,
    out_h: u32,
    in_w: u32,
    in_h: u32,
    /// 渲染管线自检 / 运行时发现产出全零 → 标记失效，调用方回退 RGBA，从根本杜绝绿屏
    broken: Arc<AtomicBool>,
    /// 捕获线程 → 工作线程的帧到达信号（unbounded，发送绝不阻塞）
    tx: Sender<()>,
    /// 工作线程 → 捕获线程（convert 取帧）的已转换结果队列
    output: Arc<Mutex<VecDeque<Vec<u8>>>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
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

unsafe fn create_staging(
    device: &ID3D11Device,
    w: u32,
    h: u32,
    fmt: DXGI_FORMAT,
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
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
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

/// 在工作设备的上下文上做两遍 Draw + 拷回 + **阻塞**读回，拼成连续 NV12 字节流。
/// 仅在独立工作线程调用，阻塞不占用捕获线程。失败返回 None。
#[allow(clippy::too_many_arguments)]
unsafe fn render_frame(
    work_ctx: &ID3D11DeviceContext,
    input_srv: &ID3D11ShaderResourceView,
    vs: &ID3D11VertexShader,
    ps_y: &ID3D11PixelShader,
    ps_uv: &ID3D11PixelShader,
    rtv_y: &ID3D11RenderTargetView,
    rtv_uv: &ID3D11RenderTargetView,
    rt_y: &ID3D11Texture2D,
    rt_uv: &ID3D11Texture2D,
    staging_y: &ID3D11Texture2D,
    staging_uv: &ID3D11Texture2D,
    sampler: &ID3D11SamplerState,
    out_w: u32,
    out_h: u32,
) -> Option<Vec<u8>> {
    work_ctx.IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    work_ctx.IASetInputLayout(None);
    work_ctx.GSSetShader(None, None);
    work_ctx.RSSetState(None);
    work_ctx.OMSetBlendState(None, None, u32::MAX);
    work_ctx.OMSetDepthStencilState(None, 0);
    // Y 遍
    work_ctx
        .OMSetRenderTargets(Some(&[Some(rtv_y.clone())]), None);
    let vp = D3D11_VIEWPORT {
        TopLeftX: 0.0,
        TopLeftY: 0.0,
        Width: out_w as f32,
        Height: out_h as f32,
        MinDepth: 0.0,
        MaxDepth: 1.0,
    };
    work_ctx.RSSetViewports(Some(&[vp]));
    let clear = [0.0f32; 4];
    work_ctx.ClearRenderTargetView(Some(rtv_y), &clear);
    work_ctx.VSSetShader(Some(vs), None);
    work_ctx.PSSetShader(Some(ps_y), None);
    work_ctx
        .PSSetShaderResources(0, Some(&[Some(input_srv.clone())]));
    work_ctx.PSSetSamplers(0, Some(&[Some(sampler.clone())]));
    work_ctx.Draw(3, 0);
    // UV 遍
    work_ctx
        .OMSetRenderTargets(Some(&[Some(rtv_uv.clone())]), None);
    let vp_uv = D3D11_VIEWPORT {
        TopLeftX: 0.0,
        TopLeftY: 0.0,
        Width: (out_w / 2).max(1) as f32,
        Height: (out_h / 2).max(1) as f32,
        MinDepth: 0.0,
        MaxDepth: 1.0,
    };
    work_ctx.RSSetViewports(Some(&[vp_uv]));
    work_ctx.ClearRenderTargetView(Some(rtv_uv), &clear);
    work_ctx.PSSetShader(Some(ps_uv), None);
    work_ctx.Draw(3, 0);
    // 两平面各拷入 staging（工作线程独占，单槽即可）
    work_ctx.CopyResource(
        Some(staging_y as &ID3D11Resource),
        Some(rt_y as &ID3D11Resource),
    );
    work_ctx.CopyResource(
        Some(staging_uv as &ID3D11Resource),
        Some(rt_uv as &ID3D11Resource),
    );
    work_ctx.Flush();
    // 阻塞读回 Y 平面
    let mut m = D3D11_MAPPED_SUBRESOURCE::default();
    if work_ctx
        .Map(Some(staging_y as &ID3D11Resource), 0, D3D11_MAP_READ, 0, Some(&mut m))
        .is_err()
    {
        return None;
    }
    let mut mu = D3D11_MAPPED_SUBRESOURCE::default();
    if work_ctx
        .Map(
            Some(staging_uv as &ID3D11Resource),
            0,
            D3D11_MAP_READ,
            0,
            Some(&mut mu),
        )
        .is_err()
    {
        work_ctx.Unmap(Some(staging_y as &ID3D11Resource), 0);
        return None;
    }
    let w = out_w as usize;
    let h = out_h as usize;
    let total = w * h + w * h / 2;
    let mut out = Vec::with_capacity(total);
    let ys = m.pData as *const u8;
    let yp = m.RowPitch as usize;
    for y in 0..h {
        out.extend_from_slice(std::slice::from_raw_parts(ys.add(y * yp), w));
    }
    work_ctx.Unmap(Some(staging_y as &ID3D11Resource), 0);
    let us = mu.pData as *const u8;
    let up = mu.RowPitch as usize;
    let uvh = h / 2;
    for y in 0..uvh {
        out.extend_from_slice(std::slice::from_raw_parts(us.add(y * up), w));
    }
    work_ctx.Unmap(Some(staging_uv as &ID3D11Resource), 0);
    Some(out)
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
            // ---- 工作设备：与捕获设备同适配器（同 GPU），独立上下文、独立线程 ----
            let adapter = device.cast::<IDXGIDevice>()?.GetAdapter()?;
            let mut work_dev = None;
            let mut work_ctx = None;
            if D3D11CreateDevice(
                Some(&adapter),
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut work_dev),
                None,
                Some(&mut work_ctx),
            )
            .is_err()
            {
                // 独立设备创建失败 → 回退 RGBA（安全，无绿屏）
                return Err(windows::core::Error::from(
                    windows::Win32::Foundation::E_FAIL,
                ));
            }
            let work_dev = work_dev.unwrap();
            let work_ctx = work_ctx.unwrap();

            // ---- 编译着色器（在工作设备）----
            let mut vs_blob = None;
            compile_hlsl(VS_HLSL, "VS", "vs_4_0", &mut vs_blob)?;
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
            work_dev.CreateVertexShader(vs_code, None, Some(&mut vs))?;
            let vs = vs.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
            let ps_y_code = std::slice::from_raw_parts(
                ps_y_blob.GetBufferPointer() as *const u8,
                ps_y_blob.GetBufferSize(),
            );
            let mut ps_y = None;
            work_dev.CreatePixelShader(ps_y_code, None, Some(&mut ps_y))?;
            let ps_y = ps_y.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
            let ps_uv_code = std::slice::from_raw_parts(
                ps_uv_blob.GetBufferPointer() as *const u8,
                ps_uv_blob.GetBufferSize(),
            );
            let mut ps_uv = None;
            work_dev.CreatePixelShader(ps_uv_code, None, Some(&mut ps_uv))?;
            let ps_uv = ps_uv.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;

            // ---- 桥接纹理：建在捕获设备，可共享 + 键控互斥；工作设备经共享句柄打开同一资源 ----
            let bridge_desc = D3D11_TEXTURE2D_DESC {
                Width: in_w,
                Height: in_h,
                MipLevels: 1,
                ArraySize: 1,
                Format: input_fmt,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
                CPUAccessFlags: 0,
                MiscFlags: (D3D11_RESOURCE_MISC_SHARED | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX).0
                    as u32,
            };
            let mut capture_bridge = None;
            device.CreateTexture2D(&bridge_desc, None, Some(&mut capture_bridge))?;
            let capture_bridge = capture_bridge.unwrap();
            let bridge_mutex = capture_bridge.cast::<IDXGIKeyedMutex>()?;
            let handle = capture_bridge.cast::<IDXGIResource>()?.GetSharedHandle()?;
            // 在工作设备打开同一共享纹理作为采样源
            let mut input_tex = None;
            work_dev.OpenSharedResource::<ID3D11Texture2D>(handle, &mut input_tex)?;
            let input_tex = input_tex
                .ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
            let mut srv = None;
            work_dev.CreateShaderResourceView(&input_tex, None, Some(&mut srv))?;
            let input_srv =
                srv.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
            let work_mutex = input_tex.cast::<IDXGIKeyedMutex>()?;

            // ---- 渲染目标与 staging（工作设备）----
            let rt_y = create_tex(
                &work_dev,
                out_w,
                out_h,
                DXGI_FORMAT_R8_UNORM,
                D3D11_BIND_RENDER_TARGET,
            )?;
            let mut rtv_y = None;
            work_dev.CreateRenderTargetView(&rt_y, None, Some(&mut rtv_y))?;
            let rtv_y = rtv_y.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
            let uvw = (out_w / 2).max(1);
            let uvh = (out_h / 2).max(1);
            let rt_uv = create_tex(
                &work_dev,
                uvw,
                uvh,
                DXGI_FORMAT_R8G8_UNORM,
                D3D11_BIND_RENDER_TARGET,
            )?;
            let mut rtv_uv = None;
            work_dev.CreateRenderTargetView(&rt_uv, None, Some(&mut rtv_uv))?;
            let rtv_uv = rtv_uv.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
            let staging_y = create_staging(&work_dev, out_w, out_h, DXGI_FORMAT_R8_UNORM)?;
            let staging_uv = create_staging(&work_dev, uvw, uvh, DXGI_FORMAT_R8G8_UNORM)?;

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
            work_dev.CreateSamplerState(&sd, Some(&mut sampler))?;
            let sampler = sampler.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;

            // ---- 线程通信原语 ----
            let (tx, rx) = mpsc::channel::<()>();
            let output: Arc<Mutex<VecDeque<Vec<u8>>>> =
                Arc::new(Mutex::new(VecDeque::with_capacity(MAX_OUTPUT)));
            let stop = Arc::new(AtomicBool::new(false));
            let broken = Arc::new(AtomicBool::new(false));

            // ---- 自检：在工作设备渲染一帧白屏 + 阻塞读回，验证 Draw 真能产出非全零 NV12 ----
            let probe = Self {
                capture_ctx: ctx.clone(),
                capture_bridge: capture_bridge.clone(),
                bridge_mutex: bridge_mutex.clone(),
                work_ctx: work_ctx.clone(),
                input_tex: input_tex.clone(),
                input_srv: input_srv.clone(),
                rt_y: rt_y.clone(),
                rtv_y: rtv_y.clone(),
                rt_uv: rt_uv.clone(),
                rtv_uv: rtv_uv.clone(),
                staging_y: staging_y.clone(),
                staging_uv: staging_uv.clone(),
                vs: vs.clone(),
                ps_y: ps_y.clone(),
                ps_uv: ps_uv.clone(),
                sampler: sampler.clone(),
                out_w,
                out_h,
                in_w,
                in_h,
                broken: broken.clone(),
                tx: tx.clone(),
                output: output.clone(),
                stop: stop.clone(),
                thread: None,
            };
            if !probe.verify() {
                eprintln!("[GPU缩放] 自检失败：分离设备渲染管线产出全零，回退 RGBA 读回");
                return Err(windows::core::Error::from(windows::Win32::Foundation::E_FAIL));
            }

            // ---- 启动独立工作线程：读共享纹理 → Draw → 阻塞读回 → 推输出队列 ----
            let out_w_c = out_w;
            let out_h_c = out_h;
            let handle_join = {
                // 资源克隆给工作线程；原值仍留给 Self 与 probe，避免 moved 冲突
                let work_ctx = work_ctx.clone();
                let input_srv = input_srv.clone();
                let rt_y = rt_y.clone();
                let rtv_y = rtv_y.clone();
                let rt_uv = rt_uv.clone();
                let rtv_uv = rtv_uv.clone();
                let staging_y = staging_y.clone();
                let staging_uv = staging_uv.clone();
                let vs = vs.clone();
                let ps_y = ps_y.clone();
                let ps_uv = ps_uv.clone();
                let sampler = sampler.clone();
                let work_mutex = work_mutex.clone();
                let output = output.clone();
                let stop = stop.clone();
                let broken = broken.clone();
                thread::spawn(move || {
                    loop {
                        if stop.load(Ordering::Relaxed) {
                            break;
                        }
                        match rx.recv_timeout(Duration::from_millis(WORK_POLL_MS)) {
                            Ok(()) => {}
                            Err(RecvTimeoutError::Timeout) => continue,
                            Err(_) => break,
                        }
                        if stop.load(Ordering::Relaxed) {
                            break;
                        }
                        // 只渲染最新一帧：排空积压信号，避免落后时重复渲染同内容
                        while rx.try_recv().is_ok() {}
                        // 等待捕获侧写入完成（GPU 级同步，最多等 1s，超时跳过本帧不死锁）
                        if work_mutex.AcquireSync(1, WORK_TIMEOUT_MS).is_err() {
                            continue;
                        }
                        let bytes = render_frame(
                            &work_ctx,
                            &input_srv,
                            &vs,
                            &ps_y,
                            &ps_uv,
                            &rtv_y,
                            &rtv_uv,
                            &rt_y,
                            &rt_uv,
                            &staging_y,
                            &staging_uv,
                            &sampler,
                            out_w_c,
                            out_h_c,
                        );
                        let _ = work_mutex.ReleaseSync(0);
                        match bytes {
                            Some(b) => {
                                // 运行时兜底：全零帧 = 共享纹理未真正写入 → 标记失效，回退 RGBA
                                if b.iter().all(|&x| x == 0) {
                                    broken.store(true, Ordering::Relaxed);
                                    break;
                                }
                                let mut q = output.lock().unwrap();
                                while q.len() >= MAX_OUTPUT {
                                    q.pop_front();
                                }
                                q.push_back(b);
                            }
                            None => { /* 读回失败，下一帧重试 */ }
                        }
                    }
                })
            };

            eprintln!("[GPU缩放] 分离设备零拷贝路径启用（GPU 转换在独立线程，捕获线程零阻塞）");
            Ok(Self {
                capture_ctx: ctx.clone(),
                capture_bridge,
                bridge_mutex,
                work_ctx,
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
                broken,
                tx,
                output,
                stop,
                thread: Some(handle_join),
            })
        }
    }

    /// 自检：用白屏填充输入纹理，走与 `render_frame` 完全一致的两遍渲染 + **阻塞**读回，
    /// 验证 Draw 真能向 R8/R8G8 渲染目标写出非全零数据。返回 true=该 D3D11 管线在本机可用。
    fn verify(&self) -> bool {
        unsafe {
            let n = (self.in_w as usize) * (self.in_h as usize) * 4;
            let white = vec![0xFFu8; n];
            self.work_ctx.UpdateSubresource(
                &self.input_tex,
                0,
                None,
                white.as_ptr() as *const core::ffi::c_void,
                self.in_w * 4,
                0,
            );
            match render_frame(
                &self.work_ctx,
                &self.input_srv,
                &self.vs,
                &self.ps_y,
                &self.ps_uv,
                &self.rtv_y,
                &self.rtv_uv,
                &self.rt_y,
                &self.rt_uv,
                &self.staging_y,
                &self.staging_uv,
                &self.sampler,
                self.out_w,
                self.out_h,
            ) {
                Some(b) => b.iter().any(|&x| x != 0),
                None => false,
            }
        }
    }

    /// 捕获线程调用：极快地把本帧拷入桥接纹理并唤醒工作线程，随后非阻塞取一帧已转换结果。
    /// 返回 `Ok(true)`=out 已写入一帧（可送 latest）；`Ok(false)`=GPU 未就绪/工作线程未产出，
    /// 本帧无数据（调用方应复用上一帧 latest）。`Err`=管线失效，调用方回退 RGBA。
    pub fn convert(&mut self, src: &ID3D11Texture2D, out: &mut Vec<u8>) -> Result<bool> {
        if self.broken.load(Ordering::Relaxed) {
            return Err(windows::core::Error::from(windows::Win32::Foundation::E_FAIL));
        }
        unsafe {
            // 非阻塞抢占键控互斥（timeout=0）：抢不到说明工作线程还在读上一帧 → 直接丢本帧，
            // 绝不阻塞捕获线程（这是消除游戏粘滞的关键）。
            if self.bridge_mutex.AcquireSync(0, 0).is_err() {
                // 仍唤醒一次工作线程（万一它卡在等待），但不阻塞
                let _ = self.tx.send(());
                return Ok(false);
            }
            // 极快 GPU→GPU 拷贝（仅一次提交，无 Map、无 Flush 阻塞）
            self.capture_ctx.CopyResource(
                Some(&self.capture_bridge as &ID3D11Resource),
                Some(src as &ID3D11Resource),
            );
            let _ = self.bridge_mutex.ReleaseSync(1);
            self.capture_ctx.Flush();
            // 唤醒工作线程做 Draw + 读回（在独立设备/线程，绝不占用捕获线程）
            let _ = self.tx.send(());
            // 非阻塞取一帧已转换结果（取最新）
            let mut q = self.output.lock().unwrap();
            if let Some(f) = q.pop_back() {
                *out = f;
                Ok(true)
            } else {
                Ok(false)
            }
        }
    }
}

impl Drop for GpuNv12Converter {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        // 唤醒工作线程使其退出 recv 等待
        let _ = self.tx.send(());
        if let Some(h) = self.thread.take() {
            let _ = h.join();
        }
    }
}

/// 进程内 GPU 转 NV12 是否可用。
///
/// **不再用临时 D3D11 设备做探针**——旧实现用 `D3D11CreateDevice(None, D3D_DRIVER_TYPE_UNKNOWN)`
/// 建临时设备，在不少机器上会落到 **WARP 软件设备 / 错误适配器**；从它取 adapter 再建的工作设备
/// 与 WGC 真实帧纹理所在的 GPU **跨适配器**，于是 `OpenSharedResource` 失败 → 探针返回 `false` →
/// `gpu_nv12=false` → 整条 GPU 路径被假阴性关闭 → 回退到「捕获线程同步读回整帧 RGBA」，正是游戏
/// 粘滞的真源（且全程无任何 `[GPU缩放]` 日志，难以诊断）。
///
/// 正确做法：真实能力由运行时 `GpuNv12Converter::new` 决定——它用的是 WGC 实际捕获设备
/// `frame.device()`，与帧纹理**同适配器**，`OpenSharedResource` 必然可用；再叠加运行期「全零帧检测」
/// 兜底（“绿屏”不可能出现）。因此这里直接返回 true，让每次录制首次帧用真实设备创建、自愈/失败回退。
pub(crate) fn nv12_in_process_supported() -> bool {
    true
}
