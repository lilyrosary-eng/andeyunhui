// ============ NVIDIA NVML 运行时动态加载 ============
//
// 用途：给 NVIDIA 显卡取**实时功耗 / 图形频率 / GPU 温度**。Windows 上没有能同时覆盖各家显卡的
// 公开 API（PDH「GPU Engine」只有利用率，没有功耗/频率/温度），只能走厂商库：
//   · NVIDIA → NVML（nvml.dll，随驱动装进 %SystemRoot%\System32）
//   · AMD    → ADLX/ADL（本模块未接，字段降级为 N/A）
//   · Intel  → 无公开消费级 API（字段降级为 N/A）
//
// ⚠ 本机实测（RTX 3080 Ti Laptop，NVML 610.88）关于**哪些符号真的可用**：
//   · nvmlDeviceGetTemperature(sensor 0) → ret=0，读到 42 °C      ✅ 已接入
//   · nvmlDeviceGetPowerUsage            → ret=0，14887 mW        ✅ 已接入
//   · nvmlDeviceGetClockInfo(0)          → ret=0，210 MHz         ✅ 已接入
//   · nvmlDeviceGetFanSpeed              → ret=3（NOT_SUPPORTED）❌ 笔记本卡不暴露风扇。
//     这是**硬件事实而非实现缺失**：笔记本的风扇由主板 EC 统一管控，GPU 只拿到「无独立风扇」
//     的回答；同型号的桌面卡同一个 API 是正常返回的。所以下面**照接**并在取不到时降级为 None：
//     接上它对桌面卡用户是真收益，对本机只是恒为 None——与 IGCL 温度同一套「按能力降级」策略。
//   · nvmlDeviceGetFanSpeedRPM           → 同上（桌面卡返回真实 RPM，笔记本 NOT_SUPPORTED）
//   · nvmlDeviceGetHandleByLUID / nvmlDeviceGetLuid **不在**该版本导出表里 ⇒ 只能按名称匹配。
//
// 为什么用 libloading 运行时加载，而不是加编译期依赖（nvml-wrapper 之类）：
//   ① NVML 只对 NVIDIA 有意义，其他机器上装了也是零收益，不该进依赖树；
//   ② libloading 已在依赖表（ffmpeg 模块在用），零新增依赖、零新增 Cargo feature
//      —— 这点在本机很关键：动 Cargo feature 会触发 windows crate 全量重编，
//      而本机 cargo 校验窗口只有 ~2 分钟。
//
// 失败策略：nvml.dll 不存在 / 符号缺失 / 初始化失败 → 整体视为不可用，
// 所有取值返回 None，调用方展示 N/A。**不 panic、不报错、不影响其他指标。**
//
// ⚠ 换算口径（本机实测 RTX 3080 Ti Laptop，NVML 610.88）：
//     nvmlDeviceGetPowerUsage      返回**毫瓦**（实测 14887 → 14.887 W，空闲态合理）
//     nvmlDeviceGetClockInfo(0)    返回**MHz**（实测 210，为空闲态降频值，合理）
//   名称与 DXGI 的 DXGI_ADAPTER_DESC1.Description **逐字一致**
//   （实测两边都是 "NVIDIA GeForce RTX 3080 Ti Laptop GPU"），故按名称匹配。
//   注：nvmlDeviceGetHandleByLUID / nvmlDeviceGetLuid **不在**该版本导出表里
//   （实测导出表里没有），所以不走 LUID 匹配，改按名称匹配 + 单卡兜底。
use std::ffi::c_void;
use std::sync::OnceLock;

use libloading::Library;

/// NVML 的不透明设备句柄
type NvmlDevice = *mut c_void;
/// nvmlReturn_t：0 == NVML_SUCCESS
type NvmlRet = u32;
/// nvmlClockType_t::NVML_CLOCK_GRAPHICS
const NVML_CLOCK_GRAPHICS: i32 = 0;
/// nvmlTemperatureSensors_t::NVML_TEMPERATURE_GPU（核心温度，非 hotspot/显存温度）
const NVML_TEMPERATURE_GPU: i32 = 0;
/// 名称缓冲长度（NVML 官方示例用的 96 足够；留 128 余量）
const NAME_BUF: usize = 128;

