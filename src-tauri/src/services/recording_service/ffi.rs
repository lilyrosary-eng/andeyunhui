//! FFmpeg 8.x 动态加载（libloading），仅供「完整 L0」进程内编码器（libavcodec + libavformat）使用。
//!
//! **设计铁律（本机深坑）**：FFmpeg 的 `AVCodecContext` / `AVHWFramesContext` 等结构字段偏移随版本
//! 变化，且 gyan.dev 共享构建里**选项名**与老 FFmpeg 不同（pix_fmt→`pixel_format`、width/height 无整数选项
//! 只有 `video_size` 字符串、bit_rate→`b`、gop_size→`g`、max_b_frames→`bf` 等）。因此：
//!   1. 曾用硬编码偏移写 `AVCodecContext` 字段 → pix_fmt 偏移算错 →「Invalid video pixel format: -1」。
//!   2. 改走 `av_dict_set`（选项系统）后，因用了不存在的选项名（pix_fmt/video_size 等），被内部静默忽略 → 仍是 -1。
//!      **注意**：选项系统本身可用，根因是选项名不对，不是设置器坏了。
//!   3. **当前解法**：整数字段用 `av_opt_find` 风格运行时取真实偏移（不靠硬编码、跨构建稳定）直接写结构体
//!      （见 `set_avctx_i32 / set_avctx_rational / set_avctx_flags`）；width/height 无整数选项，改走
//!      `av_opt_set("video_size")` 由 FFmpeg 解析写入（见 `set_avctx_video_size`）。
//!      仅 nvenc 私有选项（preset/tune/rc）位于 priv_data，必须经 children 搜索，仍走 `av_dict_set`
//!      兜底（设置器异常时 nvenc 用默认，非致命）。
//!   2. 不绑定 d3d11va hwcontext（需未知偏移的 `AVHWDeviceContext`/`AVD3D11VADeviceContext`）。
//!      改为：捕获侧在 dGPU 上把 BGRA→NV12（GpuNv12Converter），再把 NV12 喂给 `h264_nvenc`，
//!      nvenc 自动在 dGPU 上自建 CUDA 上下文并上传——仍 100% 进程内、零 ffmpeg 子进程、零 stdin
//!      字节管道（这正是「卡卡的」根因），RGBA→NV12 也全在 GPU。
//!   3. 仅对稳定字段偏移的 `AVFrame`（data/linesize/width/height/format/pts 等，自 FFmpeg 3 起
//!      未变，与 ffmpeg-next 一致）直接读写；音频帧用 `avcodec_fill_audio_frame` 免偏移猜测。

use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};
use std::path::PathBuf;
use std::sync::OnceLock;

use libloading::{Library, Symbol};

/// FFmpeg 8.x 像素格式常量（AVPixelFormat）。
pub const AV_PIX_FMT_NV12: c_int = 23;
/// 音频样本格式（AVSampleFormat）：FLTP=8、S16=1、FLT=3、S32=2。
pub const AV_SAMPLE_FMT_FLTP: c_int = 8;
#[allow(dead_code)]
pub const AV_SAMPLE_FMT_S16: c_int = 1;
/// avio_open 写标志（本实现由 alloc_output_context2 自动开 IO，未直接调用，保留以备调试）。
#[allow(dead_code)]
pub const AVIO_FLAG_WRITE: c_int = 2;

/// FFmpeg 5.1+ 的 `AVChannelLayout`（24 字节，8 字节对齐）。
/// 布局：order(i32)@0 nb_channels(i32)@4 u{mask(u64)/map(*)}@8 opaque(*)@16。
/// 提交音频帧时须与 `avctx->ch_layout` 一致，否则 send_frame 报声道布局不符。
#[repr(C)]
#[derive(Clone, Copy)]
pub struct AVChannelLayout {
    pub order: c_int,        // @0  AV_CHANNEL_ORDER_NATIVE=0
    pub nb_channels: c_int,  // @4
    pub mask: u64,           // @8  union u 的 mask 分支（map 共享同一段内存，NATIVE 模式只用 mask）
    pub opaque: *mut c_void, // @16
}

