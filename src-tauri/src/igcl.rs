// ============ Intel IGCL（Graphics Control Library）核显遥测 ============
//
// 用途：给 **Intel 核显 / Arc** 取实时频率与温度。
//
// 为什么必须单开一条路：Intel 没有 NVML 那样的公开 API，而这恰恰是**分发面最大**的一类设备，
// 且它在我们已经接的两条路里都拿不到频率/温度 —— PDH 的 `GPU Engine` 只有利用率、
// PDH 也没有显卡温度计数器，NVML 只认 NVIDIA。IGCL 是核显用户唯一的**免驱**来源。
// 成熟实现 LibreHardwareMonitor 走的正是这条：它的 `IntelIntegratedGpu` 调
// `ctlPowerTelemetryGet` 读 `gpuCurrentTemperature` / `gpuCurrentClockFrequency` / `gpuVoltage`。
//
// 为什么是运行时加载而不是编译期依赖：ControlLib.dll **随 Intel 显卡驱动安装**（非我们分发），
// 在没装 Intel 驱动的机器上根本不存在 ⇒ 与 nvml.rs 同理，不该进依赖树。
//
// ⚠ 本机实测（Intel UHD Graphics，**普通权限，无需管理员**）：
//   · ctlInit(Size=36, Version=0, AppVersion=0x10001, flags=CTL_INIT_FLAG_USE_LEVEL_ZERO) → 0
//     （若同一 API 已被其他进程打开会返回 **1** —— 那也是成功，必须容忍，否则一见非 0 就整体放弃）
//   · ctlEnumerateDevices → 1 台（IGCL **只枚举 Intel**，NVIDIA 不在其中）
//   · ctlPowerTelemetryGet(Size=1136, Version=1) → 0，且 DLL 会把 Size 回填成 1136
//   · gpuCurrentClockFrequency：bSupported=true，实测 700~750 MHz（units=MHZ、type=DOUBLE）
//   · gpuCurrentTemperature：bSupported=**false**，ctlEnumTemperatureSensors count=0
//     ⇒ 本机这块核显/驱动不暴露温度。这是**设备差异不是我们写错**，故严格按 bSupported 降级为 N/A。
//       （换一台机器很可能就有值 —— 这正是「对其他设备适配」要覆盖的场景）
//
// ⚠ Size/Version 是双门禁，且各处 Version 语义不同（都实测过）：
//   · ctl_power_telemetry_t  → Version=1（本模块只用它）
//   · ctl_freq_properties_t / ctl_freq_state_t → **只认 Version=0**（传 1 返回 0x40000009
//     UNSUPPORTED_VERSION）⇒ 不要想着"统一抄一个版本号"，将来若要接频率域必须单独钉 0。
//
// ⚠ ABI 细节（照 Intel igcl_api.h 与 LHM 互操作定义，并经探针 sizeof 实测验证）：
//   · 调用约定 **__cdecl**；Intel 明确性能/遥测类 API **仅支持 64 位进程**
//   · `ctl_oc_telemetry_item_t` = 24 字节：bSupported@0(u8)、units@4(i32)、type@8(i32)、
//     value(union 8B)@**16** ← 前面有 3 字节填充。写错**不会报错**，只会读到垃圾数。
//   · `ctl_power_telemetry_t` = **1136** 字节；clock item @80、temp item @104。
//     本模块**不镜像那 39 个成员**，而是留 1136 字节缓冲按偏移读需要的两项 —— 这样即使 Intel
//     以后在尾部加字段也不会错位（前提是它不改已有偏移，官方承诺向前兼容）。
//   · `ctl_device_adapter_properties_t` = 320 字节，name@88、pci_vendor_id@64。
//     ⚠ name 是 **char[100]（ANSI，100 字节）而不是 wchar[100]** —— 这条由独立 Rust 探针实测纠正：
//       按 wchar 读会得到「湉整⡬⥒…」这种把相邻 ASCII 两两拼成 UTF-16 的乱码。
//       结构性佐证：紧随其后的 `graphics_adapter_properties` 偏移正是 88 + 100 = 188，与官方布局吻合。
//     name 与 DXGI 的适配器名逐字一致（本机实测 "Intel(R) UHD Graphics"），故沿用 nvml.rs 的按名匹配。
use std::ffi::c_void;
use std::sync::{Mutex, OnceLock};