struct Nvml {
    /// 必须持有 Library 本体：符号是裸函数指针，库一旦卸载指针即悬空。
    /// 本模块把 Library 存进 static，进程生命周期内不卸载（也无需 nvmlShutdown）。
    _lib: Library,
    power_usage: unsafe extern "C" fn(NvmlDevice, *mut u32) -> NvmlRet,
    clock_info: unsafe extern "C" fn(NvmlDevice, i32, *mut u32) -> NvmlRet,
    temperature: unsafe extern "C" fn(NvmlDevice, i32, *mut u32) -> NvmlRet,
    /// 风扇转速（**可选**符号）：桌面卡专用，笔记本卡不导出/不响应。
    /// 与上面三个「缺失即整体放弃」的核心符号不同——这里缺失只让风扇降级为 None，
    /// 不能连带把已经能用的功耗/频率/温度一起废掉。
    fan_speed_pct: Option<unsafe extern "C" fn(NvmlDevice, u32, *mut u32) -> NvmlRet>,
    /// 真实 RPM（可选符号）。`nvmlDeviceGetFanSpeedRPM` 收一个带 version 的结构体。
    fan_speed_rpm: Option<unsafe extern "C" fn(NvmlDevice, *mut FanSpeedInfo) -> NvmlRet>,
    /// 该设备有几个风扇（可选符号）。取不到时按 1 个尝试。
    num_fans: Option<unsafe extern "C" fn(NvmlDevice, *mut u32) -> NvmlRet>,
    devices: Vec<(String, NvmlDevice)>,
}

/// `nvmlFanSpeedInfo_t` = `nvmlFanSpeedInfo_v1_t`（官方 nvml.h 原文）
///
/// ⚠ 三个易错点，全部会导致「读不到」或「读出垃圾」，且都不报错：
///  ① **字段顺序是 version → fan → speed**（version 在**第一个**，不是最后）。
///  ② `version` 必须填 `nvmlFanSpeedInfo_v1` 宏，展开为
///     `sizeof(nvmlFanSpeedInfo_v1_t) | (1 << 24U)` —— 即 **版本号在高 8 位**，
///     结构体大小（3×u32 = 12）在低比特位。写成 `sizeof | 1`（网上常见的误传）会得到
///     0x0000000C，驱动直接回 INVALID_ARGUMENT，且不写明原因 ⇒ 本项恒为 None。
///  ③ `fan` 既是入参（目标风扇索引）也会被驱动回写为风扇总数。
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct FanSpeedInfo {
    /// 入参：结构体格式版本 = `(1 << 24) | 12`
    version: u32,
    /// 入参：目标风扇索引（0 起）
    fan: u32,
    /// 出参：转速 RPM
    speed: u32,
}

impl FanSpeedInfo {
    /// `nvmlFanSpeedInfo_v1` 的实际取值：版本号(1) << 24 | sizeof(v1_t)=12
    const VERSION_V1: u32 = (1 << 24) | (std::mem::size_of::<Self>() as u32);

    /// 布局自检：字段顺序或类型一旦写错，`size_of` 就不再是 12（Debug 构建下立刻 panic，
    /// Release 不含检查、零开销）。这比「读出垃圾 RPM 却看不出异常」安全得多。
    fn new(fan: u32) -> Self {
        debug_assert_eq!(std::mem::size_of::<Self>(), 12, "nvmlFanSpeedInfo_v1_t 应为 12 字节");
        Self {
            version: Self::VERSION_V1,
            fan,
            speed: 0,
        }
    }
}

// SAFETY: devices 里是 NVML 的不透明设备句柄（驱动侧对象，非本进程堆地址），
// NVML 自身的 API 是线程安全的；此处只承诺「句柄可随 static 跨线程共享」，
// 且所有调用点都是只读查询（getPowerUsage / getClockInfo / getTemperature），无状态变更。
unsafe impl Send for Nvml {}
unsafe impl Sync for Nvml {}

/// 单块 NVIDIA 卡的实时读数
#[derive(Default, Clone, Copy)]
pub struct NvmlSample {
    /// 整卡功耗（瓦）
    pub power_w: Option<f32>,
    /// 图形时钟（MHz）
    pub clock_mhz: Option<u32>,
    /// 核心温度（摄氏度）
    pub temp_c: Option<u32>,
    /// 风扇转速（**百分比**，官方口径是「相对该卡最大转速的百分比」，可能 >100）
    ///
    /// 笔记本卡恒为 None：EC 统一管控风扇时 NVML 直接返回 NOT_SUPPORTED。
    pub fan_percent: Option<u32>,
    /// 风扇转速（**真实 RPM**）。优先于百分比：百分比是 NVML 自己换算的「意图速度」，
    /// 而官方文档明确写了「这是 intended speed，物理卡住时与实际转速不符」——
    /// 两个值都可能虚高，所以取到 RPM 时前端一并展示。
    pub fan_rpm: Option<u32>,
}

static NVML: OnceLock<Option<Nvml>> = OnceLock::new();

