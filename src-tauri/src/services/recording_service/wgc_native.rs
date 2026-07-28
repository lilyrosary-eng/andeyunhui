//! 方案 A：原生 WGC 捕获（绕过 windows-capture 的帧池设备限制）
//!
//! ## 为什么需要它（2026-07-28，第 29 轮）
//! windows-capture 用 crate 内部自建的 D3D11 设备创建帧池：
//! - 该内部设备在本机**不能渲染**（自检全零，命令被 DWM 丢弃）→ 无法在帧所在设备上缩放；
//! - 帧纹理**不带共享标志**（MiscFlags 无 `D3D11_RESOURCE_MISC_SHARED*`）→ 跨设备映射
//!   `OpenSharedResource` 必失败（0x80070057）；
//! - `Settings` 不允许注入设备或指定帧池尺寸 → 只能整帧 33MB@4K CPU 读回。
//!
//! 本模块直接调用 Windows.Graphics.Capture：**帧池建在我们自建的 D3D11 设备上**
//! （`Direct3D11CaptureFramePool::CreateFreeThreaded(自建设备, …)`），帧一出生就在自家设备——
//! 既不需要跨设备共享，也不碰 crate 内部设备。在同一设备上用 `GpuSameDeviceScaler`
//! 把 4K→(out_w,out_h) 缩放/裁剪后只读回小尺寸 RGBA（1080p ≈8MB/帧，省掉 33MB 读回 +
//! CPU 缩放）。自建设备渲染能力已被启动探针验证（本机自检通过）。
//!
//! 失败降级链（每级都干净、绝不 brick 录制）：
//! 1. 模块初始化失败（设备/item/帧池/会话任一步）→ 返回 Err，调用方回退 windows-capture 路径；
//! 2. 运行时 GPU 缩放失败 → 本模块内 CPU 兜底：同设备 staging 整帧读回 +
//!    `rgba_resize_crop_nearest`（与 windows-capture 路径同等开销，仍正确产出）。
//!
//! 产出与 WgcRecorder 完全一致：RGBA 字节流写入共享 `latest` 槽（尺寸恒 = out_w×out_h），
//! pacer / ffmpeg 管线零改动。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use windows::core::{factory, IInspectable, Interface};
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread, ID3D11Resource,
    ID3D11Texture2D, D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
    D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::HMONITOR;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

use super::gpu_nv12::GpuSameDeviceScaler;
use super::CapturedFrame;

/// 原生捕获参数。
pub(crate) struct NativeCaptureParams {
    /// 目标显示器句柄（HMONITOR 原始值；isize 便于跨线程传递）。
    pub hmonitor: isize,
    /// 目标帧率（用于 MinUpdateInterval + 回调内限流）。
    pub fps: u32,
    /// 产出尺寸（恒定；与 ffmpeg -s 严格一致）。
    pub out_w: u32,
    pub out_h: u32,
    /// 裁剪区域（相对显示器物理原点）；None = 全帧。
    pub crop: Option<(u32, u32, u32, u32)>,
}

/// FrameArrived 回调共享状态。D3D11 对象非 Send，但设备已开多线程保护、且所有访问都在
/// 本 Mutex 内序列化（WGC free-threaded 回调线程池），与 windows-capture 的 SendDirectX
/// 同理，安全。
struct NativeState {
    device: ID3D11Device,
    ctx: ID3D11DeviceContext,
    /// 同设备 GPU 缩放器（懒初始化；None 且 !failed = 待首帧初始化）。
    scaler: Option<GpuSameDeviceScaler>,
    scaler_failed: bool,
    /// CPU 兜底整帧 staging（懒初始化；(纹理, w, h)）。
    cpu_staging: Option<(ID3D11Texture2D, u32, u32)>,
    /// CPU 兜底整帧读回缓冲（复用，避免每帧分配 33MB）。
    scratch: Vec<u8>,
    out_w: u32,
    out_h: u32,
    crop: Option<(u32, u32, u32, u32)>,
    latest: Arc<Mutex<Option<CapturedFrame>>>,
    free: Arc<Mutex<Vec<Arc<Vec<u8>>>>>,
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    /// 回调内限流：两次产出的最小间隔（≈1/fps 的 90%，容忍抖动）。
    min_interval: Duration,
    last_emit: Option<Instant>,
    logged_gpu_on: bool,
    /// 累计成功产出帧数（仅用于「零帧看门狗」与诊断日志）。
    frames_produced: u32,
    /// 累计「全黑帧」数（前几帧自检用：若产出的帧几乎全零，说明自建设备取帧失败，
    /// 应整体回退 windows-capture，而非在原生路径内部继续产出黑文件）。
    black_frames: u32,
}
unsafe impl Send for NativeState {}

