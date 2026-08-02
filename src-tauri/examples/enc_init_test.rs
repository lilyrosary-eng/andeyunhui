//! 无 GUI 复现：仅跑进程内编码器的「初始化」段，每步打标记 flush。
//! 崩溃前最后一行即定位到具体哪个 ffmpeg 调用。运行：
//!   cargo run --example enc_init_test
use libloading::Library;
use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};
use std::ptr;

// SEH 异常过滤器：打印故障地址，判断是 NULL 解引用还是读脏数据
type PfnHandler = extern "system" fn(*mut c_void) -> i32;
extern "system" {
    fn SetUnhandledExceptionFilter(handler: PfnHandler) -> *mut c_void;
}
extern "system" fn veh_handler(ep: *mut c_void) -> i32 {
    unsafe {
        // PEXCEPTION_POINTERS -> ExceptionRecord (offset 0) -> ExceptionAddress (offset 8, x64)
        let er = *(ep as *const *const c_void);
        let addr = *(er as *const usize).add(1);
        let code = *(er as *const u32);
        eprintln!("[SEH] exception code={:#x} fault_address={:#x}", code, addr);
        // 额外打印 fmt_ctx 关键字段供分析（若 ep 之外需要）
    }
    1 // EXCEPTION_EXECUTE_HANDLER
}

fn flush(s: &str) {
    eprintln!("[MARK] {s}");
    use std::io::Write;
    let _ = std::io::stderr().flush();
}

macro_rules! fnp {
    ($lib:expr, $name:expr, $t:ty) => {
        unsafe { std::mem::transmute::<*mut c_void, $t>(
            *($lib).get::<*mut c_void>($name).expect("sym")
        ) }
    };
}

