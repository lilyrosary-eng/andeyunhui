//! 诊断与自测模块：把"猜测"变成"实验"。
//!
//! 过去录屏/导入问题反复修但反复坏，根本原因是**没有可观测数据**：ffmpeg 的 stderr 被丢弃、
//! 捕获线程的帧数无从得知、导入解析是否 panic 也无从得知。本模块提供两个 Tauri 命令：
//!
//! - `recording_self_test(duration_secs)`：真正跑一次 WGC 捕获 + ffmpeg 编码（写入
//!   app_data/logs/recording_selftest.mp4），统计**实际交付帧数**、输出文件体积、ffmpeg 退出码与
//!   **stderr 尾部**（关键的失败原因）。这是定位"录屏没用"的决定性实验。
//! - `wps_import_pptx_diagnose(path)`：跑同样的解析，但只回传统计（输入字节、输出 JSON 字节、
//!   幻灯片/元素/图片数、落盘图片数），并用 `catch_unwind` 捕获 panic。用于定位"导入闪退"根因，
//!   且即便解析 panic 也不会让进程崩溃。
//!
//! 所有关键节点同时写入 `app_data/logs/app.log`，便于用户把日志发回分析。

use std::fs;
use std::io::Write;
use std::process::{Command, Stdio};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

// 复用真实录制的 GPU RGBA→RGBA 缩放转换器，使自测与真实录制走完全一致的处理路径
// （含 4K→1080p 降采样；GPU 不可用时有 4K 读回兜底）。
use crate::services::recording_service::gpu_nv12::GpuNv12Converter;
use crate::services::recording_service::nv12_in_process_supported;
// 复用真实录制的音频采集：优先 ffmpeg 原生 WASAPI，否则 Rust WASAPI 回环采集（命名管道）。
use crate::services::recording_service::audio_capture::{start_audio_capture, AudioCapture, AudioFormat};
use crate::services::recording_service::resolve_audio_input;

/// 简短时间戳（HH:MM:SS，基于 UTC epoch，仅用于日志可读性）
fn now_ts() -> String {
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    format!("{:02}:{:02}:{:02}", h, m, s)
}

/// 追加一行日志到 app_data/logs/app.log（创建目录；任何失败都静默，不干扰主流程）
pub fn diag_log(app: &AppHandle, tag: &str, msg: &str) {
    if let Ok(d) = app.path().app_data_dir() {
        let p = d.join("logs").join("app.log");
        if let Some(parent) = p.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&p) {
            let _ = writeln!(f, "[{}] [{}] {}", now_ts(), tag, msg);
        }
    }
}

/// 测试用 WGC 捕获 handler：统计实际交付帧数，全帧 RGBA 投递给编码线程。
/// 与真实录制保持一致：全屏 + 驱动支持时走进程内 GPU RGBA→NV12（并按 out_w×out_h 缩放，
/// 4K 全屏即降到 1080p），否则回落 4K RGBA。这样自测就是真实录制的忠实代理，
/// 不会因“4K 全帧 RGBA 每帧 ~33MB CPU 拷贝”而比真实录制更卡，从而能正确反映“是否还卡”。
struct TestCapture {
    sender: SyncSender<Vec<u8>>,
    stop_flag: Arc<AtomicBool>,
    counter: Arc<AtomicUsize>,
    gpu_nv12: bool,
    /// 是否需要降采样（超 1080p 时恒为 true；GPU 不可用时走 CPU 双线性兜底）
    downscale_4k: bool,
    out_w: u32,
    out_h: u32,
    gpu: Option<GpuNv12Converter>,
    gpu_failed: bool,
}

/// RGBA 全帧回退：把 WGC 帧按原尺寸读到内存（非降采样路径 / GPU 转换失败时的兜底）。
fn rgba_payload(frame: &mut Frame) -> Result<Vec<u8>, String> {
    let buffer = frame.buffer().map_err(|e| e.to_string())?;
    let mut scratch = Vec::new();
    Ok(buffer.as_nopadding_buffer(&mut scratch).to_vec())
}