/// 稳定布局的 AVFrame（仅含我们用到的字段；偏移与 ffmpeg-next / FFmpeg 8.x 一致）。
/// 注意：`channel_layout`@184 与 `channels`@192 在 FFmpeg 5.1+ 已**废弃**，编码器实际读
/// `ch_layout`@200（AVChannelLayout；channels@192 后 repr(C) 自动填 4 字节对齐到 @200）。
/// 提交音频帧必须显式写 ch_layout，否则与 avctx->ch_layout 不符会导致 send_frame 失败。
#[repr(C)]
pub struct AVFrame {
    pub data: [*mut u8; 8],
    pub linesize: [c_int; 8],
    pub extended_data: *mut *mut u8,
    pub width: c_int,
    pub height: c_int,
    pub nb_samples: c_int,
    pub format: c_int,
    pub key_frame: c_int,
    pub pict_type: c_int,
    pub sample_aspect_ratio: AVRational,
    pub pts: i64,
    pub pkt_dts: i64,
    pub coded_picture_number: c_int,
    pub display_picture_number: c_int,
    pub quality: c_int,
    pub repeat_pict: c_int,
    pub interlaced_frame: c_int,
    pub top_field_first: c_int,
    pub sample_rate: c_int,            // 176
    _pad1: c_int,                      // 180（channel_layout 8 字节对齐）
    pub channel_layout: u64,           // 184（已废弃，编码器不再读；保留仅为兼容旧 FFmpeg）
    pub channels: c_int,               // 192（已废弃，编码器不再读）
    // 196..200：repr(C) 自动插入 4 字节填充，使 ch_layout 8 字节对齐（与 FFmpeg 真实布局一致）
    pub ch_layout: AVChannelLayout,    // 200（FFmpeg 5.1+ 实际生效的声道布局）
    _pad2: [u8; 228],                  // 224..（保持总尺寸不变，留余量）
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct AVRational {
    pub num: c_int,
    pub den: c_int,
}

impl AVRational {
    #[allow(dead_code)]
    pub fn new(num: c_int, den: c_int) -> Self {
        AVRational { num, den }
    }
}

/// FFmpeg 8.x API 动态绑定。所有结构（除 AVFrame）作为不透明指针在 Rust 侧传递。
#[allow(non_snake_case)]
#[allow(dead_code)]
pub struct FfmpegApi {
    pub avcodec_find_encoder_by_name: unsafe extern "C" fn(*const c_char) -> *mut c_void,
    pub avcodec_alloc_context3: unsafe extern "C" fn(*const c_void) -> *mut c_void,
    pub avcodec_open2:
        unsafe extern "C" fn(*mut c_void, *const c_void, *mut *mut c_void) -> c_int,
    pub avcodec_send_frame: unsafe extern "C" fn(*mut c_void, *const AVFrame) -> c_int,
    pub avcodec_receive_packet: unsafe extern "C" fn(*mut c_void, *mut c_void) -> c_int,
    pub avcodec_free_context: unsafe extern "C" fn(*mut *mut c_void),
    pub avcodec_parameters_from_context:
        unsafe extern "C" fn(*mut c_void, *const c_void) -> c_int,
    pub avcodec_fill_audio_frame: unsafe extern "C" fn(
        *mut AVFrame,
        c_int,
        c_int,
        *const u8,
        c_int,
        c_int,
    ) -> c_int,
    pub av_frame_alloc: unsafe extern "C" fn() -> *mut AVFrame,
    pub av_frame_free: unsafe extern "C" fn(*mut *mut AVFrame),
    pub av_frame_get_buffer: unsafe extern "C" fn(*mut AVFrame, c_int) -> c_int,
    pub av_frame_unref: unsafe extern "C" fn(*mut AVFrame),
    pub av_packet_alloc: unsafe extern "C" fn() -> *mut c_void,
    pub av_packet_free: unsafe extern "C" fn(*mut *mut c_void),
    pub av_packet_unref: unsafe extern "C" fn(*mut c_void),
    pub av_packet_rescale_ts: unsafe extern "C" fn(*mut c_void, AVRational, AVRational),
    pub av_dict_set:
        unsafe extern "C" fn(*mut *mut c_void, *const c_char, *const c_char, c_int) -> c_int,
    pub av_dict_free: unsafe extern "C" fn(*mut *mut c_void),
    pub av_strerror: unsafe extern "C" fn(c_int, *mut c_char, usize) -> c_int,
    pub av_opt_set_int:
        unsafe extern "C" fn(*mut c_void, *const c_char, i64, c_int) -> c_int,
    pub av_opt_find: unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char, c_int, c_int) -> *const c_void,
    pub av_opt_set:
        unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char, c_int) -> c_int,
    pub avformat_alloc_output_context2: unsafe extern "C" fn(
        *mut *mut c_void,
        *mut c_void,
        *const c_char,
        *const c_char,
    ) -> c_int,
    pub avformat_new_stream:
        unsafe extern "C" fn(*mut c_void, *const c_void) -> *mut c_void,
    pub avformat_write_header: unsafe extern "C" fn(*mut c_void, *mut *mut c_void) -> c_int,
    pub av_interleaved_write_frame: unsafe extern "C" fn(*mut c_void, *mut c_void) -> c_int,
    pub av_write_trailer: unsafe extern "C" fn(*mut c_void) -> c_int,
    pub avformat_free_context: unsafe extern "C" fn(*mut c_void),
    pub avio_open: unsafe extern "C" fn(*mut *mut c_void, *const c_char, c_int) -> c_int,
    pub avio_close: unsafe extern "C" fn(*mut c_void) -> c_int,
}

unsafe impl Sync for FfmpegApi {}
unsafe impl Send for FfmpegApi {}

static FFMPEG: OnceLock<FfmpegApi> = OnceLock::new();
/// 保活四个共享库句柄（avutil / swresample / avcodec / avformat），必须随进程常驻，
/// 否则 init_ffmpeg 返回后 Library drop → FreeLibrary → FfmpegApi 里的函数指针全部悬空崩溃。
static FFMPEG_LIBS: OnceLock<(Library, Library, Library, Library)> = OnceLock::new();

/// 解析 external-deps 里 ffmpeg 共享 DLL 目录（external-deps/全局/ffmpeg）。
/// 调用方可传入已解析好的目录（推荐，来自 `get_external_deps_dir`，兼容 dev/打包/_up_），
/// 否则回退到多级探测（CARGO_MANIFEST_DIR 与从 exe 逐级向上找）。
fn ffmpeg_dir(preset: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = preset {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
        eprintln!("[ffmpeg] 预置 DLL 目录不存在，回退探测: {}", p);
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    // 1) 编译期常量：dev 下 = src-tauri，向上一层即项目根 external-deps（用户机 release 不存在则跳过）
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("external-deps")
            .join("全局")
            .join("ffmpeg"),
    );
    // 2) 从 exe 逐级向上找 external-deps/全局/ffmpeg（兼容 dev 与打包）
    if let Ok(exe) = std::env::current_exe() {
        let mut p = exe;
        loop {
            let next = match p.parent() {
                Some(par) if par != p => par.to_path_buf(),
                _ => break,
            };
            candidates.push(next.join("external-deps").join("全局").join("ffmpeg"));
            p = next;
        }
    }
    candidates.into_iter().find(|p| p.exists())
}

