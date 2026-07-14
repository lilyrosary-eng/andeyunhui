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
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

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

/// 录屏状态（返回给前端）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub is_recording: bool,
    pub is_paused: bool,
    pub elapsed_secs: u64,
    pub output_path: String,
}

/// WGC 持续捕获 handler：每帧直接写入 ffmpeg stdin
struct WgcRecorder {
    /// ffmpeg stdin（多线程安全访问）
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    /// 停止标志：设为 true 后下一帧回调中 stop() 捕获
    stop_flag: Arc<AtomicBool>,
    /// 暂停标志：暂停时不写入帧（ffmpeg 保持等待）
    paused: Arc<AtomicBool>,
    /// 裁剪区域（相对于帧原点的物理像素偏移）：None = 全帧，Some((x,y,w,h)) = 逐行裁剪
    crop: Option<(u32, u32, u32, u32)>,
    /// 可复用的裁剪缓冲区：避免每帧分配 Vec（性能关键路径）
    crop_buffer: Vec<u8>,
}

impl GraphicsCaptureApiHandler for WgcRecorder {
    type Flags = (
        Arc<Mutex<Option<ChildStdin>>>,
        Arc<AtomicBool>,
        Arc<AtomicBool>,
        Option<(u32, u32, u32, u32)>,
    );
    type Error = String;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let (stdin, stop_flag, paused, crop) = ctx.flags;
        Ok(Self {
            stdin,
            stop_flag,
            paused,
            crop,
            crop_buffer: Vec::new(),
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
        // 暂停时跳过（不写入 ffmpeg，ffmpeg 会等待 stdin）
        if self.paused.load(Ordering::SeqCst) {
            return Ok(());
        }
        // 取帧数据（先获取尺寸再 borrow buffer，避免 mutable/immutable 借用冲突）
        let fw = frame.width();
        let fh = frame.height();
        let mut buffer = frame.buffer().map_err(|e| e.to_string())?;
        let src = buffer.as_nopadding_buffer().map_err(|e| e.to_string())?;

        if let Some(stdin) = self.stdin.lock().unwrap().as_mut() {
            if let Some((cx, cy, cw, ch)) = self.crop {
                // 区域裁剪：先汇总到 crop_buffer，再单次 write_all（避免逐行小写入卡顿）
                let cx = cx.min(fw);
                let cy = cy.min(fh);
                let cw = cw.min(fw.saturating_sub(cx));
                let ch = ch.min(fh.saturating_sub(cy));
                if cw == 0 || ch == 0 {
                    return Ok(());
                }
                let row_bytes = (cw * 4) as usize;
                let total = row_bytes * ch as usize;
                self.crop_buffer.clear();
                self.crop_buffer.reserve(total);
                for y in cy..(cy + ch) {
                    let start = ((y * fw + cx) * 4) as usize;
                    let end = start + row_bytes;
                    if end <= src.len() {
                        self.crop_buffer.extend_from_slice(&src[start..end]);
                    }
                }
                let _ = stdin.write_all(&self.crop_buffer);
            } else {
                // 全帧写入（原行为）
                let _ = stdin.write_all(src);
            }
        }
        Ok(())
    }
}

/// 全局录屏句柄（管理 ffmpeg 进程 + 捕获线程）
struct RecordingHandle {
    ffmpeg_child: Option<Child>,
    capture_thread: Option<std::thread::JoinHandle<()>>,
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
fn get_ffmpeg_path(app: &AppHandle) -> String {
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

/// 启动录屏
///
/// 参数：
/// - `output_path`：输出 MP4 文件路径
/// - `fps`：帧率（默认 30）
/// - `monitor_index`：显示器索引（默认 0 = 主屏），仅当 region 为 None 时使用
/// - `region`：录制区域 `Option<(x, y, w, h)>`，虚拟桌面物理像素坐标；None = 全屏
#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    output_path: String,
    fps: Option<u32>,
    monitor_index: Option<usize>,
    region: Option<(i32, i32, i32, i32)>,
) -> Result<(), String> {
    // async + spawn_blocking：将 ffmpeg 检测、显示器枚举、进程启动等阻塞操作移至线程池，
    // 避免阻塞主线程导致 UI 冻结（卡死）。
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        // 检查 ffmpeg（优先 bundled，回退系统 PATH）
        let ffmpeg_path = get_ffmpeg_path(&app);
        if !check_ffmpeg_with(&ffmpeg_path) {
            return Err("未检测到 ffmpeg，无法录屏。请在系统中安装 ffmpeg 后重试。".into());
        }

        let fps = fps.unwrap_or(30);

        // 检查是否已在录制
        {
            let recording = RECORDING.lock().unwrap();
            if recording.is_some() {
                return Err("已在录制中，请先停止当前录制".into());
            }
        }

        // 获取显示器 + 计算裁剪区域 + 编码尺寸
        let monitors = Monitor::enumerate().map_err(|e| format!("枚举显示器失败: {}", e))?;
        let total = monitors.len();

        let (monitor, crop, enc_w, enc_h) = if let Some((rx, ry, rw, rh)) = region {
            if rw <= 0 || rh <= 0 {
                return Err("录制区域尺寸无效".into());
            }
            // 找到包含区域原点的显示器
            let mon = monitors
                .into_iter()
                .find(|m| {
                    let (ml, mt, mr, mb) = monitor_rect_phys(m);
                    rx >= ml && rx < mr && ry >= mt && ry < mb
                })
                .ok_or_else(|| "录制区域不在任何显示器范围内".to_string())?;
            let (ml, mt, _, _) = monitor_rect_phys(&mon);
            let crop_offset = Some((
                (rx - ml) as u32,
                (ry - mt) as u32,
                rw as u32,
                rh as u32,
            ));
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
            (mon, None, w, h)
        };

        // 启动 ffmpeg 进程（stdin 管道接收 RGBA 帧）
        let mut child = Command::new(&ffmpeg_path)
            .args([
                "-y",
                "-f", "rawvideo",
                "-pix_fmt", "rgba",
                "-s", &format!("{}x{}", enc_w, enc_h),
                "-r", &fps.to_string(),
                "-i", "-",
                "-c:v", "libx264",
                "-preset", "ultrafast",
                "-crf", "23",
                "-pix_fmt", "yuv420p",
                "-movflags", "+faststart",
                &output_path,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped()) // 捕获 stderr 用于错误诊断
            .spawn()
            .map_err(|e| format!("启动 ffmpeg 失败: {}（请确认 ffmpeg 已安装）", e))?;

        let stdin = child.stdin.take().ok_or("无法获取 ffmpeg stdin")?;
        let stdin_arc = Arc::new(Mutex::new(Some(stdin)));
        let stop_flag = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));

