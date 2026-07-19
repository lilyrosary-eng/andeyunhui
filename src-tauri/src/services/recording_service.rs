//! 录屏服务：WGC 持续捕获 + ffmpeg 管道编码
//!
//! 技术选型：
//! - 捕获：windows-capture（WGC，硬件加速，项目已有依赖），持续帧捕获
//! - 编码：系统 ffmpeg 管道编码（H.264 + MP4），最成熟稳定
//! - 控制：Arc<AtomicBool> 停停/暂停标志，WGC 回调中检查
//!
//! 数据流：WGC on_frame_arrived → 直接 write_all 到 ffmpeg stdin → ffmpeg 编码 → MP4 文件
//! 不经过 channel 中转，零拷贝（WGC 帧缓冲直接写管道），性能最佳。

use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
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

/// WGC 持续捕获 handler：每帧组装字节后**非阻塞**投递给编码线程（try_send，满则丢帧）。
///
/// **关键设计（根治「录屏时点击主窗即整体卡死」）**：绝不在 WGC 回调里直接 write_all 到
/// ffmpeg stdin。4K 录屏时 libx264 编码跟不上 → stdin 管道写满 → 回调阻塞在 write_all →
/// WGC 帧池耗尽、DWM 合成停摆 → 整个应用（含主窗、控制台）卡死。改为把每帧丢进有界通道，
/// 由独立编码线程消费；通道满时直接丢弃当前帧（背压降级），回调始终瞬时返回。
struct WgcRecorder {
    /// 帧数据发送端（有界，满则丢帧）
    sender: SyncSender<Vec<u8>>,
    /// 停止标志：设为 true 后下一帧回调中 stop() 捕获
    stop_flag: Arc<AtomicBool>,
    /// 暂停标志：暂停时不投递帧
    paused: Arc<AtomicBool>,
    /// 裁剪区域（相对于帧原点的物理像素偏移）：None = 全帧，Some((x,y,w,h)) = 逐行裁剪
    crop: Option<(u32, u32, u32, u32)>,
}

impl GraphicsCaptureApiHandler for WgcRecorder {
    type Flags = (
        SyncSender<Vec<u8>>,
        Arc<AtomicBool>,
        Arc<AtomicBool>,
        Option<(u32, u32, u32, u32)>,
    );
    type Error = String;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let (sender, stop_flag, paused, crop) = ctx.flags;
        Ok(Self {
            sender,
            stop_flag,
            paused,
            crop,
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
        // 取帧数据（先获取尺寸再 borrow buffer，避免 mutable/immutable 借用冲突）
        let fw = frame.width();
        let fh = frame.height();
        let buffer = frame.buffer().map_err(|e| e.to_string())?;
        let mut scratch = Vec::new();
        let src = buffer.as_nopadding_buffer(&mut scratch);

        // 组装该帧字节（裁剪或全帧）
        let payload: Vec<u8> = if let Some((cx, cy, cw, ch)) = self.crop {
            let cx = cx.min(fw);
            let cy = cy.min(fh);
            let cw = cw.min(fw.saturating_sub(cx));
            let ch = ch.min(fh.saturating_sub(cy));
            if cw == 0 || ch == 0 {
                return Ok(());
            }
            let row_bytes = (cw * 4) as usize;
            let mut v = Vec::with_capacity(row_bytes * ch as usize);
            for y in cy..(cy + ch) {
                let start = ((y * fw + cx) * 4) as usize;
                let end = start + row_bytes;
                if end <= src.len() {
                    v.extend_from_slice(&src[start..end]);
                }
            }
            v
        } else {
            src.to_vec()
        };

        // 非阻塞投递：编码线程跟不上（如 4K libx264 打满 CPU）时丢弃当前帧，
        // 绝不阻塞 WGC 回调——阻塞回调会耗尽帧池、拖垮 DWM 合成，导致录制时整体卡死。
        match self.sender.try_send(payload) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => { /* 背压：丢帧 */ }
            Err(TrySendError::Disconnected(_)) => capture_control.stop(),
        }
        Ok(())
    }
}

/// 全局录屏句柄（管理 ffmpeg 进程 + 捕获线程 + 编码写入线程）
struct RecordingHandle {
    ffmpeg_child: Option<Child>,
    capture_thread: Option<std::thread::JoinHandle<()>>,
    /// 编码写入线程：从通道取帧 write_all 到 ffmpeg stdin，收到 EOF（所有发送端 drop）后
    /// 关闭 stdin 并退出，让 ffmpeg 刷新编码器输出文件。
    writer_thread: Option<std::thread::JoinHandle<()>>,
    /// 主发送端——stop 时显式 drop，配合捕获线程退出（drop 其副本）让编码线程收到 EOF。
    frame_tx: Option<SyncSender<Vec<u8>>>,
    stop_flag: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    start_time: SystemTime,
    output_path: String,
}