/// 加载 FFmpeg 共享库（avutil → swresample → avcodec → avformat）。重复调用安全（OnceLock）。
///
/// `dir` 为调用方已解析好的 DLL 目录（推荐）；为 None 时自动探测。
///
/// **根因（本机深坑）**：gyan 共享版 `avcodec-62.dll` 依赖同目录的 `avutil-60.dll` /
/// `swresample-6.dll`。但当从「非宿主 exe 目录」用完整路径 `LoadLibrary` 加载时，Windows
/// **不会**把 DLL 自身所在目录加入其依赖的搜索路径，于是 `avutil-60.dll` 找不到 →
/// `LoadLibraryExW failed`（错误码 126）。而直接跑 `ffmpeg.exe` 能成功，正是因为它的 exe 目录
/// 就是 `external-deps/全局/ffmpeg`，依赖能被应用目录搜索命中。
/// 修复：按「叶子依赖先加载」的顺序加载（avutil → swresample → avcodec → avformat），
/// 依赖一旦在进程内加载，后续 `LoadLibrary(avcodec-62)` 会复用已加载模块，不再去磁盘找。
/// 实测验证：先 `LoadLibrary(avutil-60)` 再 `LoadLibrary(avcodec-62)` 即可成功。
pub fn init_ffmpeg(dir: Option<&str>) -> Result<(), String> {
    if FFMPEG.get().is_some() {
        return Ok(());
    }
    let dir = ffmpeg_dir(dir).ok_or_else(|| {
        "未找到 external-deps/全局/ffmpeg 共享 DLL 目录（请确认该目录下含 avcodec-62.dll / avformat-62.dll / avutil-60.dll）".to_string()
    })?;
    eprintln!("[ffmpeg] 加载共享 DLL 目录: {}", dir.display());

    // 用完整路径加载；按依赖顺序（叶子先加载）以确保 avcodec 的依赖在进程内已存在。
    let load = |name: &str| -> Result<Library, String> {
        let full = dir.join(name);
        let path = full.to_string_lossy().to_string();
        unsafe { Library::new(&full) }.map_err(|e| format!("加载 {} 失败: {}", path, e))
    };

    // 顺序关键：avutil / swresample 是 avcodec 的依赖，必须先于 avcodec 进入进程。
    let avutil = load("avutil-60.dll")?;
    let swresample = load("swresample-6.dll")?;
    let avcodec = load("avcodec-62.dll")?;
    let avformat = load("avformat-62.dll")?;

    let sym = |lib: &Library, name: &[u8]| -> Result<*mut c_void, String> {
        unsafe { lib.get::<*mut c_void>(name) }
            .map(|s: Symbol<*mut c_void>| *s)
            .map_err(|e| format!("符号 {} 缺失: {}", String::from_utf8_lossy(name), e))
    };

    // ⚠️ 关键修复：函数指针必须用 `std::mem::transmute` 把「地址值」直接转成 fn 指针。
    // 旧写法 `*sym(...).cast::<FnType>()` 是把地址当成「指向 FnType 的指针」再解引用，
    // 实际读取了函数入口处那 8 字节机器码当作函数指针 → 跳到垃圾地址 → 0xc0000005。
    let api = FfmpegApi {
        avcodec_find_encoder_by_name: unsafe {
            std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*const c_char) -> *mut c_void>(
                sym(&avcodec, b"avcodec_find_encoder_by_name\0")?,
            )
        },
        avcodec_alloc_context3: unsafe {
            std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*const c_void) -> *mut c_void>(
                sym(&avcodec, b"avcodec_alloc_context3\0")?,
            )
        },
        avcodec_open2: unsafe {
            std::mem::transmute::<
                *mut c_void,
                unsafe extern "C" fn(*mut c_void, *const c_void, *mut *mut c_void) -> c_int,
            >(sym(&avcodec, b"avcodec_open2\0")?)
        },
        avcodec_send_frame: unsafe {
            std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut c_void, *const AVFrame) -> c_int>(
                sym(&avcodec, b"avcodec_send_frame\0")?,
            )
        },
        avcodec_receive_packet: unsafe {
            std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut c_void, *mut c_void) -> c_int>(
                sym(&avcodec, b"avcodec_receive_packet\0")?,
            )
        },
        avcodec_free_context: unsafe {
            std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut *mut c_void)>(
                sym(&avcodec, b"avcodec_free_context\0")?,
            )
        },
        avcodec_parameters_from_context: unsafe {
            std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut c_void, *const c_void) -> c_int>(
                sym(&avcodec, b"avcodec_parameters_from_context\0")?,
            )
        },
        avcodec_fill_audio_frame: unsafe {
            std::mem::transmute::<
                *mut c_void,
                unsafe extern "C" fn(*mut AVFrame, c_int, c_int, *const u8, c_int, c_int) -> c_int,
            >(sym(&avcodec, b"avcodec_fill_audio_frame\0")?)
        },
        av_frame_alloc: unsafe {
            std::mem::transmute::<*mut c_void, unsafe extern "C" fn() -> *mut AVFrame>(
                sym(&avutil, b"av_frame_alloc\0")?,
            )
        },
        av_frame_free: unsafe {
            std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut *mut AVFrame)>(
                sym(&avutil, b"av_frame_free\0")?,
            )
        },
        av_frame_get_buffer: unsafe {
            std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut AVFrame, c_int) -> c_int>(
                sym(&avutil, b"av_frame_get_buffer\0")?,
            )
        },
        av_frame_unref: unsafe {
            std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut AVFrame)>(
                sym(&avutil, b"av_frame_unref\0")?,
            )
        },
        // ⚠️ av_packet_* 系列属于 libavcodec（avcodec-62.dll），不是 libavutil！
        av_packet_alloc: unsafe {
            std::mem::transmute::<*mut c_void, unsafe extern "C" fn() -> *mut c_void>(
                sym(&avcodec, b"av_packet_alloc\0")?,
            )
        },
        av_packet_free: unsafe {
            std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut *mut c_void)>(
                sym(&avcodec, b"av_packet_free\0")?,
            )
        },
        av_packet_unref: unsafe {
            std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut c_void)>(
                sym(&avcodec, b"av_packet_unref\0")?,
            )
        },
        av_packet_rescale_ts: unsafe {
            std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut c_void, AVRational, AVRational)>(
                sym(&avcodec, b"av_packet_rescale_ts\0")?,
            )
        },
        av_dict_set: unsafe {
            std::mem::transmute::<
                *mut c_void,
                unsafe extern "C" fn(*mut *mut c_void, *const c_char, *const c_char, c_int) -> c_int,
            >(sym(&avutil, b"av_dict_set\0")?)
        },
        av_dict_free: unsafe {
            std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut *mut c_void)>(
                sym(&avutil, b"av_dict_free\0")?,
            )
        },
        av_strerror: unsafe {
            std::mem::transmute::<*mut c_void, unsafe extern "C" fn(c_int, *mut c_char, usize) -> c_int>(
                sym(&avutil, b"av_strerror\0")?,
            )
        },
        av_opt_set_int: unsafe {
            std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut c_void, *const c_char, i64, c_int) -> c_int>(
                sym(&avutil, b"av_opt_set_int\0")?,
            )
        },
        av_opt_find: unsafe {
            std::mem::transmute::<
                *mut c_void,
                unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char, c_int, c_int) -> *const c_void,
            >(sym(&avutil, b"av_opt_find\0")?)
        },
        av_opt_set: unsafe {
            std::mem::transmute::<
                *mut c_void,
                unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char, c_int) -> c_int,
            >(sym(&avutil, b"av_opt_set\0")?)
        },
        avformat_alloc_output_context2: unsafe {
            std::mem::transmute::<
                *mut c_void,
                unsafe extern "C" fn(*mut *mut c_void, *mut c_void, *const c_char, *const c_char) -> c_int,
            >(sym(&avformat, b"avformat_alloc_output_context2\0")?)
        },
        avformat_new_stream: unsafe {
            std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut c_void, *const c_void) -> *mut c_void>(
                sym(&avformat, b"avformat_new_stream\0")?,
            )
        },
        avformat_write_header: unsafe {
            std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut c_void, *mut *mut c_void) -> c_int>(
                sym(&avformat, b"avformat_write_header\0")?,
            )
        },
        av_interleaved_write_frame: unsafe {
            std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut c_void, *mut c_void) -> c_int>(
                sym(&avformat, b"av_interleaved_write_frame\0")?,
            )
        },
        av_write_trailer: unsafe {
            std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut c_void) -> c_int>(
                sym(&avformat, b"av_write_trailer\0")?,
            )
        },
        avformat_free_context: unsafe {
            std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut c_void)>(
                sym(&avformat, b"avformat_free_context\0")?,
            )
        },
        avio_open: unsafe {
            std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut *mut c_void, *const c_char, c_int) -> c_int>(
                sym(&avformat, b"avio_open\0")?,
            )
        },
        avio_close: unsafe {
            std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut c_void) -> c_int>(
                sym(&avformat, b"avio_close\0")?,
            )
        },
    };

    // 解析「通用 AVCodecContext 选项所在类」av_codec_context_class（avcodec_get_class 取得），
    // 作为运行时定位字段偏移的兜底来源（本 gyan.dev 构建里 av_opt_* 整体不可信，但静态选项数组若
    // 可访问则最稳）。
    let av_codec_class = match sym(&avcodec, b"avcodec_get_class\0") {
        Ok(p) => {
            let f = unsafe {
                std::mem::transmute::<*mut c_void, unsafe extern "C" fn() -> *const c_void>(p)
            };
            unsafe { f() }
        }
        Err(_) => std::ptr::null(),
    };
    let _ = AV_CODEC_CLASS.set(av_codec_class as usize);

    let _ = FFMPEG.set(api);
    // 保活四个库句柄至进程结束，避免 DLL 被卸载后函数指针悬空。
    let _ = FFMPEG_LIBS.set((avutil, swresample, avcodec, avformat));
    Ok(())
}