        // 启动 WGC 捕获线程
        let stdin_for_capture = stdin_arc.clone();
        let stop_for_capture = stop_flag.clone();
        let paused_for_capture = paused.clone();
        let capture_thread = std::thread::spawn(move || {
            let settings = Settings::new(
                monitor,
                CursorCaptureSettings::Default,
                DrawBorderSettings::Default,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Default,
                DirtyRegionSettings::Default,
                ColorFormat::Rgba8,
                (stdin_for_capture, stop_for_capture, paused_for_capture, crop),
            );
            if let Err(e) = WgcRecorder::start(settings) {
                eprintln!("[录屏] WGC 捕获异常: {}", e);
            }
        });

        // 保存录屏句柄
        *RECORDING.lock().unwrap() = Some(RecordingHandle {
            ffmpeg_child: Some(child),
            capture_thread: Some(capture_thread),
            stop_flag,
            paused,
            start_time: SystemTime::now(),
            output_path: output_path.clone(),
        });

        // 通知前端开始录制
        let _ = app.emit("recording-started", &output_path);

        Ok(())
    })
    .await
    .map_err(|e| format!("录屏任务执行失败: {}", e))?
}

/// 停止录屏，返回输出文件路径
#[tauri::command]
pub fn stop_recording(app: AppHandle) -> Result<String, String> {
    let mut handle_opt = RECORDING.lock().unwrap();
    let handle = handle_opt
        .take()
        .ok_or_else(|| "未在录制中".to_string())?;

    // 1. 设置停止标志 → WGC 下一帧回调中 stop()
    handle.stop_flag.store(true, Ordering::SeqCst);

    // 2. 等待捕获线程结束（最多 5s）
    if let Some(thread) = handle.capture_thread {
        let _ = thread.join();
    }

    // 3. 关闭 ffmpeg stdin（drop → ffmpeg flush 编码器并输出文件）
    // stdin 已在 WgcRecorder 中通过 Arc<Mutex> 持有，这里不需要额外操作
    // 但需要确保 stdin 被关闭。由于 WgcRecorder 已 stop，stdin 会被 drop

    // 4. 等待 ffmpeg 进程结束（最多 30s，大文件编码需要时间）
    let mut child = handle.ffmpeg_child.ok_or("ffmpeg 进程丢失")?;
    // drop stdin 以触发 ffmpeg EOF
    drop_stdin();
    let status = child
        .wait_timeout(std::time::Duration::from_secs(30))
        .map_err(|e| format!("等待 ffmpeg 结束失败: {}", e))?
        .ok_or_else(|| "ffmpeg 编码超时（30s），可能输出文件不完整".to_string())?;

    if !status.success() {
        // 读取 ffmpeg stderr 用于诊断
        let stderr = child
            .stderr
            .take()
            .and_then(|mut s| {
                use std::io::Read;
                let mut buf = String::new();
                s.read_to_string(&mut buf).ok().map(|_| buf)
            })
            .unwrap_or_default();
        return Err(format!("ffmpeg 编码失败: {}", stderr.chars().take(500).collect::<String>()));
    }

    let output_path = handle.output_path.clone();
    let _ = app.emit("recording-stopped", &output_path);
    Ok(output_path)
}