/// 全局录屏状态
static RECORDING: Mutex<Option<RecordingHandle>> = Mutex::new(None);

/// 解析 ffmpeg 可执行文件路径：
/// 1. 优先使用 external-deps/全局/ffmpeg/ffmpeg.exe（随应用打包，无需用户安装）
/// 2. 回退到系统 PATH 中的 ffmpeg（用户自行安装）
pub fn get_ffmpeg_path(app: &AppHandle) -> String {
    if let Some(deps_dir) = crate::commands::get_external_deps_dir(app) {
        let ffmpeg = deps_dir.join("全局").join("ffmpeg").join("ffmpeg.exe");
        if ffmpeg.exists() {
            return ffmpeg.to_string_lossy().to_string();
        }
    }
    "ffmpeg".to_string() // 回退到系统 PATH
}

/// 检查 ffmpeg 是否可用（bundled 或系统安装）
fn check_ffmpeg_with(path: &str) -> bool {
    std::process::Command::new(path)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
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
    let candidates: &[&str] = &["h264_nvenc", "h264_qsv", "h264_amf"];
    for &enc in candidates {
        if encoder_listed(ffmpeg, enc) && encoder_runtime_ok(ffmpeg, enc) {
            return Some(enc);
        }
    }
    None
}

/// 编码器是否在 ffmpeg 的 `-encoders` 列表中出现。
fn encoder_listed(ffmpeg: &str, enc: &str) -> bool {
    let out = std::process::Command::new(ffmpeg)
        .args(["-hide_banner", "-encoders"])
        .stderr(Stdio::null())
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).contains(enc),
        Err(_) => false,
    }
}