impl NativeState {
    /// 处理一帧（tex 在本设备上）。任何失败只影响本帧，绝不 panic。
    fn process(&mut self, tex: &ID3D11Texture2D) {
        if self.paused.load(Ordering::Relaxed) {
            return;
        }
        // 限流：WGC 高刷源可能超 fps 投帧，多余帧直接丢弃（帧已 Close 回池，零拷贝零读回）。
        if let Some(t) = self.last_emit {
            if t.elapsed() < self.min_interval {
                return;
            }
        }
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { tex.GetDesc(&mut desc) };
        let (fw, fh) = (desc.Width, desc.Height);
        if fw == 0 || fh == 0 {
            return;
        }

        // 取缓冲（对象池复用；被 pacer 持有的不复用，防写入撕裂）。
        let mut buf = self
            .free
            .lock()
            .ok()
            .and_then(|mut fl| fl.pop())
            .map(|mut a| {
                if Arc::get_mut(&mut a).is_some() {
                    a
                } else {
                    Arc::new(Vec::new())
                }
            })
            .unwrap_or_else(|| Arc::new(Vec::new()));

        // GPU 同设备缩放（正常路径）。
        let mut produced = false;
        if !self.scaler_failed {
            if self.scaler.is_none()
                || self.scaler.as_ref().map(|s| s.input_size()) != Some((fw, fh))
            {
                match GpuSameDeviceScaler::new(
                    &self.device,
                    &self.ctx,
                    fw,
                    fh,
                    self.out_w,
                    self.out_h,
                    desc.Format,
                    self.crop,
                ) {
                    Ok(s) => self.scaler = Some(s),
                    Err(e) => {
                        eprintln!("[录屏] 原生 WGC：同设备缩放器初始化失败，改 CPU 兜底: {e}");
                        self.scaler_failed = true;
                        self.scaler = None;
                    }
                }
            }
            if let Some(scaler) = self.scaler.as_mut() {
                let p = Arc::get_mut(&mut buf).expect("刚取得的缓冲必为独占引用");
                p.clear();
                match scaler.scale(tex, p) {
                    Ok(v) => produced = v,
                    Err(e) => {
                        eprintln!("[录屏] 原生 WGC：同设备缩放运行时失败，改 CPU 兜底: {e}");
                        self.scaler_failed = true;
                        self.scaler = None;
                    }
                }
                if produced && !self.logged_gpu_on {
                    self.logged_gpu_on = true;
                    eprintln!(
                        "[录屏] 原生 WGC GPU 缩放生效：{}x{} → {}x{}，每帧只读回 ~{:.1}MB（无跨设备共享）",
                        fw,
                        fh,
                        self.out_w,
                        self.out_h,
                        (self.out_w as f64 * self.out_h as f64 * 4.0) / 1048576.0
                    );
                }
            }
        }

        // CPU 兜底：同设备 staging 整帧读回 + 最近邻缩放/裁剪（尺寸恒 = out_w×out_h）。
        if !produced && self.scaler_failed {
            match self.cpu_readback(tex, fw, fh) {
                Ok(()) => {
                    let p = Arc::get_mut(&mut buf).expect("刚取得的缓冲必为独占引用");
                    p.clear();
                    let ow = self.out_w as usize;
                    let oh = self.out_h as usize;
                    if self.crop.is_none() && fw as usize == ow && fh as usize == oh {
                        p.extend_from_slice(&self.scratch);
                    } else {
                        super::rgba_resize_crop_nearest(
                            &self.scratch,
                            fw as usize,
                            fh as usize,
                            self.crop,
                            ow,
                            oh,
                            p,
                        );
                    }
                    produced = true;
                }
                Err(e) => {
                    eprintln!("[录屏] 原生 WGC：CPU 读回失败（本帧丢弃）: {e}");
                }
            }
        }

        if produced {
            // 全黑帧自检：前几帧若几乎全零，说明自建设备取帧失败（应整体回退 windows-capture）。
            if buf.iter().all(|&b| b == 0) {
                self.black_frames += 1;
            }
            self.last_emit = Some(Instant::now());
            self.frames_produced += 1;
            if let Ok(mut slot) = self.latest.lock() {
                let old = std::mem::replace(
                    &mut *slot,
                    Some(CapturedFrame {
                        data: buf,
                        ts: Instant::now(),
                    }),
                );
                drop(slot);
                if let Some(o) = old {
                    if let Ok(mut fl) = self.free.lock() {
                        if fl.len() < 4 {
                            fl.push(o.data);
                        }
                    }
                }
            }
        } else {
            // 无产出（GPU 未就绪等）：缓冲归还池，避免池被抽干。
            if let Ok(mut fl) = self.free.lock() {
                if fl.len() < 4 {
                    fl.push(buf);
                }
            }
        }
    }