fn main() {
    unsafe { SetUnhandledExceptionFilter(veh_handler); }
    let dir = r"c:\Users\Rosary\Desktop\andeyunhui\external-deps\全局\ffmpeg";
    flush("loading dlls");
    let avutil = unsafe { Library::new(format!("{dir}\\avutil-60.dll")) }.expect("avutil");
    let swresample = unsafe { Library::new(format!("{dir}\\swresample-6.dll")) }.expect("swresample");
    let avcodec = unsafe { Library::new(format!("{dir}\\avcodec-62.dll")) }.expect("avcodec");
    let avformat = unsafe { Library::new(format!("{dir}\\avformat-62.dll")) }.expect("avformat");
    flush("dlls loaded");

    let avcodec_version: unsafe extern "C" fn() -> c_int =
        fnp!(&avcodec, b"avcodec_version\0", unsafe extern "C" fn() -> c_int);
    flush("calling avcodec_version");
    let ver = unsafe { avcodec_version() };
    flush(&format!("avcodec_version={ver:#x}"));

    let avcodec_find_encoder_by_name: unsafe extern "C" fn(*const c_char) -> *mut c_void =
        fnp!(&avcodec, b"avcodec_find_encoder_by_name\0", unsafe extern "C" fn(*const c_char) -> *mut c_void);
    let avcodec_alloc_context3: unsafe extern "C" fn(*const c_void) -> *mut c_void =
        fnp!(&avcodec, b"avcodec_alloc_context3\0", unsafe extern "C" fn(*const c_void) -> *mut c_void);
    let avcodec_open2: unsafe extern "C" fn(*mut c_void, *const c_void, *mut *mut c_void) -> c_int =
        fnp!(&avcodec, b"avcodec_open2\0", unsafe extern "C" fn(*mut c_void, *const c_void, *mut *mut c_void) -> c_int);
    let avcodec_free_context: unsafe extern "C" fn(*mut *mut c_void) =
        fnp!(&avcodec, b"avcodec_free_context\0", unsafe extern "C" fn(*mut *mut c_void));
    let av_dict_set: unsafe extern "C" fn(*mut *mut c_void, *const c_char, *const c_char, c_int) -> c_int =
        fnp!(&avutil, b"av_dict_set\0", unsafe extern "C" fn(*mut *mut c_void, *const c_char, *const c_char, c_int) -> c_int);
    let av_opt_set_int: unsafe extern "C" fn(*mut c_void, *const c_char, i64, c_int) -> c_int =
        fnp!(&avutil, b"av_opt_set_int\0", unsafe extern "C" fn(*mut c_void, *const c_char, i64, c_int) -> c_int);
    let av_opt_find: unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char, c_int) -> *mut c_void =
        fnp!(&avutil, b"av_opt_find\0", unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char, c_int) -> *mut c_void);
    let av_dict_free: unsafe extern "C" fn(*mut *mut c_void) =
        fnp!(&avutil, b"av_dict_free\0", unsafe extern "C" fn(*mut *mut c_void));
    let avformat_alloc_output_context2: unsafe extern "C" fn(
        *mut *mut c_void,
        *mut c_void,
        *const c_char,
        *const c_char,
    ) -> c_int = fnp!(&avformat, b"avformat_alloc_output_context2\0", unsafe extern "C" fn(*mut *mut c_void, *mut c_void, *const c_char, *const c_char) -> c_int);
    let avformat_new_stream: unsafe extern "C" fn(*mut c_void, *const c_void) -> *mut c_void =
        fnp!(&avformat, b"avformat_new_stream\0", unsafe extern "C" fn(*mut c_void, *const c_void) -> *mut c_void);
    let avio_open: unsafe extern "C" fn(*mut *mut c_void, *const c_char, c_int) -> c_int =
        fnp!(&avformat, b"avio_open\0", unsafe extern "C" fn(*mut *mut c_void, *const c_char, c_int) -> c_int);
    let avio_close: unsafe extern "C" fn(*mut *mut c_void) -> c_int =
        fnp!(&avformat, b"avio_close\0", unsafe extern "C" fn(*mut *mut c_void) -> c_int);
    let avcodec_parameters_from_context: unsafe extern "C" fn(*mut c_void, *const c_void) -> c_int =
        fnp!(&avcodec, b"avcodec_parameters_from_context\0", unsafe extern "C" fn(*mut c_void, *const c_void) -> c_int);
    let avformat_write_header: unsafe extern "C" fn(*mut c_void, *mut *mut c_void) -> c_int =
        fnp!(&avformat, b"avformat_write_header\0", unsafe extern "C" fn(*mut c_void, *mut *mut c_void) -> c_int);
    let av_frame_alloc: unsafe extern "C" fn() -> *mut c_void =
        fnp!(&avutil, b"av_frame_alloc\0", unsafe extern "C" fn() -> *mut c_void);
    let av_frame_get_buffer: unsafe extern "C" fn(*mut c_void, c_int) -> c_int =
        fnp!(&avutil, b"av_frame_get_buffer\0", unsafe extern "C" fn(*mut c_void, c_int) -> c_int);
    let av_frame_unref: unsafe extern "C" fn(*mut c_void) =
        fnp!(&avutil, b"av_frame_unref\0", unsafe extern "C" fn(*mut c_void));
    let avcodec_send_frame: unsafe extern "C" fn(*mut c_void, *const c_void) -> c_int =
        fnp!(&avcodec, b"avcodec_send_frame\0", unsafe extern "C" fn(*mut c_void, *const c_void) -> c_int);
    let av_frame_free: unsafe extern "C" fn(*mut *mut c_void) =
        fnp!(&avutil, b"av_frame_free\0", unsafe extern "C" fn(*mut *mut c_void));
    let av_packet_alloc: unsafe extern "C" fn() -> *mut c_void =
        fnp!(&avcodec, b"av_packet_alloc\0", unsafe extern "C" fn() -> *mut c_void);
    let av_packet_free: unsafe extern "C" fn(*mut *mut c_void) =
        fnp!(&avcodec, b"av_packet_free\0", unsafe extern "C" fn(*mut *mut c_void));
    flush("symbols resolved");

    let fps = 60i64;
    let width = 1920u32;
    let height = 1020u32;
    let bitrate = 8_000_000u32;
    let gop = 120u32;

    flush("BEFORE avcodec_find_encoder_by_name");
    let codec_name = CString::new("h264_nvenc").unwrap();
    let mut codec = unsafe { avcodec_find_encoder_by_name(codec_name.as_ptr()) };
    flush("AFTER avcodec_find_encoder_by_name");
    let is_nvenc = !codec.is_null();
    if codec.is_null() {
        flush("nvenc null, try libx264");
        let x264 = CString::new("libx264").unwrap();
        codec = unsafe { avcodec_find_encoder_by_name(x264.as_ptr()) };
    }
    if codec.is_null() {
        flush("NO ENCODER");
        return;
    }
    flush(&format!("encoder found nvenc={is_nvenc}"));

    flush("alloc_context3");
    let avctx = unsafe { avcodec_alloc_context3(codec) };
    if avctx.is_null() {
        flush("alloc_context3 null");
        return;
    }
    flush("alloc_context3 ok");

    let mut opts: *mut c_void = ptr::null_mut();
    let mut dset = |k: &str, v: &str| {
        let k = CString::new(k).unwrap();
        let v = CString::new(v).unwrap();
        unsafe { av_dict_set(&mut opts, k.as_ptr(), v.as_ptr(), 0) };
    };
    dset("width", &width.to_string());
    dset("height", &height.to_string());
    dset("pixel_format", "nv12");
    dset("video_size", &format!("{width}x{height}"));
    dset("bit_rate", &bitrate.to_string());
    dset("maxrate", &bitrate.to_string());
    dset("bufsize", &(bitrate * 2).to_string());
    dset("gop_size", &gop.to_string());
    dset("max_b_frames", "0");
    dset("time_base", &format!("1/{fps}"));
    dset("framerate", &format!("{fps}/1"));
    dset("flags", "+global_header");
    if is_nvenc {
        dset("preset", "p1");
        dset("tune", "ll");
        dset("rc", "vbr");
    } else {
        dset("preset", "veryfast");
        dset("tune", "zerolatency");
    }
    flush("dict_set done");

    flush("avcodec_open2");
    let open_rc = unsafe { avcodec_open2(avctx, codec, &mut opts) };
    unsafe { av_dict_free(&mut opts) };
    if open_rc < 0 {
        flush(&format!("avcodec_open2 FAIL rc={open_rc}"));
        unsafe { avcodec_free_context(&mut avctx.cast()) };
        return;
    }
    flush("avcodec_open2 OK (nvenc={is_nvenc})");

    let path_c = CString::new(r"c:\Users\Rosary\Desktop\andeyunhui\enc_test_out.ts").unwrap();
    let mut fmt_ctx: *mut c_void = ptr::null_mut();
    flush("alloc_output_context2");
    let alloc_rc = unsafe {
        avformat_alloc_output_context2(
            &mut fmt_ctx,
            ptr::null_mut(),
            CString::new("mpegts").unwrap().as_ptr(),
            path_c.as_ptr(),
        )
    };
    if alloc_rc < 0 || fmt_ctx.is_null() {
        flush(&format!("alloc_output_context2 FAIL rc={alloc_rc}"));
        return;
    }
    flush("alloc_output_context2 OK");
    // avformat_alloc_output_context2 不会自动打开 IO：必须 avio_open 并手动写 fmt_ctx->pb（偏移 32）
    let mut pb: *mut c_void = ptr::null_mut();
    let io_rc = unsafe { avio_open(&mut pb, path_c.as_ptr(), 2 /*AVIO_FLAG_WRITE*/) };
    flush(&format!("avio_open rc={io_rc} pb={:p}", pb));
    if !pb.is_null() {
        // 扫描 fmt_ctx 找等于 pb 的指针，确定 AVFormatContext.pb 精确偏移
        unsafe {
            let base = fmt_ctx as *const usize;
            let mut found_off: i32 = -1;
            for i in 0..48usize {
                if *(base.add(i)) == pb as usize {
                    found_off = (i * 8) as i32;
                    break;
                }
            }
            flush(&format!("pb field scan: found_off={found_off}"));
            if found_off >= 0 {
                let p = (fmt_ctx as *mut u8).add(found_off as usize) as *mut *mut c_void;
                *p = pb;
                flush("fmt_ctx->pb set at scanned offset");
            } else {
                // 回退写 +32
                let p = (fmt_ctx as *mut u8).add(32) as *mut *mut c_void;
                *p = pb;
                flush("fmt_ctx->pb set at fallback +32");
            }
            // 读回确认
            let rb = unsafe { *(fmt_ctx as *const usize).add(4) };
            flush(&format!("pb readback@32 = {:p}", rb as *const c_void));
        }
    }

    flush("new_stream");
    let video_stream = unsafe { avformat_new_stream(fmt_ctx, ptr::null_mut()) };
    flush(&format!("new_stream -> {:p}", video_stream));
    // ⚠️ avcodec_parameters_from_context 第一参数是 AVCodecParameters*，不是 AVStream*！
    // AVStream 布局：av_class@0, index@8, id@12, codecpar@16, priv_data@24
    let par = unsafe {
        let idx = *((video_stream as *const u8).add(8) as *const c_int);
        let p = *((video_stream as *const u8).add(16) as *const *mut c_void);
        let (ct, ci) = if p.is_null() {
            (999, 999)
        } else {
            (*(p as *const c_int), *((p as *const c_int).add(1)))
        };
        flush(&format!(
            "AVStream index@8={idx} codecpar@16={:p} codec_type={ct} codec_id={ci} (期望 index=0 type=-1 id=0)",
            p
        ));
        p
    };
    let pfc = unsafe { avcodec_parameters_from_context(par, avctx) };
    flush(&format!("parameters_from_context rc={pfc}"));

    flush("write_header");
    let mut wh_opts: *mut c_void = ptr::null_mut();
    let wh = unsafe { avformat_write_header(fmt_ctx, &mut wh_opts) };
    flush(&format!("write_header rc={wh}"));
    flush("INIT DONE - encoder init succeeded on its own");

    // 触发一帧编码以复现 av_frame_get_buffer / avcodec_send_frame 崩溃
    flush("calling av_frame_alloc");
    let frame = unsafe { av_frame_alloc() };
    flush(&format!("av_frame_alloc -> {:p}", frame));
    flush("calling av_frame_unref");
    unsafe { av_frame_unref(frame) };
    flush("av_frame_unref done");
    #[repr(C)]
    struct AVFrameSim {
        data: [*mut u8; 8],
        linesize: [c_int; 8],
        extended_data: *mut *mut u8,
        width: c_int,
        height: c_int,
        nb_samples: c_int,
        format: c_int,
        key_frame: c_int,
        pict_type: c_int,
        sar: [c_int; 2],
        pts: i64,
        pkt_dts: i64,
        coded_picture_number: c_int,
        display_picture_number: c_int,
        quality: c_int,
        repeat_pict: c_int,
        interlaced_frame: c_int,
        top_field_first: c_int,
        sample_rate: c_int,
        _pad: c_int,
        channel_layout: u64,
        channels: c_int,
    }
    let fr = frame as *mut AVFrameSim;
    flush("frame fields before write");
    unsafe {
        (*fr).width = width as c_int;
        (*fr).height = height as c_int;
        (*fr).format = 23; // NV12
        (*fr).pts = 0;
    }
    flush("frame fields written");
    flush("av_frame_get_buffer");
    let rc = unsafe { av_frame_get_buffer(frame, 0) };
    if rc < 0 {
        flush(&format!("av_frame_get_buffer FAIL rc={rc}"));
    } else {
        flush("av_frame_get_buffer OK");
    }
    flush("avcodec_send_frame");
    let s = unsafe { avcodec_send_frame(avctx, frame) };
    flush(&format!("avcodec_send_frame rc={s}"));
    unsafe {
        av_frame_free(&mut frame.cast());
        let pkt = av_packet_alloc();
        av_packet_free(&mut pkt.cast());
    }
    flush("FRAME TEST DONE");
}
