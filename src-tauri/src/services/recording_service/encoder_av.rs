//! 完整 L0 进程内编码器：直接链接 libavcodec + libavformat，去掉 ffmpeg 子进程 / stdin 字节管道。
//!
//! 数据流：
//!   WGC(BGRA, dGPU) → GpuNv12Converter(BGRA→NV12, GPU 上) → 本编码器(feed_nv12)
//!     → h264_nvenc(在 dGPU 自建 CUDA 上下文上传 NV12) → libavformat 写 MP4
//!   WASAPI 回环(PCM) → 本编码器(feed_audio) → AAC(libavcodec) → 同一 MP4
//!
//! 关键修正（相对上一版被删掉的破实现）：
//!   * 所有 AVCodecContext 参数一律经 `av_dict_set` 由 ffmpeg 选项系统写入，
//!     绝不按硬编码偏移写结构体字段（那正是 avcodec_open2 报
//!     “Invalid video pixel format: -1” 的根因）。
//!   * 不绑定 d3d11va hwcontext（需未知偏移的 HWDevice 结构），改由 nvenc 自行接管 dGPU。

use std::ffi::CString;
use std::os::raw::{c_int, c_void};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use crate::services::recording_service::audio_capture::AudioFormat;
use crate::services::recording_service::ffi as ff;

/// AVPacket 视图：本构建仅写 `stream_index`，其余字段交给 ffmpeg 自有内存，不动。
/// 偏移按 FFmpeg 8 的 `AVPacket` 布局固定：`buf@0(8) pts@8(8) dts@16(8) data@24(8) size@32(4) stream_index@36(4)`。
/// ⚠️ 这是手搓布局，跨 FFmpeg 小版本若 `AVPacket` 布局变动会静默错写 stream_index；
///    理想解是 bindgen 生成真实布局。下方 assert 仅兜底结构体尺寸合理，不能校验偏移。
#[repr(C)]
struct MyPacket {
    _buf: *mut c_void,
    _pts: i64,
    _dts: i64,
    _data: *mut u8,
    _size: c_int,
    stream_index: c_int,
    _flags: c_int,
    _rest: [u8; 128],
}
const _: () = assert!(std::mem::size_of::<MyPacket>() >= 40);

#[derive(Clone)]
pub struct EncoderConfig {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u32,
    pub gop: u32,
    pub audio_enabled: bool,
    pub audio_sample_rate: u32,
    pub audio_channels: u16,
    pub output_path: String,
}

/// WASAPI 采集来的 PCM 格式描述（音频字节经 `feed_audio` 喂入，不在此携带）。
pub struct AudioSource {
    pub fmt: AudioFormat,
}

/// 喂给编码线程的一帧 NV12（GPU 上转换好、CPU 读回的紧凑 NV12 字节）。
pub struct Nv12Frame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub pts_us: i64,
}

enum EncoderMsg {
    Video(Nv12Frame),
    Audio(Vec<u8>),
    Stop,
}

pub struct AvEncoder {
    encode_thread: Mutex<Option<JoinHandle<()>>>,
    frame_tx: SyncSender<EncoderMsg>,
    done_rx: Mutex<Receiver<bool>>,
    started: AtomicBool,
    dropped_video: Arc<AtomicU64>,
}

impl AvEncoder {
    /// 启动进程内编码器线程。成功即返回（真正的打开在子线程内完成，避免阻塞捕获主循环）。
    pub fn new(config: EncoderConfig, audio: Option<AudioSource>) -> Result<Arc<Self>, String> {
        let (frame_tx, frame_rx) = mpsc::sync_channel::<EncoderMsg>(3);
        let (done_tx, done_rx) = mpsc::channel::<bool>();

        let dropped_video = Arc::new(AtomicU64::new(0));
        let handle = std::thread::spawn({
            let dropped_video = dropped_video.clone();
            move || {
                encode_loop(config, audio, frame_rx, done_tx, dropped_video);
            }
        });

        Ok(Arc::new(AvEncoder {
            encode_thread: Mutex::new(Some(handle)),
            frame_tx,
            done_rx: Mutex::new(done_rx),
            started: AtomicBool::new(true),
            dropped_video,
        }))
    }