/// **运行时**能否用该编码器真正编码一帧（验证驱动 / 授权等是否支持）。
/// 用 lavfi 极小分辨率跑 0.2s 编码到 null，成功才算可用。
fn encoder_runtime_ok(ffmpeg: &str, enc: &str) -> bool {
    let out = std::process::Command::new(ffmpeg)
        .args([
            "-hide_banner", "-y", "-f", "lavfi", "-i", "nullsrc=s=128x128",
            "-t", "0.2", "-c:v", enc, "-f", "null", "-",
        ])
        .stderr(Stdio::null())
        .output();
    match out {
        Ok(o) => o.status.success(),
        Err(_) => false,
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
        let fps = fps.unwrap_or(60);

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
            let recording = RECORDING.lock().unwrap();
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
            eprintln!("[录屏] 区域录制: crop=({},{},{},{})", rx - ml, ry - mt, rw, rh);
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
        let hw = probe_hw_encoder(&ffmpeg_path);
        let mut ffmpeg_args: Vec<String> = vec![
            "-y".into(),
            "-f".into(),
            "rawvideo".into(),
            "-pix_fmt".into(),
            "rgba".into(),
            "-s".into(),
            format!("{}x{}", enc_w, enc_h),
            // 恒定输入帧率：ffmpeg 据此为每帧生成绝对均匀的 PTS（n × 1/fps），
            // 不受管道读取抖动 / 系统调度 / WGC 突发投帧影响 → 高刷屏下也看不出卡顿。
            "-r".into(),
            fps.to_string(),
            "-i".into(),
            "-".into(),
        ];
        match hw {
            Some("h264_nvenc") => {
                ffmpeg_args.extend([
                    "-c:v".into(),
                    "h264_nvenc".into(),
                    "-preset".into(),
                    "p1".into(),
                    "-rc".into(),
                    "constqp".into(),
                    "-qp".into(),
                    "23".into(),
                    "-pix_fmt".into(),
                    "yuv420p".into(),
                ]);
                eprintln!("[录屏] 使用硬件编码器 h264_nvenc（GPU 编码，CPU 占用低）");
            }
            Some("h264_qsv") => {
                ffmpeg_args.extend([
                    "-c:v".into(),
                    "h264_qsv".into(),
                    "-preset".into(),
                    "veryfast".into(),
                    "-global_quality".into(),
                    "23".into(),
                    "-pix_fmt".into(),
                    "yuv420p".into(),
                ]);
                eprintln!("[录屏] 使用硬件编码器 h264_qsv（GPU 编码，CPU 占用低）");
            }
            Some("h264_amf") => {
                ffmpeg_args.extend([
                    "-c:v".into(),
                    "h264_amf".into(),
                    "-quality".into(),
                    "speed".into(),
                    "-rc".into(),
                    "cqp".into(),
                    "-qp_p".into(),
                    "23".into(),
                    "-qp_b".into(),
                    "23".into(),
                    "-pix_fmt".into(),
                    "yuv420p".into(),
                ]);
                eprintln!("[录屏] 使用硬件编码器 h264_amf（GPU 编码，CPU 占用低）");
            }
            _ => {
                ffmpeg_args.extend([
                    "-c:v".into(),
                    "libx264".into(),
                    "-preset".into(),
                    "ultrafast".into(),
                    "-crf".into(),
                    "23".into(),
                    "-pix_fmt".into(),
                    "yuv420p".into(),
                ]);
                eprintln!(
                    "[录屏] 未检测到硬件编码器，回退 libx264（CPU 软编码；4K 可能仍较吃 CPU）"
                );
            }
        }
        ffmpeg_args.extend(["-movflags".into(), "+faststart".into(), output_path.clone()]);

        // 启动 ffmpeg 进程（stdin 管道接收 RGBA 帧）
        let mut child = Command::new(&ffmpeg_path)
            .args(&ffmpeg_args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            // 关键：stderr 必须用 null，不能用 piped。
            // piped 时若不持续读取，stderr 管道缓冲区（~64KB）填满后 ffmpeg 阻塞在
            // stderr 写入 → 停止消费 stdin → stdin 管道填满 → 捕获线程 write_all 阻塞
            // （同时持有 stdin 锁）→ stop_recording 无法获取锁关闭 stdin → 死锁 → UI 卡死。
            // 区域录屏尤其严重：奇数尺寸会产生每帧一条 ffmpeg 警告，瞬间填满 stderr 管道。
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("启动 ffmpeg 失败: {}（请确认 ffmpeg 已安装）", e))?;

        let mut stdin = child.stdin.take().ok_or("无法获取 ffmpeg stdin")?;
        let stop_flag = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));

        // 帧数据有界通道：容量 4。捕获线程 try_send（满则丢帧），编码线程 recv 后 write_all。
        // 有界 + 丢帧 = 背压降级，杜绝捕获回调阻塞导致的整体卡死。
        let (frame_tx, frame_rx) = sync_channel::<Vec<u8>>(4);

        // 编码写入线程：唯一持有 ffmpeg stdin。所有发送端 drop 后 recv 返回 Err → 退出循环
        // → stdin 在此 drop → ffmpeg 收到 EOF 并刷新编码器输出文件。
        let writer_thread = std::thread::spawn(move || {
            while let Ok(buf) = frame_rx.recv() {
                if stdin.write_all(&buf).is_err() {
                    break; // ffmpeg 已退出/管道断开
                }
            }
            // 循环结束：stdin 于此作用域 drop，关闭管道触发 ffmpeg EOF
        });

        // 启动 WGC 捕获线程
        let tx_for_capture = frame_tx.clone();
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
                (tx_for_capture, stop_for_capture, paused_for_capture, crop),
            );
            if let Err(e) = WgcRecorder::start(settings) {
                eprintln!("[录屏] WGC 捕获异常: {}", e);
            }
            // 捕获结束：WgcRecorder（持 sender 副本）在此 drop
        });

        // 保存录屏句柄
        *RECORDING.lock().unwrap() = Some(RecordingHandle {
            ffmpeg_child: Some(child),
            capture_thread: Some(capture_thread),
            writer_thread: Some(writer_thread),
            frame_tx: Some(frame_tx), // 主发送端：stop 时 drop 以尽快断开
            stop_flag,
            paused,
            start_time: SystemTime::now(),
            output_path: output_path.clone(),
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
            let mut handle_opt = RECORDING.lock().unwrap();
            handle_opt
                .take()
                .ok_or_else(|| "未在录制中".to_string())?
        };

        // 立即隐藏录屏区域边框窗：停止即时生效，红框立刻消失、不再拦截点击。
        if let Some(bw) = app.get_webview_window(RECORDING_BORDER_LABEL) {
            let _ = bw.hide();
        }

        // 1. 设置停止标志 → WGC 下一帧回调中 stop() 捕获 → 捕获线程退出（drop 其 sender 副本）
        handle.stop_flag.store(true, Ordering::SeqCst);

        // 2. drop 主发送端。配合捕获线程退出时 drop 的副本，编码线程通道的所有发送端归零
        //    → recv 返回 Err → 编码线程退出并关闭 stdin → ffmpeg 收到 EOF 刷新输出文件。
        drop(handle.frame_tx.take());

        // 3. detach 捕获线程与编码线程：捕获线程下一帧检查 stop_flag 后退出；
        //    编码线程排空通道剩余帧、关闭 stdin 后自行结束。均无需 join。
        drop(handle.capture_thread.take());
        drop(handle.writer_thread.take());

        let output_path = handle.output_path.clone();
        let mut child = handle.ffmpeg_child.take().ok_or("ffmpeg 进程丢失")?;

        // 4. 立即广播「保存中」占位（前端显示「录屏文件保存中」，不静默等待）。
        //    用 &output_path 借用，避免把 output_path 移入 json! 宏（后续还需返回）。
        let _ = app.emit(
            "recording-saving",
            serde_json::json!({ "path": &output_path, "status": "saving" }),
        );

        // 5. 后台监视线程：等 ffmpeg 真正退出（封装/快启完成）后再广播最终事件。
        //    超时放宽到 120s（远超原 5s），巨大录屏也能安全封装完成、不再被误杀。
        let app2 = app.clone();
        let out_path = output_path.clone();
        std::thread::spawn(move || {
            match child.wait_timeout(std::time::Duration::from_secs(120)) {
                Ok(Some(status)) => {
                    if !status.success() {
                        // 编码失败也要广播：否则前端保存面板永远不弹（表现为「录屏没效果」）
                        let _ = app2.emit("recording-stopped", "");
                        let _ = app2.emit(
                            "recording-error",
                            "ffmpeg 编码失败（进程异常退出），未生成录屏文件",
                        );
                        return;
                    }
                    // 体积校验：ffmpeg 偶发「静默成功」产出 0/极小文件（如未捕获到任何画面、
                    // 或捕获会话异常）。若文件过小，说明录制实际无效，必须报错而非假装成功，
                    // 否则用户看到「保存 MP4」却得到打不开的空文件 → 以为「录屏还是不行」。
                    if let Ok(meta) = std::fs::metadata(&out_path) {
                        if meta.len() <= 1024 {
                            let _ = app2.emit("recording-stopped", "");
                            let _ = app2.emit(
                                "recording-error",
                                "录制文件异常（体积过小，可能未捕获到画面）。请确认 external-deps/全局/ffmpeg 可用，或尝试较小的录制区域/降低分辨率。",
                            );
                            return;
                        }
                    }
                    let _ = app2.emit("recording-stopped", &out_path);
                }
                Ok(None) => {
                    // 超时：ffmpeg 未退出，强制 kill（输出文件可能不完整，但避免无限等待）
                    eprintln!("[录屏] ffmpeg 120s 内未退出，强制终止");
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = app2.emit("recording-stopped", "");
                    let _ = app2.emit(
                        "recording-error",
                        "ffmpeg 编码超时，已强制终止（未生成录屏文件）",
                    );
                }
                Err(e) => {
                    let _ = app2.emit("recording-stopped", "");
                    let _ = app2.emit("recording-error", format!("等待 ffmpeg 结束失败: {}", e));
                }
            }
        });

        // 命令立即返回（不再阻塞）：前台「停止」即刻完成，文件在后台封装。
        Ok(output_path)
    })
    .await
    .map_err(|e| format!("停止录屏任务失败: {}", e))?
}

