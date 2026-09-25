// ============ PDH 计数器共享底座 ============
//
// 全项目只建**一个** PDH 查询，把资源监视需要的全部计数器挂在同一个 query 上：
//   ① 每轮轮询只需一次 PdhCollectQueryData —— 速率类计数器（Disk Bytes/sec、% Idle Time、
//      Utilization Percentage）靠两次采样之间的时间差算速率，共用同一个 query 才能保证
//      所有速率读数的时间基准完全一致；分成多个 query 会各自预热、各自计时，读数互相错拍。
//   ② 每个计数器路径都有独立句柄，缺哪个都不影响其他（add 失败 → 该槽位为 None）。
//
// 计数器清单（下标即槽位常量，调用方按常量取用）：
//   0  \GPU Engine(*)\Utilization Percentage        —— 每个图形引擎的利用率
//   1  \GPU Adapter Memory(*)\Dedicated Usage       —— 每个适配器的专用显存（全机口径）
//   2  \Energy Meter(*)\Power                       —— Intel RAPL 封装功耗（单位毫瓦）
//   3  \Processor Information(_Total)\% Processor Performance —— 有效频率 = 它 × 标称基频
//   4  \LogicalDisk(*)\Disk Read Bytes/sec
//   5  \LogicalDisk(*)\Disk Write Bytes/sec
//   6  \LogicalDisk(*)\% Idle Time                  —— 活动度 = 100 − 它
//
// 全部路径都挂不上才认为 PDH 整体不可用（session() 返回 None），调用方一律降级为 N/A。
//
// ⚠ 单位说明（本机实测）：`Energy Meter` 的 `Power` 是**毫瓦**。
//    实测 idle ≈ 11700–23500（≈ 11.7–23.5 W）、CPU 施压 30% ≈ 29200–31000（≈ 29–31 W），
//    与 i9-12900HX 55W 基础功耗档位的量级吻合；若按微瓦解读会得到 0.02 W 这种荒谬值。
//
// ⚠ 为什么不用 GetSystemTimes / 自建计时：速率计数器由 PDH 内核侧计时，比自己打时间戳稳。
use std::ptr;
use std::sync::{Mutex, OnceLock};

use windows::core::PCWSTR;
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
    PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
};

/// GPU 引擎利用率（需要按 luid/engtype 自行聚合）
pub const IDX_GPU_ENGINE: usize = 0;
/// 适配器专用显存（全机所有进程合计，按 luid 匹配实例）
pub const IDX_GPU_VRAM: usize = 1;
/// Intel RAPL 封装功耗（毫瓦）
pub const IDX_CPU_POWER: usize = 2;
/// 处理器性能百分比（× 标称基频 = 有效频率）
pub const IDX_CPU_PERF: usize = 3;
/// 逻辑磁盘读取字节/秒
pub const IDX_DISK_READ: usize = 4;
/// 逻辑磁盘写入字节/秒
pub const IDX_DISK_WRITE: usize = 5;
/// 逻辑磁盘空闲时间百分比
pub const IDX_DISK_IDLE: usize = 6;

const SLOT_COUNT: usize = 7;

/// 英文路径常量。PdhAddEnglishCounterW 在中文系统上同样按英文索引，不受界面语言影响。
const PATHS: [&str; SLOT_COUNT] = [
    r"\GPU Engine(*)\Utilization Percentage",
    r"\GPU Adapter Memory(*)\Dedicated Usage",
    r"\Energy Meter(*)\Power",
    r"\Processor Information(_Total)\% Processor Performance",
    r"\LogicalDisk(*)\Disk Read Bytes/sec",
    r"\LogicalDisk(*)\Disk Write Bytes/sec",
    r"\LogicalDisk(*)\% Idle Time",
];

/// 一轮采样结果：每个槽位是该计数器的全部实例（实例名统一已转小写，值为 f64）。
/// 槽位为 None 表示该计数器在本机不可用，调用方应降级展示 N/A。
#[derive(Default)]
pub struct Sample {
    pub gpu_engine: Option<Vec<(String, f64)>>,
    pub gpu_vram: Option<Vec<(String, f64)>>,
    pub cpu_power: Option<Vec<(String, f64)>>,
    pub cpu_perf: Option<Vec<(String, f64)>>,
    pub disk_read: Option<Vec<(String, f64)>>,
    pub disk_write: Option<Vec<(String, f64)>>,
    pub disk_idle: Option<Vec<(String, f64)>>,
}

impl Sample {
    /// 全局 CPU 性能百分比（实例名 `_total`）
    pub fn cpu_perf_total(&self) -> Option<f64> {
        instance_value(&self.cpu_perf, "_total")
    }

    /// 从某一槽位里按实例名精确取值
    pub fn value_of(slot: &Option<Vec<(String, f64)>>, instance: &str) -> Option<f64> {
        instance_value(slot, instance)
    }
}

struct PdhSession {
    query: PDH_HQUERY,
    counters: [Option<PDH_HCOUNTER>; SLOT_COUNT],
}

// PDH_HQUERY / PDH_HCOUNTER 内含 *mut c_void（raw pointer 默认 !Send），
// 会让 OnceLock<...> 无法作为 static（要求 Sync）。
// SAFETY: 这两个句柄是不透明的 PDH 内核句柄（HANDLE 语义，不是内存地址），
// PDH API 自身可从任意线程调用；此处只承诺「句柄可随 Mutex 在线程间移动」，
// 所有实际访问仍严格在 SESSION 的 Mutex 保护下串行进行。
unsafe impl Send for PdhSession {}

