//! WASAPI Loopback 频谱分析器 — 捕获系统音频做 FFT，推送频域数据到前端。
//!
//! 设计目标：极低占用。
//! - 单线程，10ms WASAPI 轮询 + 1024 点 FFT（约 0.05ms/次）
//! - 推送频率 30fps（33ms），payload 64×u8 = 64B/帧 ≈ 2KB/s
//! - 内存：FFT buffer ~16KB，PCM ring ~8KB，总 <1MB 额外
//! - WASAPI Loopback 不干扰 WebView2 音频路由

#![cfg(windows)]

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use windows::core::GUID;
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

/// 频谱条数（与前端 EQ_BARS 对齐）
const SPECTRUM_BARS: usize = 64;
/// FFT 窗口大小（2 的幂，1024 点足够频率分辨率）
const FFT_SIZE: usize = 1024;
/// 推送间隔（~30fps）
const PUSH_INTERVAL_MS: u64 = 33;

const SUBTYPE_FLOAT: GUID = GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);
const SUBTYPE_PCM: GUID = GUID::from_u128(0x00000001_0000_0010_8000_00aa00389b71);

/// 全局状态：当前频谱数据（双缓冲，Arc<Mutex> 供前端命令读取）
static SPECTRUM_DATA: Mutex<Option<Vec<u8>>> = Mutex::new(None);

/// 全局句柄，供 stop_spectrum 命令使用
static CAPTURE_STOP: AtomicBool = AtomicBool::new(false);

/// 活跃的 JS 监听者计数。>0 才做 WASAPI 轮询 / FFT / 推送；
/// 为 0 时采集线程退化为轻负载休眠，避免无人收听时白白占 CPU。
/// Tauri 的 emit 本身只投递给注册了该事件的 JS 监听器（非真·全局广播），
/// 这里用计数做「无监听即暂停」的门控，同时实现定向（仅在有监听者时推）。
static SPECTRUM_LISTENERS: AtomicUsize = AtomicUsize::new(0);

/// 前端订阅/退订频谱事件时调用，驱动「无监听即暂停」。
/// active=true：监听计数 +1；active=false：-1（saturating，防止泄漏为负）。
pub fn set_listener(active: bool) {
    if active {
        SPECTRUM_LISTENERS.fetch_add(1, Ordering::Relaxed);
    } else {
        let _ = SPECTRUM_LISTENERS.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |c| {
            if c > 0 {
                Some(c - 1)
            } else {
                None
            }
        });
    }
}

/// 当前是否有前端在监听频谱事件
pub fn has_listener() -> bool {
    SPECTRUM_LISTENERS.load(Ordering::Relaxed) > 0
}

/// 采集线程句柄：重启时 join 等待旧线程真正退出，避免新旧线程
/// 同时持有 WASAPI client、重复 emit（此前用固定 sleep(50ms) 猜测等待，
/// 旧线程若处于 100ms 休眠档会读到被新线程改回的运行标志而存活）。
static SPECTRUM_JOIN: std::sync::Mutex<Option<thread::JoinHandle<()>>> = std::sync::Mutex::new(None);

/// 启动频谱采集线程。返回 Ok 表示已启动（幂等：重复调用会先停旧线程再启新）。
pub fn start_spectrum_capture(app: tauri::AppHandle) -> Result<(), String> {
    // 停旧线程并 join 等待其真正退出（主循环每 10ms 检查一次停止标志）
    CAPTURE_STOP.store(true, Ordering::SeqCst);
    if let Some(h) = SPECTRUM_JOIN
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
    {
        let _ = h.join();
    }

    CAPTURE_STOP.store(false, Ordering::SeqCst); // 新线程标志：false = 运行中

    let app_handle = app.clone();
    let handle = thread::Builder::new()
        .name("spectrum-capture".into())
        .stack_size(256 * 1024) // 256KB 栈，足够 WASAPI + FFT
        .spawn(move || {
            spectrum_loop(app_handle);
        })
        .map_err(|e| format!("启动频谱线程失败: {e}"))?;

    *SPECTRUM_JOIN
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(handle);

    Ok(())
}

/// 停止频谱采集
pub fn stop_spectrum_capture() {
    CAPTURE_STOP.store(true, Ordering::SeqCst);
}

/// 获取当前频谱快照（前端 invoke 命令调用）
pub fn get_spectrum() -> Vec<u8> {
    SPECTRUM_DATA
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .unwrap_or_else(|| vec![0u8; SPECTRUM_BARS])
}