/// 取已加载的 FFmpeg API（未加载时触发 panic，调用方须先 `init_ffmpeg`）。
pub fn ffmpeg() -> &'static FfmpegApi {
    FFMPEG.get().expect("FFmpeg 未初始化，请先调用 init_ffmpeg")
}

/// 把 AVError 码转成可读字符串（供日志）。
pub fn errstr(code: c_int) -> String {
    let mut buf = [0u8; 256];
    unsafe {
        (ffmpeg().av_strerror)(code, buf.as_mut_ptr() as *mut c_char, buf.len());
    }
    let nul = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..nul]).to_string()
}

/// 便捷：av_dict_set 的 Rust 封装。
pub unsafe fn dict_set(api: &FfmpegApi, dict: &mut *mut c_void, key: &str, val: &str) {
    // FFI 边界严禁 panic：key/val 含 NUL 时跳过该项并告警（调用方现均传常量，此处为防御）。
    let k = match CString::new(key) {
        Ok(c) => c,
        Err(_) => {
            eprintln!("[FFI] dict_set 跳过含 NUL 的 key: {:?}", key);
            return;
        }
    };
    let v = match CString::new(val) {
        Ok(c) => c,
        Err(_) => {
            eprintln!("[FFI] dict_set 跳过含 NUL 的 val（key={:?}）", key);
            return;
        }
    };
    (api.av_dict_set)(dict, k.as_ptr(), v.as_ptr(), 0);
}

// 字段写入策略说明（经 dbg 实测，FFmpeg 8.0 gyan 共享构建）：
// - 整数选项（pix_fmt/bit_rate/gop_size/max_b_frames/rc_max_rate/rc_buffer_size/time_base/flags）
//   走 `avctx_field_offset` 运行时取偏移 + 直写结构体（stride=64 验证通过，偏移与 FFmpeg 真实布局吻合）。
// - width/height **没有**独立整数选项，只有字符串选项 "video_size"（"WxH"），走 `av_opt_set`（见 set_avctx_video_size）。
// - 之前「选项系统整体不可信」的结论是误判：根因是用了 FFmpeg 8.0 里**不存在**的选项名
//   （pix_fmt→应为 pixel_format、width/height→应走 video_size、bit_rate→应为 b 等），导致设置器静默忽略 / 查找全失败。
//   现用真实选项名，offset 直写与 av_opt_set 均工作正常。
// - `AVClass`  布局: class_name@0 item_name@8 option@16(→AVOption*)（option 恒第 3 指针，跨版本稳定）。
// - `AVOption` 布局: name@0(ptr) help@8 offset@16(i32) type@20 … 单条通常 64 字节（8 字节对齐）。
// 偏移从 DLL 静态数据现查，不靠硬编码；并带护栏防野写。

