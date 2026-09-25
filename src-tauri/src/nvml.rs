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
//   · nvmlDeviceGetFanSpeed              → ret=3（NOT_SUPPORTED）❌ 笔记本卡不暴露风扇，
//     故**刻意不接**：接了也只是一列恒为 N/A 的噪音。
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
    devices: Vec<(String, NvmlDevice)>,
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
    unsafe {
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
    })
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