    /// 同设备整帧 CPU 读回到 self.scratch（RGBA，无行距填充）。
    fn cpu_readback(&mut self, tex: &ID3D11Texture2D, fw: u32, fh: u32) -> windows::core::Result<()> {
        unsafe {
            // staging 尺寸不匹配（首次 / 分辨率变化）则重建。
            let rebuild = match &self.cpu_staging {
                Some((_, w, h)) => *w != fw || *h != fh,
                None => true,
            };
            if rebuild {
                let mut d = D3D11_TEXTURE2D_DESC::default();
                tex.GetDesc(&mut d);
                let sd = D3D11_TEXTURE2D_DESC {
                    Width: fw,
                    Height: fh,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: d.Format,
                    SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                    Usage: D3D11_USAGE_STAGING,
                    BindFlags: 0,
                    CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                    MiscFlags: 0,
                };
                let mut st = None;
                self.device.CreateTexture2D(&sd, None, Some(&mut st))?;
                let st = st.ok_or(windows::core::Error::from(
                    windows::Win32::Foundation::E_FAIL,
                ))?;
                self.cpu_staging = Some((st, fw, fh));
            }
            let (staging, _, _) = self.cpu_staging.as_ref().unwrap();
            self.ctx.CopyResource(
                Some(staging as &ID3D11Resource),
                Some(tex as &ID3D11Resource),
            );
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.ctx.Map(
                Some(staging as &ID3D11Resource),
                0,
                D3D11_MAP_READ,
                0,
                Some(&mut mapped),
            )?;
            let w = fw as usize;
            let h = fh as usize;
            self.scratch.clear();
            self.scratch.reserve(w * h * 4);
            let src = mapped.pData as *const u8;
            let pitch = mapped.RowPitch as usize;
            for y in 0..h {
                self.scratch
                    .extend_from_slice(std::slice::from_raw_parts(src.add(y * pitch), w * 4));
            }
            self.ctx.Unmap(Some(staging as &ID3D11Resource), 0);
            Ok(())
        }
    }
}

