//! 录屏服务：WGC 持续捕获 + ffmpeg 管道编码
//!
//! 技术选型：
//! - 捕获：windows-capture（WGC，硬件加速，项目已有依赖），持续帧捕获
//! - 编码：系统 ffmpeg 管道编码（H.264 + MP4），最成熟稳定
//! - 控制：Arc<AtomicBool> 停停/暂停标志，WGC 回调中检查
//!
//! 数据流：WGC on_frame_arrived → 非阻塞写入「最新帧槽」（保留最新/丢弃最旧）→ 独立 pacer
//! 线程按「呈现时间」降采样写 ffmpeg stdin → ffmpeg 编码 → MP4 文件。回调绝不阻塞，捕获线程与
//! 编码线程解耦；pacer 以每帧真实呈现时间戳驱动写帧，杜绝补帧堆积与时间压缩。

use std::io::Write;
use std::process::{Child, Command, Stdio};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::mpsc;
use std::time::SystemTime;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use crate::services::window_manager::per_window_data_dir;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use winapi::shared::windef::HWND;


use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
/// 进程内 GPU RGBA→RGBA 缩放（阶段二核心，见 gpu_nv12.rs）
/// 完整 L0 后改为同设备 GPU 缩放，产出 NV12 纹理留 GPU（不再 Map 读回）
pub(crate) mod gpu_nv12;
/// WASAPI 回环音频采集（命名管道喂给 ffmpeg，见 audio_capture.rs）
/// 完整 L0 后改为 mpsc 通道直接喂进程内 AAC 编码器
pub(crate) mod audio_capture;
/// 方案 A：原生 WGC 捕获——帧池建在自建 D3D11 设备上，同设备 GPU 缩放只读回小尺寸 RGBA
/// （绕过 windows-capture「帧池设备不能渲染 + 帧纹理不可共享」的双重死路，见 wgc_native.rs）
pub(crate) mod wgc_native;
/// FFmpeg libavcodec/libavformat 动态加载（libloading，完整 L0 用）
mod ffi;
/// 进程内编码器：d3d11va→nvenc 零拷贝 + AAC 音频 + MP4 封装（完整 L0）
pub(crate) mod encoder_av;
use audio_capture::{start_audio_capture, start_audio_capture_channel, AudioCapture, AudioFormat};
use gpu_nv12::{GpuNv12Converter, GpuSameDeviceScaler};
use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::ID3D11Multithread;
use encoder_av::{AvEncoder, AudioSource, EncoderConfig};


/// 录屏控制台窗口标签
pub const RECORDER_WINDOW_LABEL: &str = "recorder-widget";

/// 录屏区域选择覆盖窗标签
pub const RECORDER_SELECT_LABEL: &str = "recorder-select";

/// 录屏区域边框窗标签（透明、点击穿透、排除捕获，仅用于屏幕可视化提示录制区域）
pub const RECORDING_BORDER_LABEL: &str = "recording-border";

// ---- 录屏边框窗「区域镂空」实现点击穿透 ----
// 旧方案用 WS_EX_TRANSPARENT + 子类化 WM_NCHITTEST，但 WebView2 在页面加载后才创建子 HWND，
// 预创建时子类化来不及，且 WebView2 会重置窗口过程 → 红框内点击被 WebView2 子窗拦截，无法操作。
// 改为更稳健的做法：用窗口区域（HRGN）把边框做成「画框」——仅保留四周 FRAME 像素属于窗口，
// 内部全部镂空（不属于窗口）。镂空区域在 OS 命中测试里本就不存在窗口，点击必然穿透到下层应用，
// 与 WebView2 实现、DPI、样式时机都无关，彻底可靠。
const BORDER_FRAME_PX: i32 = 2;

/// 设置边框窗为「画框」区域：外框 = 整窗矩形，内框 = 向内缩 FRAME 的矩形，二者差分得到仅四周的环。
/// 之后窗口内部（录制区域）完全镂空，鼠标点击自然穿透，无需任何透明/子类化 hack。
unsafe fn set_border_region(hwnd: HWND, w: i32, h: i32) {
    if w <= 0 || h <= 0 {
        return;
    }
    let t = BORDER_FRAME_PX;
    let outer = winapi::um::wingdi::CreateRectRgn(0, 0, w, h);
    let inner = winapi::um::wingdi::CreateRectRgn(t, t, (w - t).max(0), (h - t).max(0));
    let rgn = winapi::um::wingdi::CreateRectRgn(0, 0, 0, 0);
    winapi::um::wingdi::CombineRgn(rgn, outer, inner, winapi::um::wingdi::RGN_DIFF);
    // SetWindowRgn 接管 rgn 所有权，由系统负责释放；outer/inner 由我们释放。
    winapi::um::winuser::SetWindowRgn(hwnd, rgn, 1);
    winapi::um::wingdi::DeleteObject(outer as *mut _);
    winapi::um::wingdi::DeleteObject(inner as *mut _);
}

/// 录屏状态（返回给前端）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub is_recording: bool,
    pub is_paused: bool,
    pub elapsed_secs: u64,
    pub output_path: String,
}

/// WGC 持续捕获 handler：每帧组装字节后**非阻塞**写入共享「最新帧槽」（Arc 覆盖，瞬时返回），
/// 由独立节拍器线程按恒定 fps 取用写入 ffmpeg。
///
/// **关键设计一（根治「录屏时点击主窗即整体卡死」）**：绝不在 WGC 回调里直接 write_all 到
/// ffmpeg stdin。4K 录屏时 libx264 编码跟不上 → stdin 管道写满 → 回调阻塞在 write_all →
/// WGC 帧池耗尽、DWM 合成停摆 → 整个应用（含主窗、控制台）卡死。回调只做一次 Arc 覆盖写入
/// 共享槽，永不阻塞。
///
/// **关键设计二（根治「画面卡卡 / 加速回放 / 不丝滑」）**：pacer 按恒定 1/fps 墙钟节奏驱动写帧，
/// 单槽「保留最新、丢弃最旧」即退化 SPSC：捕获回调非阻塞、捕获线程永不被阻塞，高刷多帧仅留最新。
/// 输入改用 `-fps_mode cfr`：ffmpeg 严格按 -r fps 均匀打点并自动复制/丢帧对齐真实时长，从而无论
/// qsv 编码器多慢（本机 1080p 仅 ~13fps），输出时长严格 = 真实录制墙钟、帧间隔均匀、绝不快进；
/// 音频（WASAPI 墙钟）同为真实墙钟 → 音画天然同步。捕获/编码偶发阻塞表现为 cfr 复制最近帧
/// （停顿=真实时长）而非「快进」。
/// 一帧捕获数据 + 其呈现时间代理。
///
/// `ts` 在 WGC 回调拷贝帧的瞬间记录（`std::time::Instant`）作为该帧的「真实呈现时刻」代理，
/// 当前 pacer 以恒定墙钟节奏投帧（不逐帧读 ts），ts 预留作后续高刷降采样优化（目前未读取，
/// 故编译器报 dead_code 警告——不影响运行时，非录制问题的成因）。pacer 据此按呈现节奏降采样（高刷
/// 165Hz→目标 60fps）并打点，杜绝「补帧堆积冻结 / 时间压缩」，是极致丝滑的关键。
#[derive(Clone)]
pub(crate) struct CapturedFrame {
    data: Arc<Vec<u8>>,
    // 预留给后续高刷降采样打点（当前 pacer 以恒定墙钟投帧、未逐帧读 ts），故允许 dead_code。
    #[allow(dead_code)]
    ts: std::time::Instant,
}

struct WgcRecorder {
    /// 最新帧共享槽（Arc 便于节拍器零拷贝取用；None = 尚无帧）。
    /// 单槽即「保留最新、丢弃最旧」的退化 SPSC：捕获回调非阻塞覆盖写入，捕获线程永不被阻塞；
    /// 高刷源多帧涌来时仅保留最新，pacer 按呈现时间降采样到目标 fps。
    latest: Arc<Mutex<Option<CapturedFrame>>>,
    /// 停止标志：设为 true 后下一帧回调中 stop() 捕获
    stop_flag: Arc<AtomicBool>,
    /// 暂停标志：暂停时不写入帧槽
    paused: Arc<AtomicBool>,
    /// 裁剪区域（相对于帧原点的物理像素偏移）：None = 全帧，Some((x,y,w,h)) = 逐行裁剪
    crop: Option<(u32, u32, u32, u32)>,
    /// 帧缓冲对象池：复用已分配的 Vec，避免 4K 每帧 ~33MB 反复分配触发分配器周期性停顿
    /// （录制卡顿主因之一）。回调取缓冲→填充→覆盖进 latest；旧帧（节拍器不再持有时）回收进池循环复用。
    free: Arc<Mutex<Vec<Arc<Vec<u8>>>>>,
    /// 复用的 nopadding 输出缓冲，避免每帧重新分配
    scratch: Vec<u8>,
    /// 编码输出尺寸（4K 全屏时在 GPU 内降采样到此；区域/1080p 时等于捕获尺寸）
    out_w: u32,
    out_h: u32,
    /// 是否启用进程内 GPU RGBA 缩放/裁剪（探针通过且运行时帧纹理可共享才真正生效；否则 CPU 兜底）
    gpu_nv12: bool,
    /// 进程内 GPU 转换器（懒初始化；None = 未初始化/不可用）——旧 ffmpeg 子进程路径用
    gpu: Option<GpuNv12Converter>,
    /// 进程内同设备 GPU 缩放器（L0 路径用，不需要共享句柄，故本机可用）：
    /// GPU 内 4K→1080p，只读回 8MB RGBA（替代需要共享句柄、本机必失败的 GpuNv12Converter）
    gpu_scaler: Option<GpuSameDeviceScaler>,
    /// 同设备 GPU 缩放输出缓冲（复用，避免每帧分配 8MB）
    gpu_rgba: Vec<u8>,
    /// 诊断：同设备 GPU 缩放「产出帧 / 未就绪跳过帧」计数（定位空视频用）
    gpu_stat_ok: u64,
    gpu_stat_skip: u64,
    /// GPU 转换器初始化是否曾失败（失败则不再重试，整段回退 RGBA）
    gpu_failed: bool,
    // ── 完整 L0：进程内 avcodec (d3d11va→nvenc) 字段 ──
    /// 进程内编码器（懒初始化：首个 WGC 帧到达时用 frame.device() 创建）。
    /// None = 未初始化或回退到旧 ffmpeg 子进程路径。
    encoder: Option<Arc<AvEncoder>>,
    /// 编码器初始化是否已失败（失败则不再重试）
    encoder_init_failed: bool,
    /// 录制开始时刻（用于计算 PTS）
    start_instant: Option<std::time::Instant>,
    /// 编码器配置（在 start_recording 中准备好，首帧到达时用于初始化）
    enc_cfg: Option<EncoderConfig>,
    /// 编码器句柄（与 RecordingHandle 共享，初始化完成后写入此句柄供停止时调用 stop()）
    encoder_handle: Arc<Mutex<Option<Arc<AvEncoder>>>>,
    /// 视频时间原点已定（首帧馈入编码器时置位），音频采集线程据此对齐时间轴、消除音画不同步
    video_started: Arc<AtomicBool>,
}