/// 选项数组基址 + 单条 AVOption 步长（运行时确定，跨构建/版本稳定）。
#[derive(Clone, Copy)]
struct OptSource {
    base: *const u8,
    stride: usize,
}
// OptSource 只持有指向 DLL 内静态数据的裸指针（永不释放），跨线程共享安全。
unsafe impl Sync for OptSource {}
unsafe impl Send for OptSource {}

static OPT_SOURCE: OnceLock<Option<OptSource>> = OnceLock::new();
/// `av_codec_context_class` 指针（avcodec_get_class 取得），作为定位通用字段偏移的兜底来源。
/// 以 usize 存指针值（裸指针不 Sync，usize 可安全进 static）。
static AV_CODEC_CLASS: OnceLock<usize> = OnceLock::new();
/// 运行时探测出的 `AVOption` 单条大小（步长）。仅缓存成功探测到的步长（不缓存失败，避免一次
/// 错位数组污染后续所有探测）。探测失败由 `detect_opt_stride` 内部打印原因。
static OPT_STRIDE: OnceLock<usize> = OnceLock::new();

extern "system" {
    fn IsBadReadPtr(lp: *const c_void, ucb: usize) -> i32;
}

/// 安全探测 `AVOption` 单条大小（步长）。遍历候选步长，对每条步长统计「连续结构合法的选项数」，
/// 取连续数最长的步长（真实选项数组有数百条连续合法选项，错位步长会很快撞到野内存/非法字段）。
/// 探测失败会打印各候选步长的失败原因，便于区分「护栏过严」与「真读到野内存」。
unsafe fn detect_opt_stride(option_arr: *const u8) -> Option<usize> {
    if let Some(s) = OPT_STRIDE.get() {
        return Some(*s);
    }
    let mut best: Option<(usize, usize, String)> = None; // (stride, 连续合法数, 失败原因)
    for stride in [64usize, 80, 72, 56, 48, 88] {
        let (ok, run, reason) = stride_run(option_arr, stride);
        if ok {
            let _ = OPT_STRIDE.set(stride); // 永久缓存成功步长
            return Some(stride);
        }
        if best.as_ref().map_or(0, |b| b.1) < run {
            best = Some((stride, run, reason));
        }
    }
    eprintln!(
        "[DBG] 步长探测失败：最佳候选 stride={} 连续合法选项={} 原因={}（option 数组基址={:p}）",
        best.as_ref().map_or(0, |b| b.0),
        best.as_ref().map_or(0, |b| b.1),
        best.as_ref().map(|b| b.2.clone()).unwrap_or_default(),
        option_arr
    );
    None
}

/// 统计某步长下「连续结构合法的 AVOption 数」。返回 (是否≥8, 连续数, 首个失败原因)。
/// 合法判定：name 指针可读且为合法 C 字符串（可打印 ASCII、≤256 字节有终止符）；offset 字段可读、
/// 4 字节对齐、绝对值≤16384（探测步长允许 offset=0，真正取字段时再要求 >0）。
unsafe fn stride_run(option_arr: *const u8, stride: usize) -> (bool, usize, String) {
    let mut c = option_arr;
    let mut run = 0usize;
    for i in 0..256 {
        let np = *(c as *const *const c_char);
        if np.is_null() {
            break; // 正常以 NULL name 结束数组
        }
        if IsBadReadPtr(np as *const c_void, 1) != 0 {
            return (false, run, format!("name[{}] 指针 {:p} IsBadReadPtr 失败（野指针）", i, np));
        }
        let mut no_term = false;
        for j in 0..256 {
            if IsBadReadPtr(np.add(j) as *const c_void, 1) != 0 {
                return (false, run, format!("name[{}] 字符串第 {} 字节不可读（野内存）", i, j));
            }
            let b = *np.add(j) as u8;
            if b == 0 {
                break;
            }
            if b >= 0x80 || (b < 0x20 && b != b'\t') {
                return (false, run, format!("name[{}] 含非 ASCII/控制字符 {:#x}", i, b));
            }
            if j == 255 {
                no_term = true;
            }
        }
        if no_term {
            return (false, run, format!("name[{}] 超 256 字节无终止符", i));
        }
        let offp = (c as *const c_int).add(4);
        if IsBadReadPtr(offp as *const c_void, 4) != 0 {
            return (false, run, format!("offset[{}] 字段不可读（野内存）", i));
        }
        let off = *offp;
        if off % 4 != 0 || off.unsigned_abs() > 16384 {
            return (false, run, format!("offset[{}]={} 非 4 对齐或超范围", i, off));
        }
        run += 1;
        c = c.add(stride);
    }
    (run >= 8, run, format!("连续合法选项仅 {} 条（<8），疑似步长不对", run))
}

/// 字段名 → 候选选项名。
/// ⚠️ 关键：必须用 FFmpeg 8.0（gyan.dev 共享构建）`AVCodecContext` 选项表里**真实存在**的名字，
/// 否则 offset 直写永远查不到，退化成「全部字段失败」。本构建实测真实名字（见 dbg 打印）：
///   pix_fmt→"pixel_format"  bit_rate→"b"  gop_size→"g"  max_b_frames→"bf"
///   rc_max_rate→"maxrate"  rc_buffer_size→"bufsize"  time_base→"time_base"  flags→"flags"
/// width/height 在本构建**没有独立整数选项**，只有字符串选项 "video_size"（"WxH"），
/// 故不走 offset 直写，改由 `set_avctx_video_size` 经 `av_opt_set` 设置（见 encoder_av.rs）。
/// framerate 在本构建无对应 AVOption，由编码器据 time_base 推断，暂不直写。
static EMPTY_NAMES: &[&str] = &[];
fn option_names_for(field: &str) -> &'static [&'static str] {
    match field {
        "pix_fmt" => &["pixel_format"],
        "bit_rate" => &["b", "bit_rate"],
        "rc_max_rate" => &["maxrate"],
        "rc_buffer_size" => &["bufsize"],
        "gop_size" => &["g", "gop_size"],
        "max_b_frames" => &["bf", "max_b_frames"],
        "time_base" => &["time_base"],
        "flags" => &["flags"],
        "sample_rate" => &["ar"],
        "channels" => &["ac"],
        "ch_layout" => &["ch_layout"],
        // sample_fmt 在本构建被改名（与 pix_fmt→pixel_format 同一规律：fmt→format），
        // 故候选名用 sample_format（其名字不含 "fmt" 子串，所以之前按 ["sample","fmt"] 子串搜不到）。
        "sample_fmt" => &["sample_format"],
        "b" => &["b", "ab"],
        _ => EMPTY_NAMES,
    }
}

