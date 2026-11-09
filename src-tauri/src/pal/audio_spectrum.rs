//! PipeWire 频谱分析 — 通过 `pw-record` 子进程抓系统音频，做 FFT 推送频域数据。
//!
//! 与 Windows 版的差异只在「音频源」：
//! - Windows：WASAPI Loopback（`src/audio_spectrum.rs`）
//! - Linux  ：`pw-record` 抓默认 sink 的 monitor（本文件）
//!
//! FFT / Hann 窗 / 频段聚类 / 推送节奏与 Windows 版保持一致，
//! 这样前端拿到的 `audio-spectrum` 事件格式完全相同，无需分支。
//!
//! 依赖系统命令 `pw-record`（PipeWire 自带）。实测本机：
//! `pw-record --format s16 --rate 48000 --channels 2 --target <sink>`
//! 能抓到播放中的系统音频（440Hz 正弦：峰值 4095 / 非零 98%）。

use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

/// FFT 窗口大小（与 Windows 版一致）
const FFT_SIZE: usize = 1024;
const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: u32 = 2;
/// s16le
const BYTES_PER_SAMPLE: usize = 2;
/// 输出频段数
const BARS: usize = 64;
/// 推送间隔（约 30fps）
const PUSH_INTERVAL_MS: u64 = 33;

static SPECTRUM_DATA: Mutex<Option<Vec<u8>>> = Mutex::new(None);
static CAPTURE_STOP: AtomicBool = AtomicBool::new(false);
static LISTENERS: AtomicUsize = AtomicUsize::new(0);
static STARTED: AtomicBool = AtomicBool::new(false);
static CHILD_PID: Mutex<Option<u32>> = Mutex::new(None);

/// 前端监听者计数：>0 才做 FFT / 推送（与 Windows 版语义一致）
pub fn set_listener(active: bool) {
    if active {
        LISTENERS.fetch_add(1, Ordering::SeqCst);
    } else {
        LISTENERS.fetch_sub(1, Ordering::SeqCst);
    }
}

fn has_listener() -> bool {
    LISTENERS.load(Ordering::SeqCst) > 0
}

/// 启动采集线程（幂等）
pub fn start_spectrum_capture(app: tauri::AppHandle) -> Result<(), String> {
    if STARTED.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    CAPTURE_STOP.store(false, Ordering::SeqCst);
    thread::Builder::new()
        .name("spectrum-pipewire".into())
        .stack_size(256 * 1024)
        .spawn(move || spectrum_loop(app))
        .map_err(|e| format!("频谱采集线程启动失败: {e}"))?;
    Ok(())
}

pub fn stop_spectrum_capture() {
    CAPTURE_STOP.store(true, Ordering::SeqCst);
    STARTED.store(false, Ordering::SeqCst);
    // 杀掉子进程（否则它会一直抓音）
    if let Some(pid) = *CHILD_PID.lock().unwrap_or_else(|e| e.into_inner()) {
        let _ = Command::new("kill").arg(pid.to_string()).status();
    }
}

pub fn get_spectrum() -> Vec<u8> {
    SPECTRUM_DATA
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .unwrap_or_else(|| vec![0u8; BARS])
}

/// 找默认音频 sink 的 node.name。
///
/// `pw-record --target` 接受节点名或 id。优先用**名字**（id 会随重启变化）。
/// 解析 `pw-dump` 的 JSON（项目已有 serde_json，无需额外依赖）。
fn find_sink_target() -> Option<String> {
    // **优先读系统默认 sink**：`pw-metadata -n default` 会输出
    //   update: id:0 key:'default.audio.sink' value:'{"name":"...Headphones__sink"}' ...
    // 不能简单取第一个 Audio/Sink —— 本机有 HDMI1/2/3 + Headphones 四个，
    // 第一个是 HDMI3，抓它会一直静音（用户实际输出在 Headphones）。
    if let Ok(out) = Command::new("pw-metadata").args(["-n", "default"]).output() {
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if !line.contains("default.audio.sink") {
                continue;
            }
            // 从 value:'{"name":"XXX"}' 里抠出 name
            if let Some(pos) = line.find("\"name\":\"") {
                let rest = &line[pos + 8..];
                if let Some(end) = rest.find('"') {
                    let name = &rest[..end];
                    if !name.is_empty() {
                        return Some(name.to_string());
                    }
                }
            }
        }
    }

    // 回退：取第一个 Audio/Sink
    let out = Command::new("pw-dump").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let arr = json.as_array()?;
    for obj in arr {
        let props = match obj.get("info").and_then(|i| i.get("props")) {
            Some(p) => p,
            None => continue,
        };
        let class = props
            .get("media.class")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if class == "Audio/Sink" {
            if let Some(name) = props.get("node.name").and_then(|v| v.as_str()) {
                return Some(name.to_string());
            }
        }
    }
    None
}