fn instance() -> Option<&'static Nvml> {
    NVML.get_or_init(load).as_ref()
}

/// 惰性加载 nvml.dll 并完成初始化（进程内只尝试一次）
fn load() -> Option<Nvml> {
    unsafe {
        let lib = open_nvml()?;
        // 逐个解析需要的符号；任一缺失即整体放弃（版本差异下不猜 ABI）
        let init: unsafe extern "C" fn() -> NvmlRet = *lib.get(b"nvmlInit_v2\0").ok()?;
        let get_count: unsafe extern "C" fn(*mut u32) -> NvmlRet =
            *lib.get(b"nvmlDeviceGetCount_v2\0").ok()?;
        let get_by_index: unsafe extern "C" fn(u32, *mut NvmlDevice) -> NvmlRet =
            *lib.get(b"nvmlDeviceGetHandleByIndex_v2\0").ok()?;
        let get_name: unsafe extern "C" fn(NvmlDevice, *mut i8, u32) -> NvmlRet =
            *lib.get(b"nvmlDeviceGetName\0").ok()?;
        let power_usage: unsafe extern "C" fn(NvmlDevice, *mut u32) -> NvmlRet =
            *lib.get(b"nvmlDeviceGetPowerUsage\0").ok()?;
        let clock_info: unsafe extern "C" fn(NvmlDevice, i32, *mut u32) -> NvmlRet =
            *lib.get(b"nvmlDeviceGetClockInfo\0").ok()?;
        // 温度符号自 NVML 1.0（2011）就存在，与功耗/频率同属最老的一批 API，
        // 故沿用「任一缺失即整体放弃」的策略，不为它单开可选分支。
        let temperature: unsafe extern "C" fn(NvmlDevice, i32, *mut u32) -> NvmlRet =
            *lib.get(b"nvmlDeviceGetTemperature\0").ok()?;

        // ---- 风扇相关：三个符号各自可选，缺失只让风扇降级为 None ----
        // 为什么不用「任一缺失即整体放弃」：风扇是**桌面卡专有**能力，老驱动上可能不导出。
        // 若沿用严格策略，一台老机器上会连带丢掉已经能用的功耗/频率/温度 —— 那是净损失。
        // （本函数已整体处于 unsafe 块内，故直接 lib.get(...) 不再嵌套 unsafe。）
        let fan_speed_pct: Option<unsafe extern "C" fn(NvmlDevice, u32, *mut u32) -> NvmlRet> = lib
            .get(b"nvmlDeviceGetFanSpeed_v2\0")
            .ok()
            .map(|f| *f as unsafe extern "C" fn(NvmlDevice, u32, *mut u32) -> NvmlRet);
        let fan_speed_rpm: Option<unsafe extern "C" fn(NvmlDevice, *mut FanSpeedInfo) -> NvmlRet> =
            lib.get(b"nvmlDeviceGetFanSpeedRPM\0")
                .ok()
                .map(|f| *f as unsafe extern "C" fn(NvmlDevice, *mut FanSpeedInfo) -> NvmlRet);
        let num_fans: Option<unsafe extern "C" fn(NvmlDevice, *mut u32) -> NvmlRet> = lib
            .get(b"nvmlDeviceGetNumFans\0")
            .ok()
            .map(|f| *f as unsafe extern "C" fn(NvmlDevice, *mut u32) -> NvmlRet);

        if init() != 0 {
            return None;
        }
        let mut count: u32 = 0;
        if get_count(&mut count) != 0 || count == 0 {
            return None;
        }
        let mut devices = Vec::new();
        for i in 0..count {
            let mut dev: NvmlDevice = std::ptr::null_mut();
            if get_by_index(i, &mut dev) != 0 || dev.is_null() {
                continue;
            }
            let mut buf = [0i8; NAME_BUF];
            let ret = get_name(dev, buf.as_mut_ptr(), NAME_BUF as u32);
            let name = if ret == 0 {
                // 强制 NUL 结尾：万一驱动把 128 字节写满且不带终止符，
                // CStr::from_ptr 会顺着内存越界读到 0xC0000005。多写一个 0 即可消除该风险。
                buf[NAME_BUF - 1] = 0;
                std::ffi::CStr::from_ptr(buf.as_ptr())
                    .to_string_lossy()
                    .to_string()
            } else {
                String::new()
            };
            devices.push((name, dev));
        }
        if devices.is_empty() {
            return None;
        }
        Some(Nvml {
            _lib: lib,
            power_usage,
            clock_info,
            temperature,
            fan_speed_pct,
            fan_speed_rpm,
            num_fans,
            devices,
        })
    }
}