/// 惰性确定通用选项数组来源：只要 `av_class->option` 是合法选项数组（detect_opt_stride 成功即证明）
/// 就直接采用，不再依赖“必须先按名命中某个具体字段”来确认，避免候选名与构建不符时整体失效。
/// 先试 `avctx->av_class->option`，再试 `av_codec_context_class->option`。
unsafe fn resolve_opt_source(avctx: *mut c_void) -> Option<OptSource> {
    let probe = |av_class: *const c_void| -> Option<OptSource> {
        if av_class.is_null() {
            return None;
        }
        let opt = *((av_class as *const u8).add(16) as *const *const c_void);
        if opt.is_null() {
            return None;
        }
        let stride = detect_opt_stride(opt as *const u8)?;
        Some(OptSource { base: opt as *const u8, stride })
    };
    if !avctx.is_null() {
        let av_class = *(avctx as *const *const c_void);
        if let Some(s) = probe(av_class) {
            return Some(s);
        }
    }
    let ac = AV_CODEC_CLASS.get().copied().unwrap_or(0) as *const c_void;
    probe(ac)
}

/// 运行时定位 `avctx` 中字段 `field` 的真实偏移（绕开不可信的选项系统）。None = 找不到。
pub unsafe fn avctx_field_offset(avctx: *mut c_void, field: &str) -> Option<usize> {
    let src = OPT_SOURCE.get_or_init(|| resolve_opt_source(avctx));
    let s = match src {
        Some(s) => s,
        None => {
            eprintln!("[DBG] avctx_field_offset({:?}) 来源未建立（选项数组探测失败或不存在）", field);
            return None;
        }
    };
    let mut c = s.base;
    let names = option_names_for(field);
    for i in 0..1024 {
        let np = *(c as *const *const c_char);
        if np.is_null() {
            eprintln!(
                "[DBG] avctx_field_offset({:?}) 扫描至 [{}] 遇 NULL 结束，未命中（基址={:p} stride={}）",
                field, i, s.base, s.stride
            );
            return None;
        }
        if IsBadReadPtr(np as *const c_void, 1) != 0 {
            eprintln!(
                "[DBG] avctx_field_offset({:?}) 扫描至 [{}] name 指针 {:p} 不可读，中止（未命中）",
                field, i, np
            );
            return None;
        }
        let bytes = std::ffi::CStr::from_ptr(np).to_bytes();
        if names.iter().any(|n| n.as_bytes() == bytes) {
            let off = *((c as *const c_int).add(4)) as usize;
            if off != 0 && off <= 8192 && off % 4 == 0 {
                return Some(off);
            }
            eprintln!(
                "[DBG] avctx_field_offset({:?}) 命中 name={:?} 但 offset={} 非法（offset=0 或超范围），放弃",
                field, bytes, off
            );
            return None;
        }
        c = c.add(s.stride);
    }
    eprintln!(
        "[DBG] avctx_field_offset({:?}) 扫描 1024 条未命中候选名 {:?}（基址={:p} stride={}）",
        field, names, s.base, s.stride
    );
    None
}

/// 按名字子串兜底定位字段偏移，绕开「选项名被本构建改名、按名/按类型都查不到」的问题。
/// 用于 sample_fmt：本构建把选项名改成了 `sample_format` 一类（与 pix_fmt→pixel_format 同模式），
/// 且 AVOptionType 枚举值也被重排（type=12 实为 IMAGE_SIZE/video_size，非 SAMPLE_FMT），
/// 故按名/按类型都不可信。这里要求名字同时包含 `contains_all` 中所有子串、且不含 `contains_none`
/// 中任一子串。命中后若 offset 非法则继续扫描（避免首个匹配恰是脏字段）。
/// None = 无匹配。命中会打印实际 name 与 offset，便于核对改名后的真实字段名。
pub unsafe fn avctx_field_offset_substr(
    avctx: *mut c_void,
    contains_all: &[&str],
    contains_none: &[&str],
) -> Option<usize> {
    let src = OPT_SOURCE.get_or_init(|| resolve_opt_source(avctx));
    let s = match src {
        Some(s) => s,
        None => {
            eprintln!("[DBG] avctx_field_offset_substr({:?}) 来源未建立", contains_all);
            return None;
        }
    };
    let mut c = s.base;
    for i in 0..1024 {
        let np = *(c as *const *const c_char);
        if np.is_null() {
            eprintln!(
                "[DBG] avctx_field_offset_substr({:?}) 扫描至 [{}] 遇 NULL 结束，未命中（基址={:p} stride={}）",
                contains_all, i, s.base, s.stride
            );
            return None;
        }
        if IsBadReadPtr(np as *const c_void, 1) != 0 {
            eprintln!(
                "[DBG] avctx_field_offset_substr({:?}) 扫描至 [{}] name 不可读，中止",
                contains_all, i
            );
            return None;
        }
        let name = std::ffi::CStr::from_ptr(np).to_string_lossy().into_owned();
        let ok = contains_all.iter().all(|sub| name.contains(sub))
            && contains_none.iter().all(|sub| !name.contains(sub));
        if ok {
            let off = *((c as *const c_int).add(4)) as usize;
            if off != 0 && off <= 8192 && off % 4 == 0 {
                eprintln!(
                    "[DBG] avctx_field_offset_substr({:?}) 命中 [{}] name={:?} off={}",
                    contains_all, i, name, off
                );
                return Some(off);
            }
            eprintln!(
                "[DBG] avctx_field_offset_substr({:?}) 命中 name={:?} 但 offset={} 非法，继续扫描",
                contains_all, name, off
            );
        }
        c = c.add(s.stride);
    }
    eprintln!(
        "[DBG] avctx_field_offset_substr({:?}) 扫描 1024 条未命中（基址={:p} stride={}）",
        contains_all, s.base, s.stride
    );
    None
}