fn spectrum_loop(app: tauri::AppHandle) {
    let target = match find_sink_target() {
        Some(t) => t,
        None => {
            eprintln!("[Spectrum] 找不到 PipeWire 音频 sink，频谱不可用");
            STARTED.store(false, Ordering::SeqCst);
            return;
        }
    };

    let mut child: Child = match Command::new("pw-record")
        .args([
            "--format",
            "s16",
            "--rate",
            &SAMPLE_RATE.to_string(),
            "--channels",
            &CHANNELS.to_string(),
            "--target",
            &target,
            // `-` = stdout（pw-record 明确支持 `[<文件>|-]`）。
            // 之前写 /dev/stdout 会被 pw-record 当作普通文件重新 open，
            // 拿不到 Stdio::piped() 的管道 ⇒ 立刻 EOF ⇒ 采集线程秒退。
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[Spectrum] 启动 pw-record 失败: {e}（频谱不可用）");
            STARTED.store(false, Ordering::SeqCst);
            return;
        }
    };
    *CHILD_PID.lock().unwrap_or_else(|e| e.into_inner()) = Some(child.id());
    eprintln!(
        "[Spectrum] PipeWire 采集就绪: target={target}, {SAMPLE_RATE}Hz {CHANNELS}ch s16"
    );

    let mut stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            eprintln!("[Spectrum] 无法获取 pw-record 输出");
            return;
        }
    };

    // Hann 窗
    let hann: Vec<f64> = (0..FFT_SIZE)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / (FFT_SIZE - 1) as f64).cos())
        .collect();

    let mut planner = rustfft::FftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let mut fft_buf: Vec<rustfft::num_complex::Complex<f64>> = (0..FFT_SIZE)
        .map(|_| rustfft::num_complex::Complex::new(0.0, 0.0))
        .collect();

    // PCM ring（mono f32）
    let mut pcm_ring: Vec<f32> = Vec::with_capacity(FFT_SIZE * 2);
    let frame_bytes = CHANNELS as usize * BYTES_PER_SAMPLE;
    // 每次读约 10ms 的数据
    let mut chunk = vec![0u8; frame_bytes * (SAMPLE_RATE as usize / 100)];
    let mut last_push = Instant::now();

    while !CAPTURE_STOP.load(Ordering::SeqCst) {
        match stdout.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                let samples = n / BYTES_PER_SAMPLE;
                let frames = samples / CHANNELS as usize;
                for f in 0..frames {
                    let mut acc = 0.0f32;
                    for c in 0..CHANNELS as usize {
                        let off = (f * CHANNELS as usize + c) * BYTES_PER_SAMPLE;
                        if off + 1 < n {
                            let v = i16::from_le_bytes([chunk[off], chunk[off + 1]]) as f32;
                            acc += v / 32768.0;
                        }
                    }
                    pcm_ring.push(acc / CHANNELS as f32);
                }
                if pcm_ring.len() > FFT_SIZE * 2 {
                    let drop = pcm_ring.len() - FFT_SIZE * 2;
                    pcm_ring.drain(0..drop);
                }
            }
            Err(e) => {
                eprintln!("[Spectrum] 读取 pw-record 失败: {e}");
                break;
            }
        }

        // 无监听者时不做 FFT（省 CPU），但仍继续读取以清空管道
        if !has_listener() {
            if pcm_ring.len() > FFT_SIZE * 2 {
                let drop = pcm_ring.len() - FFT_SIZE * 2;
                pcm_ring.drain(0..drop);
            }
            continue;
        }

        while pcm_ring.len() >= FFT_SIZE {
            let start = pcm_ring.len() - FFT_SIZE;
            for i in 0..FFT_SIZE {
                fft_buf[i] =
                    rustfft::num_complex::Complex::new(pcm_ring[start + i] as f64 * hann[i], 0.0);
            }
            fft.process(&mut fft_buf);
            let bars = compute_bars(&fft_buf);

            {
                let mut guard = SPECTRUM_DATA.lock().unwrap_or_else(|e| e.into_inner());
                *guard = Some(bars.clone());
            }
            if last_push.elapsed().as_millis() as u64 >= PUSH_INTERVAL_MS {
                let _ = tauri::Emitter::emit(&app, "audio-spectrum", bars);
                last_push = Instant::now();
                break; // 一帧只推一次，避免积压
            }
            pcm_ring.drain(0..(FFT_SIZE / 2)); // 50% overlap
        }

        thread::sleep(Duration::from_millis(10));
    }

    let _ = child.kill();
    let _ = child.wait();
    *CHILD_PID.lock().unwrap_or_else(|e| e.into_inner()) = None;
    eprintln!("[Spectrum] 采集线程退出");
}

/// 把 FFT 结果聚成 BARS 个频段（对数分布，0~255）。
///
/// 输出形状与 Windows 版 `compute_bars` 一致（64 个 u8），前端不区分平台。
fn compute_bars(buf: &[rustfft::num_complex::Complex<f64>]) -> Vec<u8> {
    let nyquist = SAMPLE_RATE as f64 / 2.0;
    let bin_hz = nyquist / (FFT_SIZE as f64 / 2.0);
    let mut bars = vec![0u8; BARS];

    let f_min = 20.0f64;
    let f_max = 16_000.0f64;
    for (i, bar) in bars.iter_mut().enumerate() {
        let lo = f_min * (f_max / f_min).powf(i as f64 / BARS as f64);
        let hi = f_min * (f_max / f_min).powf((i + 1) as f64 / BARS as f64);
        let b0 = (lo / bin_hz).floor().max(1.0) as usize;
        let b1 = (hi / bin_hz).ceil().min((FFT_SIZE / 2 - 1) as f64) as usize;
        let mut peak = 0.0f64;
        for b in b0..=b1.max(b0) {
            if b < buf.len() / 2 {
                let m = buf[b].norm();
                if m > peak {
                    peak = m;
                }
            }
        }
        let norm = (peak / (FFT_SIZE as f64 / 4.0)).clamp(0.0, 1.0);
        let db = 20.0 * (norm.max(1e-6)).log10(); // -120..0
        let v = ((db + 80.0) / 80.0 * 255.0).clamp(0.0, 255.0);
        *bar = v as u8;
    }
    bars
}