/// 阻塞运行原生 WGC 捕获直到 stop 置位。初始化任一步失败立即返回 Err（调用方回退
/// windows-capture 路径）；启动成功后总是 Ok（运行时问题在模块内降级消化）。
pub(crate) fn run_native_capture(
    params: NativeCaptureParams,
    latest: Arc<Mutex<Option<CapturedFrame>>>,
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    free: Arc<Mutex<Vec<Arc<Vec<u8>>>>>,
) -> Result<(), String> {
    unsafe {
        // free-threaded 帧池要求 COM/WinRT 初始化（MTA）；重复初始化无害。
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        // 1. 自建 D3D11 设备（渲染能力已被启动探针验证）。WGC 会在其他线程向帧池纹理写入，
        //    必须开多线程保护（官方 ScreenCapture 示例同款）。
        let mut dev = None;
        let mut ctx = None;
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
        .map_err(|e| format!("D3D11CreateDevice: {e}"))?;
        let device = dev.ok_or("D3D11CreateDevice 未返回设备")?;
        let ctx = ctx.ok_or("D3D11CreateDevice 未返回上下文")?;
        if let Ok(mt) = ctx.cast::<ID3D11Multithread>() {
            let _ = mt.SetMultithreadProtected(true);
        }

        // 2. 包装成 WinRT IDirect3DDevice（帧池设备参数）。
        let dxgi: IDXGIDevice = device
            .cast()
            .map_err(|e| format!("设备转 IDXGIDevice: {e}"))?;
        let winrt_dev: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&dxgi)
            .map_err(|e| format!("CreateDirect3D11DeviceFromDXGIDevice: {e}"))?
            .cast()
            .map_err(|e| format!("IInspectable 转 IDirect3DDevice: {e}"))?;

        // 3. 从 HMONITOR 创建捕获项。
        let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
            .map_err(|e| format!("取 IGraphicsCaptureItemInterop: {e}"))?;
        let item: GraphicsCaptureItem = interop
            .CreateForMonitor(HMONITOR(params.hmonitor as *mut core::ffi::c_void))
            .map_err(|e| format!("CreateForMonitor: {e}"))?;
        let size = item.Size().map_err(|e| format!("item.Size: {e}"))?;

        // 4. 帧池建在**我们的设备**上（本模块的全部意义）。RGBA 与 ffmpeg -pix_fmt rgba 一致。
        //    双缓冲 free-threaded：回调在线程池触发，无需消息泵。
        let frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &winrt_dev,
            DirectXPixelFormat::R8G8B8A8UIntNormalized,
            2,
            size,
        )
        .map_err(|e| format!("CreateFreeThreaded: {e}"))?;
        let session = frame_pool
            .CreateCaptureSession(&item)
            .map_err(|e| format!("CreateCaptureSession: {e}"))?;
        // 关黄框（区域录制时黄框只会误导）；旧系统不支持则忽略。
        let _ = session.SetIsBorderRequired(false);
        // 限流到目标 fps（Win11 24H2+；不支持则由回调内 min_interval 限流兜底）。
        let _ = session.SetMinUpdateInterval(TimeSpan {
            Duration: 10_000_000i64 / i64::from(params.fps.max(1)),
        });

        let state = Arc::new(Mutex::new(NativeState {
            device,
            ctx,
            scaler: None,
            scaler_failed: false,
            cpu_staging: None,
            scratch: Vec::new(),
            out_w: params.out_w,
            out_h: params.out_h,
            crop: params.crop,
            latest,
            free,
            stop: stop.clone(),
            paused,
            min_interval: Duration::from_secs_f64(0.9 / f64::from(params.fps.max(1))),
            last_emit: None,
            logged_gpu_on: false,
            frames_produced: 0,
            black_frames: 0,
        }));

        let handler_state = state.clone();
        let token = frame_pool
            .FrameArrived(&TypedEventHandler::<
                Direct3D11CaptureFramePool,
                IInspectable,
            >::new(move |pool, _| {
                let Some(pool) = pool.as_ref() else {
                    return Ok(());
                };
                let Ok(frame) = pool.TryGetNextFrame() else {
                    return Ok(());
                };
                if let Ok(mut st) = handler_state.lock() {
                    if !st.stop.load(Ordering::Relaxed) {
                        if let Ok(surface) = frame.Surface() {
                            if let Ok(access) = surface.cast::<IDirect3DDxgiInterfaceAccess>() {
                                if let Ok(tex) = access.GetInterface::<ID3D11Texture2D>() {
                                    st.process(&tex);
                                }
                            }
                        }
                    }
                }
                let _ = frame.Close(); // 立即归还帧池，避免池饥饿
                Ok(())
            }))
            .map_err(|e| format!("FrameArrived 订阅: {e}"))?;

        if let Err(e) = session.StartCapture() {
            let _ = frame_pool.RemoveFrameArrived(token);
            let _ = frame_pool.Close();
            return Err(format!("StartCapture: {e}"));
        }
        eprintln!(
            "[录屏] 原生 WGC 捕获已启动：帧池建在自建 D3D11 设备（{}x{}，双缓冲 free-threaded），同设备 GPU 缩放至 {}x{}",
            size.Width, size.Height, params.out_w, params.out_h
        );

        // 5. 驻留至 stop（回调在线程池运行，本线程只轮询停止标志）。
        // 零帧看门狗：若 2.5s 内未产出任何帧，说明本机在该显示器/分辨率下原生 WGC 取帧失败
        // （回调静默吞错，典型为帧纹理取不到/限流死锁），立即返回 Err 让捕获线程回退到
        // windows-capture 老路径（本机已验证可用），避免产出 1kb 空文件。
        let boot = std::time::Instant::now();
        while !stop.load(Ordering::Relaxed) {
            if boot.elapsed() > Duration::from_millis(2500) {
                if let Ok(s) = state.lock() {
                    if s.frames_produced == 0 {
                        eprintln!(
                            "[录屏] 原生 WGC 2.5s 内零帧产出，回退 windows-capture 捕获（显示器/分辨率取帧失败）"
                        );
                        return Err("native wgc produced 0 frames in 2.5s".into());
                    } else if s.frames_produced >= 5 && s.black_frames == s.frames_produced {
                        eprintln!(
                            "[录屏] 原生 WGC 连续产出全黑帧，回退 windows-capture 捕获（自建设备取帧失败）"
                        );
                        return Err("native wgc all-black frames".into());
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(30));
        }

        let _ = frame_pool.RemoveFrameArrived(token);
        let _ = session.Close();
        let _ = frame_pool.Close();
        Ok(())
    }
}