/// 频谱采集线程主循环
fn spectrum_loop(app: tauri::AppHandle) {
    // 初始化 COM（MTA）
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    // 初始化 WASAPI Loopback
    let (client, capture, rate, channels, bytes_per_sample) = match init_wasapi() {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[Spectrum] WASAPI 初始化失败: {}，频谱功能不可用", e);
            return;
        }
    };

    eprintln!(
        "[Spectrum] WASAPI 回环就绪: {}Hz, {}ch, {}bytes/sample",
        rate, channels, bytes_per_sample
    );

    // FFT 预计算 Hann 窗
    let hann: Vec<f64> = (0..FFT_SIZE)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / (FFT_SIZE - 1) as f64).cos())
        .collect();

    // FFT planner 和 buffer
    let mut planner = rustfft::FftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let mut fft_buf: Vec<rustfft::num_complex::Complex<f64>> =
        (0..FFT_SIZE).map(|_| rustfft::num_complex::Complex::new(0.0, 0.0)).collect();

    // PCM ring buffer（存 mono f32 采样）
    let mut pcm_ring: Vec<f32> = Vec::with_capacity(FFT_SIZE * 2);
    let block_align = (channels as usize * bytes_per_sample as usize).max(1);

    let mut last_push = Instant::now();

    while !CAPTURE_STOP.load(Ordering::SeqCst) {
        // 无前端监听 → 退化为轻负载休眠，跳过 WASAPI 轮询 / FFT / 推送。
        // 仅保持 IAudioClient 运行；恢复监听后一次性排空累积缓冲即可，无需重新初始化。
        if !has_listener() {
            thread::sleep(Duration::from_millis(100));
            continue;
        }

        // 排空 WASAPI 缓冲
        unsafe {
            loop {
                let mut data_ptr: *mut u8 = std::ptr::null_mut();
                let mut frames: u32 = 0;
                let mut flags: u32 = 0;
                if capture
                    .GetBuffer(&mut data_ptr, &mut frames, &mut flags, None, None)
                    .is_err()
                {
                    break;
                }
                if frames == 0 {
                    let _ = capture.ReleaseBuffer(0);
                    break;
                }

                let bytes = (frames as usize) * block_align;
                let silent = (flags & 0x2) != 0;

                if !silent && !data_ptr.is_null() {
                    // 将 PCM 转为 mono f32 并推入 ring
                    let slice = std::slice::from_raw_parts(data_ptr, bytes);
                    pcm_to_mono_f32(
                        slice,
                        channels as usize,
                        bytes_per_sample,
                        &mut pcm_ring,
                    );
                }
                let _ = capture.ReleaseBuffer(frames);
            }
        }

        // 保持 ring 不超过 2×FFT_SIZE
        if pcm_ring.len() > FFT_SIZE * 2 {
            pcm_ring.drain(0..(pcm_ring.len() - FFT_SIZE * 2));
        }

        // 有足够数据就做 FFT
        if pcm_ring.len() >= FFT_SIZE {
            // 取最新的 FFT_SIZE 个样本
            let start = pcm_ring.len() - FFT_SIZE;
            for i in 0..FFT_SIZE {
                let sample = pcm_ring[start + i] as f64;
                fft_buf[i] = rustfft::num_complex::Complex::new(sample * hann[i], 0.0);
            }

            fft.process(&mut fft_buf);

            // 计算 64 个频段的幅度
            let bars = compute_bars(&fft_buf, rate);

            // 存入全局
            {
                let mut guard = SPECTRUM_DATA.lock().unwrap_or_else(|e| e.into_inner());
                *guard = Some(bars.clone());
            }

            // 推送给前端（30fps）
            if last_push.elapsed().as_millis() as u64 >= PUSH_INTERVAL_MS {
                let _ = tauri::Emitter::emit(&app, "audio-spectrum", bars);
                last_push = Instant::now();
            }

            // 消费已分析的样本（滑动窗口）
            pcm_ring.drain(0..(FFT_SIZE / 2)); // 50% overlap
        }

        // 10ms 轮询
        thread::sleep(Duration::from_millis(10));
    }

    // 清理
    unsafe {
        let _ = client.Stop();
    }
    eprintln!("[Spectrum] 采集线程退出");
}

/// 初始化 WASAPI Loopback
fn init_wasapi() -> Result<(IAudioClient, IAudioCaptureClient, u32, u16, u16), String> {
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|e| e.to_string())?;
        let client: IAudioClient = device
            .Activate::<IAudioClient>(CLSCTX_ALL, None)
            .map_err(|e| e.to_string())?;

        let pformat = client.GetMixFormat().map_err(|e| e.to_string())?;
        let (rate, channels, bytes_per_sample) = parse_format(pformat)?;

        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK,
                0,
                0,
                pformat as *const _,
                None,
            )
            .map_err(|e| e.to_string())?;

        let capture: IAudioCaptureClient = client.GetService().map_err(|e| e.to_string())?;
        client.Start().map_err(|e| e.to_string())?;

        Ok((client, capture, rate, channels, bytes_per_sample))
    }
}