/// 暂停录制
#[tauri::command]
pub fn pause_recording() -> Result<(), String> {
    let recording = RECORDING.lock().unwrap();
    let handle = recording.as_ref().ok_or("未在录制中")?;
    handle.paused.store(true, Ordering::SeqCst);
    Ok(())
}

/// 恢复录制
#[tauri::command]
pub fn resume_recording() -> Result<(), String> {
    let recording = RECORDING.lock().unwrap();
    let handle = recording.as_ref().ok_or("未在录制中")?;
    handle.paused.store(false, Ordering::SeqCst);
    Ok(())
}

/// 获取录屏状态
#[tauri::command]
pub fn get_recording_status() -> RecordingStatus {
    let recording = RECORDING.lock().unwrap();
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

    // 控制台显示在屏幕正上方居中（需将物理像素转换为逻辑像素以正确居中）
    let (screen_w, _screen_h) = screen_size();
    let scale = unsafe {
        let dpi = winapi::um::winuser::GetDpiForSystem();
        if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 }
    };
    let widget_w = 320.0_f64;
    let widget_h = 52.0_f64;
    let x = (screen_w as f64 / scale - widget_w) / 2.0;
    let y = 8.0_f64; // 距离屏幕顶部 8px

    let _win = WebviewWindowBuilder::new(
        app,
        RECORDER_WINDOW_LABEL,
        WebviewUrl::App("recorder-widget.html".into()),
    )
    .title("录屏")
    .inner_size(widget_w, widget_h)
    .position(x, y)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .transparent(true)
    .resizable(false)
    .shadow(false)
    .visible(false) // 预创建时隐藏
    .build()
    .map_err(|e| format!("创建录屏控制台失败: {}", e))?;

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
    .position(0.0, 0.0)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .transparent(true)
    .resizable(false)
    .shadow(false)
    .visible(false) // 预创建时隐藏，start_recording 时按区域定位并显示
    .build()
    .map_err(|e| format!("创建录屏边框窗失败: {}", e))?;

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

    let (vx, vy, vw, vh) = virtual_desktop_rect();
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
    let lx = vx as f64 / scale;
    let ly = vy as f64 / scale;

    let _win = WebviewWindowBuilder::new(
        app,
        RECORDER_SELECT_LABEL,
        WebviewUrl::App("recorder-select.html".into()),
    )
    .title("选择录屏区域")
    .inner_size(lw, lh)
    .position(lx, ly)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .transparent(true)
    .resizable(false)
    .visible(false) // 预创建时隐藏
    .shadow(false) // 去除 Windows 11 不可见调整边框，与截图覆盖窗一致
    .build()
    .map_err(|e| format!("创建录屏区域选择窗口失败: {}", e))?;

    Ok(())
}

