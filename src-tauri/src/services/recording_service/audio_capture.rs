//! 用 Windows WASAPI 回环捕获「正在播放的系统声音」，把裸 PCM 写入命名管道，
//! 再由 ffmpeg 以第二个输入（命名管道）读取并编码为音轨。
//!
//! 动机：打包的 ffmpeg（gyan essentials 版）不含 `wasapi` demuxer，原 `resolve_audio_input`
//! 用 `ffmpeg -f wasapi` 的路径在本环境恒为 None，导致录制从无声音。本模块在 Rust 侧直接
//! 抓 PCM，彻底绕开 ffmpeg 对 wasapi demuxer 的依赖，任何机器都能录到系统声音。
//!
//! 设计为 best-effort：初始化失败只返回 Err，上层应降级为「仅视频」，绝不 panic。
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use windows::core::{GUID, PCWSTR};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
};
use windows::Win32::Storage::FileSystem::{
    WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_OUTBOUND,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES,
    PIPE_WAIT,
};
use windows::Win32::System::Threading::GetCurrentProcessId;

/// KSDATAFORMAT_SUBTYPE_IEEE_FLOAT / _PCM（用于解析 WAVEFORMATEXTENSIBLE 的 SubFormat）。
const SUBTYPE_FLOAT: GUID = GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);
const SUBTYPE_PCM: GUID = GUID::from_u128(0x00000001_0000_0010_8000_00aa00389b71);

#[derive(Clone, Copy)]
pub struct AudioFormat {
    pub rate: u32,
    pub channels: u16,
    pub sample_fmt: &'static str,
    /// 每帧字节数（channels * bytes_per_sample），用于按帧换算 PCM 字节。
    pub block_align: u16,
}

pub struct AudioCapture {
    stop: Arc<AtomicBool>,
    /// 命名管道句柄以 usize 保存以满足 Send（HANDLE 本身不 Send）。
    handle: usize,
    thread: Option<JoinHandle<()>>,
}

impl AudioCapture {
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // 关闭管道句柄会令仍在阻塞 ConnectNamedPipe / WriteFile 的采集线程立即出错返回，从而退出。
        unsafe {
            let h = HANDLE(self.handle as *mut std::ffi::c_void);
            let _ = DisconnectNamedPipe(h);
            let _ = windows::Win32::Foundation::CloseHandle(h);
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// 启动系统声音回环采集。成功时返回 (句柄, 管道路径, 格式)，调用方应在拿到格式、
/// 拼好 ffmpeg 参数后再 spawn ffmpeg（ffmpeg 打开管道时本线程才 ConnectNamedPipe）。
pub fn start_audio_capture() -> Result<(AudioCapture, String, AudioFormat), String> {
    let pid = unsafe { GetCurrentProcessId() };
    let salt = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let pipe_path = format!("\\\\.\\pipe\\andeyunhui_audio_{}_{}", pid, salt);

    let wide: Vec<u16> = OsStr::new(pipe_path.as_str())
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let handle = unsafe {
        CreateNamedPipeW(
            PCWSTR(wide.as_ptr()),
            PIPE_ACCESS_OUTBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            1 << 20,
            1 << 20,
            0,
            None,
        )
    };
    if handle.is_invalid() {
        return Err("CreateNamedPipeW 失败".into());
    }
    let handle_raw = handle.0 as usize;

    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel::<Result<AudioFormat, String>>();
    let stop2 = stop.clone();
        let thread = thread::spawn(move || {
        let res = capture_entry(handle_raw, stop2, tx);
        if res.is_err() {
            // 已通过 tx 回传过错误；此处无需再处理。
        }
    });

    match rx.recv() {
        Ok(Ok(fmt)) => Ok((
            AudioCapture {
                stop,
                handle: handle_raw,
                thread: Some(thread),
            },
            pipe_path,
            fmt,
        )),
        Ok(Err(e)) => {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(HANDLE(handle_raw as *mut std::ffi::c_void));
            }
            let _ = thread.join();
            Err(e)
        }
        Err(_) => {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(HANDLE(handle_raw as *mut std::ffi::c_void));
            }
            Err("音频采集线程意外退出".into())
        }
    }
}