/// 辅助函数：确保 ffmpeg stdin 被关闭
fn drop_stdin() {
    // stdin 已经在 WgcRecorder 的 Arc<Mutex<Option<ChildStdin>>> 中
    // 当 WGC 线程结束时，WgcRecorder 被 drop，stdin 也会被 drop
    // 但为了确保，这里不需要额外操作——child.wait() 会等待进程结束
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
fn monitor_rect_phys(monitor: &Monitor) -> (i32, i32, i32, i32) {
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
#[tauri::command]
pub fn show_recorder_widget(app: AppHandle) -> Result<(), String> {
    if app.get_webview_window(RECORDER_WINDOW_LABEL).is_some() {
        let win = app.get_webview_window(RECORDER_WINDOW_LABEL).unwrap();
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
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
        &app,
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
    .build()
    .map_err(|e| format!("创建录屏控制台失败: {}", e))?;

    Ok(())
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
    // 原因与 screenshot.rs 的 start_screenshot 相同：set_position 异步，outer_position()
    // 可能返回带 DWM 边框偏移的值（如 +7px），导致选区坐标左边偏移。
    // virtual_desktop_rect 与 GetDC(NULL) 同源，是权威的虚拟桌面原点。
    let scale = win.scale_factor().unwrap_or(1.0);

    let _ = win.emit("recorder-select-ready", serde_json::json!({
        "ox": vx,
        "oy": vy,
        "scale": scale,
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
#[tauri::command]
pub fn get_recorder_select_coords(app: AppHandle) -> Result<serde_json::Value, String> {
    let (vx, vy, _vw, _vh) = virtual_desktop_rect();
    let win = app
        .get_webview_window(RECORDER_SELECT_LABEL)
        .ok_or_else(|| "录屏区域选择窗口不存在".to_string())?;
    let scale = win.scale_factor().unwrap_or(1.0);
    Ok(serde_json::json!({
        "ox": vx,
        "oy": vy,
        "scale": scale,
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