impl GraphicsCaptureApiHandler for WgcRecorder {
    type Flags = (
        Arc<Mutex<Option<CapturedFrame>>>,
        Arc<AtomicBool>,
        Arc<AtomicBool>,
        Option<(u32, u32, u32, u32)>,
        Arc<Mutex<Vec<Arc<Vec<u8>>>>>,
        bool, // gpu_nv12: 是否启用进程内 GPU RGBA→NV12
        bool, // downscale_4k: 是否需要降采样（超 1080p 时）
        (u32, u32), // 编码输出尺寸（4K 全屏降采样目标；否则等于捕获尺寸）
        Option<EncoderConfig>, // 完整 L0 编码器配置（None = 走旧 ffmpeg 路径）
        Arc<Mutex<Option<Arc<AvEncoder>>>>, // 编码器共享句柄（RecordingHandle 也持有一份）
        Arc<AtomicBool>, // video_started：首帧馈入编码器时置位，供音频对齐时间轴
    );
    type Error = String;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let (latest, stop_flag, paused, crop, free, gpu_nv12, _downscale_4k, (out_w, out_h), enc_cfg, encoder_handle, video_started) = ctx.flags;
        Ok(Self {
            latest,
            stop_flag,
            paused,
            crop,
            free,
            out_w,
            out_h,
            scratch: Vec::new(),
            gpu_nv12,
            gpu: None,
            gpu_scaler: None,
            gpu_rgba: Vec::new(),
            gpu_stat_ok: 0,
            gpu_stat_skip: 0,
            gpu_failed: false,
            encoder: None,
            encoder_init_failed: false,
            start_instant: None,
            enc_cfg,
            encoder_handle,
            video_started,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        // 检查停止标志
        if self.stop_flag.load(Ordering::SeqCst) {
            capture_control.stop();
            return Ok(());
        }
        // 暂停时跳过
        if self.paused.load(Ordering::SeqCst) {
            return Ok(());
        }
        let fw = frame.width();
        let fh = frame.height();

        // ── 完整 L0 路径：进程内 libavcodec + libavformat（去掉 ffmpeg 子进程 / stdin 字节管道）──
        // GPU 上完成 BGRA→NV12，再把 NV12 喂给进程内 h264_nvenc，nvenc 在 dGPU 自建 CUDA 上下文上传。
        // 与旧 GpuNv12Converter→Map 读回→stdin 管道 互斥：编码器就绪后跳过 latest 槽 / 生产者消费者线程。
        if self.enc_cfg.is_some() {
            if self.encoder.is_none() {
                // 优先从共享句柄取（start_recording 已提前建好进程内编码器）
                if let Ok(g) = self.encoder_handle.lock() {
                    if let Some(e) = g.clone() {
                        self.encoder = Some(e);
                    }
                }
                // 兜底惰性创建（理论上不会触发）：无音频
                // 注：此处 init_ffmpeg(None) 自动探测在 release 下漏掉 user_external_deps，
                // 但主路径（start_recording 的 get_ffmpeg_dir）已覆盖，encoder_handle 此时应已有值，
                // 本兜底仅 dev 兜底生效。
                if self.encoder.is_none() && !self.encoder_init_failed {
                    match ffi::init_ffmpeg(None) {
                        Ok(()) => match AvEncoder::new(self.enc_cfg.clone().unwrap(), None) {
                            Ok(enc) => {
                                if let Ok(mut handle) = self.encoder_handle.lock() {
                                    *handle = Some(enc.clone());
                                }
                                self.encoder = Some(enc);
                                eprintln!("[录屏] ✅ 进程内 libavcodec 编码器惰性初始化成功");
                            }
                            Err(e) => {
                                self.encoder_init_failed = true;
                                eprintln!("[录屏] 进程内编码器初始化失败: {e}");
                            }
                        },
                        Err(e) => {
                            self.encoder_init_failed = true;
                            eprintln!("[录屏] FFmpeg DLL 加载失败: {e}");
                        }
                    }
                }
            }
        }
        // 初始化 start_instant（首帧锚定时间基准）
        if self.start_instant.is_none() {
            self.start_instant = Some(std::time::Instant::now());
        }

        // 进程内 GPU 缩放/裁剪：在「自建设备」上把 WGC 帧（经共享句柄跨设备映射，仅当帧纹理可共享时）
        // 缩到 out_w×out_h 产 RGBA，仅 DO_NOT_WAIT 读回 ~8MB（4K 场景跳过 33MB 整帧读回 + CPU 缩放）。
        // 仅当本机 WGC 帧纹理可共享时生效；否则 new() 预筛直接回退，由 CPU 兜底产出 RGBA 并永久禁用
        // GPU 路（gpu_failed）。失败则本帧不写（latest 保留上一帧）。
        let payload: Option<Arc<Vec<u8>>> = if self.encoder.is_some() {
            // 进程内编码器路径：GPU NV12 转换在下方 convert_to_nv12 单独完成，避免双重 GPU 转换
            None
        } else if self.gpu_nv12 && !self.gpu_failed {
            if self.gpu.is_none() && !self.gpu_failed {
                match GpuNv12Converter::new(
                    frame.device(),
                    frame.desc().MiscFlags,
                    fw,
                    fh,
                    self.out_w,
                    self.out_h,
                    frame.desc().Format,
                    self.crop,
                ) {
                    Ok(g) => self.gpu = Some(g),
                    Err(e) => {
                        self.gpu_failed = true;
                        eprintln!("[录屏] GPU 缩放转换器初始化失败，停止 GPU 路径: {e}");
                    }
                }
            }
            if let Some(gpu) = self.gpu.as_mut() {
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
                // convert 现为非阻塞读回：Ok(true)=本帧产出；Ok(false)=GPU 未就绪、无产出
                // （读回延迟约 1 帧，节拍器继续复用上一帧 latest，无感知差异）
                let produced = {
                    let p = Arc::get_mut(&mut buf).expect("刚取得的缓冲必为独占引用");
                    p.clear();
                    match gpu.convert(frame.as_raw_texture(), p) {
                        Ok(v) => v,
                        Err(e) => {
                            // GPU 路径彻底失效（自检/运行时全零）→ 标记并不再重试，
                            // 本帧起回退到 RGBA 读回路径，保证至少能产出真实画面（绝不再绿屏）。
                            eprintln!("[录屏] GPU 缩放转换失败，永久回退 RGBA 读回: {e}");
                            self.gpu_failed = true;
                            self.gpu = None;
                            false
                        }
                    }
                };
                if produced {
                    Some(buf)
                } else {
                    // 本帧无产出：缓冲归还对象池，避免池被抽干后反复重新分配
                    if let Ok(mut fl) = self.free.lock() {
                        if fl.len() < 4 {
                            fl.push(buf);
                        }
                    }
                    None
                }
            } else {
                None
            }
        } else {
            // 原 RGBA 路径（区域裁剪 / 未启用 GPU 转换）：缓冲从池中复用
            let mut payload = self
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
            {
                let p = Arc::get_mut(&mut payload).expect("刚取得的缓冲必为独占引用");
                // 快速 RGBA 读回（纯 memcpy / 最近邻重采样，零逐像素颜色计算，绝不阻塞捕获线程）。
                // GPU 转换器只做缩放/裁剪并输出 RGBA，故两条路径字节布局一致；颜色转换（RGB→NV12）
                // 统一交给 ffmpeg 的 SIMD 完成——既快又正确。无论 GPU 是否成功，产出尺寸恒等于
                // (out_w,out_h)，与 ffmpeg 的 -s 严格一致，杜绝尺寸错配损坏视频 / 旧版慢转换导致丢帧。
                let buffer = frame.buffer().map_err(|e| e.to_string())?;
                let src = buffer.as_nopadding_buffer(&mut self.scratch);
                let ow = self.out_w as usize;
                let oh = self.out_h as usize;
                // 常见路径（无裁剪且尺寸已一致，如 1080p 全屏）：直接 memcpy，零开销。
                if self.crop.is_none() && fw as usize == ow && fh as usize == oh {
                    p.extend_from_slice(src);
                } else {
                    // 罕见路径（GPU 失败 / 区域录制 / 4K 降采样）：最近邻重采样到 (out_w,out_h)，
                    // 与 GPU 路径输出尺寸严格一致（含区域录制时把裁剪区拉伸到输出尺寸）。
                    rgba_resize_crop_nearest(src, fw as usize, fh as usize, self.crop, ow, oh, p);
                }
            }
            Some(payload)
        };

        // 完整 L0 路径：同设备 GPU 缩放（不需要共享句柄，故本机可用）→ 只读回 8MB RGBA → 进程内编码器
        // 把 BGRA 转 NV12。WGC 帧纹理不可共享，故用同设备 CopyResource（GpuSameDeviceScaler），而非需要
        // 共享句柄、本机必失败的 GpuNv12Converter（每帧 0x80070057 → 31MB CPU 读回 + CPU 缩放 → 卡顿/粘滞）。
        // 同设备 GPU 缩放失败时回退 WGC 原生 RGBA 读回 + CPU 缩放。
        if self.encoder.is_some() {
            let fmt = frame.desc().Format;
            let mut gpu_produced = false;
            // 首帧懒创建同设备 GPU 缩放器（仅当尚未失败）
            if self.gpu_scaler.is_none() && !self.gpu_failed {
                let device = frame.device();
                // ⚠️ 这里拿到的是「WGC 捕获设备的唯一即时上下文」，windows-capture 内部（frame.buffer()
                // 等）也在用它，而 ID3D11DeviceContext 默认非线程安全。必须开启多线程保护，否则我们的
                // Draw/Map 与库内部命令并发会互相破坏状态（表现为画面错乱或静默不出帧）。
                if let Ok(mt) = device.cast::<ID3D11Multithread>() {
                    let _ = unsafe { mt.SetMultithreadProtected(true) };
                }
                match unsafe { device.GetImmediateContext() } {
                    Ok(ctx) => match GpuSameDeviceScaler::new(
                        &device,
                        &ctx,
                        fw,
                        fh,
                        self.out_w,
                        self.out_h,
                        fmt,
                        self.crop,
                    ) {
                        Ok(s) => {
                            self.gpu_scaler = Some(s);
                            eprintln!(
                                "[录屏] GPU 同设备缩放已启用：{}x{} → {}x{}，每帧只读回 ~{:.1}MB（无跨设备共享）",
                                fw, fh, self.out_w, self.out_h,
                                (self.out_w as f64 * self.out_h as f64 * 4.0) / 1048576.0
                            );
                        }
                        Err(e) => {
                            self.gpu_failed = true;
                            eprintln!("[录屏] GPU 同设备缩放器初始化失败，回退 RGBA 读回: {e}");
                        }
                    },
                    Err(e) => {
                        self.gpu_failed = true;
                        eprintln!("[录屏] 取同设备即时上下文失败，回退 RGBA 读回: {e}");
                    }
                }
            }
            // 同设备 GPU 缩放（GPU 内 4K→1080p，只读回 8MB RGBA；Map 阻塞强制 GPU 完成，安全拷出帧纹理）
            if !self.gpu_failed {
                if let Some(scaler) = self.gpu_scaler.as_mut() {
                    let need = (self.out_w as usize) * (self.out_h as usize) * 4;
                    if self.gpu_rgba.capacity() < need {
                        self.gpu_rgba.reserve(need);
                    }
                    match scaler.scale(frame.as_raw_texture(), &mut self.gpu_rgba) {
                        Ok(true) => {
                            gpu_produced = true;
                            self.gpu_stat_ok += 1;
                        }
                        Ok(false) => {
                            // GPU 未就绪，本帧跳过（不回退）。持续跳过 = 空视频，必须能看见。
                            self.gpu_stat_skip += 1;
                        }
                        Err(e) => {
                            eprintln!("[录屏] GPU 同设备缩放失败，回退 RGBA 读回: {e}");
                            self.gpu_failed = true;
                        }
                    }
                    // 每 120 帧打一次进出统计，用于定位「录出来是空视频」到底断在哪一环
                    let total = self.gpu_stat_ok + self.gpu_stat_skip;
                    if total > 0 && total % 120 == 0 {
                        eprintln!(
                            "[录屏] GPU 缩放统计: 产出={} 跳过={}",
                            self.gpu_stat_ok, self.gpu_stat_skip
                        );
                    }
                }
            }
            if gpu_produced {
                self.video_started.store(true, Ordering::SeqCst); // 音频时间轴对齐
                let pts = self.start_instant.map(|s| s.elapsed().as_micros() as i64).unwrap_or(0);
                if let Some(ref encoder) = self.encoder {
                    // ⚠️ 色序：GPU 渲染目标恒为 R8G8B8A8_UNORM（28），且像素着色器已把 BGRA 源
                    // swizzle 成 RGBA，所以这里必须传 28，不能透传原始帧格式（BGRA=87），否则红蓝互换。
                    encoder.feed_rgba(&self.gpu_rgba, self.out_w, self.out_h, pts, 28);
                }
                return Ok(());
            }
            // ── CPU 兜底：WGC 原生 RGBA 读回 + CPU 缩放/转 NV12（同设备 GPU 缩放失败时）──
            if self.gpu_failed {
                let pts = self.start_instant.map(|s| s.elapsed().as_micros() as i64).unwrap_or(0);
                let mut rgba = self
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
                {
                    let p = Arc::get_mut(&mut rgba).expect("刚取得的缓冲必为独占引用");
                    p.clear();
                    let buffer = match frame.buffer() {
                        Ok(b) => b,
                        Err(e) => {
                            eprintln!("[录屏] RGBA 读回失败，本帧丢弃: {e}");
                            return Ok(());
                        }
                    };
                    let src = buffer.as_nopadding_buffer(&mut self.scratch);
                    let ow = self.out_w as usize;
                    let oh = self.out_h as usize;
                    // 与旧路径一致：尺寸一致且无裁剪则直接 memcpy，否则最近邻重采样
                    if self.crop.is_none() && fw as usize == ow && fh as usize == oh {
                        p.extend_from_slice(src);
                    } else {
                        rgba_resize_crop_nearest(src, fw as usize, fh as usize, self.crop, ow, oh, p);
                    }
                }
                if let Some(ref encoder) = self.encoder {
                    self.video_started.store(true, Ordering::SeqCst); // 音频时间轴对齐
                    encoder.feed_rgba(&rgba, self.out_w, self.out_h, pts, fmt.0 as u32);
                }
                if let Ok(mut fl) = self.free.lock() {
                    if fl.len() < 4 {
                        fl.push(rgba);
                    }
                }
                return Ok(());
            }
            return Ok(());
        }

        // 旧管线：非阻塞写入最新帧槽（Arc 覆盖，瞬时返回；绝不阻塞回调）
        if let Some(payload) = payload {
            if let Ok(mut slot) = self.latest.lock() {
                let old = std::mem::replace(
                    &mut *slot,
                    Some(CapturedFrame {
                        data: payload,
                        ts: std::time::Instant::now(),
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
        }
        Ok(())
    }
}

/// 全局录屏句柄（管理 ffmpeg 进程 / 进程内编码器 + 捕获线程 + 节拍器写入线程）
struct RecordingHandle {
    ffmpeg_child: Option<Child>,
    capture_thread: Option<std::thread::JoinHandle<()>>,
    /// 写入（consumer）线程：唯一持有 ffmpeg stdin，按编码器吞吐从通道取帧 write_all。
    /// 投帧节拍器（producer）已解耦为独立线程（用有界通道衔接），不被编码器背压门控。
    /// 检测到 stop_flag → producer 退出 → 通道排空 → 本线程 EOF → ffmpeg 刷新编码器输出文件。
    writer_thread: Option<std::thread::JoinHandle<()>>,
    /// 系统声音采集句柄（Rust WASAPI 回环 → 命名管道）。None 表示仅录视频。
    audio: Option<AudioCapture>,
    stop_flag: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    start_time: SystemTime,
    output_path: String,
    /// 完整 L0：进程内编码器（懒初始化完成后由 WGC 回调写入此句柄）
    encoder: Arc<Mutex<Option<Arc<AvEncoder>>>>,
}

/// 全局录屏状态
static RECORDING: Mutex<Option<RecordingHandle>> = Mutex::new(None);

/// 取全局录屏锁。用 `unwrap_or_else(into_inner)` 容忍中毒：命令处理函数持锁期间若 panic 会毒化
/// Mutex，普通 `.unwrap()` 会让此后所有录屏命令永久崩（须重启才恢复）；容毒可保证录屏功能不被
/// 单次 panic 拖垮。中毒仅意味着「曾有线程持锁时 panic」，状态可能不一致，但优于整体不可用。
fn recording_lock() -> std::sync::MutexGuard<'static, Option<RecordingHandle>> {
    RECORDING.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 解析 ffmpeg 可执行文件路径：
/// 1. 优先使用 external-deps/全局/ffmpeg/ffmpeg.exe（随应用打包，无需用户安装）
/// 2. 回退到系统 PATH 中的 ffmpeg（用户自行安装）
pub fn get_ffmpeg_path(app: &AppHandle) -> String {
    if let Some(dir) = crate::commands::get_ffmpeg_dir(app) {
        let ffmpeg = dir.join("ffmpeg.exe");
        if ffmpeg.exists() {
            return ffmpeg.to_string_lossy().to_string();
        }
    }
    "ffmpeg".to_string() // 回退到系统 PATH
}

/// 检查 ffmpeg 是否可用（bundled 或系统安装）
fn check_ffmpeg_with(path: &str) -> bool {
    let mut cmd = std::process::Command::new(path);
    cmd.arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    cmd.status().is_ok()
}

/// 探测可用的硬件加速 H.264 编码器（按优先级 nvenc > qsv > amf）。
///
/// 4K 录屏用 libx264（CPU 软编码）会打满所有核心，导致「整个电脑都卡卡的」、
/// 录屏控制台（WebView2）因抢不到 CPU 而无法交互。硬件编码器把编码卸载到 GPU，
/// CPU 占用骤降，录屏期间系统依旧流畅。无硬件编码器时返回 None，调用方回退 libx264。
/// 探测可用的硬件加速 H.264 编码器（按优先级 nvenc > qsv > amf）。
///
/// **关键修复（录屏 0 字节 / 自测失败根因）**：旧实现只在 `-encoders` 列表里 grep 名字，
/// 但「列表里有」≠「运行时能用」。例如本机 N 卡驱动过旧（支持 nvenc API 13.0，而 ffmpeg
/// 需要 13.1 / 驱动 610+），`h264_nvenc` 在列表里能看到，但真正初始化时 ffmpeg 直接异常退出
/// → 录屏产出 0 字节、自测 `交付帧数=4 输出体积=0 ffmpeg退出正常=false`。
/// 因此这里**真正跑一次极小编码测试**验证运行时能否初始化，只有能初始化成功的编码器才被选用；
/// 全部失败则回退 libx264（软件编码，4K 也能用，只是更吃 CPU）。
pub fn probe_hw_encoder(ffmpeg: &str) -> Option<&'static str> {
    // 优先级：N 卡 nvenc（独显，极快）> Intel qsv（核显）> AMD amf。nvenc 可用时一律优先，
    // 因其吞吐远高于 qsv，能稳定跑满 30/60fps 且不被编码器背压门控（根治快进/卡顿）。
    let candidates: &[&str] = &["h264_nvenc", "h264_qsv", "h264_amf"];
    let mut nvenc_reason: Option<String> = None;
    for &enc in candidates {
        if encoder_listed(ffmpeg, enc) {
            match encoder_runtime_ok(ffmpeg, enc) {
                Ok(()) => return Some(enc),
                Err(reason) => {
                    if enc == "h264_nvenc" {
                        nvenc_reason = Some(reason);
                    }
                }
            }
        }
    }
    if nvenc_reason.is_some() {
        let _ = NVENC_SKIP_REASON.get_or_init(|| nvenc_reason);
    }
    None
}

/// CPU 兜底：把（裁剪后的）源 RGBA 最近邻重采样到 (dw,dh)，使产出尺寸恒等于 (out_w,out_h)，
/// 与 GPU 路径输出尺寸严格一致，避免 GPU 运行时失败→尺寸/内容错配损坏视频。
/// 仅在 GPU 转换器初始化/运行时失败的罕见路径触发；正常路径走 GPU，不经此。
/// 快速 memcpy 路径（无裁剪且尺寸已一致）在调用处单独处理，不经此函数。
fn rgba_resize_crop_nearest(
    src: &[u8],
    fw: usize,
    fh: usize,
    crop: Option<(u32, u32, u32, u32)>,
    dw: usize,
    dh: usize,
    out: &mut Vec<u8>,
) {
    out.clear();
    out.resize(dw * dh * 4, 0);
    let (ox, oy, cw, ch) = match crop {
        Some((cx, cy, cw, ch)) => (
            (cx as usize).min(fw),
            (cy as usize).min(fh),
            (cw as usize).min(fw.saturating_sub((cx as usize).min(fw))),
            (ch as usize).min(fh.saturating_sub((cy as usize).min(fh))),
        ),
        None => (0, 0, fw, fh),
    };
    if cw == 0 || ch == 0 || dw == 0 || dh == 0 {
        return;
    }
    for y in 0..dh {
        let fy = (y as f64 + 0.5) / dh as f64;
        let sy = ((oy as f64 + fy * ch as f64).floor() as usize).min(fh - 1);
        for x in 0..dw {
            let fx = (x as f64 + 0.5) / dw as f64;
            let sx = ((ox as f64 + fx * cw as f64).floor() as usize).min(fw - 1);
            let si = (sy * fw + sx) * 4;
            let di = (y * dw + x) * 4;
            out[di..di + 4].copy_from_slice(&src[si..si + 4]);
        }
    }
}

/// 进程内缓存硬件编码器探测结果：硬件编码器不会热插拔，进程生命周期内稳定。
/// 每次录制若都跑 3×0.2s 编码探测（≈0.6s）会拖慢「点开始→真正出帧」的响应，
/// 且游戏刚启动时抢占 GPU/CPU 队列；缓存后仅首次录制探测一次。直接助力 <200ms 启动目标。
static HW_ENCODER: OnceLock<Option<&'static str>> = OnceLock::new();
fn cached_hw_encoder(ffmpeg: &str) -> Option<&'static str> {
    *HW_ENCODER.get_or_init(|| probe_hw_encoder(ffmpeg))
}

/// 进程内 GPU RGBA 缩放（D3D11 渲染管线）能力探针，结果进程级缓存。
/// 仅验证「本机 D3D11 设备能否渲染」；跨设备共享 WGC 帧的能力需在运行时按帧纹理 MiscFlags 判定
/// （见 GpuNv12Converter::new 的预筛）。在可共享的机器上启用后，4K→1080p 缩放搬到显卡、只读回 8MB；
/// 不可共享时（如本机）由 CPU 兜底，探针通过与否不影响正确性。
pub(crate) fn nv12_in_process_supported() -> bool {
    gpu_nv12::nv12_in_process_supported()
}

/// 编码器是否在 ffmpeg 的 `-encoders` 列表中出现。
fn encoder_listed(ffmpeg: &str, enc: &str) -> bool {
    let mut cmd = std::process::Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-encoders"])
        .stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let out = cmd.output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).contains(enc),
        Err(_) => false,
    }
}

/// nvenc 被跳过的原因（驱动过旧等），供诊断/前端提示用户「升级驱动以启用独显」。
static NVENC_SKIP_REASON: OnceLock<Option<String>> = OnceLock::new();

/// 读取「nvenc 因何被跳过」的诊断原因（若有）。
pub fn nvenc_skip_reason() -> Option<String> {
    NVENC_SKIP_REASON.get().cloned().flatten()
}

/// **运行时**能否用该编码器真正编码一帧（验证驱动 / 授权等是否支持）。
/// 返回 `Result<(), String>`：失败时携带可读原因（如 N 卡驱动过旧导致 nvenc API 不匹配），
/// 供诊断提示用户升级驱动以启用独显。用 lavfi 极小分辨率跑 0.2s 编码到 null，成功才算可用。
fn encoder_runtime_ok(ffmpeg: &str, enc: &str) -> Result<(), String> {
    let mut cmd = std::process::Command::new(ffmpeg);
    cmd.args([
            "-hide_banner", "-y", "-f", "lavfi", "-i", "nullsrc=s=640x480",
            "-t", "0.2", "-c:v", enc, "-f", "null", "-",
        ])
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    match cmd.output() {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr);
            let line = err
                .lines()
                .find(|l| {
                    l.contains("nvenc")
                        || l.contains("NVENC")
                        || l.contains("driver")
                        || l.contains("Error")
                })
                .unwrap_or("未知原因（编码器初始化失败）")
                .trim()
                .to_string();
            Err(format!("{} 运行期初始化失败: {}", enc, line))
        }
        Err(e) => Err(format!("{} 启动失败: {}", enc, e)),
    }
}