impl PdhSession {
    fn open() -> Option<Self> {
        unsafe {
            let mut query = PDH_HQUERY(ptr::null_mut());
            if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != 0 {
                return None;
            }
            let mut counters: [Option<PDH_HCOUNTER>; SLOT_COUNT] = [None; SLOT_COUNT];
            let mut any = false;
            for (i, path) in PATHS.iter().enumerate() {
                counters[i] = add_counter(query, path);
                any |= counters[i].is_some();
            }
            if !any {
                let _ = PdhCloseQuery(query);
                return None;
            }
            // 预热一次：速率类计数器需要两个采样点才有意义。先 collect 建立基线，
            // 使随后第一次读取（约 1s 后）即可拿到有效值，而不是首帧 0 / 空数组。
            let _ = PdhCollectQueryData(query);
            Some(PdhSession { query, counters })
        }
    }

    fn collect(&self) -> bool {
        unsafe { PdhCollectQueryData(self.query) == 0 }
    }
}

static SESSION: OnceLock<Option<Mutex<PdhSession>>> = OnceLock::new();

/// 惰性建立全局 PDH 会话（进程内只建一次，失败后不再重试）
fn session() -> Option<&'static Mutex<PdhSession>> {
    SESSION.get_or_init(|| PdhSession::open().map(Mutex::new)).as_ref()
}

/// 一次采样：内部只调用**一次** PdhCollectQueryData，然后逐个读取需要的槽位。
/// 任一步失败都返回 None；部分槽位失败时该字段为 None、其余字段照常返回。
///
/// 全程持锁：主窗口面板与桌面浮岛会各自独立地每秒调用本命令，Tauri 可能分派到不同线程，
/// 两个线程同时 collect / 读同一个 PDH 查询会互相踩（PDH 未承诺句柄可并发使用）。
/// 串行化后，「一次采样 = 一次 collect + 同批读取」这个不变量在每个调用内都成立。
pub fn sample_all() -> Option<Sample> {
    let m = session()?;
    let s = m.lock().ok()?;
    if !s.collect() {
        return None;
    }
    Some(Sample {
        gpu_engine: s.read(IDX_GPU_ENGINE),
        gpu_vram: s.read(IDX_GPU_VRAM),
        cpu_power: s.read(IDX_CPU_POWER),
        cpu_perf: s.read(IDX_CPU_PERF),
        disk_read: s.read(IDX_DISK_READ),
        disk_write: s.read(IDX_DISK_WRITE),
        disk_idle: s.read(IDX_DISK_IDLE),
    })
}

impl PdhSession {
    /// 读取某个槽位计数器当前的全部实例
    fn read(&self, idx: usize) -> Option<Vec<(String, f64)>> {
        let counter = self.counters.get(idx).copied().flatten()?;
        // SAFETY: counter 来自 PdhAddEnglishCounterW 且挂在未关闭的 query 上
        unsafe { read_counter_array(counter) }
    }
}

/// 向查询添加英文路径计数器；失败返回 None，不影响其他计数器
unsafe fn add_counter(query: PDH_HQUERY, path: &str) -> Option<PDH_HCOUNTER> {
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut c = PDH_HCOUNTER(ptr::null_mut());
    if PdhAddEnglishCounterW(query, PCWSTR(wide.as_ptr()), 0, &mut c) != 0 {
        None
    } else {
        Some(c)
    }
}

/// 按实例名不区分大小写取值
fn instance_value(slot: &Option<Vec<(String, f64)>>, instance: &str) -> Option<f64> {
    let want = instance.to_lowercase();
    slot.as_ref()?.iter().find(|(n, _)| *n == want).map(|(_, v)| *v)
}

/// 读取计数器当前的全部实例，返回（实例名小写，值）。失败/无实例返回 None。
unsafe fn read_counter_array(counter: PDH_HCOUNTER) -> Option<Vec<(String, f64)>> {
    let mut size: u32 = 0;
    let mut count: u32 = 0;
    // 第一次传 None 探明所需缓冲字节数（返回 PDH_MORE_DATA 属正常，不计错）
    let _ = PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, None);
    if size == 0 {
        return None;
    }
    let item_size = std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>().max(1);
    let cap = (size as usize) / item_size;
    if cap == 0 {
        return None;
    }
    let mut buf: Vec<PDH_FMT_COUNTERVALUE_ITEM_W> = Vec::new();
    // PDH_FMT_COUNTERVALUE_ITEM_W 自带 Default（全零），无需手工构造 union 字段
    buf.resize_with(cap, PDH_FMT_COUNTERVALUE_ITEM_W::default);
    // 第二次取真实数组（size 作为 IN 传入缓冲字节数）
    let ret = PdhGetFormattedCounterArrayW(
        counter,
        PDH_FMT_DOUBLE,
        &mut size,
        &mut count,
        Some(buf.as_mut_ptr()),
    );
    if ret != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(count as usize);
    for item in buf.iter().take(count as usize) {
        // CStatus != 0 表示该实例本次采样无效（如速率计数器首个采样点），跳过
        if item.FmtValue.CStatus != 0 {
            continue;
        }
        out.push((
            pwstr_to_string_lower(item.szName),
            item.FmtValue.Anonymous.doubleValue,
        ));
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// PWSTR → 小写 String（PDH 实例名大小写在不同查询路径下不一致，统一小写后比较）
unsafe fn pwstr_to_string_lower(p: windows::core::PWSTR) -> String {
    if p.0.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    while *p.0.add(len) != 0 {
        len += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(p.0, len)).to_lowercase()
}