fn capture_entry(
    handle_raw: usize,
    stop: Arc<AtomicBool>,
    tx: mpsc::Sender<Result<AudioFormat, String>>,
) -> Result<AudioFormat, String> {
    let handle = HANDLE(handle_raw as *mut std::ffi::c_void);
    unsafe {
        // 采集线程独立初始化 COM（MTA）。已初始化时返回的错误可忽略。
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|e| e.to_string())?;
        let client: IAudioClient = device
            .Activate::<IAudioClient>(CLSCTX_ALL, None)
            .map_err(|e| e.to_string())?;

        let pformat = client.GetMixFormat().map_err(|e| e.to_string())?;
        let fmt = parse_format(pformat)?;

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

        // 先把格式回传给调用方（调用方据此拼 ffmpeg 音频输入参数），再阻塞等待 ffmpeg 连接管道。
        if tx.send(Ok(fmt)).is_err() {
            let _ = client.Stop();
            return Err("音频格式回传失败".into());
        }

        if ConnectNamedPipe(handle, None).is_err() {
            let _ = client.Stop();
            return Err("ConnectNamedPipe 失败（ffmpeg 未连接音频管道）".into());
        }

        let block_align = fmt.block_align as usize;
        while !stop.load(Ordering::SeqCst) {
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut frames: u32 = 0;
            let mut flags: u32 = 0;
            if capture
                .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                .is_ok()
            {
                if frames > 0 && !data.is_null() {
                    let bytes = (frames as usize) * block_align;
                    let slice = std::slice::from_raw_parts(data, bytes);
                    let mut written: u32 = 0;
                    let _ = WriteFile(handle, Some(slice), Some(&mut written), None);
                }
                let _ = capture.ReleaseBuffer(frames);
            } else {
                thread::sleep(Duration::from_millis(10));
            }
            thread::sleep(Duration::from_millis(8));
        }

        let _ = client.Stop();
        Ok(fmt)
    }
}

/// 解析 WAVEFORMATEX（含 WAVEFORMATEXTENSIBLE）为 ffmpeg 可用的 PCM 格式描述。
fn parse_format(pformat: *mut windows::Win32::Media::Audio::WAVEFORMATEX) -> Result<AudioFormat, String> {
    unsafe {
        let f = *pformat;
        let tag = f.wFormatTag;
        let bits = f.wBitsPerSample;
        let (sample_fmt, bytes_per_sample) = if tag == 3 {
            // WAVE_FORMAT_IEEE_FLOAT
            ("f32le", 4u16)
        } else if tag == 1 {
            // WAVE_FORMAT_PCM
            match bits {
                16 => ("s16le", 2),
                32 => ("s32le", 4),
                _ => return Err(format!("不支持的 PCM 位深 {}", bits)),
            }
        } else if tag == 0xFFFE {
            // WAVE_FORMAT_EXTENSIBLE：SubFormat 位于 WAVEFORMATEX(18) + Samples(2) = 偏移 20 字节处。
            let sub_ptr = (pformat as *const u8).add(20) as *const GUID;
            let sub = *sub_ptr;
            if sub == SUBTYPE_FLOAT {
                ("f32le", 4)
            } else if sub == SUBTYPE_PCM {
                match bits {
                    16 => ("s16le", 2),
                    32 => ("s32le", 4),
                    _ => return Err(format!("不支持的 EXTENSIBLE PCM 位深 {}", bits)),
                }
            } else {
                return Err("不支持的 WAVEFORMATEXTENSIBLE SubFormat".into());
            }
        } else {
            return Err(format!("不支持的 wave 格式标签 {}", tag));
        };
        let channels = f.nChannels;
        let rate = f.nSamplesPerSec;
        let block_align = (channels as u32 * bytes_per_sample as u32) as u16;
        Ok(AudioFormat {
            rate,
            channels,
            sample_fmt,
            block_align,
        })
    }
}