/// 启动录屏
///
/// 参数：
/// - `output_path`：输出 MP4 文件路径
/// - `fps`：帧率（默认 30）
/// - `monitor_index`：显示器索引（默认 0 = 主屏），仅当 region 为 None 时使用
/// - `region_x/y/w/h`：录制区域（虚拟桌面物理像素坐标）。四个均为 `Some` 且 w>0、h>0 时
///   视为有效区域；任一为 `None` 或尺寸非正 → 退化为全屏。
///
/// **设计说明（关键！）**：旧实现用 `region: Option<Vec<i32>>` 传 `[x,y,w,h]` 数组，
/// 但 Tauri v2 IPC 把 JS 数组反序列化成 `Vec<i32>` 会在某些场景下**静默回退为 None**
/// （与 tuple 同样的坑），导致区域录制退化成全屏录制——这正是「选了区域却录全屏」的根因。
/// 改用 4 个独立的 `Option<i32>` 参数，i32 是 Tauri 序列化最稳妥的类型，彻底消除该风险。
/// 取系统默认播放设备（扬声器/耳机）的端点 id，用于 WASAPI 回环采集「正在播放的声音」。
/// 失败返回 None（此时录屏不带声音，视频照常）。best-effort，绝不阻断录制。
#[cfg(windows)]
fn default_render_endpoint_id() -> Option<String> {
    use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
    unsafe {
        // spawn_blocking 工作线程通常未初始化 COM；MTA 模型下 MMDeviceEnumerator 可用。
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: IMMDeviceEnumerator = match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[录屏] 创建 IMMDeviceEnumerator 失败，跳过声音: {e:?}");
                return None;
            }
        };
        let device = match enumerator.GetDefaultAudioEndpoint(eRender, eConsole) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[录屏] 取默认播放端点失败，跳过声音: {e:?}");
                return None;
            }
        };
        let id = match device.GetId() {
            Ok(id) => id,
            Err(e) => {
                eprintln!("[录屏] 取端点 id 失败，跳过声音: {e:?}");
                return None;
            }
        };
        // id 形如 "{0.0.0.00000000}.{...}"，手动转 UTF-16 字符串（泄露小幅内存，可接受）。
        let mut s = String::new();
        let mut p = id.0;
        while *p != 0 {
            s.push(char::from_u32_unchecked(*p as u32));
            p = p.add(1);
        }
        if s.is_empty() {
            None
        } else {
            eprintln!("[录屏] 系统声音设备 id: {s}");
            Some(s)
        }
    }
}

#[cfg(not(windows))]
fn default_render_endpoint_id() -> Option<String> {
    None
}

/// ffmpeg 是否支持 wasapi 输入设备。很多精简打包版 ffmpeg 不含 wasapi demuxer，
/// 若直接加 `-f wasapi` 会让 ffmpeg 报 “Unknown input format 'wasapi'” 并异常退出，
/// 导致整段录制失败。结果缓存，避免每次录制都跑一次 `ffmpeg -devices`。
static FFMPEG_WASAPI: OnceLock<bool> = OnceLock::new();
fn ffmpeg_supports_wasapi(ffmpeg_path: &str) -> bool {
    *FFMPEG_WASAPI.get_or_init(|| {
        let out = std::process::Command::new(ffmpeg_path)
            .args(["-hide_banner", "-devices"])
            .output();
        match out {
            Ok(o) => String::from_utf8_lossy(&o.stdout).contains("wasapi"),
            Err(_) => false,
        }
    })
}

/// 解析可用的系统声音输入串（如 `audio=@{endpoint-id}`），best-effort 且全程缓存。
/// 返回 None 表示不加音频（仅录视频）。判定链：
///   1) ffmpeg 支持 wasapi demuxer；
///   2) 能取到默认播放设备端点 id（WASAPI）；
///   3) ffmpeg 能真正打开该设备（`-t 0.2 -f null` 实测），避免「列表有 wasapi 但本机打开失败」
///      仍导致整段录制失败。任一环节失败都退回 None，绝不阻断录制。
static AUDIO_INPUT: OnceLock<Option<String>> = OnceLock::new();
pub(crate) fn resolve_audio_input(ffmpeg_path: &str) -> Option<String> {
    AUDIO_INPUT
        .get_or_init(|| {
            if !ffmpeg_supports_wasapi(ffmpeg_path) {
                return None;
            }
            let id = default_render_endpoint_id()?;
            let probe = std::process::Command::new(ffmpeg_path)
                .args([
                    "-hide_banner",
                    "-f",
                    "wasapi",
                    "-i",
                    &format!("audio=@{}", id),
                    "-t",
                    "0.2",
                    "-f",
                    "null",
                    "-",
                ])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
            match probe {
                Ok(s) if s.success() => Some(format!("audio=@{}", id)),
                _ => None,
            }
        })
        .clone()
}