use libloading::Library;

/// CTL_RESULT_SUCCESS
const CTL_RESULT_SUCCESS: i32 = 0;
/// 「同一 API 已被其他进程打开」——仍是可用的成功码（本机实测值为 1）
const CTL_RESULT_ALREADY_OPEN: i32 = 1;
/// CTL_IMPL_VERSION = (1 << 16) | 1，既作 AppVersion 也作 SupportedVersion
const CTL_IMPL_VERSION: u32 = 0x0001_0001;
/// CTL_INIT_FLAG_USE_LEVEL_ZERO：走 Level Zero 后端（本机实测可用）
const CTL_INIT_FLAG_USE_LEVEL_ZERO: u32 = 1;

/// ctl_power_telemetry_t 的实测字节数（DLL 会把 Size 回填成此值，反向印证布局）
const TELEMETRY_SIZE: usize = 1136;
/// telemetry 结构自身的版本号（**不是** API 版本）
const TELEMETRY_VERSION: u8 = 1;
/// ctl_oc_telemetry_item_t 的字节数
const ITEM_SIZE: usize = 24;
/// item 里 union 值相对 item 起点的偏移（前面 3 字节填充，极易写错）
const ITEM_VALUE_OFF: usize = 16;
/// 两个目标 item 在 telemetry 缓冲里的偏移（实测确定）
const OFF_CLOCK_ITEM: usize = 80;
const OFF_TEMP_ITEM: usize = 104;
/// ctl_data_type_t::DOUBLE —— 本机实测这几项都是 double；非 double 一律不猜
const CTL_DATA_TYPE_DOUBLE: i32 = 9;

/// ctl_device_adapter_properties_t 的字节数与关键偏移（name 是 ANSI 100 字节，见 props_name）
const PROPS_SIZE: usize = 320;
const PROPS_VERSION: u32 = 1;
const OFF_PROPS_NAME: usize = 88;
const PROPS_NAME_LEN: usize = 100;

/// 不透明句柄：IGCL 的 `ctl_api_handle_t` / `ctl_device_adapter_handle_t` 都是「指向不透明结构的指针」
type ApiHandle = *mut c_void;
type DevHandle = *mut c_void;

/// ctl_init_args_t（36 字节）
#[repr(C)]
#[derive(Clone, Copy)]
struct InitArgs {
    size: u32,          // +0
    version: u8,        // +4
    _pad: [u8; 3],      // +5..8
    app_version: u32,   // +8
    flags: u32,         // +12
    supported_version: u32, // +16
    app_id: [u8; 16],   // +20（ctl_application_id_t：u32+u16+u16+u8[8]）
}

/// ctl_power_telemetry_t 的**载体**：只声明前 8 字节（Size/Version），其余按偏移读
#[repr(C)]
struct Telemetry {
    size: u32,             // +0
    version: u8,           // +4
    _pad: [u8; 3],         // +5..8
    rest: [u8; TELEMETRY_SIZE - 8], // +8..1136
}

/// ctl_device_adapter_properties_t 的载体：同理，只声明 Size/Version，name 按偏移读
#[repr(C)]
struct AdapterProps {
    size: u32,   // +0
    version: u32, // +4
    rest: [u8; PROPS_SIZE - 8],
}

/// 单块 Intel 核显的读数（取不到的项为 None，交由调用方降级为 N/A）
#[derive(Default, Clone, Copy)]
pub struct IgclSample {
    /// 当前图形时钟（MHz）
    pub clock_mhz: Option<u32>,
    /// 核心温度（°C）
    pub temp_c: Option<f32>,
}

struct Igcl {
    /// 必须持有 Library 本体：符号是裸函数指针，库一卸载指针即悬空（与 nvml.rs 同理）
    _lib: Library,
    telemetry_get: unsafe extern "C" fn(DevHandle, *mut Telemetry) -> i32,
    devices: Vec<(String, DevHandle)>,
}

// SAFETY: devices 里是 IGCL 的不透明设备句柄（驱动侧对象，非本进程堆地址），
// 且所有访问都在 IGCL 的 Mutex 保护下串行进行（两个面板会并发轮询同一个 DLL）。
unsafe impl Send for Igcl {}

static IGCL: OnceLock<Option<Mutex<Igcl>>> = OnceLock::new();