/// 载入 nvml.dll：先按 DLL 名让系统在标准搜索路径里找（System32 在列表内），
/// 失败再退回绝对路径（少数环境把 System32 从搜索路径里剔了）。
unsafe fn open_nvml() -> Option<Library> {
    if let Ok(lib) = Library::new("nvml.dll") {
        return Some(lib);
    }
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    Library::new(format!(r"{root}\System32\nvml.dll")).ok()
}

/// 按 DXGI 显卡名查 NVML 读数。
///
/// 匹配策略（从严格到宽松）：
///   ① 名称逐字相等（本机实测 DXGI 与 NVML 名称完全一致）
///   ② 名称不区分大小写相等
///   ③ 只有一个 NVML 设备且 DXGI 名以 "NVIDIA" 开头 → 认为就是它
///      （有些驱动会给 DXGI 加后缀，名称不再逐字相等）
pub fn sample_by_name(dxgi_name: &str) -> Option<NvmlSample> {
    let n = instance()?;
    let dev = pick_device(&n.devices, dxgi_name)?;
    let mut power_w = None;
    let mut clock_mhz = None;
    let mut temp_c = None;
    let (fan_percent, fan_rpm);
    unsafe {
        // 风扇放在功耗/频率/温度之前读：任一失败都只让该项为 None，不影响其余。
        fan_percent = read_fan_percent(n, dev);
        fan_rpm = read_fan_rpm(n, dev);
        let mut mw: u32 = 0;
        if (n.power_usage)(dev, &mut mw) == 0 {
            power_w = Some(mw as f32 / 1000.0);
        }
        let mut mhz: u32 = 0;
        if (n.clock_info)(dev, NVML_CLOCK_GRAPHICS, &mut mhz) == 0 {
            clock_mhz = Some(mhz);
        }
        let mut c: u32 = 0;
        if (n.temperature)(dev, NVML_TEMPERATURE_GPU, &mut c) == 0 {
            temp_c = Some(c);
        }
    }
    Some(NvmlSample {
        power_w,
        clock_mhz,
        temp_c,
        fan_percent,
        fan_rpm,
    })
}

/// 风扇总数；符号缺失或调用失败时按 1 尝试（单风扇是绝大多数桌面卡的形态）。
unsafe fn fan_count(n: &Nvml, dev: NvmlDevice) -> u32 {
    match n.num_fans {
        Some(f) => {
            let mut c: u32 = 0;
            if f(dev, &mut c) == 0 && c > 0 {
                c
            } else {
                1
            }
        }
        None => 1,
    }
}

/// 风扇转速百分比：多风扇取**最大**那路（与任务管理器取 GPU 最忙引擎同一思路：
/// 「整卡风扇读数」应反映最积极的一路，而不是把机箱里几个风扇做平均）。
/// 0 视为「停转/不报」→ 返回 None，避免展示一个假的 0%。
unsafe fn read_fan_percent(n: &Nvml, dev: NvmlDevice) -> Option<u32> {
    let f = n.fan_speed_pct?;
    let count = fan_count(n, dev);
    let mut best: Option<u32> = None;
    for i in 0..count {
        let mut pct: u32 = 0;
        if f(dev, i, &mut pct) == 0 && pct > 0 {
            best = Some(best.map_or(pct, |b: u32| b.max(pct)));
        }
    }
    best
}

/// 风扇真实 RPM。多风扇取最大（口径同 `read_fan_percent`）。
/// 传 `version` 是硬要求：填错驱动只回 INVALID_ARGUMENT、不说明原因 ⇒ 本项恒为 None。
unsafe fn read_fan_rpm(n: &Nvml, dev: NvmlDevice) -> Option<u32> {
    let f = n.fan_speed_rpm?;
    let count = fan_count(n, dev);
    let mut best: Option<u32> = None;
    for i in 0..count {
        let mut info = FanSpeedInfo::new(i);
        if f(dev, &mut info) == 0 && info.speed > 0 {
            best = Some(best.map_or(info.speed, |b: u32| b.max(info.speed)));
        }
    }
    best
}

fn pick_device(devices: &[(String, NvmlDevice)], dxgi_name: &str) -> Option<NvmlDevice> {
    if let Some((_, d)) = devices.iter().find(|(n, _)| n == dxgi_name) {
        return Some(*d);
    }
    let lower = dxgi_name.to_lowercase();
    if let Some((_, d)) = devices
        .iter()
        .find(|(n, _)| n.to_lowercase() == lower)
    {
        return Some(*d);
    }
    if devices.len() == 1 && lower.starts_with("nvidia") {
        return Some(devices[0].1);
    }
    None
}