/// 是否启用实验性「原生 WGC」捕获路径（方案 A）。
///
/// 默认关闭：稳定路径是 windows-capture（WgcRecorder）纯 RGBA 读回，无黑屏、无每帧
/// 阻塞读回卡顿。本机实测原生路径表现为黑屏 + 操作时粘滞 + 输出卡顿，故降级为实验。
/// 仅当设置环境变量 `ANDY_NATIVE_WGC=1` 后重启应用才会尝试原生路径；其初始化失败会
/// 自动回退 windows-capture，不会 brick 录制。详见 research_report_recording_review.md。
fn native_wgc_enabled() -> bool {
    std::env::var("ANDY_NATIVE_WGC")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    output_path: String,
    fps: Option<u32>,
    monitor_index: Option<usize>,
    region_x: Option<i32>,
    region_y: Option<i32>,
    region_w: Option<i32>,
    region_h: Option<i32>,
) -> Result<(), String> {
    // async + spawn_blocking：将 ffmpeg 检测、显示器枚举、进程启动等阻塞操作移至线程池，
    // 避免阻塞主线程导致 UI 冻结（卡死）。
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        // 检查 ffmpeg（优先 bundled，回退系统 PATH）
        let ffmpeg_path = get_ffmpeg_path(&app);
        if !check_ffmpeg_with(&ffmpeg_path) {
            return Err("未检测到 ffmpeg，无法录屏。请在系统中安装 ffmpeg 后重试。".into());
        }

        // 默认 60fps：高刷屏（144Hz 游戏等）下降采样到 60 仍均匀平滑，且 60fps 比 30fps
        // 在时间分辨率上更接近高刷源，肉眼更难察觉顿挫。无硬件编码器（纯 libx264）时
        // 60fps 软编码更吃 CPU，但属可接受代价；硬件编码器（nvenc/qsv/amf）下毫无压力。
        let mut fps = fps.unwrap_or(30);
        // 帧率安全上限在编码器选定（hw）后计算：见下方 cached_hw_encoder 之后。

        // 确保输出目录存在：videoDir 可能被重定向或不存在，若不先建目录，
        // ffmpeg 打开输出文件失败 → 编码 0 字节 / 进程异常退出 → stop_recording 走 Err 分支
        // → 根本不 emit recording-stopped → 前端保存面板永远不弹（表现为「录屏完全没效果」）。
        if let Some(parent) = std::path::Path::new(&output_path).parent() {
            if !parent.as_os_str().is_empty() {
                let _ = std::fs::create_dir_all(parent);
            }
        }

        // 检查是否已在录制
        {
            let recording = recording_lock();
            if recording.is_some() {
                return Err("已在录制中，请先停止当前录制".into());
            }
        }

        // 解析 region：4 个独立 Option<i32> → (rx, ry, rw, rh)
        // 全部为 Some 且尺寸为正才视为有效区域，否则退化全屏（并打日志便于排查）
        let region_parsed: Option<(i32, i32, i32, i32)> = match (region_x, region_y, region_w, region_h) {
            (Some(rx), Some(ry), Some(rw), Some(rh)) if rw > 0 && rh > 0 => {
                eprintln!("[录屏] region=[{},{},{},{}]", rx, ry, rw, rh);
                Some((rx, ry, rw, rh))
            }
            _ => {
                eprintln!(
                    "[录屏] region 未提供或无效: x={:?} y={:?} w={:?} h={:?}，回退全屏",
                    region_x, region_y, region_w, region_h
                );
                None
            }
        };

        // 获取显示器 + 计算裁剪区域 + 编码尺寸
        let monitors = Monitor::enumerate().map_err(|e| format!("枚举显示器失败: {}", e))?;
        let total = monitors.len();

        let (monitor, crop, enc_w, enc_h) = if let Some((rx, ry, rw, rh)) = region_parsed {
            // 找到包含区域原点的显示器
            let mon = monitors
                .into_iter()
                .find(|m| {
                    let (ml, mt, mr, mb) = monitor_rect_phys(m);
                    rx >= ml && rx < mr && ry >= mt && ry < mb
                })
                .ok_or_else(|| {
                    eprintln!("[录屏] 区域原点 ({},{}) 不在任何显示器范围内", rx, ry);
                    "录制区域不在任何显示器范围内".to_string()
                })?;
            let (ml, mt, _, _) = monitor_rect_phys(&mon);
            let crop_offset = Some((
                (rx - ml) as u32,
                (ry - mt) as u32,
                rw as u32,
                rh as u32,
            ));
            // 【全屏归一化】前端「全屏」模式也会传整屏矩形 region。若区域恰好覆盖整个显示器，
            // 归一化为 crop=None（等价于全屏）：恢复 1080p 屏的零拷贝 memcpy 快路径，
            // 也让日志正确显示「全屏录制」。
            let (_, _, mr2, mb2) = monitor_rect_phys(&mon);
            let mon_w = (mr2 - ml) as u32;
            let mon_h = (mb2 - mt) as u32;
            let is_full_monitor =
                rx == ml && ry == mt && rw as u32 == mon_w && rh as u32 == mon_h;
            let crop_offset = if is_full_monitor { None } else { crop_offset };
            if is_full_monitor {
                eprintln!("[录屏] region 覆盖整屏 → 归一化为全屏录制 {}x{}", mon_w, mon_h);
            } else {
                eprintln!("[录屏] 区域录制: crop=({},{},{},{})", rx - ml, ry - mt, rw, rh);
            }
            (mon, crop_offset, rw as u32, rh as u32)
        } else {
            let idx = monitor_index.unwrap_or(0);
            let mon = monitors
                .into_iter()
                .nth(idx)
                .ok_or_else(|| format!("无效的显示器索引: {}（共 {} 个显示器）", idx, total))?;
            let info = monitor_rect_phys(&mon);
            let w = (info.2 - info.0) as u32;
            let h = (info.3 - info.1) as u32;
            if w == 0 || h == 0 {
                return Err("显示器分辨率无效".into());
            }
            eprintln!("[录屏] 全屏录制: monitor[{}] {}x{}", idx, w, h);
            (mon, None, w, h)
        };

        // H.264 (libx264) 要求宽高为偶数。向下取整避免超出捕获区域，
        // 同时调整 crop 以匹配 enc_w/enc_h（裁剪数据字节数必须与 ffmpeg 预期帧大小一致）。
        let enc_w = enc_w & !1;
        let enc_h = enc_h & !1;
        let crop = crop.map(|(cx, cy, cw, ch)| (cx, cy, cw & !1, ch & !1));
        if enc_w == 0 || enc_h == 0 {
            return Err("录制区域尺寸过小（取整后为 0）".into());
        }

        // 计算录屏区域边框窗的物理像素矩形（精确贴合实际录制区域）。
        // 区域录制：显示器物理原点 + 裁剪偏移；全屏：整个显示器矩形。
        let (mon_l, mon_t, _, _) = monitor_rect_phys(&monitor);
        let (border_x, border_y, border_w, border_h) = match crop {
            Some((cx, cy, cw, ch)) => (
                mon_l + cx as i32,
                mon_t + cy as i32,
                cw,
                ch,
            ),
            None => {
                let info = monitor_rect_phys(&monitor);
                (info.0, info.1, (info.2 - info.0) as u32, (info.3 - info.1) as u32)
            }
        };

        // 选择编码器：优先硬件加速（nvenc/qsv/amf），避免 4K 软编码打满 CPU 导致整机卡顿；
        // 无硬件编码器时回退 libx264（ultrafast）。
        let hw = cached_hw_encoder(&ffmpeg_path);
        // 若独显 nvenc 因驱动过旧被跳过，打印可读原因，提示用户升级驱动以启用独显（根治卡顿/快进）。
        if let Some(reason) = nvenc_skip_reason() {
            eprintln!("[录屏] 独显 nvenc 不可用（{}）；已回退到 {}", reason, hw.unwrap_or("libx264"));
        }
        // 帧率安全上限：编码器跟不上目标帧率时，pacer 会被编码器背压门控→实际投帧速率<
        // 目标 fps→有界通道耗尽后 tx.send 阻塞→cfr 复制最近帧补齐→观感一顿一顿（见 2026-07-28
        // 录屏 ffmpeg.log：h264_qsv 1080p 实测 speed 仅 0.87x）。故按所选编码器给定「可持续帧率」
        // 封顶，留出余量使编码永远跟得上投帧、背压不发生。
        // 实测：本机 h264_qsv 1080p 约 0.87x 实时（含 RGBA→NV12 CPU 转换 + 31MB/帧读回争用），
        // 0.87×30≈26fps < 30 → 必背压；封顶 24 则 0.87×30≈26 > 24 → 无背压、输出真 24fps 流畅。
        // nvenc 独显能力强保留 60；AMF/软件→30。
        let safe_fps: u32 = match hw {
            Some("h264_nvenc") => 60,
            Some("h264_qsv") => 24,
            Some("h264_amf") => 30,
            _ => 30,
        };
        fps = fps.min(safe_fps);
        // 无硬件编码器时软编码 60fps 必卡 → 自动降到 30fps（用户要求最低 30）；
        // 有硬件编码器时由上方 safe_fps 封顶（nvenc 保留 60，qsv 封顶 24）。
        if hw.is_none() {
            fps = fps.min(30);
        }
        // 系统声音（best-effort）：优先 ffmpeg 原生 wasapi 回环采集「正在播放的声音」
        // （需打包 ffmpeg 含 wasapi demuxer，即「全量版」ffmpeg；精简版 essentials 不含，会探测失败）。
        // 全量 ffmpeg 直接 `-f wasapi -i audio=@{设备}` 采集，最稳定。若 ffmpeg 无 wasapi（仍用精简版），
        // 则回退到 Rust 侧 WASAPI 回环采集经命名管道喂给 ffmpeg。任一不可用均静默仅录视频，绝不阻断录制。
        // 音视频同步信号：视频 producer 锚定首帧时置位，音频采集线程等待它再启动时间轴，
        // 使音/视频共用同一时间原点，消除「音画不同步」。producer 见下方捕获段、音频见 audio_capture.rs。
        let video_started = Arc::new(AtomicBool::new(false));

        // 进程内 libavcodec 编码器是否可用（FFmpeg 共享 DLL 已就位即走「完整 L0」）
        // 用统一 ffmpeg 目录解析（dev=external-deps/全局/ffmpeg；release=user_external_deps/全局/ffmpeg，.mujin 解压后）。
        let ffmpeg_dep_dir = crate::commands::get_ffmpeg_dir(&app);
        let inprocess_available = ffmpeg_dep_dir
            .as_ref()
            .and_then(|p| p.to_str())
            .map(|s| ffi::init_ffmpeg(Some(s)).is_ok())
            .unwrap_or(false);
        if !inprocess_available {
            eprintln!(
                "[录屏] FFmpeg 共享 DLL 未加载（目录 {:?}），回退旧 ffmpeg 子进程路径",
                ffmpeg_dep_dir
            );
        }

        // 音频输入（best-effort）：
        // - 进程内路径：音频经 mpsc 通道直接喂进程内 AAC，绝不启动命名管道（没有 ffmpeg 子进程可读管道）。
        // - 旧路径：优先 ffmpeg 原生 wasapi 回环；否则 Rust 侧 WASAPI 回环写命名管道。
        let (audio_wasapi, audio_pipe): (Option<String>, Option<(AudioCapture, String, AudioFormat)>) =
            if inprocess_available {
                (None, None)
            } else if let Some(dev) = resolve_audio_input(&ffmpeg_path) {
                (Some(dev), None)
            } else {
                match start_audio_capture(video_started.clone()) {
                    Ok(triple) => (None, Some(triple)),
                    Err(e) => {
                        eprintln!("[录屏] 系统声音采集不可用，仅录视频（无声音）: {e}");
                        (None, None)
                    }
                }
            };
        if inprocess_available {
            eprintln!("[录屏] 走进程内 libavcodec 编码器（完整 L0，无 ffmpeg 子进程）");
        } else if audio_wasapi.is_some() {
            eprintln!("[录屏] 已加入系统声音（ffmpeg 原生 WASAPI 回环）");
        } else if let Some((_c, _p, f)) = &audio_pipe {
            eprintln!("[录屏] 已加入系统声音（Rust WASAPI 回环，命名管道；{} {}ch {}Hz）", f.sample_fmt, f.channels, f.rate);
        }
        // 进程内 GPU 缩放是否可用（仅当本机 D3D11 渲染可用且 WGC 帧纹理可共享才真正生效；否则 CPU 兜底）。
        // 若生效，4K→1080p 缩放搬到显卡、只读回 8MB RGBA，省去 33MB 整帧读回 + CPU 缩放。
        // 无论 GPU 是否生效，4K 全屏都先在捕获侧缩到 1080p（GPU 在显卡 / CPU 用最近邻兜底），ffmpeg 始终
        // 1080p 编码——避免「GPU 不可用时误编码 4K」导致占用高、文件大。
        let native_w = enc_w;
        let native_h = enc_h;
        // 【关键修复】前端在「全屏」模式下也会把整屏矩形当 region 传进来（crop 恒为 Some），
        // 旧条件 `crop.is_none() && …` 会把 4K 全屏误判为「区域录制」而跳过降采样 →
        // 以原生 4K 编码（QSV 4K 仅 ~0.75x 实时 → 背压卡顿 + 16Mbps 大文件）。
        // GPU 着色器与 CPU 兜底（rgba_resize_crop_nearest）均原生支持「裁剪+缩放」同时进行，
        // 故只需按实际编码区域像素量判断：任何 >1080p 的区域一律降到 1080p 编码。
        let downscale_4k = (native_w as u64) * (native_h as u64) > 1920u64 * 1080u64;
        // 进程内 GPU RGBA→NV12 转码（含区域裁剪）对本机所有支持 D3D11 渲染管线的硬件均为 true。
        // 区域录制也走 GPU：着色器只采样子矩形、直接输出裁剪后 NV12，绕开「整帧 33MB 读回 + CPU 裁剪」。
        // 进程内编码器需要 NV12 输入：只要走完整 L0（FFmpeg 共享 DLL 已就位）就启用 GPU BGRA→NV12
        // （不可共享时由 CPU 兜底），否则按 D3D11 能力探针决定。
        let gpu_nv12 = inprocess_available || nv12_in_process_supported();
        // 喂给 ffmpeg 的尺寸：4K 全屏一律先降到 1080p（无论 GPU 还是 CPU 兜底路径，产出都 = out_w×out_h
        // = 1080p），故 ffmpeg 永远以 1080p 编码——既避免「GPU 不可用时误编码 4K」导致占用高 / 文件大，
        // 也保证两条路径字节尺寸一致。GPU 路把「4K→1080p 缩放」搬到显卡；GPU 不可用时由 CPU 兜底
        // （rgba_resize_crop_nearest）在捕获侧完成同样缩放，ffmpeg 端 scale=iw:ih 为恒等、仅做色彩转换。
        let (feed_w, feed_h) = if downscale_4k {
            let mut ow = 1920u32;
            let mut oh = (((1920.0 * native_h as f64 / native_w as f64) / 2.0).round() as u32) * 2;
            ow &= !1;
            oh &= !1;
            (ow, oh)
        } else {
            (native_w, native_h)
        };
        let enc_w = feed_w;
        let enc_h = feed_h;
        // 缩放已在捕获侧完成（GPU 在显卡 / CPU 用 rgba_resize_crop_nearest 兜底），喂给 ffmpeg 的永远是
        // (out_w,out_h)=1080p，故下方 scale=iw:ih 为恒等缩放、仅做 RGB→NV12 色彩转换，开销极小。
        let enc_hw = hw;
        let mut ffmpeg_args: Vec<String> = vec!["-y".into()];
        ffmpeg_args.extend([
            "-f".into(),
            "rawvideo".into(),
            "-pix_fmt".into(),
            // 进程内 GPU 转换器与 CPU 兜底路径现在都统一产出 RGBA（GPU 只做缩放/裁剪、颜色转换交给
            // ffmpeg）。无论 GPU 是否成功，喂给 ffmpeg 的永远是尺寸正确、格式统一（RGBA）的帧——
            // 捕获线程仅在 GPU 路径做极快拷贝（或 CPU 路径做纯 memcpy），绝不做逐像素转换，
            // 因此录制始终平滑、颜色始终正确。RGBA→NV12 由下方 -vf format=nv12（SIMD）完成。
            "rgba".into(),
            "-s".into(),
            format!("{}x{}", enc_w, enc_h),
            // 时间戳策略（2026-07-22 终修正）：用 -fps_mode cfr（恒定帧率）取代 passthrough 与
            // wallclock。cfr 让 ffmpeg 忽略「管道写入节奏 / 编码背压」，严格按 -r fps 为每帧生成
            // 均匀 PTS（n×1/fps），并在输入跟不上时自动复制最近帧、过快时丢帧，从而无论 qsv 编码器
            // 多慢（本机 1080p 仅 ~13fps，见自测 speed=0.43x）输出时长都严格 = 真实录制墙钟、
            // 帧间隔均匀、绝不快进；音频（WASAPI 墙钟）同为真实墙钟 → 音画天然同步。
            // 旧方案 passthrough 用「写出计数 i」打点：编码器慢 → write_all 阻塞 → 实际写出帧数
            // < fps×时长 → 末帧 PTS=实际帧数/fps 远小于真实时长 → 视频被压成快进（即此前加速根因）。
            // 旧方案 -use_wallclock_as_timestamps 用「管道读取墙钟」打点：编码背压使 ffmpeg 突发读取
            // → 时间戳成簇/拉伸 → 卡顿 + 音画差。cfr 二者皆避。
            "-r".into(),
            fps.to_string(),
            "-i".into(),
            "-".into(), // 视频来自 stdin 管道（RGBA 帧）
        ]);
        // 系统声音输入（视频为第 0 路、音频为第 1 路）：
        // 优先 ffmpeg 原生 WASAPI；否则 Rust WASAPI 采集的命名管道。
        if let Some(ref dev) = audio_wasapi {
            ffmpeg_args.extend([
                "-f".into(),
                "wasapi".into(),
                "-i".into(),
                dev.clone(),
            ]);
        } else if let Some((_cap, apath, afmt)) = &audio_pipe {
            ffmpeg_args.extend([
                "-f".into(),
                afmt.sample_fmt.into(),
                "-ar".into(),
                afmt.rate.to_string(),
                "-ac".into(),
                afmt.channels.to_string(),
                "-i".into(),
                apath.clone(),
            ]);
        }
        // 视频滤镜（统一在 CPU 以 SIMD 完成 RGBA→NV12）：桌面 RGBA 是 full-range sRGB（BT.709 矩阵），
        // H.264 标准消费 limited-range 的 BT.709 NV12。旧实现未指定矩阵/范围，swscale 默认按 BT.601
        // SD 矩阵 + 不处理 range → 偏色（蓝/红偏移、整体偏亮）。这里用 scale 滤镜显式声明
        // in_color_matrix=bt709 / in_range=full / out_range=limited 触发正确转换，再 format=nv12。
        // 尺寸已在捕获侧缩放到 (out_w,out_h)，故 scale=iw:ih 为恒等缩放（仅触发色彩转换，开销极小）。
        let vf = "scale=iw:ih:in_color_matrix=bt709:in_range=full:out_range=limited,format=nv12".to_string();
        ffmpeg_args.extend(["-vf".into(), vf]);
        // 把色彩元数据写入容器 VUI，确保播放器按 BT.709 limited 解码（否则部分播放器二次偏色）。
        ffmpeg_args.extend([
            "-color_range".into(),
            "tv".into(),
            "-colorspace".into(),
            "bt709".into(),
            "-color_trc".into(),
            "bt709".into(),
        ]);
        // 目标码率（Mbps）：硬件编码器（nvenc/qsv/amf）的 constqp/global_quality(ICQ)/cqp 模式
        // **没有码率上限**，4K 游戏录制能产生几十~上百 Mbps，几分钟即数 GB（「文件非常大」的真源）。
        // 这里按输出分辨率+帧率给一个合理上限（VBR + maxrate/bufsize 兜底），静态桌面会远低于此、
        // 高动态场景也不会爆。ICQ/CQP 改为带 b:v 封顶的 VBR，画质基本不变、体积可控。
        let enc_pixels = (enc_w as u64) * (enc_h as u64);
        let target_mbps: u32 = if enc_pixels >= 5_000_000 {
            // 4K 区域录制（全屏 4K 已由 downscale_4k 降到 1080p，不会命中此档）：封顶 16Mbps。
            if fps >= 40 { 32 } else { 16 }
        } else if enc_w >= 1920 || enc_h >= 1080 {
            // 1080p（含 1920x1020 等非标准 1080p 尺寸，按长边判定避免跌破像素阈值误入 4Mbps 档）：
            // 屏幕录制 5Mbps 画质足够、体积可控（用户要求更小文件）。
            if fps >= 40 { 8 } else { 5 }
        } else if enc_pixels >= 900_000 {
            4
        } else {
            3
        };
        // 真值日志：一眼确认实际捕获/输出分辨率、编码器、码率封顶，便于排查「文件大/卡顿」。
        eprintln!(
            "[录屏] 分辨率 捕获{}x{} → 输出{}x{} | 编码器 {} | 帧率 {} | 码率封顶 {}Mbps",
            native_w, native_h, enc_w, enc_h, enc_hw.unwrap_or("libx264"), fps, target_mbps
        );
        let bitrate_arg = format!("{}M", target_mbps);
        let bufsize_arg = format!("{}M", target_mbps * 2);
        match enc_hw {
            Some("h264_nvenc") => {
                // 进程内 GPU 转换器只做缩放/裁剪、输出 RGBA；RGBA→NV12 由下方统一 -vf format=nv12
                // （SIMD，快且正确）完成。nvenc 原生消费 nv12。vbr + cq(质量目标) + b:v/maxrate(封顶)
                // 兼顾画质与体积，根治「无码率上限→文件巨大」。
                ffmpeg_args.extend([
                    "-c:v".into(),
                    "h264_nvenc".into(),
                    "-preset".into(),
                    "p1".into(),
                    "-tune".into(),
                    "ll".into(),
                    "-rc".into(),
                    "vbr".into(),
                    "-cq".into(),
                    "23".into(),
                    "-b:v".into(),
                    bitrate_arg.clone(),
                    "-maxrate".into(),
                    bitrate_arg.clone(),
                    "-bufsize".into(),
                    bufsize_arg.clone(),
                    "-pix_fmt".into(),
                    "yuv420p".into(),
                ]);
                eprintln!("[录屏] 使用硬件编码器 h264_nvenc（码率封顶 {}Mbps，RGBA 输入由 ffmpeg 转 NV12）", target_mbps);
            }
            Some("h264_qsv") => {
                // 进程内 GPU 转换器只做缩放/裁剪、输出 RGBA；RGBA→NV12 由统一 -vf format=nv12 完成，
                // qsv 原生消费 nv12（见 stderr "auto-selecting format 'nv12'"）。旧实现用
                // -global_quality(=ICQ 无码率上限) 是「文件非常大」的根因；改为 vbr + b:v/maxrate 封顶，
                // 画质几乎不变、体积可控。
                ffmpeg_args.extend([
                    "-c:v".into(),
                    "h264_qsv".into(),
                    "-preset".into(),
                    "veryfast".into(),
                    "-rc".into(),
                    "vbr".into(),
                    "-b:v".into(),
                    bitrate_arg.clone(),
                    "-maxrate".into(),
                    bitrate_arg.clone(),
                    "-bufsize".into(),
                    bufsize_arg.clone(),
                    "-pix_fmt".into(),
                    "yuv420p".into(),
                ]);
                eprintln!("[录屏] 使用硬件编码器 h264_qsv（码率封顶 {}Mbps，RGBA 输入由 ffmpeg 转 NV12）", target_mbps);
            }
            Some("h264_amf") => {
                ffmpeg_args.extend([
                    "-c:v".into(),
                    "h264_amf".into(),
                    "-quality".into(),
                    "speed".into(),
                    "-rc".into(),
                    "vbr_peak".into(),
                    "-b:v".into(),
                    bitrate_arg.clone(),
                    "-maxrate".into(),
                    bitrate_arg.clone(),
                    "-bufsize".into(),
                    bufsize_arg.clone(),
                    "-pix_fmt".into(),
                    "yuv420p".into(),
                ]);
                eprintln!("[录屏] 使用硬件编码器 h264_amf（码率封顶 {}Mbps，GPU 编码）", target_mbps);
            }
            _ => {
                ffmpeg_args.extend([
                    "-c:v".into(),
                    "libx264".into(),
                    "-preset".into(),
                    "ultrafast".into(),
                    "-crf".into(),
                    "23".into(),
                    "-maxrate".into(),
                    bitrate_arg.clone(),
                    "-bufsize".into(),
                    bufsize_arg.clone(),
                    "-pix_fmt".into(),
                    "yuv420p".into(),
                ]);
                eprintln!(
                    "[录屏] 未检测到硬件编码器，回退 libx264（码率封顶 {}Mbps；4K 可能仍较吃 CPU）",
                    target_mbps
                );
                // 4K 降采样已并入统一的 -vf（need_fallback_scale 时 scale=1920:-2,format=nv12），
                // 此处不再单独追加滤镜，避免与统一滤镜冲突。
            }
        }
        // 音视频映射：视频取自 stdin 管道（第 0 路输入），音频取自 WASAPI 或命名管道（第 1 路输入，若有）。
        if audio_wasapi.is_some() || audio_pipe.is_some() {
            // -shortest 保证视频管道 EOF 后 ffmpeg 即退出，不被实时音频输入挂起。
            ffmpeg_args.extend([
                "-map".into(),
                "0:v:0".into(),
                "-map".into(),
                "1:a:0".into(),
                "-c:a".into(),
                "aac".into(),
                "-b:a".into(),
                "192k".into(),
                "-shortest".into(),
            ]);
        } else {
            ffmpeg_args.extend(["-map".into(), "0:v:0".into()]);
        }
        // 时间戳策略（2026-07-22 终修正）：用 cfr（恒定帧率）。此前注释称「cfr 在本机挂起」实为
        // 音频命名管道死锁（静音断流）的误判——该死锁已用「静音补帧」根治，与 fps_mode 无关。
        // cfr 让 ffmpeg 严格按 -r fps 均匀打点、自动复制/丢帧以对齐真实时长，从根本杜绝「编码器慢
        // 导致 passthrough 按写出计数打点→时长被压成快进」与「wallclock 突发读取→卡顿/音画差」。
        // 配合 pacer 恒定 1/fps 节奏写出，输出时长严格 = 真实录制墙钟、音画同步、绝不快进。
        ffmpeg_args.extend(["-fps_mode".into(), "cfr".into()]);
        ffmpeg_args.extend(["-movflags".into(), "+faststart".into(), output_path.clone()]);

        // ── 完整 L0 预检：ffmpeg 共享 DLL 可用 → 进程内编码器，否则回退子进程 ──
        // 复用上方 ffmpeg_dep_dir（统一解析 dev/ release），避免 init_ffmpeg(None) 自动探测漏掉 user_external_deps。
        let enc_cfg: Option<EncoderConfig> = match ffi::init_ffmpeg(ffmpeg_dep_dir.as_ref().and_then(|p| p.to_str())) {
            Ok(()) => {
                let mbps_bps = (target_mbps as u32) * 1_000_000;
                eprintln!("[录屏] ffmpeg 共享 DLL 已加载，尝试完整 L0 进程内编码器 ({}x{} {}fps {}Mbps)", enc_w, enc_h, fps, target_mbps);
                Some(EncoderConfig {
                    output_path: output_path.clone(),
                    width: enc_w,
                    height: enc_h,
                    fps,
                    bitrate: mbps_bps,
                    gop: fps * 2,
                    audio_enabled: audio_wasapi.is_some() || audio_pipe.is_some(),
                    audio_sample_rate: 48000,
                    audio_channels: 2,
                })
            }
            Err(e) => {
                eprintln!("[录屏] ffmpeg 共享 DLL 未找到（{}），回退旧 ffmpeg 子进程路径", e);
                None
            }
        };
        let encoder_handle: Arc<Mutex<Option<Arc<AvEncoder>>>> = Arc::new(Mutex::new(None));
        let enc_handle_for_flags = encoder_handle.clone();

        let use_av_encoder = enc_cfg.is_some();

        // 进程内「完整 L0」编码器：提前建好并放入共享句柄；音频经 mpsc 通道桥接喂入（无 ffmpeg 子进程）。
        let mut inprocess_audio_cap: Option<AudioCapture> = None;
        if let Some(cfg) = enc_cfg.clone() {
            match start_audio_capture_channel(video_started.clone()) {
                Ok((cap, fmt, audio_rx)) => {
                    inprocess_audio_cap = Some(cap);
                    let mut cfg2 = cfg;
                    cfg2.audio_enabled = true;
                    cfg2.audio_sample_rate = fmt.rate;
                    cfg2.audio_channels = fmt.channels;
                    match AvEncoder::new(cfg2, Some(AudioSource { fmt })) {
                        Ok(enc) => {
                            if let Ok(mut g) = encoder_handle.lock() {
                                *g = Some(enc.clone());
                            }
                            // 桥接线程：音频 PCM 通道 → 进程内编码器（非阻塞，编码线程停则退出）
                            let enc_bridge = enc.clone();
                            let _ = std::thread::Builder::new()
                                .name("av-audio-bridge".into())
                                .spawn(move || {
                                    while let Ok(bytes) = audio_rx.recv() {
                                        if !enc_bridge.feed_audio(bytes) {
                                            break;
                                        }
                                    }
                                });
                        }
                        Err(e) => {
                            eprintln!("[录屏] 进程内编码器(带音频)创建失败，回退仅视频: {e}");
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[录屏] 进程内音频通道不可用，仅录视频: {e}");
                    match AvEncoder::new(cfg, None) {
                        Ok(enc) => {
                            if let Ok(mut g) = encoder_handle.lock() {
                                *g = Some(enc);
                            }
                        }
                        Err(e) => eprintln!("[录屏] 进程内编码器(无音频)创建失败: {e}"),
                    }
                }
            }
        }

        // 启动 ffmpeg 进程（stdin 管道接收 RGBA 帧）—— 完整 L0 时跳过
        let mut child: Option<Child> = None;
        let mut stdin_opt: Option<std::process::ChildStdin> = None;

        let stop_flag = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));

        if !use_av_encoder {
            let mut cmd = Command::new(&ffmpeg_path);
            cmd.args(&ffmpeg_args)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(match std::fs::File::create(format!("{}.ffmpeg.log", output_path)) {
                    Ok(f) => Stdio::from(f),
                    Err(_) => Stdio::null(),
                });
            #[cfg(windows)]
            cmd.creation_flags(0x08000000);
            let mut c = cmd.spawn()
                .map_err(|e| format!("启动 ffmpeg 失败: {}（请确认 ffmpeg 已安装）", e))?;
            stdin_opt = c.stdin.take();
            child = Some(c);
        }

        // 共享「最新帧槽」：WGC 回调非阻塞覆盖写入（保留最新、丢弃最旧），pacer 按呈现时间取用。
        let latest: Arc<Mutex<Option<CapturedFrame>>> = Arc::new(Mutex::new(None));
        // 帧缓冲对象池：WGC 回调复用已分配的 Vec，避免 4K 每帧 ~33MB 分配触发分配器周期性停顿（卡顿主因）。
        let free: Arc<Mutex<Vec<Arc<Vec<u8>>>>> = Arc::new(Mutex::new(Vec::new()));

        // 节拍器（producer）线程 + 独立的写入（consumer）线程，用有界通道解耦：
        // producer 按恒定 1/fps 真实墙钟节奏把帧塞入通道，永不被慢编码器门控（try_send 满则
        // 丢瞬时帧；稳态下通道近空，丢弃极罕见）；consumer 唯一持有 ffmpeg stdin，按编码器吞吐
        // 从通道取帧 write_all。配合 -fps_mode cfr：输出帧数=真实墙钟表数 → 时长严格=真实录制
        // 墙钟、绝不快进；音频(WASAPI 墙钟)同为真实墙钟 → 音画同步。这是根治此前「pacer 用
        // write_all 直写 stdin 被编码器背压门控→实际投帧速率 < 目标 fps→cfr 按帧数打点→视频被
        // 压成快进（顽固的加速现象）」的关键。暂停段从时间基准扣除，恢复后节奏连续、无补帧爆发。
        let mut writer_thread: Option<std::thread::JoinHandle<()>> = None;
        if !use_av_encoder {
            let pacer_latest = latest.clone();
            let pacer_stop = stop_flag.clone();
            let pacer_paused = paused.clone();
            let pacer_video_started = video_started.clone();
            let frame_dur = std::time::Duration::from_secs_f64(1.0 / (fps.max(1) as f64));
            // 有界通道：容量=数秒缓冲，足以吸收瞬时编码抖动；稳态近空，内存占用极低。
            let chan_cap = ((fps as usize) * 2).clamp(30, 120);
            let (tx, rx) = mpsc::sync_channel::<Arc<Vec<u8>>>(chan_cap);
        // —— producer（投帧节拍器）：恒定墙钟节奏，不碰 stdin、永不被编码器门控 ——
        let producer_thread = std::thread::spawn(move || {
            let mut start: Option<std::time::Instant> = None; // 首帧到达才锚定，避免开场空闲计入时长
            let mut last: Option<Arc<Vec<u8>>> = None; // 最近投出帧（采集跟不上时用于补帧）
            let mut pause_begin: Option<std::time::Instant> = None;
            let mut i: u64 = 0;
            loop {
                if pacer_stop.load(Ordering::SeqCst) {
                    break;
                }
                if pacer_paused.load(Ordering::SeqCst) {
                    // 暂停：不投帧；记录暂停起点，恢复时把暂停时长从时间基准扣除。
                    if pause_begin.is_none() {
                        pause_begin = Some(std::time::Instant::now());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(5));
                    continue;
                } else if let Some(pb) = pause_begin.take() {
                    // 恢复：时间基准顺延暂停时长，并重置 last 为最新帧，避免恢复瞬间补帧爆发。
                    if let Some(s) = pacer_latest.lock().ok().and_then(|s| s.clone()) {
                        last = Some(s.data);
                    }
                    if let Some(st) = start {
                        start = Some(st + pb.elapsed());
                    }
                }
                // 取最新帧（Arc 克隆零拷贝）；尚无则沿用上一帧（保持）；都无则空等首帧。
                let frame = pacer_latest.lock().ok().and_then(|s| s.clone()).map(|cf| cf.data);
                let to_write = frame.or_else(|| last.clone());
                if to_write.is_none() {
                    // 首帧未到：睡到本拍目标时刻再试，不推进 i（避免首帧前的空闲被计入时长）。
                    if let Some(st) = start {
                        let target = st + frame_dur * (i as u32 + 1);
                        let now = std::time::Instant::now();
                        if target > now {
                            std::thread::sleep(target - now);
                        }
                    } else {
                        std::thread::sleep(std::time::Duration::from_millis(2));
                    }
                    continue;
                }
                let data = to_write.unwrap();
                last = Some(data.clone());
                if start.is_none() {
                    start = Some(std::time::Instant::now()); // 首帧锚定时间基准
                    pacer_video_started.store(true, Ordering::SeqCst); // 通知音频线程：视频时间原点已定
                }
                // 恒定节拍：睡到本帧应投出时刻，保证 producer 以稳定 1/fps 节奏投帧（让 cfr 拿到
                // 均匀到达的输入，复制/丢帧决策最稳）。若因编码背压已落后（target <= now），从当前
                // 时刻起睡一个 frame_dur 恢复稳定节奏；try_send 满则丢瞬时帧（cfr 据相邻帧补点），
                // 绝不阻塞等编码器——这是「pacer 不再被编码器门控」的核心。
                let st = start.unwrap();
                let target = st + frame_dur * (i as u32 + 1);
                let now = std::time::Instant::now();
                if target > now {
                    std::thread::sleep(target - now);
                } else {
                    std::thread::sleep(frame_dur);
                }
                let _ = tx.try_send(data); // 不阻塞：编码器慢→通道暂满→丢瞬时帧，时长仍正确
                i += 1;
            }
            // producer 退出 → tx drop → consumer 收完通道剩余帧后收到 EOF
        });
        // —— consumer（写入线程）：唯一持有 ffmpeg stdin，按编码器吞吐取帧写出 ——
        writer_thread = Some(std::thread::spawn(move || {
            loop {
                match rx.recv() {
                    Ok(data) => {
                        if let Some(ref mut s) = stdin_opt {
                            if s.write_all(&data).is_err() {
                                eprintln!("[录屏] 写 ffmpeg stdin 失败（ffmpeg 已退出或管道断开），停止投帧");
                                break;
                            }
                        } else {
                            break;
                        }
                    }
                    Err(_) => break, // producer 已结束且通道排空 → EOF
                }
            }
            // 循环结束：stdin 于此作用域 drop，关闭管道触发 ffmpeg EOF
        }));
        // producer 不参与停止时的 join（detach）：stop_flag 触发后自行退出、tx drop，consumer 自然收尾。
        drop(producer_thread);
        } // end if !use_av_encoder

        // 启动 WGC 捕获线程
        let latest_for_capture = latest.clone();
        let stop_for_capture = stop_flag.clone();
        let paused_for_capture = paused.clone();
        let capture_thread = std::thread::spawn(move || {
            // 捕获最小更新间隔限制为「目标 fps」：WGC 最多每 1/fps 秒投一帧，
            // 与恒定输入帧率对齐 → 输出严格均匀（极致平滑），同时把高刷显示器
            // （144Hz）下涌入的超额帧砍掉，显著降低每帧 ~33MB 的 CPU 拷贝/分配压力
            // （极致优化：4K 录制 CPU 占用随帧率线性下降，整机依旧丝滑）。
            // 脏区域机制（DirtyRegionSettings::Default）保留：内容不变时不投帧，
            // 静态幻灯片/桌面零开销；仅在有变化时按上限 fps 投帧。
            // 注意：**不要**用 Custom(Duration::ZERO) 强制满帧率——会绕过此限流，
            // 4K RGBA 在 60fps 下每帧 ~33MB 拷贝吃满 CPU，导致录屏卡顿、区域选择覆盖窗
            // 的 JS 线程与 200ms 实时刷新被饿死（表现为「窗口识别只识别一个 / 鼠标无效」）。
            let cap_interval = std::time::Duration::from_millis((1000 / fps.max(1)) as u64);
            // —— 默认路径：windows-capture（WgcRecorder）纯 RGBA 读回。这是历史「惊艳版本」
            // 的管线：稳定、无黑屏、无每帧阻塞读回卡顿（对比原生 GPU 路径在本机表现为黑屏 +
            // 卡顿）。原生 WGC（方案 A）已降级为实验特性，仅 ANDY_NATIVE_WGC=1 时尝试，
            // 失败仍回退本路径，绝不 brick。详见 research_report_recording_review.md。
            let native_on = gpu_nv12 && native_wgc_enabled();
            if native_on {
                match wgc_native::run_native_capture(
                    wgc_native::NativeCaptureParams {
                        hmonitor: monitor.as_raw_hmonitor() as isize,
                        fps,
                        out_w: enc_w,
                        out_h: enc_h,
                        crop,
                    },
                    latest_for_capture.clone(),
                    stop_for_capture.clone(),
                    paused_for_capture.clone(),
                    free.clone(),
                ) {
                    Ok(()) => return, // 正常运行至 stop，捕获线程结束
                    Err(e) => {
                        eprintln!("[录屏] 原生 WGC 初始化失败，回退 windows-capture 捕获: {e}")
                    }
                }
            }
            let settings = Settings::new(
                monitor,
                CursorCaptureSettings::Default,
                // 关闭 WGC 默认黄框：该边框画在「捕获项（整块显示器）」边界上，
                // 区域录屏时裁剪发生在 ffmpeg 阶段，故黄框永远显示全屏边缘而非录制区域。
                // 去掉后区域录屏不再有误导性的全屏黄框。
                DrawBorderSettings::WithoutBorder,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Custom(cap_interval),
                DirtyRegionSettings::Default,
                ColorFormat::Rgba8,
                // 完整 L0：走进程内 libavcodec 时启用 GPU BGRA→NV12（含 4K 内降采样），
                // 帧直接喂进程内 nvenc，去掉 ffmpeg 子进程与 stdin 字节管道。
                // gpu_nv12 在 enc_cfg.is_some() 时恒为 true；仅当 D3D11 转换探针失败才回退 CPU。
                (latest_for_capture, stop_for_capture, paused_for_capture, crop, free.clone(), gpu_nv12, downscale_4k, (enc_w, enc_h), enc_cfg.clone(), enc_handle_for_flags, video_started.clone()),
            );
            if let Err(e) = WgcRecorder::start(settings) {
                eprintln!("[录屏] WGC 捕获异常: {}", e);
            }
            // 捕获结束：WgcRecorder 在此 drop
        });

        // 取出 Rust 音频采集句柄（仅命名管道路径有；ffmpeg 原生 WASAPI 无需此句柄），
        // 移入全局录屏句柄，停止录制时一并关闭管道/线程。
        // 进程内路径：音频采集句柄（mpsc 通道）也需随 RecordingHandle 释放；旧路径用命名管道句柄
        let audio_cap = inprocess_audio_cap.take().or_else(|| audio_pipe.map(|(cap, _p, _f)| cap));
        // 保存录屏句柄
        *recording_lock() = Some(RecordingHandle {
            ffmpeg_child: child,
            capture_thread: Some(capture_thread),
            writer_thread,
            audio: audio_cap,
            stop_flag,
            paused,
            start_time: SystemTime::now(),
            output_path: output_path.clone(),
            encoder: encoder_handle,
        });

        // 通知前端开始录制
        let _ = app.emit("recording-started", &output_path);

        // 显示并精确定位录屏区域边框窗（透明、点击穿透、排除捕获，仅作屏幕可视化提示）。
        // 边框紧贴实际录制区域，替代 WGC 默认（总是画整屏边缘、误导性的）黄框。
        if let Some(bw) = app.get_webview_window(RECORDING_BORDER_LABEL) {
            let _ = bw.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                x: border_x,
                y: border_y,
            }));
            let _ = bw.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                width: border_w,
                height: border_h,
            }));
            // 按实际录制区域大小重设「画框」区域，确保内部真正镂空、点击穿透
            if let Ok(hwnd) = bw.hwnd() {
                unsafe { set_border_region(hwnd.0 as HWND, border_w as i32, border_h as i32) };
            }
            let _ = bw.show();
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("录屏任务执行失败: {}", e))?
}