/// 惰性加载 ControlLib.dll 并完成初始化（进程内只尝试一次；失败后不再重试）
fn instance() -> Option<&'static Mutex<Igcl>> {
    IGCL.get_or_init(|| load().map(Mutex::new)).as_ref()
}

fn load() -> Option<Igcl> {
    // 布局自检：Debug 构建（就是 `pnpm tauri dev`）下任何一处错位都会立刻 panic 并说明是哪一条，
    // 而不是静默读到垃圾数之后再让人去猜。Release 构建不含这些检查，零开销。
    debug_assert_eq!(std::mem::size_of::<InitArgs>(), 36, "ctl_init_args_t 应为 36 字节");
    debug_assert_eq!(
        std::mem::size_of::<Telemetry>(),
        TELEMETRY_SIZE,
        "ctl_power_telemetry_t 应为 1136 字节"
    );
    debug_assert_eq!(
        std::mem::size_of::<AdapterProps>(),
        PROPS_SIZE,
        "ctl_device_adapter_properties_t 应为 320 字节"
    );
    debug_assert!(OFF_PROPS_NAME + PROPS_NAME_LEN <= PROPS_SIZE, "name 必须落在结构体内");
    unsafe {
        let lib = open_control_lib()?;
        let init: unsafe extern "C" fn(*mut InitArgs, *mut ApiHandle) -> i32 =
            *lib.get(b"ctlInit\0").ok()?;
        let enumerate: unsafe extern "C" fn(ApiHandle, *mut u32, *mut DevHandle) -> i32 =
            *lib.get(b"ctlEnumerateDevices\0").ok()?;
        let get_props: unsafe extern "C" fn(DevHandle, *mut AdapterProps) -> i32 =
            *lib.get(b"ctlGetDeviceProperties\0").ok()?;
        let telemetry_get: unsafe extern "C" fn(DevHandle, *mut Telemetry) -> i32 =
            *lib.get(b"ctlPowerTelemetryGet\0").ok()?;

        // 先按「走 Level Zero 后端」初始化（本机实测可用）；失败再退回不带该标志。
        // 必须容忍 CTL_RESULT_ALREADY_OPEN：同一 API 被别人先打开也是可用状态。
        let mut api: ApiHandle = std::ptr::null_mut();
        let mut rc = call_init(init, &mut api, CTL_INIT_FLAG_USE_LEVEL_ZERO);
        if !ok(rc) {
            api = std::ptr::null_mut();
            rc = call_init(init, &mut api, 0);
        }
        if !ok(rc) || api.is_null() {
            return None;
        }

        // 枚举要调两次：先取数量，再取数组
        let mut count: u32 = 0;
        if enumerate(api, &mut count, std::ptr::null_mut()) != CTL_RESULT_SUCCESS || count == 0 {
            return None;
        }
        let mut handles: Vec<DevHandle> = vec![std::ptr::null_mut(); count as usize];
        if enumerate(api, &mut count, handles.as_mut_ptr()) != CTL_RESULT_SUCCESS {
            return None;
        }
        handles.truncate(count as usize);

        let mut devices = Vec::new();
        for h in handles {
            if h.is_null() {
                continue;
            }
            let mut props = AdapterProps {
                size: PROPS_SIZE as u32,
                version: PROPS_VERSION,
                rest: [0u8; PROPS_SIZE - 8],
            };
            if get_props(h, &mut props) != CTL_RESULT_SUCCESS {
                continue;
            }
            let name = props_name(&props);
            if !name.is_empty() {
                devices.push((name, h));
            }
        }
        if devices.is_empty() {
            return None;
        }
        Some(Igcl {
            _lib: lib,
            telemetry_get,
            devices,
        })
    }
}

unsafe fn call_init(
    init: unsafe extern "C" fn(*mut InitArgs, *mut ApiHandle) -> i32,
    api: &mut ApiHandle,
    flags: u32,
) -> i32 {
    let mut args = InitArgs {
        size: std::mem::size_of::<InitArgs>() as u32,
        version: 0, // ctlInit 的 InitArgs.Version 实测传 0 即成功
        _pad: [0; 3],
        app_version: CTL_IMPL_VERSION,
        flags,
        supported_version: CTL_IMPL_VERSION,
        app_id: [0; 16],
    };
    init(&mut args, api)
}