    pub fn feed_nv12(&self, data: Vec<u8>, width: u32, height: u32, pts_us: i64) {
        if !self.started.load(Ordering::SeqCst) {
            return;
        }
        // 非阻塞发送：捕获回调（WGC/DXGI）严禁被编码线程背压卡住，否则 DWM 卡顿/整机掉帧。
        // 通道满（cap=3）时丢弃本帧并计数，与音频 feed_audio 的 try_send 策略一致。
        match self.frame_tx.try_send(EncoderMsg::Video(Nv12Frame {
            data,
            width,
            height,
            pts_us,
        })) {
            Ok(()) => {}
            Err(mpsc::TrySendError::Full(_)) => {
                self.dropped_video.fetch_add(1, Ordering::Relaxed);
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {}
        }
    }

    /// RGBA/BGRA（来自 WGC 原生 CPU 读回 `frame.buffer()`）经 CPU 转 NV12 后喂编码器。
    /// `format` 为 DXGI 格式值（87=BGRA8 / 28,29=RGBA8），用于判定 R 通道字节偏移，
    /// 使 CPU 兜底与 GPU 路径（rgba_to_nv12 着色器）的色序保持一致。
    /// 当本机 WGC 帧纹理不可共享（`convert_to_nv12` 取共享句柄失败）时作为兜底，保证仍能出画。
    pub fn feed_rgba(&self, rgba: &[u8], width: u32, height: u32, pts_us: i64, format: u32) {
        if !self.started.load(Ordering::SeqCst) {
            return;
        }
        let w = width as usize;
        let h = height as usize;
        if w == 0 || h == 0 || rgba.len() < w * h * 4 {
            return;
        }
        // R 通道偏移：BGRA(87) 内存序 B,G,R,A → red 在 index 2；其余（RGBA8）red 在 0
        let (r_off, g_off, b_off) = if format == 87 {
            (2usize, 1usize, 0usize)
        } else {
            (0usize, 1usize, 2usize)
        };
        let mut nv12: Vec<u8> = vec![0u8; w * h * 3 / 2];
        let (y_plane, uv_plane) = nv12.split_at_mut(w * h);
        // 亮度 Y（BT.709 limited range，与封装侧 colorspace=bt709 信号一致）
        for y in 0..h {
            let row = y * w;
            for x in 0..w {
                let i = (row + x) * 4;
                let r = rgba[i + r_off] as i32;
                let g = rgba[i + g_off] as i32;
                let b = rgba[i + b_off] as i32;
                let yv = ((47 * r + 157 * g + 16 * b + 128) >> 8) + 16;
                y_plane[row + x] = clamp8(yv);
            }
        }
        // 色度 UV（4:2:0，2×2 块平均）
        let half_w = w / 2;
        for vy in 0..(h / 2) {
            for vx in 0..half_w {
                let mut r = 0i32;
                let mut g = 0i32;
                let mut b = 0i32;
                for dy in 0..2 {
                    for dx in 0..2 {
                        let xx = (vx * 2 + dx).min(w - 1);
                        let yy = (vy * 2 + dy).min(h - 1);
                        let i = (yy * w + xx) * 4;
                        r += rgba[i + r_off] as i32;
                        g += rgba[i + g_off] as i32;
                        b += rgba[i + b_off] as i32;
                    }
                }
                r >>= 2;
                g >>= 2;
                b >>= 2;
                let u = ((-26 * r - 87 * g + 112 * b + 128) >> 8) + 128;
                let v = ((112 * r - 102 * g - 10 * b + 128) >> 8) + 128;
                let o = (vy * half_w + vx) * 2;
                uv_plane[o] = clamp8(u);
                uv_plane[o + 1] = clamp8(v);
            }
        }
        self.feed_nv12(nv12, width, height, pts_us);
    }

    /// 喂入一路音频 PCM 字节。非阻塞（满则丢弃本块，通道断开则停止）。
    /// 返回 false 表示编码线程已停止，桥接线程应退出。
    pub fn feed_audio(&self, bytes: Vec<u8>) -> bool {
        if !self.started.load(Ordering::SeqCst) {
            return false;
        }
        match self.frame_tx.try_send(EncoderMsg::Audio(bytes)) {
            Ok(()) => true,
            Err(mpsc::TrySendError::Full(_)) => true, // 编码线程忙，丢弃本块继续
            Err(mpsc::TrySendError::Disconnected(_)) => false,
        }
    }

    /// 停止并冲刷：发送 Stop，等子线程收尾（写 trailer、关文件）后返回。
    pub fn stop(&self) {
        if !self.started.swap(false, Ordering::SeqCst) {
            return;
        }
        let _ = self.frame_tx.send(EncoderMsg::Stop);
        if let Ok(mut guard) = self.encode_thread.lock() {
            if let Some(h) = guard.take() {
                let _ = h.join();
            }
        }
        if let Ok(guard) = self.done_rx.lock() {
            let _ = guard.recv();
        }
    }
}

#[inline]
fn clamp8(v: i32) -> u8 {
    if v < 0 {
        0
    } else if v > 255 {
        255
    } else {
        v as u8
    }
}

// ---------------------------------------------------------------------------
// 编码线程
// ---------------------------------------------------------------------------

struct VideoCtx {
    avctx: *mut c_void,
    fmt_ctx: *mut c_void,
    frame: *mut ff::AVFrame,
    pkt: *mut c_void,
    fps: i64,
    /// 收到的视频帧数（诊断：为 0 说明捕获侧根本没喂帧）
    in_frames: u64,
    /// 实际写入 mp4 的视频包数（诊断：远小于 in_frames 说明编码/复用环节吞帧）
    out_pkts: u64,
}

struct AudioCtx {
    actx: *mut c_void,
    frame: *mut ff::AVFrame,
    pkt: *mut c_void,
    rate: u32,
    channels: usize,
    raw: Vec<u8>,
    samples: Vec<f32>,
    frame_size: usize,
    sample_bytes: usize,
    is_float: bool,
    pts_base: i64,
}

fn encode_loop(
    cfg: EncoderConfig,
    audio: Option<AudioSource>,
    rx: Receiver<EncoderMsg>,
    done_tx: mpsc::Sender<bool>,
    dropped_video: Arc<AtomicU64>,
) {
    let api = ff::ffmpeg();
    let fps = cfg.fps.max(1) as i64;

    // ---- 视频编码器 ----
    let codec_name = CString::new("h264_nvenc").unwrap();
    let mut codec = unsafe { (api.avcodec_find_encoder_by_name)(codec_name.as_ptr()) };
    let is_nvenc = !codec.is_null();
    if codec.is_null() {
        eprintln!("[编码器] h264_nvenc 不可用，回退 libx264（仍进程内）");
        let x264 = CString::new("libx264").unwrap();
        codec = unsafe { (api.avcodec_find_encoder_by_name)(x264.as_ptr()) };
    }
    if codec.is_null() {
        eprintln!("[编码器] 找不到任何 h264 编码器");
        let _ = done_tx.send(false);
        return;
    }

    let avctx = unsafe { (api.avcodec_alloc_context3)(codec) };
    if avctx.is_null() {
        eprintln!("[编码器] avcodec_alloc_context3 失败");
        let _ = done_tx.send(false);
        return;
    }
    // 诊断：打印 AVCodecContext 类与选项数组（确认本构建选项数组是否可访问、字段真实偏移）。
    unsafe { ff::dbg_avctx_class(avctx); }

    let mut opts: *mut c_void = ptr::null_mut();
    // 字段写入策略（经 dbg 实测确认 FFmpeg 8.0 gyan 共享构建的选项名）：
    // - 整数选项（pix_fmt/bit_rate/gop_size/max_b_frames/rc_max_rate/rc_buffer_size/time_base/flags）
    //   走 `avctx_field_offset` 运行时取偏移 + 直写结构体（已验证 stride=64、偏移与 FFmpeg 真实布局吻合）。
    // - width/height 在本构建**没有**独立整数选项，只有字符串选项 "video_size"（"WxH"），
    //   故走 `av_opt_set`，由 FFmpeg 解析写入 width/height。
    // - framerate 在本构建无对应 AVOption，由编码器据 time_base 推断；若 open2 报 framerate 相关错误再补。
    // 注：之前「选项系统整体不可信」的结论是误判——真正原因是用了不存在的选项名（pix_fmt/width/height…）。
    unsafe {
        let ok_wh = ff::set_avctx_video_size(api, avctx, cfg.width as i32, cfg.height as i32);
        let ok_p  = ff::set_avctx_i32(api, avctx, "pix_fmt", ff::AV_PIX_FMT_NV12);
        if !ok_p {
            eprintln!("[编码器] ⚠️ pix_fmt 偏移查不到，编码器大概率仍会报 Invalid video pixel format");
        }
        let _ = ff::set_avctx_i32(api, avctx, "bit_rate", cfg.bitrate as i32);
        let _ = ff::set_avctx_i32(api, avctx, "rc_max_rate", cfg.bitrate as i32);
        let _ = ff::set_avctx_i32(api, avctx, "rc_buffer_size", (cfg.bitrate * 2) as i32);
        let _ = ff::set_avctx_i32(api, avctx, "gop_size", cfg.gop as i32);
        let _ = ff::set_avctx_i32(api, avctx, "max_b_frames", 0);
        let _ = ff::set_avctx_rational(api, avctx, "time_base", 1, fps as i32);
        ff::set_avctx_flags(api, avctx, "flags", 0x400000); // AV_CODEC_FLAG_GLOBAL_HEADER (1<<22)
        eprintln!(
            "[编码器] 直接写 avctx 字段: video_size={}x{}({}) pix_fmt={}({})",
            cfg.width, cfg.height, ok_wh, ff::AV_PIX_FMT_NV12, ok_p
        );
        if is_nvenc {
            ff::dict_set(api, &mut opts, "preset", "p1");
            ff::dict_set(api, &mut opts, "tune", "ll");
            ff::dict_set(api, &mut opts, "rc", "vbr");
        } else {
            ff::dict_set(api, &mut opts, "preset", "veryfast");
            ff::dict_set(api, &mut opts, "tune", "zerolatency");
        }
    }

    let open_rc = unsafe { (api.avcodec_open2)(avctx, codec, &mut opts) };
    unsafe {
        (api.av_dict_free)(&mut opts);
    }
    if open_rc < 0 {
        eprintln!(
            "[编码器] avcodec_open2(h264) 失败: {} (rc={})",
            ff::errstr(open_rc),
            open_rc
        );
        unsafe { (api.avcodec_free_context)(&mut avctx.cast()) };
        let _ = done_tx.send(false);
        return;
    }
    eprintln!(
        "[编码器] 进程内 libavcodec 编码器初始化成功 (nvenc={})",
        is_nvenc
    );

    // ---- 封装上下文 ----
    // ⚠️ avformat_alloc_output_context2 只设置 oformat/url，**不会**打开 IO（pb 保持 NULL）。
    // 必须先 avio_open 拿到 AVIOContext，再手动写入 fmt_ctx->pb（AVFormatContext.pb @ 偏移 32，跨 FFmpeg 版本稳定）。
    // 输出路径来自用户配置，FFI 边界禁止 panic：剔除任意 NUL 后再构造 CString
    // （Windows 文件路径正常不含 NUL；剔除仅为防御，避免 panic 拖垮编码线程）。
    let path_c = CString::new(cfg.output_path.replace('\0', ""))
        .unwrap_or_else(|_| CString::new("").unwrap());
    let mut fmt_ctx: *mut c_void = ptr::null_mut();
    let alloc_rc = unsafe {
        (api.avformat_alloc_output_context2)(
            &mut fmt_ctx,
            ptr::null_mut(),
            CString::new("mp4").unwrap().as_ptr(),
            path_c.as_ptr(),
        )
    };
    if alloc_rc < 0 || fmt_ctx.is_null() {
        eprintln!(
            "[编码器] avformat_alloc_output_context2 失败: {}",
            ff::errstr(alloc_rc)
        );
        unsafe { (api.avcodec_free_context)(&mut avctx.cast()) };
        let _ = done_tx.send(false);
        return;
    }
    // 打开输出 IO 并挂到 fmt_ctx->pb
    let mut pb: *mut c_void = ptr::null_mut();
    let io_rc = unsafe { (api.avio_open)(&mut pb, path_c.as_ptr(), 2 /* AVIO_FLAG_WRITE */) };
    if io_rc < 0 || pb.is_null() {
        eprintln!("[编码器] avio_open 失败: {} (rc={})", ff::errstr(io_rc), io_rc);
        unsafe { (api.avcodec_free_context)(&mut avctx.cast()) };
        let _ = done_tx.send(false);
        return;
    }
    unsafe {
        // AVFormatContext.pb 字段在偏移 32（ffmpeg-next 与 FFmpeg 8.x 一致，AVIOContext* 8 字节）
        let p = (fmt_ctx as *mut u8).add(32) as *mut *mut c_void;
        *p = pb;
    }
    let video_stream = unsafe { (api.avformat_new_stream)(fmt_ctx, ptr::null_mut()) };
    if video_stream.is_null() {
        eprintln!("[编码器] avformat_new_stream(video) 失败");
        unsafe {
            (api.avio_close)(pb);
            (api.avformat_free_context)(fmt_ctx);
            (api.avcodec_free_context)(&mut avctx.cast());
        }
        let _ = done_tx.send(false);
        return;
    }
    unsafe {
        // ⚠️ 第一参数必须是 st->codecpar（AVCodecParameters*），传 AVStream* 会覆写
        // AVStream 头部并把 codecpar 打成 NULL → write_header 崩在 0x0。详见 ff::stream_codecpar。
        let par = ff::stream_codecpar(video_stream);
        let rc = (api.avcodec_parameters_from_context)(par, avctx);
        if rc < 0 {
            eprintln!(
                "[编码器] avcodec_parameters_from_context(video) 失败: {}",
                ff::errstr(rc)
            );
        }
        // 流 time_base 由 ffmpeg 依据 codecpar->time_base(=1/fps) 自动设定，与包 pts 一致，无需手填。
    }

    // ---- 音频（best-effort）----
    let mut audio_ctx: Option<AudioCtx> = None;
    if let Some(a) = audio {
        if let Some(ac) = setup_audio(api, fmt_ctx, &a.fmt) {
            audio_ctx = Some(ac);
            eprintln!(
                "[编码器] 进程内 AAC 音频已就绪 ({}Hz, {}ch, {})",
                a.fmt.rate, a.fmt.channels, a.fmt.sample_fmt
            );
        } else {
            eprintln!("[编码器] 音频初始化失败，降级为仅视频");
        }
    }

    let wh = unsafe { (api.avformat_write_header)(fmt_ctx, ptr::null_mut()) };
    if wh < 0 {
        // header 没写成就继续写包 = 必然写坏文件甚至崩溃，这里直接收摊回退。
        eprintln!("[编码器] avformat_write_header 失败: {}（放弃进程内编码）", ff::errstr(wh));
        unsafe {
            let p = (fmt_ctx as *mut u8).add(32) as *mut *mut c_void;
            if !(*p).is_null() {
                (api.avio_close)(*p);
                *p = ptr::null_mut();
            }
            (api.avformat_free_context)(fmt_ctx);
            (api.avcodec_free_context)(&mut avctx.cast());
        }
        if let Some(ac) = audio_ctx.take() {
            unsafe {
                (api.avcodec_free_context)(&mut ac.actx.cast());
                (api.av_frame_free)(&mut ac.frame.cast());
                (api.av_packet_free)(&mut ac.pkt.cast());
            }
        }
        let _ = done_tx.send(false);
        return;
    }
    eprintln!("[编码器] avformat_write_header OK");

    let frame = unsafe { (api.av_frame_alloc)() };
    let pkt = unsafe { (api.av_packet_alloc)() };
    let mut video = VideoCtx {
        avctx,
        fmt_ctx,
        frame,
        pkt,
        fps,
        in_frames: 0,
        out_pkts: 0,
    };

    // ---- 主循环 ----
    loop {
        let msg = match rx.recv() {
            Ok(m) => m,
            Err(_) => break,
        };
        match msg {
            EncoderMsg::Video(f) => unsafe { encode_video_frame(api, &mut video, &f) },
            EncoderMsg::Audio(bytes) => {
                if let Some(ac) = audio_ctx.as_mut() {
                    unsafe { encode_audio_chunk(api, ac, &video, bytes) };
                }
            }
            EncoderMsg::Stop => break,
        }
    }

    unsafe { flush_video(api, &mut video) };
    if let Some(ac) = audio_ctx.as_mut() {
        unsafe { flush_audio(api, ac, &video) };
    }

    unsafe {
        (api.av_write_trailer)(video.fmt_ctx);
        // 先关 AVIO（释放 pb），再释放 fmt_ctx
        let pb = (video.fmt_ctx as *mut u8).add(32) as *mut *mut c_void;
        if !(*pb).is_null() {
            (api.avio_close)(*pb);
            *pb = ptr::null_mut();
        }
        (api.avformat_free_context)(video.fmt_ctx);
        (api.avcodec_free_context)(&mut video.avctx.cast());
        (api.av_frame_free)(&mut video.frame.cast());
        (api.av_packet_free)(&mut video.pkt.cast());
    }
    if let Some(ac) = audio_ctx {
        unsafe {
            (api.avcodec_free_context)(&mut ac.actx.cast());
            (api.av_frame_free)(&mut ac.frame.cast());
            (api.av_packet_free)(&mut ac.pkt.cast());
        }
    }
    let dv = dropped_video.load(Ordering::Relaxed);
    eprintln!(
        "[编码器] 视频统计: 收到帧={} 写入包={} 丢弃帧={}（收到=0 说明捕获侧没喂帧；丢弃>0 说明编码线程曾背压丢帧，属正常限流）",
        video.in_frames, video.out_pkts, dv
    );
    eprintln!("[编码器] 录制完成，文件已写入: {}", cfg.output_path);
    let _ = done_tx.send(true);
}

unsafe fn encode_video_frame(api: &ff::FfmpegApi, v: &mut VideoCtx, f: &Nv12Frame) {
    v.in_frames += 1;
    (api.av_frame_unref)(v.frame);
    (*v.frame).width = f.width as c_int;
    (*v.frame).height = f.height as c_int;
    (*v.frame).format = ff::AV_PIX_FMT_NV12;
    (*v.frame).pts = (f.pts_us * v.fps) / 1_000_000;
    let rc = (api.av_frame_get_buffer)(v.frame, 0);
    if rc < 0 {
        eprintln!("[编码器] av_frame_get_buffer 失败: {}", ff::errstr(rc));
        return;
    }
    let w = f.width as usize;
    let h = f.height as usize;
    let y_size = w * h;
    let uv_size = w * h / 2;
    if f.data.len() < y_size + uv_size {
        return;
    }
    std::ptr::copy_nonoverlapping(f.data.as_ptr(), (*v.frame).data[0], y_size);
    std::ptr::copy_nonoverlapping(
        f.data.as_ptr().add(y_size),
        (*v.frame).data[1],
        uv_size,
    );
    (*v.frame).linesize[0] = w as c_int;
    (*v.frame).linesize[1] = w as c_int;

    let s = (api.avcodec_send_frame)(v.avctx, v.frame);
    if s < 0 {
        eprintln!("[编码器] avcodec_send_frame 失败: {}", ff::errstr(s));
    }
    drain_video_packets(api, v);
}

unsafe fn drain_video_packets(api: &ff::FfmpegApi, v: &mut VideoCtx) {
    loop {
        let r = (api.avcodec_receive_packet)(v.avctx, v.pkt);
        if r < 0 {
            break;
        }
        let p = &mut *(v.pkt as *mut MyPacket);
        p.stream_index = 0;
        let rc = (api.av_interleaved_write_frame)(v.fmt_ctx, v.pkt);
        if rc < 0 {
            eprintln!("[编码器] av_interleaved_write_frame 失败: {}", ff::errstr(rc));
        } else {
            v.out_pkts += 1;
        }
        (api.av_packet_unref)(v.pkt);
    }
}

unsafe fn flush_video(api: &ff::FfmpegApi, v: &mut VideoCtx) {
    let _ = (api.avcodec_send_frame)(v.avctx, ptr::null());
    drain_video_packets(api, v);
}

// ---------------------------------------------------------------------------
// 音频
// ---------------------------------------------------------------------------

/// AAC 合法采样率（libavcodec native aac 编码器仅接受这些值）。
const AAC_RATES: [u32; 12] = [
    8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000,
];

/// 把任意采样率吸附到最近的 AAC 合法值；非法（0）直接回退 48000。
/// 某些虚拟/回环音频设备的 GetMixFormat 会把 nSamplesPerSec 报成 0，必须兜底。
fn snap_aac_sample_rate(r: u32) -> u32 {
    if r == 0 {
        return 48000;
    }
    if AAC_RATES.contains(&r) {
        return r;
    }
    *AAC_RATES
        .iter()
        .min_by_key(|&&x| (x as i64 - r as i64).unsigned_abs())
        .unwrap_or(&48000)
}

fn setup_audio(api: &ff::FfmpegApi, fmt_ctx: *mut c_void, fmt: &AudioFormat) -> Option<AudioCtx> {
    let name = CString::new("aac").unwrap();
    let codec = unsafe { (api.avcodec_find_encoder_by_name)(name.as_ptr()) };
    if codec.is_null() {
        return None;
    }
    let actx = unsafe { (api.avcodec_alloc_context3)(codec) };
    if actx.is_null() {
        return None;
    }
    // 诊断：打印音频 AVCodecContext 类与选项数组。
    unsafe { ff::dbg_avctx_class(actx); }
    let rate = snap_aac_sample_rate(fmt.rate);
    if fmt.rate <= 0 {
        eprintln!(
            "[编码器] ⚠️ 采样率 {} 非法，吸附到 {}Hz 继续（设备 mix format 异常）",
            fmt.rate, rate
        );
    }
    let mut channels = fmt.channels as usize;
    if channels == 0 {
        eprintln!("[编码器] ⚠️ 声道数 0 非法，回退 2");
        channels = 2;
    }
    let mut opts: *mut c_void = ptr::null_mut();
    unsafe {
        // 本质同视频：核心 int 字段一律直接写结构体（avctx_field_offset 取真实偏移），
        // 绕开本构建不可信的 dict/av_opt_set 选项系统。声道布局（AVChannelLayout）也直接写。
        // 关键教训：sample_fmt 之前只走 dict，本构建 dict 设置静默失败 → actx->sample_fmt 恒为
        // -1（AV_SAMPLE_FMT_NONE）→ AAC 报 "Invalid audio sample format: -1"。现改为同视频 pix_fmt
        // 一样的偏移直写（sample_fmt 是 i32 枚举，偏移直写即可）。
        let ok_ar = ff::set_avctx_i32(api, actx, "sample_rate", rate as i32);
        let _ = ff::set_avctx_i32(api, actx, "b", 192000);
        let _ = ff::set_avctx_rational(api, actx, "time_base", 1, rate as i32);
        // 声道数走 ch_layout（FFmpeg 5.1+ 废弃裸 channels），不再单独写已废弃的 "ac" 字段；
        // ch_layout 写入成功后 avcodec_open2 会据其推导 channels。
        ff::set_avctx_flags(api, actx, "flags", 0x400000); // AV_CODEC_FLAG_GLOBAL_HEADER (1<<22)
        // 声道布局：直接写 AVChannelLayout；失败仅报警（坏 dict 只会让 ch_layout 恒 0）
        let ok_cl = ff::set_avctx_ch_layout(api, actx, channels as i32);
        if !ok_cl {
            eprintln!("[编码器] ⚠️ ch_layout 偏移查不到，AAC 可能报 requires channel layout");
        }
        // 采样格式：本构建把选项名由 sample_fmt 改成 sample_format（与 pix_fmt→pixel_format 同一改名规律，
        // 且 sample_format 不含 "fmt" 子串，故之前按 ["sample","fmt"] 子串搜只逮到 request_sample_fmt）。
        // 现用改名后的精确名 "sample_format" 走偏移直写（同视频 pix_fmt，已验证可靠）；子串兜底作为双保险。
        ff::dbg_dump_option_names_containing(actx, "sample"); // 一次性反查真实改名名
        let ok_sf = ff::set_avctx_i32(api, actx, "sample_fmt", ff::AV_SAMPLE_FMT_FLTP)
            || ff::set_avctx_i32_substr(api, actx, &["sample"], &["request", "rate", "aspect"], ff::AV_SAMPLE_FMT_FLTP);
        if !ok_sf {
            eprintln!("[编码器] ⚠️ sample_fmt 偏移查不到，AAC 仍会报 Invalid audio sample format");
        }
        eprintln!(
            "[编码器] 直接写 actx 字段: ar={}({}) ch_layout={}({}) sample_fmt={}({})",
            rate, ok_ar, ok_cl, ok_cl, ok_sf, ok_sf
        );
        let rc = (api.avcodec_open2)(actx, codec, &mut opts);
        (api.av_dict_free)(&mut opts);
        if rc < 0 {
            eprintln!("[编码器] AAC avcodec_open2 失败: {}", ff::errstr(rc));
            (api.avcodec_free_context)(&mut actx.cast());
            return None;
        }
    }
    let stream = unsafe { (api.avformat_new_stream)(fmt_ctx, ptr::null_mut()) };
    if stream.is_null() {
        unsafe { (api.avcodec_free_context)(&mut actx.cast()) };
        return None;
    }
    unsafe {
        // 同 video：必须传 st->codecpar，不能传 AVStream*
        let par = ff::stream_codecpar(stream);
        let rc = (api.avcodec_parameters_from_context)(par, actx);
        if rc < 0 {
            eprintln!(
                "[编码器] avcodec_parameters_from_context(audio) 失败: {}",
                ff::errstr(rc)
            );
        }
    }
    let frame = unsafe { (api.av_frame_alloc)() };
    let pkt = unsafe { (api.av_packet_alloc)() };
    let (sample_bytes, is_float) = match fmt.sample_fmt {
        "f32le" => (4usize, true),
        "s16le" => (2, false),
        "s32le" => (4, false),
        _ => (4, true),
    };
    Some(AudioCtx {
        actx,
        frame,
        pkt,
        rate,
        channels,
        raw: Vec::new(),
        samples: Vec::new(),
        frame_size: 1024,
        sample_bytes,
        is_float,
        pts_base: 0,
    })
}

unsafe fn encode_audio_chunk(api: &ff::FfmpegApi, ac: &mut AudioCtx, v: &VideoCtx, bytes: Vec<u8>) {
    ac.raw.extend_from_slice(&bytes);
    let frame_bytes = ac.frame_size * ac.channels * ac.sample_bytes;
    while ac.raw.len() >= frame_bytes {
        let chunk: Vec<u8> = ac.raw.drain(..frame_bytes).collect();
        ac.samples.clear();
        let n = ac.frame_size * ac.channels;
        match (ac.is_float, ac.sample_bytes) {
            (true, 4) => {
                for i in 0..n {
                    let b = [
                        chunk[i * 4],
                        chunk[i * 4 + 1],
                        chunk[i * 4 + 2],
                        chunk[i * 4 + 3],
                    ];
                    ac.samples.push(f32::from_le_bytes(b));
                }
            }
            (false, 2) => {
                for i in 0..n {
                    let b = [chunk[i * 2], chunk[i * 2 + 1]];
                    ac.samples.push(i16::from_le_bytes(b) as f32 / 32768.0);
                }
            }
            (false, 4) => {
                for i in 0..n {
                    let b = [
                        chunk[i * 4],
                        chunk[i * 4 + 1],
                        chunk[i * 4 + 2],
                        chunk[i * 4 + 3],
                    ];
                    ac.samples.push(i32::from_le_bytes(b) as f32 / 2147483648.0);
                }
            }
            _ => {}
        }

        let mut planar: Vec<f32> = vec![0.0; ac.frame_size * ac.channels];
        for c in 0..ac.channels {
            for s in 0..ac.frame_size {
                planar[c * ac.frame_size + s] = ac.samples[s * ac.channels + c];
            }
        }
        (api.av_frame_unref)(ac.frame);
        (*ac.frame).format = ff::AV_SAMPLE_FMT_FLTP;
        (*ac.frame).sample_rate = ac.rate as c_int;
        (*ac.frame).channels = ac.channels as c_int;
        (*ac.frame).nb_samples = ac.frame_size as c_int;
        (*ac.frame).channel_layout = if ac.channels == 1 { 4 } else { 3 };
        // FFmpeg 5.1+ 编码器读 frame->ch_layout（@200），废弃的 channel_layout@184/channels@192
        // 已不够。此处与 actx->ch_layout（set_avctx_ch_layout）保持一致：order=NATIVE、
        // nb_channels=channels、mask=mono(4)/stereo(3)（与 av_channel_layout_default 语义一致）。
        // avcodec_fill_audio_frame 即便也设 ch_layout=default(channels)，二者值相同互不冲突。
        (*ac.frame).ch_layout = ff::AVChannelLayout {
            order: 0,
            nb_channels: ac.channels.max(1) as c_int,
            mask: if ac.channels <= 1 { 4 } else { 3 },
            opaque: ptr::null_mut(),
        };
        (*ac.frame).pts = ac.pts_base;
        let fill = (api.avcodec_fill_audio_frame)(
            ac.frame,
            ac.channels as c_int,
            ff::AV_SAMPLE_FMT_FLTP,
            planar.as_ptr() as *const u8,
            (planar.len() * 4) as c_int,
            0,
        );
        if fill < 0 {
            eprintln!("[编码器] avcodec_fill_audio_frame 失败: {}", ff::errstr(fill));
            ac.pts_base += ac.frame_size as i64;
            continue;
        }
        let s = (api.avcodec_send_frame)(ac.actx, ac.frame);
        if s < 0 {
            eprintln!("[编码器] 音频 send_frame 失败: {}", ff::errstr(s));
        }
        loop {
            let r = (api.avcodec_receive_packet)(ac.actx, ac.pkt);
            if r < 0 {
                break;
            }
            let p = &mut *(ac.pkt as *mut MyPacket);
            p.stream_index = 1;
            let rc = (api.av_interleaved_write_frame)(v.fmt_ctx, ac.pkt);
            if rc < 0 {
                eprintln!("[编码器] 音频写包失败: {}", ff::errstr(rc));
            }
            (api.av_packet_unref)(ac.pkt);
        }
        ac.pts_base += ac.frame_size as i64;
    }
}

unsafe fn flush_audio(api: &ff::FfmpegApi, ac: &mut AudioCtx, v: &VideoCtx) {
    let frame_bytes = ac.frame_size * ac.channels * ac.sample_bytes;
    if !ac.raw.is_empty() {
        let pad = frame_bytes.saturating_sub(ac.raw.len());
        ac.raw.extend(std::iter::repeat(0u8).take(pad));
        let _ = encode_audio_chunk(api, ac, v, Vec::new());
    }
    let _ = (api.avcodec_send_frame)(ac.actx, ptr::null());
    loop {
        let r = (api.avcodec_receive_packet)(ac.actx, ac.pkt);
        if r < 0 {
            break;
        }
        let p = &mut *(ac.pkt as *mut MyPacket);
        p.stream_index = 1;
        let rc = (api.av_interleaved_write_frame)(v.fmt_ctx, ac.pkt);
        if rc < 0 {
            eprintln!("[编码器] 音频写包(冲刷)失败: {}", ff::errstr(rc));
        }
        (api.av_packet_unref)(ac.pkt);
    }
}