/// 停止录屏，返回输出文件路径
///
/// **关键修复（区域录屏卡死）**：
/// 旧实现是 sync `#[tauri::command]`，在主线程执行 `thread.join()`（无超时的阻塞调用）
/// + `child.wait_timeout(10s)`。如果捕获线程卡住（WGC 消息循环未退出），`join()` 永远
/// 阻塞 → 主线程冻结 → 整个应用卡死。
///
/// 修复方案：
/// 1. 改为 `async fn` + `spawn_blocking`：阻塞操作在线程池执行，主线程（UI）不受影响
/// 2. **不 join 捕获线程**（detach）：设 stop_flag 后捕获线程会在下一帧自动退出
/// 3. 关闭 stdin（try_lock + 短暂重试，避免与捕获线程的 write_all 死锁）
/// 4. 等待 ffmpeg 退出（最多 5s），超时则 kill 进程
/// 5. stderr 已改为 `Stdio::null()`，不会因管道满导致 ffmpeg 阻塞
#[tauri::command]
pub async fn stop_recording(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        // **关键修复（保存秒结束 / 巨大录屏不再被 kill）**：
        // 旧实现在命令内 `wait_timeout(5s)` 阻塞等 ffmpeg 封装完成才返回——巨大录屏
        // 封装/快启（faststart 重写 moov）远超 5s → 被强制 kill，文件丢失；且前台
        // 「卡一下」（控制台窗口冻结等待）。现改为：停止信号一发即返回，ffmpeg 封装交给
        // 后台监视线程，结束后再广播「最终」事件；同时立即广播 `recording-saving` 占位，
        // 让前端显示「录屏文件保存中」，绝不静默。
        let mut handle = {
            let mut handle_opt = recording_lock();
            handle_opt
                .take()
                .ok_or_else(|| "未在录制中".to_string())?
        };

        // 立即隐藏录屏区域边框窗：停止即时生效，红框立刻消失、不再拦截点击。
        if let Some(bw) = app.get_webview_window(RECORDING_BORDER_LABEL) {
            let _ = bw.hide();
        }

        // 1. 设置停止标志 → WGC 下一帧回调中 stop() 捕获 → 捕获线程退出；
        //    节拍器线程亦在下一拍（≤1/fps）检测到 stop_flag 后退出 → stdin 于此 drop
        //    → ffmpeg 收到 EOF 刷新编码器输出文件。
        handle.stop_flag.store(true, Ordering::SeqCst);

        // 2. detach 捕获线程与节拍器线程：均在检测到 stop_flag 后自行退出，无需 join（避免阻塞 UI）。
        drop(handle.capture_thread.take());
        drop(handle.writer_thread.take());

        let output_path = handle.output_path.clone();
        let audio_cap = handle.audio.take();

        // 尝试取出进程内编码器（完整 L0 路径）
        let av_encoder = handle.encoder.lock().ok().and_then(|mut g| g.take());

        // 立即广播「保存中」占位
        let _ = app.emit(
            "recording-saving",
            serde_json::json!({ "path": &output_path, "status": "saving" }),
        );

        let app2 = app.clone();
        let out_path = output_path.clone();

        if let Some(encoder) = av_encoder {
            // ── 完整 L0 路径：进程内编码器停止（stop 支持 &self）──
            std::thread::spawn(move || {
                encoder.stop();
                if let Ok(meta) = std::fs::metadata(&out_path) {
                    if meta.len() <= 1024 {
                        let _ = app2.emit("recording-stopped", "");
                        let _ = app2.emit("recording-error", "录制文件异常（体积过小）");
                    } else {
                        let _ = app2.emit("recording-stopped", &out_path);
                    }
                } else {
                    let _ = app2.emit("recording-stopped", &out_path);
                }
                if let Some(mut a) = audio_cap {
                    a.stop();
                }
            });
        } else if let Some(mut child) = handle.ffmpeg_child.take() {
            // ── 旧 ffmpeg 子进程路径 ──
            std::thread::spawn(move || {
                let ffmpeg_log_tail = std::fs::read_to_string(format!("{}.ffmpeg.log", out_path))
                    .map(|s| {
                        let t = s.trim();
                        if t.len() > 1500 {
                            format!("…{}", &t[t.len() - 1500..])
                        } else {
                            t.to_string()
                        }
                    })
                    .unwrap_or_default();
                match child.wait_timeout(std::time::Duration::from_secs(120)) {
                    Ok(Some(status)) => {
                        if !status.success() {
                            let _ = app2.emit("recording-stopped", "");
                            let _ = app2.emit(
                                "recording-error",
                                format!("ffmpeg 编码失败（进程异常退出）。ffmpeg 日志：\n{}", ffmpeg_log_tail),
                            );
                            return;
                        }
                        if let Ok(meta) = std::fs::metadata(&out_path) {
                            if meta.len() <= 1024 {
                                let _ = app2.emit("recording-stopped", "");
                                let _ = app2.emit(
                                    "recording-error",
                                    format!("录制文件异常（体积过小）。ffmpeg 日志：\n{}", ffmpeg_log_tail),
                                );
                                return;
                            }
                        }
                        let _ = app2.emit("recording-stopped", &out_path);
                    }
                    Ok(None) => {
                        eprintln!("[录屏] ffmpeg 120s 内未退出，强制终止");
                        let _ = child.kill();
                        let _ = child.wait();
                        let _ = app2.emit("recording-stopped", "");
                        let _ = app2.emit("recording-error", "ffmpeg 编码超时，已强制终止");
                    }
                    Err(e) => {
                        let _ = app2.emit("recording-stopped", "");
                        let _ = app2.emit("recording-error", format!("等待 ffmpeg 结束失败: {}", e));
                    }
                }
                if let Some(mut a) = audio_cap {
                    a.stop();
                }
            });
        } else {
            return Err("录制会话异常（无编码器、无 ffmpeg 进程）".into());
        }

        // 命令立即返回（不再阻塞）：前台「停止」即刻完成，文件在后台封装。
        Ok(output_path)
    })
    .await
    .map_err(|e| format!("停止录屏任务失败: {}", e))?
}