/// 过滤掉本进程的覆盖窗/控制台/截图覆盖窗 hwnd。
/// 这些 fullscreen 或 always-on-top 窗口若出现在列表中会挡住其他窗口的命中测试
/// （overlay 是 fullscreen，hitWindow 总是先命中它 → 区域录屏退化为全屏）。
/// 主窗口（is_self）**不**过滤：用户明确要求"不需要屏蔽"，应允许识别应用主窗口。
fn filter_self_overlay_windows(app: &AppHandle, mut windows: Vec<crate::screenshot::WindowInfo>) -> Vec<crate::screenshot::WindowInfo> {
    // 收集需排除的 hwnd。关键：Tauri 的 `WebviewWindow::hwnd()` 在 Windows 上返回的是
    // WebView2 **子控件**的 HWND，而 `EnumWindows`/`list_windows` 枚举的是**顶层父窗口**
    // HWND —— 二者不同，若只排除子控件 HWND，全屏覆盖窗的顶层窗口仍留在列表里，
    // 于是前端 hitWindow 永远先命中它（fullscreen + always-on-top）→「只能识别一个窗口 /
    // 鼠标移动没用」。因此这里同时排除「raw hwnd」与「其顶层祖先(GA_ROOT)」，确保覆盖窗被剔除。
    let mut excluded: Vec<u64> = Vec::new();
    for label in [
        RECORDER_SELECT_LABEL,
        RECORDER_WINDOW_LABEL,
        "screenshot-overlay",
        "floating-clipboard",
    ] {
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

    let (vx, vy, vw, vh) = virtual_desktop_rect();
    if vw <= 0 || vh <= 0 {
        return Err("无法获取虚拟桌面尺寸".into());
    }

    // 用物理像素精确设置位置和大小（与截图覆盖窗一致，消除 DPI 换算误差）
    let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: vx, y: vy }));
    let _ = win.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: vw as u32, height: vh as u32 }));

    // 直接使用 virtual_desktop_rect 作为坐标原点——不读 outer_position()。
    let scale = win.scale_factor().unwrap_or(1.0);

    // 在 win.show() 之前获取窗口列表。此时覆盖窗尚未可见，IsWindowVisible 会跳过它。
    // 但控制台（recorder-widget）若上次录屏后未隐藏可能仍可见，需过滤。
    // 同时过滤 screenshot-overlay / floating-clipboard 等 fullscreen / always-on-top 窗口，
    // 避免它们挡住其他窗口的命中测试。
    let windows = crate::screenshot::list_windows().unwrap_or_default();
    let windows = filter_self_overlay_windows(&app, windows);
    eprintln!(
        "[录屏区域] show_recorder_select: ox={}, oy={}, scale={}, 窗口数={}",
        vx, vy, scale, windows.len()
    );

    let _ = win.emit("recorder-select-ready", serde_json::json!({
        "ox": vx,
        "oy": vy,
        "scale": scale,
        "windows": windows,
    }));
    let _ = win.show();
    let _ = win.set_focus();

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
    let windows = crate::screenshot::list_windows().unwrap_or_default();
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
        let output = std::process::Command::new(&ffmpeg_path)
            .args([
                "-y",
                "-i",
                &mp4_path,
                "-vf",
                "fps=15,scale=480:-1:flags=lanczos",
                "-loop",
                "0",
                &gif_path,
            ])
            .output()
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