/// 解析 WAVEFORMATEX
fn parse_format(
    pformat: *mut windows::Win32::Media::Audio::WAVEFORMATEX,
) -> Result<(u32, u16, u16), String> {
    unsafe {
        // WAVEFORMATEX 是 #[repr(packed)] struct，不能直接引用字段（Rust 禁止 misaligned reference）。
        // 用 ptr::read_unaligned 安全读取。
        let f = std::ptr::read_unaligned(pformat);
        let tag = f.wFormatTag;
        let bits = f.wBitsPerSample;
        let channels = f.nChannels;
        let rate = f.nSamplesPerSec;
        let bytes_per_sample = (bits / 8).max(1);

        if tag == 3 || tag == 1 {
            // IEEE_FLOAT 或 PCM — 均可用
        } else if tag == 0xFFFE {
            let sub_ptr = (pformat as *const u8).add(24) as *const GUID;
            let sub = std::ptr::read_unaligned(sub_ptr);
            if sub != SUBTYPE_FLOAT && sub != SUBTYPE_PCM {
                eprintln!(
                    "[Spectrum] 未知 SubFormat {:?}（bits={}），回退 f32le",
                    sub, bits
                );
            }
        } else {
            return Err(format!("不支持的 wave 格式标签 {}", tag));
        }

        eprintln!(
            "[Spectrum] 格式: tag=0x{:X} ch={} bits={} rate={}",
            tag, channels, bits, rate
        );

        Ok((rate, channels, bytes_per_sample as u16))
    }
}

/// 将 PCM 字节流转为 mono f32 采样
fn pcm_to_mono_f32(data: &[u8], channels: usize, bytes_per_sample: u16, out: &mut Vec<f32>) {
    let bps = bytes_per_sample as usize;
    let frame_size = (channels * bps).max(1);
    let n_frames = data.len() / frame_size;

    for i in 0..n_frames {
        let frame_start = i * frame_size;
        let mut sum = 0.0f32;
        for ch in 0..channels {
            let off = frame_start + ch * bps;
            if off + bps > data.len() {
                break;
            }
            let sample = match bps {
                4 => {
                    // f32le
                    let bytes = [data[off], data[off + 1], data[off + 2], data[off + 3]];
                    f32::from_le_bytes(bytes)
                }
                2 => {
                    // s16le
                    let bytes = [data[off], data[off + 1]];
                    i16::from_le_bytes(bytes) as f32 / 32768.0
                }
                _ => 0.0,
            };
            sum += sample;
        }
        out.push(sum / channels as f32);
    }
}

/// 从 FFT 结果计算 64 个频段的幅度（0-255）
fn compute_bars(fft_buf: &[rustfft::num_complex::Complex<f64>], _rate: u32) -> Vec<u8> {
    let n = fft_buf.len();
    let half = n / 2; // 只取前半（Nyquist）

    // 对数频率映射：人耳对低频敏感
    let mut bars = vec![0u8; SPECTRUM_BARS];
    for i in 0..SPECTRUM_BARS {
        // 对数映射：前几个 bar 覆盖低频，后面覆盖高频
        let ratio = i as f64 / SPECTRUM_BARS as f64;
        let start_bin = ((ratio.powf(1.5) * half as f64) as usize).min(half - 1);
        let end_bin = (((ratio + 1.0 / SPECTRUM_BARS as f64).powf(1.5) * half as f64) as usize)
            .min(half)
            .max(start_bin + 1);

        // 取该频段的最大幅度
        let mut max_mag: f64 = 0.0;
        for j in start_bin..end_bin {
            let mag = (fft_buf[j].re * fft_buf[j].re + fft_buf[j].im * fft_buf[j].im).sqrt();
            if mag > max_mag {
                max_mag = mag;
            }
        }

        // 归一化：FFT 幅度 / FFT_SIZE → 0~1，再映射到 0~255
        // 经验值：典型音乐幅度在 0.001~0.5 范围（除以 FFT_SIZE 后）
        let normalized = (max_mag / (FFT_SIZE as f64 * 0.5)).min(1.0);
        // 对数缩放增强低频可见度
        let scaled = (normalized * 3.0).min(1.0);
        bars[i] = (scaled * 255.0) as u8;
    }
    bars
}