/// 暂停录制
#[tauri::command]
pub fn pause_recording() -> Result<(), String> {
    let recording = recording_lock();
    let handle = recording.as_ref().ok_or("未在录制中")?;
    handle.paused.store(true, Ordering::SeqCst);
    Ok(())
}

/// 恢复录制
#[tauri::command]
pub fn resume_recording() -> Result<(), String> {
    let recording = recording_lock();
    let handle = recording.as_ref().ok_or("未在录制中")?;
    handle.paused.store(false, Ordering::SeqCst);
    Ok(())
}

/// 获取录屏状态
#[tauri::command]
pub fn get_recording_status() -> RecordingStatus {
    let recording = recording_lock();
    match recording.as_ref() {
        Some(handle) => {
            let elapsed = handle
                .start_time
                .elapsed()
                .map(|d| d.as_secs())
                .unwrap_or(0);
            RecordingStatus {
                is_recording: true,
                is_paused: handle.paused.load(Ordering::SeqCst),
                elapsed_secs: elapsed,
                output_path: handle.output_path.clone(),
            }
        }
        None => RecordingStatus {
            is_recording: false,
            is_paused: false,
            elapsed_secs: 0,
            output_path: String::new(),
        },
    }
}

/// 获取显示器列表（供前端选择录制目标）
#[tauri::command]
pub fn list_recording_monitors() -> Result<Vec<MonitorInfo>, String> {
    let monitors = Monitor::enumerate().map_err(|e| format!("枚举显示器失败: {}", e))?;
    let mut list = Vec::new();
    for (i, mon) in monitors.iter().enumerate() {
        let (l, t, r, b) = monitor_rect_phys(mon);
        list.push(MonitorInfo {
            index: i,
            name: format!("显示器 {}", i + 1),
            x: l,
            y: t,
            width: r - l,
            height: b - t,
        });
    }
    Ok(list)
}