/// 诊断：打印 avctx 的类信息与选项数组内容（含每个字段名+偏移），确认本构建的选项数组是否可访问。
/// 加 Once 守卫：同一类选项数组只 dump 一次，避免视频/音频/重试多次初始化时把日志刷爆、淹没关键行。
pub unsafe fn dbg_avctx_class(avctx: *mut c_void) {
    static DONE: std::sync::Once = std::sync::Once::new();
    DONE.call_once(|| {
        eprintln!("[DBG] === AVCodecContext 类探测 ===");
        if avctx.is_null() {
            eprintln!("[DBG] avctx 为 NULL");
            return;
        }
        let av_class = *(avctx as *const *const c_void);
        eprintln!("[DBG] avctx={:p} av_class={:p}", avctx, av_class);
        if !av_class.is_null() {
            let cn = *(av_class as *const *const c_char);
            if !cn.is_null() {
                eprintln!("[DBG] av_class->class_name={:?}", std::ffi::CStr::from_ptr(cn));
            }
            let opt = *((av_class as *const u8).add(16) as *const *const c_void);
            eprintln!("[DBG] av_class->option={:p}", opt);
            dump_option_array(opt, "av_class->option");
        }
        let ac = AV_CODEC_CLASS.get().copied().unwrap_or(0) as *const c_void;
        eprintln!("[DBG] av_codec_class(avcodec_get_class)={:p}", ac);
        if !ac.is_null() {
            let cn = *(ac as *const *const c_char);
            if !cn.is_null() {
                eprintln!("[DBG] av_codec_class->class_name={:?}", std::ffi::CStr::from_ptr(cn));
            }
            let opt = *((ac as *const u8).add(16) as *const *const c_void);
            eprintln!("[DBG] av_codec_class->option={:p}", opt);
            dump_option_array(opt, "av_codec_class->option");
        }
    });
}

unsafe fn dump_option_array(opt: *const c_void, label: &str) {
    if opt.is_null() {
        return;
    }
    let stride = match detect_opt_stride(opt as *const u8) {
        Some(s) => s,
        None => {
            eprintln!("[DBG] -- {} 步长探测失败，详见上方 [DBG] 步长探测失败 行 --", label);
            return;
        }
    };
    eprintln!("[DBG] -- {} (stride {}) --", label, stride);
    let mut c = opt as *const u8;
    for i in 0..512 {
        let np = *(c as *const *const c_char);
        if np.is_null() {
            eprintln!("[DBG]   [{}] NULL", i);
            break;
        }
        if IsBadReadPtr(np as *const c_void, 1) != 0 {
            break;
        }
        let cn = std::ffi::CStr::from_ptr(np);
        let off = *((c as *const c_int).add(4));
        eprintln!("[DBG]   [{:2}] name={:?} offset={}", i, cn, off);
        c = c.add(stride);
    }
}

/// 直接写 `AVCodecContext` 的某 i32 字段（如 width/height/pix_fmt/bit_rate/maxrate/bufsize/gop_size…）。
/// 返回 false 表示字段偏移查不到（极少见），调用方可降级到 dict。
pub unsafe fn set_avctx_i32(
    _api: &FfmpegApi,
    avctx: *mut c_void,
    name: &str,
    value: c_int,
) -> bool {
    match avctx_field_offset(avctx, name) {
        Some(off) => {
            let p = (avctx as *mut u8).add(off) as *mut c_int;
            *p = value;
            true
        }
        None => {
            eprintln!("[编码器] avctx_field_offset({}) 失败：av_class/option 异常", name);
            false
        }
    }
}

/// 同 `set_avctx_i32`，但按名字子串兜底定位偏移（用于选项名被改名、按名查不到的字段，如 sample_fmt）。
pub unsafe fn set_avctx_i32_substr(
    _api: &FfmpegApi,
    avctx: *mut c_void,
    contains_all: &[&str],
    contains_none: &[&str],
    value: c_int,
) -> bool {
    match avctx_field_offset_substr(avctx, contains_all, contains_none) {
        Some(off) => {
            let p = (avctx as *mut u8).add(off) as *mut c_int;
            *p = value;
            true
        }
        None => {
            eprintln!(
                "[编码器] avctx_field_offset_substr({:?}) 失败：未找到该字段",
                contains_all
            );
            false
        }
    }
}

/// 诊断：打印选项数组里所有名字含 `substr` 的字段（含 offset），用于反查被改名的字段真实名
/// （如 sample_fmt→sample_format）。复用已缓存的 OPT_SOURCE；仅打印、不改写。
pub unsafe fn dbg_dump_option_names_containing(avctx: *mut c_void, substr: &str) {
    let src = OPT_SOURCE.get_or_init(|| resolve_opt_source(avctx));
    let s = match src {
        Some(s) => s,
        None => {
            eprintln!("[DBG] dump({:?}): 来源未建立", substr);
            return;
        }
    };
    let mut c = s.base;
    eprintln!("[DBG] === 选项名含 {:?} 的字段 ===", substr);
    for i in 0..1024 {
        let np = *(c as *const *const c_char);
        if np.is_null() {
            break;
        }
        if IsBadReadPtr(np as *const c_void, 1) != 0 {
            break;
        }
        let name = std::ffi::CStr::from_ptr(np).to_string_lossy();
        if name.contains(substr) {
            let off = *((c as *const c_int).add(4));
            eprintln!("[DBG]   [{}] name={:?} offset={}", i, name, off);
        }
        c = c.add(s.stride);
    }
}

pub unsafe fn set_avctx_rational(
    _api: &FfmpegApi,
    avctx: *mut c_void,
    name: &str,
    num: c_int,
    den: c_int,
) -> bool {
    match avctx_field_offset(avctx, name) {
        Some(off) => {
            let p = (avctx as *mut u8).add(off) as *mut c_int;
            *p = num;
            *p.add(1) = den;
            true
        }
        None => {
            eprintln!("[编码器] avctx_field_offset({}) 失败", name);
            false
        }
    }
}