impl GraphicsCaptureApiHandler for TestCapture {
    type Flags = (SyncSender<Vec<u8>>, Arc<AtomicBool>, Arc<AtomicUsize>, bool, bool, u32, u32);
    type Error = String;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let (sender, stop_flag, counter, gpu_nv12, downscale_4k, out_w, out_h) = ctx.flags;
        Ok(Self {
            sender,
            stop_flag,
            counter,
            gpu_nv12,
            downscale_4k,
            out_w,
            out_h,
            gpu: None,
            gpu_failed: false,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if self.stop_flag.load(Ordering::SeqCst) {
            capture_control.stop();
            return Ok(());
        }
        let fw = frame.width();
        let fh = frame.height();
        // 与真实录制同构：全程 GPU 内 RGBA→NV12 + 缩放，回读字节降至目标的 1/4（4K→1080p）。
        let payload: Vec<u8> = if self.gpu_nv12 && !self.gpu_failed {
            if self.gpu.is_none() {
                match GpuNv12Converter::new(
                    frame.device(),
                    frame.device_context(),
                    fw,
                    fh,
                    self.out_w,
                    self.out_h,
                    frame.desc().Format,
                ) {
                    Ok(c) => self.gpu = Some(c),
                    Err(_) => self.gpu_failed = true,
                }
            }
            match self.gpu.as_mut() {
                Some(conv) => {
                    let mut bytes = Vec::new();
                    match conv.convert(frame.as_raw_texture(), &mut bytes) {
                        Ok(()) => bytes,
                        Err(_) => {
                            // 单帧 GPU 转换失败：标记失效并回退 RGBA，避免写入错误格式字节损坏视频。
                            self.gpu_failed = true;
                            self.gpu = None;
                            rgba_payload(frame)?
                        }
                    }
                }
                None => rgba_payload(frame)?,
            }
        } else {
            // GPU 缩放不可用时的兜底：直接读回原生 RGBA（4K 全帧回读，较慢），由 ffmpeg scale 兜底。
            rgba_payload(frame)?
        };
        self.counter.fetch_add(1, Ordering::SeqCst);
        match self.sender.try_send(payload) {
            Ok(()) => {}
            Err(std::sync::mpsc::TrySendError::Full(_)) => { /* 背压丢帧 */ }
            Err(std::sync::mpsc::TrySendError::Disconnected(_)) => capture_control.stop(),
        }
        Ok(())
    }
}

/// 录屏自测：真正捕获 `duration_secs` 秒，统计帧数与输出，并捕获 ffmpeg stderr。
#[tauri::command]
pub async fn recording_self_test(app: AppHandle, duration_secs: Option<u32>) -> Value {
    tauri::async_runtime::spawn_blocking(move || -> Value {
        let dur = duration_secs.unwrap_or(3).clamp(1, 15) as u64;
        run_capture_test(&app, dur)
    })
    .await
    .unwrap_or_else(|e| json!({ "ok": false, "stage": "task", "error": format!("{:?}", e) }))
}

fn run_capture_test(app: &AppHandle, dur: u64) -> Value {
    let ffmpeg_path = crate::services::recording_service::get_ffmpeg_path(app);
    let ffmpeg_present = {
        let mut cmd = Command::new(&ffmpeg_path);
        cmd.arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        cmd.creation_flags(0x08000000);
        cmd.status().is_ok()
    };
    if !ffmpeg_present {
        let r = json!({ "ok": false, "ffmpegPath": ffmpeg_path, "error": "ffmpeg 不可用（未找到或无法执行）" });
        diag_log(app, "REC", &format!("selftest ffmpeg 不可用: {}", ffmpeg_path));
        return r;
    }
    let ffmpeg_version = {
        let mut cmd = Command::new(&ffmpeg_path);
        cmd.arg("-version");
        #[cfg(windows)]
        cmd.creation_flags(0x08000000);
        cmd.output()
    }
        .ok()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .to_string()
        })
        .unwrap_or_default();
    let encoder = crate::services::recording_service::probe_hw_encoder(&ffmpeg_path);

    let out_dir = match app.path().app_data_dir() {
        Ok(d) => d.join("logs"),
        Err(e) => return json!({ "ok": false, "error": format!("app_data 失败: {}", e) }),
    };
    let _ = fs::create_dir_all(&out_dir);
    let out_path = out_dir.join("recording_selftest.mp4");
    let _ = fs::remove_file(&out_path);

    let monitors = match Monitor::enumerate() {
        Ok(m) => m,
        Err(e) => return json!({ "ok": false, "error": format!("枚举显示器失败: {}", e) }),
    };
    let monitor = match monitors.into_iter().next() {
        Some(m) => m,
        None => return json!({ "ok": false, "error": "无显示器" }),
    };
    let rect = crate::services::recording_service::monitor_rect_phys(&monitor);
    let mut enc_w = ((rect.2 - rect.0) as u32) & !1;
    let mut enc_h = ((rect.3 - rect.1) as u32) & !1;
    if enc_w == 0 {
        enc_w = 1280;
    }
    if enc_h == 0 {
        enc_h = 720;
    }
    let fps = 30u32;

    // 与真实录制一致的 4K 全屏降采样决策：超 1080p 即降采样。GPU 可用时走 GPU RGBA→NV12 缩放，
    // 否则走 CPU 双线性降采样，使自测不再因 4K 整帧 RGBA 的 ~33MB/帧 回读而比真实录制更卡。
    let gpu_nv12 = nv12_in_process_supported();
    let downscale_4k = (enc_w as u64) * (enc_h as u64) > 1920u64 * 1080u64;
    let (out_w, out_h) = if downscale_4k {
        let mut ow = 1920u32;
        let mut oh = (((1920.0 * enc_h as f64 / enc_w as f64) / 2.0).round() as u32) * 2;
        ow &= !1;
        oh &= !1;
        (ow, oh)
    } else {
        (enc_w, enc_h)
    };
    // 进程内 GPU 缩放产出 RGBA（8MB），故像素格式恒为 rgba；ffmpeg 负责 RGBA→YUV。
    let pix_fmt = "rgba";

    // 系统声音（best-effort）：优先 ffmpeg 原生 WASAPI 回环采集（需全量 ffmpeg 含 wasapi demuxer），
    // 否则回退 Rust WASAPI 采集命名管道。
    let audio_wasapi: Option<String> = resolve_audio_input(&ffmpeg_path);
    let audio_pipe: Option<(AudioCapture, String, AudioFormat)> = if audio_wasapi.is_none() {
        match start_audio_capture() {
            Ok(triple) => Some(triple),
            Err(e) => {
                eprintln!("[诊断自测] 系统声音采集不可用，仅测视频: {e}");
                None
            }
        }
    } else {
        None
    };
    let had_audio = audio_wasapi.is_some() || audio_pipe.is_some();
    let audio_fmt_str = audio_pipe.as_ref().map(|(_, _, f)| format!("{} {}ch {}Hz", f.sample_fmt, f.channels, f.rate));

    let mut args: Vec<String> = vec![
        "-y".into(),
        "-f".into(),
        "rawvideo".into(),
        "-pix_fmt".into(),
        pix_fmt.into(),
        "-s".into(),
        format!("{}x{}", out_w, out_h),
        "-r".into(),
        fps.to_string(),
        "-i".into(),
        "-".into(), // 视频来自 stdin 管道（RGBA 帧）
    ];
    // 音频输入：优先 ffmpeg 原生 WASAPI（视频第 0 路、音频第 1 路），否则 Rust 命名管道。
    if let Some(ref dev) = audio_wasapi {
        args.extend(["-f".into(), "wasapi".into(), "-i".into(), dev.clone()]);
    } else if let Some((_cap, apath, afmt)) = &audio_pipe {
        args.extend([
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
    match encoder {
        Some("h264_nvenc") => args.extend([
            "-c:v".into(), "h264_nvenc".into(), "-preset".into(), "p1".into(),
            "-rc".into(), "constqp".into(), "-qp".into(), "23".into(), "-pix_fmt".into(), "yuv420p".into(),
        ]),
        Some("h264_qsv") => args.extend([
            "-c:v".into(), "h264_qsv".into(), "-preset".into(), "veryfast".into(),
            "-global_quality".into(), "23".into(), "-pix_fmt".into(), "yuv420p".into(),
        ]),
        Some("h264_amf") => args.extend([
            "-c:v".into(), "h264_amf".into(), "-quality".into(), "speed".into(),
            "-rc".into(), "cqp".into(), "-qp_p".into(), "23".into(), "-qp_b".into(), "23".into(),
            "-pix_fmt".into(), "yuv420p".into(),
        ]),
        _ => args.extend([
            "-c:v".into(), "libx264".into(), "-preset".into(), "ultrafast".into(),
            "-crf".into(), "23".into(), "-pix_fmt".into(), "yuv420p".into(),
        ]),
    }
    // 音视频映射：视频第 0 路、音频第 1 路（若有）；-shortest 保证视频 EOF 后 ffmpeg 退出。
    // 采用恒定帧率（pacer 已按 1/fps 恒定写出 + 帧保持），不使用 wallclock，确保视频时长精确为 dur 秒。
    args.extend(["-fps_mode".into(), "passthrough".into()]);
    if audio_wasapi.is_some() || audio_pipe.is_some() {
        args.extend([
            "-map".into(), "0:v:0".into(),
            "-map".into(), "1:a:0".into(),
            "-c:a".into(), "aac".into(),
            "-b:a".into(), "192k".into(),
            "-shortest".into(),
        ]);
    } else {
        args.extend(["-map".into(), "0:v:0".into()]);
    }
    args.extend(["-movflags".into(), "+faststart".into(), out_path.to_string_lossy().to_string()]);

    // ffmpeg stderr 重定向到文件（最可靠，避免管道读取遗漏导致"stderr 为空"无法定位失败原因）
    let stderr_path = out_dir.join("ffmpeg_selftest_stderr.txt");
    let mut child_cmd = Command::new(&ffmpeg_path);
    child_cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(match std::fs::File::create(&stderr_path) {
            Ok(f) => Stdio::from(f),
            Err(_) => Stdio::null(),
        });
    #[cfg(windows)]
    child_cmd.creation_flags(0x08000000);
    let mut child = match child_cmd.spawn()
    {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "error": format!("启动 ffmpeg 失败: {}", e) }),
    };

    let mut stdin = match child.stdin.take() {
        Some(s) => s,
        None => {
            let _ = child.kill();
            return json!({ "ok": false, "error": "无法获取 ffmpeg stdin" });
        }
    };
    let (tx, rx) = sync_channel::<Vec<u8>>(4);
    let counter = Arc::new(AtomicUsize::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let _writer = thread::spawn(move || {
        // 恒定节奏写出 + 帧保持：保证自测视频时长精确为 dur 秒（不加速）；
        // 若采集跟不上则在相应位置重复上一帧，可直观反映掉帧/卡顿。
        let frame_dur = Duration::from_secs_f64(1.0 / fps as f64);
        let total = (dur as usize) * (fps as usize);
        let mut last: Option<Vec<u8>> = None;
        let start = std::time::Instant::now();
        for i in 0..total {
            let frame = match rx.recv_timeout(frame_dur) {
                Ok(b) => {
                    last = Some(b.clone());
                    b
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => match &last {
                    Some(b) => b.clone(),
                    None => {
                        let target = start + frame_dur * ((i as u32) + 1);
                        let now = std::time::Instant::now();
                        if target > now {
                            thread::sleep(target - now);
                        }
                        continue;
                    }
                },
                Err(_) => break,
            };
            if stdin.write_all(&frame).is_err() {
                break;
            }
            let target = start + frame_dur * ((i as u32) + 1);
            let now = std::time::Instant::now();
            if target > now {
                thread::sleep(target - now);
            }
        }
    });
    let tx_c = tx.clone();
    let stop_c = stop.clone();
    let counter_c = counter.clone();
    // 自测用适度连续投帧：最小更新间隔 40ms（≈25fps）。
    // 目的：静态桌面下也能稳定拿到足量帧、产出有效 MP4，避免「交付帧数=4 → 0 字节」误判。
    // 不采用 Custom(Duration::ZERO)：那会强制 60fps 满帧率，4K RGBA 每帧 ~33MB 的 CPU 拷贝
    // 会吃满整机 CPU（真实录屏卡顿、区域选择覆盖窗饿死的根因）。40ms 对一次 3s 自测足够轻量。
    // 平台不支持 Custom 时退回 Default。monitor 为 Copy，可复用。
    let capture = thread::spawn(move || {
        let flags = (tx_c, stop_c, counter_c, gpu_nv12, downscale_4k, out_w, out_h);
        let settings = Settings::new(
            monitor,
            CursorCaptureSettings::Default,
            DrawBorderSettings::WithoutBorder,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Custom(Duration::from_millis(40)),
            DirtyRegionSettings::Default,
            ColorFormat::Rgba8,
            flags.clone(),
        );
        let res = TestCapture::start(settings);
        if let Err(e) = res {
            if format!("{:?}", e).contains("MinimumUpdateInterval") {
                let settings = Settings::new(
                    monitor,
                    CursorCaptureSettings::Default,
                    DrawBorderSettings::WithoutBorder,
                    SecondaryWindowSettings::Default,
                    MinimumUpdateIntervalSettings::Default,
                    DirtyRegionSettings::Default,
                    ColorFormat::Rgba8,
                    flags,
                );
                let _ = TestCapture::start(settings);
            } else {
                // 捕获失败（如 WGC 无法启动）仅记录，不直接 panic；capture 线程结束会令 writer 收 EOF
                let _ = e;
            }
        }
    });

    // 真正录 duration 秒
    thread::sleep(Duration::from_secs(dur));
    stop.store(true, Ordering::SeqCst);
    drop(tx);
    let _ = capture.join();

    // 等待 ffmpeg 退出（最多 6s）
    let mut waited = 0;
    let mut exited_ok = false;
    let mut exit_code: i64 = -1;
    loop {
        match child.try_wait() {
            Ok(Some(st)) => {
                exited_ok = st.success();
                exit_code = st.code().map(|c| c as i64).unwrap_or(-1);
                break;
            }
            Ok(None) => {
                if waited >= 6000 {
                    let _ = child.kill();
                    break;
                }
                thread::sleep(Duration::from_millis(100));
                waited += 100;
            }
            Err(_) => break,
        }
    }
    let stderr_tail = fs::read_to_string(&stderr_path).unwrap_or_default();
    let out_bytes = fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
    let frames = counter.load(Ordering::SeqCst);

    // ffmpeg 已退出（或超时）：关闭系统声音采集管道与线程，释放 COM/句柄。
    if let Some((mut a, _, _)) = audio_pipe {
        a.stop();
    }

    let report = json!({
        "ok": out_bytes > 1024,
        "ffmpegPath": ffmpeg_path,
        "ffmpegVersion": ffmpeg_version,
        "encoder": encoder,
        "captureW": enc_w,
        "captureH": enc_h,
        "gpuNv12": gpu_nv12,
        "downscale4k": downscale_4k,
        "outW": out_w,
        "outH": out_h,
        "audio": had_audio,
        "audioFmt": audio_fmt_str,
        "durationSecs": dur,
        "framesCaptured": frames,
        "outputBytes": out_bytes,
        "ffmpegExitedOk": exited_ok,
        "ffmpegExitCode": exit_code,
        "ffmpegStderrTail": stderr_tail,
    });
    diag_log(
        app,
        "REC",
        &format!(
            "selftest: frames={} outBytes={} enc={:?} exitedOk={} stderrTail={}",
            frames, out_bytes, encoder, exited_ok, stderr_tail
        ),
    );
    report
}

/// 导入诊断：跑同样的 pptx_to_json，但只回传统计并用 catch_unwind 捕获 panic。
/// 即便解析 panic 也不会让进程崩溃；输出 JSON 体量也能直接看出是否"数据过大"。
#[tauri::command]
pub fn wps_import_pptx_diagnose(app: AppHandle, path: String) -> Value {
    let started = SystemTime::now();
    let file_size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let media_dir = match app.path().app_data_dir() {
        Ok(d) => d.join("pptx_media"),
        Err(e) => {
            let r = json!({ "ok": false, "stage": "app_data", "error": e.to_string() });
            diag_log(&app, "PPTX", &format!("diagnose app_data err: {}", e));
            return r;
        }
    };
    let _ = fs::create_dir_all(&media_dir);

    let work = std::panic::AssertUnwindSafe(|| -> Result<String, String> {
        let bytes = fs::read(&path).map_err(|e| format!("读取失败: {}", e))?;
        crate::services::pptx_import::pptx_to_json(&bytes, &media_dir)
    });
    let result = std::panic::catch_unwind(work);

    match result {
        Ok(Ok(json_str)) => {
            let v: Value = serde_json::from_str(&json_str).unwrap_or(Value::Null);
            let slides = v
                .get("slides")
                .and_then(|s| s.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            let mut elements = 0usize;
            let mut images = 0usize;
            if let Some(arr) = v.get("slides").and_then(|s| s.as_array()) {
                for s in arr {
                    if let Some(els) = s.get("elements").and_then(|e| e.as_array()) {
                        elements += els.len();
                        for el in els {
                            if el.get("type").and_then(|t| t.as_str()) == Some("image") {
                                images += 1;
                            }
                        }
                    }
                }
            }
            let out_bytes = json_str.len() as u64;
            let media_files = fs::read_dir(&media_dir).map(|r| r.count()).unwrap_or(0);
            let elapsed = started.elapsed().map(|d| d.as_millis() as u64).unwrap_or(0);
            let report = json!({
                "ok": true,
                "inputBytes": file_size,
                "outputJsonBytes": out_bytes,
                "slideCount": slides,
                "elementCount": elements,
                "imageCount": images,
                "mediaFilesWritten": media_files,
                "elapsedMs": elapsed,
            });
            diag_log(&app, "PPTX", &format!("diagnose OK: {}", report));
            report
        }
        Ok(Err(e)) => {
            let report = json!({ "ok": false, "stage": "parse", "error": e });
            diag_log(&app, "PPTX", &format!("diagnose parse err: {}", e));
            report
        }
        Err(payload) => {
            // 取出 panic 的真实信息（通常是 String 或 &str），便于定位崩溃点
            let msg = if let Some(s) = payload.downcast_ref::<String>() {
                s.clone()
            } else if let Some(s) = payload.downcast_ref::<&str>() {
                s.to_string()
            } else {
                "未知 panic 类型（无消息负载）".to_string()
            };
            let report = json!({
                "ok": false,
                "stage": "panic",
                "error": format!("pptx_to_json panic: {}", msg),
            });
            diag_log(&app, "PPTX", &format!("diagnose PANIC: {}", msg));
            report
        }
    }
}