/// 显示器信息（返回给前端）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub index: usize,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// 取显示器物理像素矩形（复用 screenshot.rs 的同名函数逻辑）
pub fn monitor_rect_phys(monitor: &Monitor) -> (i32, i32, i32, i32) {
    unsafe {
        let hmon = monitor.as_raw_hmonitor() as winapi::shared::windef::HMONITOR;
        let mut info: winapi::um::winuser::MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<winapi::um::winuser::MONITORINFO>() as u32;
        winapi::um::winuser::GetMonitorInfoW(hmon, &mut info);
        (
            info.rcMonitor.left,
            info.rcMonitor.top,
            info.rcMonitor.right,
            info.rcMonitor.bottom,
        )
    }
}

/// 显示录屏控制台窗口
///
/// **重要**：本函数为 sync `#[tauri::command]`，在主线程执行。
/// 严禁在此调用 `WebviewWindowBuilder::build()` —— 会触发 WebView2 主线程
/// 「重入死锁」（build 等待的创建完成回调需要被同一消息循环派发，而该命令
/// 闭包正占用着消息循环），导致整个应用卡死（右上角按钮、托盘菜单全部失效）。
///
/// 窗口由 `create_recorder_widget_window` 在 setup 阶段预创建，本函数仅做
/// show + set_focus + 重新定位（避免多显示器切换后位置不正确）。
#[tauri::command]
pub fn show_recorder_widget(app: AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window(RECORDER_WINDOW_LABEL)
        .ok_or_else(|| "录屏控制台窗口未预创建，请重启应用".to_string())?;

    // 重新居中（多显示器切换或分辨率变化后保持正确位置）
    let (screen_w, _screen_h) = screen_size();
    let scale = unsafe {
        let dpi = winapi::um::winuser::GetDpiForSystem();
        if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 }
    };
    let widget_w = 320.0_f64;
    let _widget_h = 52.0_f64;
    let x = (screen_w as f64 / scale - widget_w) / 2.0;
    let y = 8.0_f64; // 距离屏幕顶部 8px
    let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));

    let _ = win.show();
    let _ = win.set_focus();
    Ok(())
}

/// 预创建录屏控制台窗口（隐藏），setup 阶段调用，避免运行时在 sync 命令中
/// 创建 WebView2 窗口导致主线程「重入死锁」（详见 show_recorder_widget 注释）。
pub fn create_recorder_widget_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(RECORDER_WINDOW_LABEL).is_some() {
        return Ok(()); // 已存在则复用
    }

    // 离屏创建（-4000,-4000），实际居中定位由 show_recorder_widget 完成（那里用 win.scale_factor() 算逻辑坐标）。
    let widget_w = 320.0_f64;
    let widget_h = 52.0_f64;

    let _win = WebviewWindowBuilder::new(
        app,
        RECORDER_WINDOW_LABEL,
        WebviewUrl::App("recorder-widget.html".into()),
    )
    .title("录屏")
    .inner_size(widget_w, widget_h)
    .position(-4000.0, -4000.0) // 离屏创建，待 show_recorder_widget 时再定位显示
    .decorations(false)
    .always_on_top(true)
    .transparent(true)
    .resizable(false)
    .shadow(false)
    .visible(true) // 透明(layered)子窗绝不能用 visible:false 创建，否则 WebView2 报 0x8007139F 坏窗
    .data_directory(per_window_data_dir(app, RECORDER_WINDOW_LABEL))
    // 独立环境不继承主窗 flag：禁用遮挡检测/后台化，保证失焦时录制计时等 UI 持续重绘
    .additional_browser_args(crate::services::window_manager::OVERLAY_BROWSER_ARGS)
    .build()
    .map_err(|e| format!("创建录屏控制台失败: {}", e))?;

    // 离屏创建后先隐藏，待 show_recorder_widget 时再显示（避免启动期在主屏闪现 / 出现在任务栏）
    let _ = _win.hide();

    // 将录屏控制台排除在屏幕捕获之外（WDA_EXCLUDEFROMCAPTURE = 0x11）：
    // 操作者屏幕上可见并可点击操作，但 WGC/DXGI 捕获时被跳过 —— 录出的视频里看不到控制台。
    // 与边框窗不同：控制台需要接收点击，故**不**设置 WS_EX_TRANSPARENT 点击穿透。
    if let Some(win) = app.get_webview_window(RECORDER_WINDOW_LABEL) {
        if let Ok(hwnd) = win.hwnd() {
            unsafe {
                winapi::um::winuser::SetWindowDisplayAffinity(hwnd.0 as *mut _, 0x11);
            }
        }
    }

    Ok(())
}

/// 预创建录屏区域边框窗（隐藏），setup 阶段调用。
/// 该窗透明、置顶、点击穿透、且通过 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`
/// 排除在屏幕捕获之外——因此边框只在屏幕上可见、不会录进视频，用于精确提示「正在录制的区域」。
pub fn create_recording_border_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(RECORDING_BORDER_LABEL).is_some() {
        return Ok(()); // 已存在则复用
    }

    let _win = WebviewWindowBuilder::new(
        app,
        RECORDING_BORDER_LABEL,
        WebviewUrl::App("recording-border.html".into()),
    )
    .title("录屏区域")
    .inner_size(100.0, 100.0)
    .position(-4000.0, -4000.0) // 离屏创建，start_recording 时按录制区域定位并显示
    .decorations(false)
    .always_on_top(true)
    .transparent(true)
    .resizable(false)
    .shadow(false)
    .visible(true) // 透明(layered)子窗绝不能用 visible:false 创建，否则 WebView2 报 0x8007139F 坏窗
    .data_directory(per_window_data_dir(app, RECORDING_BORDER_LABEL))
    // 独立环境不继承主窗 flag：禁用遮挡检测/后台化，保证录制中边框持续呈现
    .additional_browser_args(crate::services::window_manager::OVERLAY_BROWSER_ARGS)
    .build()
    .map_err(|e| format!("创建录屏边框窗失败: {}", e))?;

    // 离屏创建后先隐藏，待 start_recording 时再显示
    let _ = _win.hide();

    // 排除在屏幕捕获之外（WDA_EXCLUDEFROMCAPTURE），边框不进入录屏画面；
    // transparent(true) 已由 Tauri 设置 WS_EX_LAYERED，保证窗口背景透明、只显示 CSS 红框。
    if let Some(win) = app.get_webview_window(RECORDING_BORDER_LABEL) {
        if let Ok(hwnd) = win.hwnd() {
            unsafe {
                // WDA_EXCLUDEFROMCAPTURE = 0x11：从 WGC/DXGI 捕获中隐藏本窗
                winapi::um::winuser::SetWindowDisplayAffinity(hwnd.0 as *mut _, 0x11);
                // 画框镂空：仅四周 FRAME 像素属于窗口，内部镂空 → 点击自然穿透（无需透明/子类化 hack）
                set_border_region(hwnd.0 as HWND, 100, 100);
            }
        }
    }

    Ok(())
}

/// 诊断「红框区域内无法操作」：返回边框窗实际 EXSTYLE（是否真的带 WS_EX_TRANSPARENT）、
/// 窗口矩形，以及在录制区域中心点做 `WindowFromPoint` 命中测试，看该点归属于哪个 HWND/类。
/// 若中心点仍归属于本边框窗 → 点击被本窗拦截（未真正穿透）；若归属于别的窗口 → 穿透正常。
#[tauri::command]
pub fn recording_border_probe(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let win = app
        .get_webview_window(RECORDING_BORDER_LABEL)
        .ok_or_else(|| "边框窗不存在（可能未开始录屏）".to_string())?;
    let hwnd = win.hwnd().map_err(|e| e.to_string())?;
    let ex = unsafe {
        winapi::um::winuser::GetWindowLongPtrW(hwnd.0 as *mut _, winapi::um::winuser::GWL_EXSTYLE)
    };
    let has_transparent = (ex & (winapi::um::winuser::WS_EX_TRANSPARENT as isize)) != 0;
    let has_layered = (ex & (winapi::um::winuser::WS_EX_LAYERED as isize)) != 0;
    let rect = unsafe {
        let mut r = winapi::shared::windef::RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        winapi::um::winuser::GetWindowRect(hwnd.0 as *mut _, &mut r);
        r
    };
    let cx = (rect.left + rect.right) / 2;
    let cy = (rect.top + rect.bottom) / 2;
    let hit = unsafe {
        winapi::um::winuser::WindowFromPoint(winapi::shared::windef::POINT { x: cx, y: cy })
    };
    let hit_info = if hit.is_null() {
        "null".to_string()
    } else {
        unsafe {
            let mut buf = [0u16; 256];
            let n = winapi::um::winuser::GetClassNameW(hit, buf.as_mut_ptr(), buf.len() as i32);
            let class = if n > 0 {
                String::from_utf16_lossy(&buf[..n as usize])
            } else {
                "?".into()
            };
            let is_self = hit == hwnd.0 as *mut _;
            format!(
                "hwnd=0x{:X} class={} isBorderSelf={}",
                hit as usize, class, is_self
            )
        }
    };
    let verdict = if has_transparent && hit_info.contains("isBorderSelf=false") {
        "WS_EX_TRANSPARENT 已置位且中心点击穿透到下层窗口 → 穿透正常，问题在别处"
    } else if has_transparent {
        "WS_EX_TRANSPARENT 已置位但中心命中仍归本边框窗 → WebView2 子控件拦截，需 WM_NCHITTEST 返回 HTTRANSPARENT"
    } else {
        "✗ WS_EX_TRANSPARENT 未真正生效（SetWindowLongPtr 后缺 SetWindowPos SWP_FRAMECHANGED）→ 整块区域被拦截"
    };
    Ok(serde_json::json!({
        "exStyle": format!("0x{:X}", ex),
        "hasTransparent": has_transparent,
        "hasLayered": has_layered,
        "rect": format!(
            "{}x{} @({},{})=>({},{})",
            rect.right - rect.left,
            rect.bottom - rect.top,
            rect.left,
            rect.top,
            rect.right,
            rect.bottom
        ),
        "centerPoint": format!("({},{}", cx, cy),
        "hitTestAtCenter": hit_info,
        "verdict": verdict,
    }))
}

/// 隐藏录屏控制台窗口
#[tauri::command]
pub fn hide_recorder_widget(app: AppHandle) {
    if let Some(w) = app.get_webview_window(RECORDER_WINDOW_LABEL) {
        let _ = w.hide();
    }
}

/// 预创建录屏区域选择覆盖窗（隐藏），setup 阶段调用，避免首次使用时 WebView2 初始化卡顿
pub fn create_recorder_select_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(RECORDER_SELECT_LABEL).is_some() {
        return Ok(()); // 已存在则复用
    }

    let (_vx, _vy, vw, vh) = virtual_desktop_rect();
    if vw <= 0 || vh <= 0 {
        return Err("无法获取虚拟桌面尺寸".into());
    }

    // builder API 接受逻辑像素，需将物理像素除以 DPI 缩放比（与 screenshot.rs 的 create_overlay_window 一致）
    let scale = unsafe {
        let dpi = winapi::um::winuser::GetDpiForSystem();
        if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 }
    };
    let lw = vw as f64 / scale;
    let lh = vh as f64 / scale;

    let _win = WebviewWindowBuilder::new(
        app,
        RECORDER_SELECT_LABEL,
        WebviewUrl::App("recorder-select.html".into()),
    )
    .title("选择录屏区域")
    .inner_size(lw, lh)
    .position(-4000.0, -4000.0) // 离屏创建，show_recorder_select 时再定位显示
    .decorations(false)
    .always_on_top(true)
    .transparent(true)
    .resizable(false)
    .visible(true) // 透明(layered)子窗绝不能用 visible:false 创建，否则 WebView2 报 0x8007139F 坏窗
    .shadow(false) // 去除 Windows 11 不可见调整边框，与截图覆盖窗一致
    .data_directory(per_window_data_dir(app, RECORDER_SELECT_LABEL))
    // 独立环境不继承主窗 flag：与其他浮窗保持一致的浏览器参数（禁用遮挡检测/后台化）
    .additional_browser_args(crate::services::window_manager::OVERLAY_BROWSER_ARGS)
    .build()
    .map_err(|e| format!("创建录屏区域选择窗口失败: {}", e))?;

    // 离屏创建后先隐藏，待 show_recorder_select 时再显示
    let _ = _win.hide();

    Ok(())
}