/// CTL_RESULT_SUCCESS 或「已被其他进程打开」都算可用
fn ok(rc: i32) -> bool {
    rc == CTL_RESULT_SUCCESS || rc == CTL_RESULT_ALREADY_OPEN
}

/// 载入 ControlLib.dll：先按名字让系统在标准搜索路径里找（System32 在列），
/// 失败再退回绝对路径（少数环境把 System32 从搜索路径剔了）
unsafe fn open_control_lib() -> Option<Library> {
    if let Ok(lib) = Library::new("ControlLib.dll") {
        return Some(lib);
    }
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    Library::new(format!(r"{root}\System32\ControlLib.dll")).ok()
}

/// 从 properties 里读适配器名。
///
/// ⚠ 这里踩过一次坑、已由探针实测纠正：`name` 是 **char[100]（ANSI，100 字节）**，不是 wchar[100]。
///   按 wchar 读会把相邻 ASCII 两两拼成一个 UTF-16 字符，得到 "湉整⡬⥒…" 这种乱码，
///   而按名匹配 NVIDIA/Intel 全靠它 ⇒ 一旦读错，核显的读数会被静默丢弃（幸好探针跑出了乱码）。
fn props_name(p: &AdapterProps) -> String {
    let bytes = &p.rest[OFF_PROPS_NAME - 8..OFF_PROPS_NAME - 8 + PROPS_NAME_LEN];
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).trim().to_string()
}

/// 按 DXGI 显卡名查 IGCL 读数。
/// 匹配策略与 nvml.rs 对齐（从严格到宽松）：逐字 → 不区分大小写 → 只有一台设备且名字含 intel。
pub fn sample_by_name(dxgi_name: &str) -> Option<IgclSample> {
    let m = instance()?;
    let g = m.lock().ok()?;
    let dev = pick_device(&g.devices, dxgi_name)?;
    let mut t = Telemetry {
        size: TELEMETRY_SIZE as u32,
        version: TELEMETRY_VERSION,
        _pad: [0; 3],
        rest: [0u8; TELEMETRY_SIZE - 8],
    };
    let rc = unsafe { (g.telemetry_get)(dev, &mut t) };
    if rc != CTL_RESULT_SUCCESS {
        return None;
    }
    // SAFETY: 缓冲是本地 1136 字节结构体，两个偏移 + 24 字节 item 都落在缓冲内（见模块头注释）
    let (clock, temp) = unsafe {
        let base = (&t as *const Telemetry).cast::<u8>();
        (read_item(base, OFF_CLOCK_ITEM), read_item(base, OFF_TEMP_ITEM))
    };
    Some(IgclSample {
        clock_mhz: clock.map(|v| v.round() as u32),
        temp_c: temp.map(|v| v as f32),
    })
}

/// 读一个 `ctl_oc_telemetry_item_t`：只有 DLL 明确报 bSupported 且值为 DOUBLE 才取。
/// 其他类型不猜（本机实测这几项都是 double；若将来变 int 型，宁可 N/A 也不读错）。
/// 非正数也按取不到处理：0 MHz / 0 °C 没有展示意义，前端会显示「—」。
unsafe fn read_item(base: *const u8, off: usize) -> Option<f64> {
    debug_assert!(off + ITEM_SIZE <= TELEMETRY_SIZE);
    let supported = *base.add(off) != 0;
    if !supported {
        return None;
    }
    let ty = i32::from_le_bytes(*(base.add(off + 8) as *const [u8; 4]));
    if ty != CTL_DATA_TYPE_DOUBLE {
        return None;
    }
    let v = f64::from_le_bytes(*(base.add(off + ITEM_VALUE_OFF) as *const [u8; 8]));
    if v.is_finite() && v > 0.0 {
        Some(v)
    } else {
        None
    }
}

fn pick_device(devices: &[(String, DevHandle)], dxgi_name: &str) -> Option<DevHandle> {
    if let Some((_, d)) = devices.iter().find(|(n, _)| n == dxgi_name) {
        return Some(*d);
    }
    let lower = dxgi_name.to_lowercase();
    if let Some((_, d)) = devices.iter().find(|(n, _)| n.to_lowercase() == lower) {
        return Some(*d);
    }
    // 有些驱动会给 DXGI 名加后缀，名称不再逐字相等
    if devices.len() == 1 && lower.contains("intel") {
        return Some(devices[0].1);
    }
    None
}