/// 直接对 `AVCodecContext` 的 flags 字段做「按位或」（如 +global_header）。
pub unsafe fn set_avctx_flags(
    _api: &FfmpegApi,
    avctx: *mut c_void,
    name: &str,
    add: c_int,
) -> bool {
    match avctx_field_offset(avctx, name) {
        Some(off) => {
            let p = (avctx as *mut u8).add(off) as *mut c_int;
            *p |= add;
            true
        }
        None => false,
    }
}

/// 经 FFmpeg 选项系统设置 `video_size`（"WxH"），由 FFmpeg 解析写入 width/height。
/// 关键：本构建 `AVCodecContext` 选项表里 **没有** "width"/"height" 整数选项，只有字符串选项
/// "video_size"（AV_OPT_TYPE_IMAGE_SIZE），其 write 回调解析 "WxH" 后写入结构体的 width/height 字段。
/// 故 width/height 不能走 offset 直写，必须走 `av_opt_set`（已在 FfmpegApi 绑定）。
/// 返回 false 仅打印，不会致命（若失败则 avcodec_open2 会报维度相关错误，日志可定位）。
pub unsafe fn set_avctx_video_size(
    api: &FfmpegApi,
    avctx: *mut c_void,
    width: c_int,
    height: c_int,
) -> bool {
    let key = std::ffi::CString::new("video_size").unwrap();
    let val = std::ffi::CString::new(format!("{}x{}", width, height)).unwrap();
    let rc = (api.av_opt_set)(avctx, key.as_ptr(), val.as_ptr(), 0);
    if rc < 0 {
        eprintln!(
            "[编码器] av_opt_set(video_size={}x{}) 失败: {} (rc={})",
            width, height, errstr(rc), rc
        );
        return false;
    }
    true
}

/// 直接写 `AVCodecContext` 的 `ch_layout`（FFmpeg 5.1+ 的 `AVChannelLayout`），绕开不可信的设置器。
/// AVChannelLayout 布局（24 字节）: order(i32)@0 nb_channels(i32)@4 u{mask(u64)/map(*)}@8 opaque(*)@16。
/// channels<=1 → mono(mask=4=FRONT_CENTER)，否则 stereo(mask=3=FL|FR)，与 av_channel_layout_default 一致。
pub unsafe fn set_avctx_ch_layout(
    _api: &FfmpegApi,
    avctx: *mut c_void,
    channels: c_int,
) -> bool {
    match avctx_field_offset(avctx, "ch_layout") {
        Some(off) => {
            let p = (avctx as *mut u8).add(off);
            // mask：mono=FRONT_CENTER(4)、stereo=FL|FR(3)，与 av_channel_layout_default 一致
            // （旧代码 mono 用 1=FRONT_LEFT，非标准；与 frame 侧保持一致以防 send_frame 报布局不符）。
            let mask: u64 = if channels <= 1 { 4 } else { 3 };
            *(p as *mut i32) = 0; // @0  order = AV_CHANNEL_ORDER_NATIVE
            *((p as *mut i32).add(1)) = channels.max(1); // @4  nb_channels
            *((p as *mut u8).add(8) as *mut u64) = mask;  // @8  u.mask（union：mask 与 map 共享内存）
            *((p as *mut u8).add(16) as *mut usize) = 0;  // @16 opaque = NULL
            // AVChannelLayout 总长 24 字节（@0..24）。旧代码在 @24 写 0 越界，会污染
            // AVCodecContext 中 ch_layout 之后的字段——已删除。
            true
        }
        None => false,
    }
}

/// 取 `AVStream->codecpar`。
///
/// **深坑**：`avcodec_parameters_from_context(par, ctx)` 的第一个参数是
/// `AVCodecParameters *`，**不是** `AVStream *`。曾误把 `avformat_new_stream` 返回的
/// `AVStream*` 直接传进去，导致 ffmpeg 按 `AVCodecParameters` 布局把
/// `codec_type/codec_id/codec_tag/extradata/...` 写在 `AVStream` 头部，正好覆盖
/// `av_class@0` / `index@8` / `id@12` / **`codecpar@16`**（被写成 extradata=NULL）。
/// 随后 `avformat_write_header` 内部解引用 `st->codecpar` →
/// `0xc0000005 fault_address=0x0`（mp4 / mpegts 均复现）。
///
/// AVStream 布局（FFmpeg 6/7/8 一致）：`av_class@0, index@8, id@12, codecpar@16, priv_data@24`。
/// 这里不盲信 16，而是用「刚创建的 codecpar」特征做自检：
/// `codec_type == AVMEDIA_TYPE_UNKNOWN(-1)` 且 `codec_id == AV_CODEC_ID_NONE(0)`。
/// 只探测 16 / 24 两个「一定是指针」的槽位，绝不扫描 start_time 等非指针字段
/// （AV_NOPTS_VALUE 当指针解引用会直接崩）。
pub unsafe fn stream_codecpar(st: *mut c_void) -> *mut c_void {
    if st.is_null() {
        return std::ptr::null_mut();
    }
    let base = st as *const usize;
    let looks_like_fresh_codecpar = |p: *mut c_void| -> bool {
        if p.is_null() || (p as usize) < 0x1000 {
            return false;
        }
        let ct = *(p as *const c_int);
        let ci = *((p as *const c_int).add(1));
        ct == -1 && ci == 0
    };
    for slot in [2usize /* @16 */, 3 /* @24 */] {
        let p = *(base.add(slot)) as *mut c_void;
        if looks_like_fresh_codecpar(p) {
            if slot != 2 {
                eprintln!("[编码器] ⚠️ AVStream.codecpar 位于偏移 {}（非预期的 16）", slot * 8);
            }
            return p;
        }
    }
    eprintln!("[编码器] ⚠️ AVStream.codecpar 自检失败，回退偏移 16");
    *(base.add(2)) as *mut c_void
}