/// 过滤掉本进程的覆盖窗/控制台/截图覆盖窗 hwnd。
/// 这些 fullscreen 或 always-on-top 窗口若出现在列表中会挡住其他窗口的命中测试
/// （overlay 是 fullscreen，hitWindow 总是先命中它 → 区域录屏退化为全屏）。
/// 主窗口（is_self）**不**过滤：用户明确要求"不需要屏蔽"，应允许识别应用主窗口。
pub(crate) fn filter_self_overlay_windows(app: &AppHandle, mut windows: Vec<crate::screenshot::WindowInfo>) -> Vec<crate::screenshot::WindowInfo> {
    // 收集需排除的 hwnd。关键：Tauri 的 `WebviewWindow::hwnd()` 在 Windows 上返回的是
    // WebView2 **子控件**的 HWND，而 `EnumWindows`/`list_windows` 枚举的是**顶层父窗口**
    // HWND —— 二者不同，若只排除子控件 HWND，全屏覆盖窗的顶层窗口仍留在列表里，
    // 于是前端 hitWindow 永远先命中它（fullscreen + always-on-top）→「只能识别一个窗口 /
    // 鼠标移动没用」。因此这里同时排除「raw hwnd」与「其顶层祖先(GA_ROOT)」，确保覆盖窗被剔除。
    let mut excluded: Vec<u64> = Vec::new();
    for &label in crate::screenshot::SELF_OVERLAY_LABELS {
        if let Some(w) = app.get_webview_window(label) {
            if let Ok(h) = w.hwnd() {
                let raw = h.0 as u64;
                excluded.push(raw);
                let hwnd = h.0 as winapi::shared::windef::HWND;
                let root = unsafe { winapi::um::winuser::GetAncestor(hwnd, winapi::um::winuser::GA_ROOT) };
                if !root.is_null() {
                    excluded.push(root as u64);
                }
            }
        }
    }
    windows.retain(|w| !excluded.contains(&w.hwnd));
    windows
}

/// 显示录屏区域选择覆盖窗（全屏透明，用户拖拽选择录制区域）
/// 复用预创建的窗口（setup 阶段已创建），避免每次创建 WebView2 的卡顿
#[tauri::command]
pub fn show_recorder_select(app: AppHandle) -> Result<(), String> {
    // 确保窗口已创建（首次或被销毁后）
    create_recorder_select_window(&app)?;

    let win = app
        .get_webview_window(RECORDER_SELECT_LABEL)
        .ok_or_else(|| "录屏区域选择窗口不存在".to_string())?;

    // 清理上一段录屏遗留的常驻置顶窗（控制台 recorder-widget / 录屏区域边框窗）。
    // 它们 stop 后不会自动隐藏（结果面板需手动关闭），若仍可见会与新选择窗争夺
    // 激活/焦点（set_focus 需先停用上一个置顶窗口）。多次录屏后该竞争会累积，
    // 表现为「首次不卡、频繁启动卡」——截图流程无此常驻置顶窗生命周期，故从不卡。
    // 此处强制隐藏，保证每次打开选择窗都是干净的（隐藏仅收起 UI，后台保存线程不受影响）。
    // 注：去掉 is_visible() 查询（需走 WebView2 IPC，高频调用时累加延迟），直接 hide()。
    //     hide() 对已隐藏窗口为 no-op，速度远快于 IPC 查询。
    if let Some(w) = app.get_webview_window(RECORDER_WINDOW_LABEL) {
        let _ = w.hide();
    }
    if let Some(bw) = app.get_webview_window(RECORDING_BORDER_LABEL) {
        let _ = bw.hide();
    }

    let (vx, vy, vw, vh) = virtual_desktop_rect();
    if vw <= 0 || vh <= 0 {
        return Err("无法获取虚拟桌面尺寸".into());
    }

    // 直接使用 virtual_desktop_rect 作为坐标原点——不读 outer_position()。
    let scale = win.scale_factor().unwrap_or(1.0);

    // 先截桌面快照（窗口此刻仍隐藏 → 截到干净桌面，不含自身透明层），供前端注入 freeze
    // canvas 做不透明底 → 分层窗整窗命中稳，根治「低 alpha 兜底在 4K 合成下被舍入为 0
    // → 鼠标穿透到下层、默认光标、窗口识别卡死」。与截图热键「先截后显」同源。
    crate::screenshot::capture_recorder_snapshot();

    // show + 置顶 + 聚焦 整体包进 run_on_main_thread（set_focus 内部直接 SetForegroundWindow，
    // 不经过 thread_executor；若从 async/命令线程直接调会触发 tao flush_paint_messages panic，
    // 表现为窗口「已显示但未真正激活」：十字光标偶发退回默认箭头、悬停命中测试卡顿，
    // 按任意键触发消息泵/激活后才恢复 —— 即本次「偶尔卡顿」根因。与截图覆盖窗
    // reveal_screenshot_overlay 完全一致，故录屏选窗也须如此）。
    let win_for_show = win.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = win_for_show.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: vx, y: vy }));
        let _ = win_for_show.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: vw as u32, height: vh as u32 }));
        let _ = win_for_show.set_always_on_top(true);
        let _ = win_for_show.show();
        let _ = win_for_show.set_focus();
    });

    // 悬停命中统一走 OS window_at_point（每帧、worker 线程、零 UI 阻塞），结果永远与系统一致、
    // 无 stale 列表问题；已移除 WinEventHook 看门狗与 window-list-changed（覆盖窗可见期间持续
    // EnumWindows 风暴、且 z 序不可靠反而误导命中）。耗时的窗口枚举仍移到后台线程，避免阻塞主线程。
    // 枚举完成后推送列表（供 clipToWorkArea 找任务栏），命中测试不受影响。
    let app_b = app.clone();
    let win_b = win.clone();
    tauri::async_runtime::spawn(async move {
        let windows = tauri::async_runtime::spawn_blocking({
            let app_c = app_b.clone();
            move || {
                let ws = crate::screenshot::list_windows(app_c.clone()).unwrap_or_default();
                filter_self_overlay_windows(&app_c, ws)
            }
        })
        .await
        .unwrap_or_default();
        eprintln!(
            "[录屏区域] show_recorder_select: ox={}, oy={}, scale={}, 窗口数={}",
            vx, vy, scale, windows.len()
        );
        let _ = win_b.emit(
            "recorder-select-ready",
            serde_json::json!({ "ox": vx, "oy": vy, "scale": scale, "windows": windows }),
        );
        // 首开兜底：首个覆盖窗 WebView2 冷启动 + 事件竞态常导致首次列表丢失，150ms 重推同一份列表。
        let win_f = win_b.clone();
        let windows_f = windows.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(150));
            let _ = win_f.emit(
                "recorder-select-ready",
                serde_json::json!({ "ox": vx, "oy": vy, "scale": scale, "windows": windows_f }),
            );
        });
    });

    Ok(())
}

/// 隐藏录屏区域选择覆盖窗
#[tauri::command]
pub fn hide_recorder_select(app: AppHandle) {
    if let Some(w) = app.get_webview_window(RECORDER_SELECT_LABEL) {
        let _ = w.hide();
    }
}

/// 获取录屏区域选择覆盖窗的坐标信息（前端主动拉取，解决 push 事件竞态）
/// 与 `recorder-select-ready` 事件数据格式一致，前端在事件未到达时用此命令兜底。
///
/// **关键**：此时 overlay 已可见，list_windows 会包含 overlay 自身（fullscreen）。
/// 若不过滤，前端 hitWindow 总是先命中 overlay → 区域录屏退化为全屏。
#[tauri::command]
pub fn get_recorder_select_coords(app: AppHandle) -> Result<serde_json::Value, String> {
    let (vx, vy, _vw, _vh) = virtual_desktop_rect();
    let win = app
        .get_webview_window(RECORDER_SELECT_LABEL)
        .ok_or_else(|| "录屏区域选择窗口不存在".to_string())?;
    let scale = win.scale_factor().unwrap_or(1.0);
    let windows = crate::screenshot::list_windows(app.clone()).unwrap_or_default();
    // 过滤掉本进程的 overlay / 控制台 / 截图覆盖窗 / 浮窗剪贴板
    let windows = filter_self_overlay_windows(&app, windows);
    Ok(serde_json::json!({
        "ox": vx,
        "oy": vy,
        "scale": scale,
        "windows": windows,
    }))
}

// =================录屏热键持久化（镜像截图热键系统）=================

/// 录屏热键默认值
pub const DEFAULT_RECORDER_SHORTCUT: &str = "Ctrl+Alt+R";

/// 当前生效的录屏热键（内存态，handler 中用于比较）
static RECORDER_SHORTCUT_STR: OnceLock<Mutex<String>> = OnceLock::new();

pub fn recorder_shortcut_state() -> &'static Mutex<String> {
    RECORDER_SHORTCUT_STR.get_or_init(|| Mutex::new(DEFAULT_RECORDER_SHORTCUT.to_string()))
}

fn recorder_shortcut_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("recorder_shortcut.json"))
}

/// 读取录屏热键（从持久化配置，不存在则返回默认值）
pub fn read_recorder_shortcut(app: &AppHandle) -> String {
    if let Some(p) = recorder_shortcut_path(app) {
        if let Ok(s) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                if let Some(s2) = v.get("shortcut").and_then(|x| x.as_str()) {
                    if !s2.is_empty() {
                        return s2.to_string();
                    }
                }
            }
        }
    }
    DEFAULT_RECORDER_SHORTCUT.to_string()
}

fn write_recorder_shortcut(app: &AppHandle, sc: &str) -> Result<(), String> {
    let p = recorder_shortcut_path(app).ok_or_else(|| "无法获取 app_data 目录".to_string())?;
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&p, serde_json::json!({ "shortcut": sc }).to_string())
        .map_err(|e| e.to_string())
}

/// 注册录屏热键（复用 screenshot::parse_shortcut 解析）
pub fn register_recorder_shortcut(app: &AppHandle, sc: &str) -> Result<(), String> {
    let shortcut = crate::screenshot::parse_shortcut(sc)?;
    app.global_shortcut()
        .register(shortcut)
        .map_err(|e| format!("注册录屏热键失败: {}", e))
}

/// 获取当前录屏热键（Tauri 命令，供前端设置面板读取）
#[tauri::command]
pub fn get_recorder_shortcut(app: AppHandle) -> String {
    let sc = read_recorder_shortcut(&app);
    // 同步到内存态
    if let Ok(mut state) = recorder_shortcut_state().lock() {
        *state = sc.clone();
    }
    sc
}

/// 设置录屏热键（Tauri 命令，先注销旧键 → 注册新键 → 持久化）
#[tauri::command]
pub fn set_recorder_shortcut(app: AppHandle, shortcut: String) -> Result<(), String> {
    let new = crate::screenshot::parse_shortcut(&shortcut)?;
    let old = recorder_shortcut_state()
        .lock()
        .map(|s| s.clone())
        .unwrap_or_else(|_| DEFAULT_RECORDER_SHORTCUT.to_string());

    // 先注销旧键
    if let Ok(old_sc) = crate::screenshot::parse_shortcut(&old) {
        let _ = app.global_shortcut().unregister(old_sc);
    }

    // 注册新键：注册成功后才落盘
    app.global_shortcut().register(new).map_err(|e| {
        // 注册失败 → 回退旧键
        if let Ok(old_sc) = crate::screenshot::parse_shortcut(&old) {
            let _ = app.global_shortcut().register(old_sc);
        }
        format!("注册失败（已回退原热键）: {}", e)
    })?;

    // 注册成功 → 持久化 + 更新内存态
    write_recorder_shortcut(&app, &shortcut)?;
    if let Ok(mut state) = recorder_shortcut_state().lock() {
        *state = shortcut;
    }
    Ok(())
}

/// 获取虚拟桌面矩形（所有显示器并集），物理像素坐标
fn virtual_desktop_rect() -> (i32, i32, i32, i32) {
    unsafe {
        let x = winapi::um::winuser::GetSystemMetrics(winapi::um::winuser::SM_XVIRTUALSCREEN);
        let y = winapi::um::winuser::GetSystemMetrics(winapi::um::winuser::SM_YVIRTUALSCREEN);
        let w = winapi::um::winuser::GetSystemMetrics(winapi::um::winuser::SM_CXVIRTUALSCREEN);
        let h = winapi::um::winuser::GetSystemMetrics(winapi::um::winuser::SM_CYVIRTUALSCREEN);
        (x, y, w, h)
    }
}

/// 获取屏幕宽度（物理像素），用于控制台居中
fn screen_size() -> (i32, i32) {
    unsafe {
        let w = winapi::um::winuser::GetSystemMetrics(winapi::um::winuser::SM_CXSCREEN);
        let h = winapi::um::winuser::GetSystemMetrics(winapi::um::winuser::SM_CYSCREEN);
        (w, h)
    }
}

/// 将录屏 MP4 转换为 GIF（供「保存为 GIF」使用）。
///
/// 限制尺寸（宽 480）与帧率（15fps）并启用 lanczos 缩放，避免 GIF 体积爆炸。
/// 输出路径与输入同目录、扩展名改为 `.gif`。
#[tauri::command]
pub async fn convert_recording_to_gif(app: AppHandle, mp4_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let ffmpeg_path = get_ffmpeg_path(&app);
        if !check_ffmpeg_with(&ffmpeg_path) {
            return Err("未检测到 ffmpeg，无法转换为 GIF。请安装 ffmpeg 后重试。".into());
        }
        if !std::path::Path::new(&mp4_path).exists() {
            return Err(format!("录屏文件不存在: {}", mp4_path));
        }
        let gif_path = mp4_path.trim_end_matches(".mp4").to_string() + ".gif";
        let mut cmd = std::process::Command::new(&ffmpeg_path);
        cmd.args([
                "-y",
                "-i",
                &mp4_path,
                "-vf",
                "fps=15,scale=480:-1:flags=lanczos",
                "-loop",
                "0",
                &gif_path,
            ]);
        #[cfg(windows)]
        cmd.creation_flags(0x08000000);
        let output = cmd.output()
            .map_err(|e| format!("GIF 转换失败: {}", e))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(format!("GIF 转换失败: {}", err));
        }
        Ok(gif_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删除临时录屏文件（取消保存时清理，避免 videoDir 留下孤儿文件）。
/// 安全护栏：仅删除以 .mp4 / .gif 结尾的路径，防止误删其他文件。
#[tauri::command]
pub fn delete_recording_file(path: String) -> Result<(), String> {
    if path.is_empty() {
        return Ok(());
    }
    if path.ends_with(".mp4") || path.ends_with(".gif") {
        let _ = std::fs::remove_file(&path);
    }
    Ok(())
}

/// Child::wait_timeout 的辅助 trait（标准库没有直接提供）
trait ChildWaitTimeoutExt {
    fn wait_timeout(&mut self, dur: std::time::Duration) -> std::io::Result<Option<std::process::ExitStatus>>;
}

impl ChildWaitTimeoutExt for Child {
    fn wait_timeout(&mut self, dur: std::time::Duration) -> std::io::Result<Option<std::process::ExitStatus>> {
        // 用 try_wait 轮询，每 100ms 检查一次
        let deadline = std::time::Instant::now() + dur;
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(Some(status));
            }
            if std::time::Instant::now() >= deadline {
                return Ok(None);
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
}
