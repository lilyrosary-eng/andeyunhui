// ============ CPU 频率 / 功耗 + 磁盘 IO ============
//
// 这三个指标都能从「同一个 PDH 采样」里拿到（见 pdh_util.rs），本模块只负责把原始计数器
// 翻译成有物理意义的量，并处理缺失硬件的降级。
//
// ── CPU 频率 ────────────────────────────────────────────────────────────────
// 公式：有效频率 = (\Processor Information(_Total)\% Processor Performance) / 100 × 标称基频
//
// 标称基频取自 CallNtPowerInformation(ProcessorInformation) 返回的 PROCESSOR_POWER_INFORMATION
// 的 MaxMhz（多路 CPU 取各逻辑处理器最大值）。
//
// 为什么这么绕、不直接读 `\Processor Information(_Total)\Processor Frequency`：
//   本机实测（i9-12900HX，24 逻辑处理器）——
//     · MaxMhz（CallNtPowerInformation）           = 2300（每个核都是）
//     · Processor Frequency（PDH）                 = 1917 → 2091（随负载几乎不动）
//     · % Processor Performance（PDH）             = 99.5 → 132.6（随负载明显变化）
//     · Actual Frequency（PDH，非标准计数器）      = 2300 × (%Perf/100)，实测三次全对得上
//                                                   2467.26/1.0727、3050.27/1.3263、2308.6/1.0033
//                                                   → 商恒为 2300.0
//   ⇒ 真正跟着负载走的是 % Processor Performance，而它的分母就是这个 2300。
//     `Processor Frequency` 那一路读出来恒在 2.0GHz 附近、且与 %Perf 变化不一致，
//     是「当前 P-state 标称值」而非有效频率，**不能**拿来当实时频率。
//   ⇒ 这里不依赖非标准的 `Actual Frequency` 计数器（换机器可能不存在），而是自己乘——
//     用官方 API 拿基频 + 官方计数器拿比例，两者都是标准可移植的。
//
// ── CPU 功耗 ────────────────────────────────────────────────────────────────
// 取 \Energy Meter(*)\Power 里实例名以 `_pkg` 结尾的那些（Intel RAPL 封装域），多路求和。
//   · `_pkg` = 整个封装；`_pp0` 是核心域、`_pp1` 是 GT 域、`_dram` 是内存域 —— 都是子域，
//     单独取任一个都不等于「CPU 功耗」，而 pkg 才是。（本机实测 pp1 只有 0.09–0.14 W。）
//   · 单位是**毫瓦**（本机实测 idle ≈ 11.7–23.5 W、CPU 施压 30% ≈ 29–31 W，
//     与 55W 基础功耗档位吻合；按微瓦解读会得到 0.02 W 这种荒谬值）。
//   · AMD 平台与不暴露 Energy Meter 的机型拿不到 → 返回 None，前端展示 N/A。这是硬限制，
//     不是没实现：Windows 没有覆盖各家的功耗 API。
//
// ── 系统温度（ACPI 热区） ────────────────────────────────────────────────────
// 取 \Thermal Zone Information(*)\Temperature 里各热区的**最高**值，单位是**开尔文**，自行换算 °C。
//   · 为什么不用「CPU 核心温度」：Windows 没有公开的 CPU 核心温度 API（厂商工具走 MSR 或内核
//     驱动），ACPI 热区是唯一**跨厂商、免驱动**的温度源。本机实测 \_tz.tz01 = 314K ≈ 40.9°C
//     （idle 状态合理，与 42°C 的 GPU 温度同量级）。
//   · 代价是口径随 OEM 变：有的机器只暴露一个主板温区、有的暴露 CPU/GPU 多热区、少数机型
//     压根不暴露。故取最高值并在 UI 上标注来源 —— 比挑一个「可能是 CPU」的实例更诚实。
//   · 容错两条：① 个别固件按「十分之一开尔文」上报（读数 >1000 时按 0.1K 处理）；
//     ② 最终只接受 0–150 °C，其余一律 None（宁可 N/A，也不给一个看不出错的假温度）。
//
// ── 磁盘 IO ────────────────────────────────────────────────────────────────
// 按**逻辑磁盘**（卷）取，与界面上「逐个分区一行」的粒度对齐：
//   · 读/写 = \LogicalDisk(<卷>)\Disk Read|Write Bytes/sec（字节/秒）
//   · 活动度 = 100 − \LogicalDisk(<卷>)\% Idle Time（与任务管理器「活动时间」同口径）
//   · 响应时间 = \LogicalDisk(<卷>)\Avg. Disk sec/Transfer × 1000（秒 → 毫秒）
//   · 队列长度 = \LogicalDisk(<卷>)\Current Disk Queue Length（当前排队的请求数）
//   为什么补后两项：活动度只说明「盘在忙」，响应时间与队列才说明「盘是不是已经成瓶颈」
//   （本机实测 C: 响应 2.3ms / 队列 0，空闲状态自洽）。
//   实例名形如 `c:` / `d:` / `harddiskvolume3` / `_total`；调用方按盘符去匹配挂载点。
//   注意：`% Disk Time` 允许 >100%，但 `% Idle Time` 不会，所以活动度走 100−idle 更稳。
//
// ── 页面文件 ────────────────────────────────────────────────────────────────
// 取 \Paging File(_Total)\% Usage。物理内存卡旁边最该有的那个「是不是开始换页了」的指示。
use std::ffi::c_void;
use std::sync::OnceLock;

use libloading::Library;

use crate::pdh_util::Sample;

/// CPU/系统汇总指标（频率 / 功耗 / 温度各自独立降级）
#[derive(Default, Clone, Copy)]
pub struct CpuExtra {
    pub freq_mhz: Option<f32>,
    pub power_w: Option<f32>,
    /// ACPI 热区最高温（°C）；部分机型为主板温区而非 CPU 核心温度
    pub temp_c: Option<f32>,
}

/// 单个卷的实时 IO
pub struct DiskIo {
    /// 计数器实例名（小写），如 `c:`
    pub instance: String,
    pub read_bps: Option<f64>,
    pub write_bps: Option<f64>,
    /// 活动度 %（0–100）
    pub activity: Option<f32>,
    /// 平均响应时间（毫秒）
    pub resp_ms: Option<f32>,
    /// 当前队列长度（排队中的请求数）
    pub queue: Option<f32>,
}

/// 从一轮 PDH 采样里算出 CPU 频率、功耗与系统温度
pub fn cpu_extra(sample: Option<&Sample>) -> CpuExtra {
    CpuExtra {
        freq_mhz: cpu_freq_mhz(sample),
        power_w: cpu_power_w(sample),
        temp_c: system_temp_c(sample),
    }
}

/// ACPI 热区最高温（°C）。取各热区最大值；读数落在「十分之一开尔文」量级时按 0.1K 处理。
/// 只接受 0–150 °C，其余返回 None（详见文件头「系统温度」段）。
pub fn system_temp_c(sample: Option<&Sample>) -> Option<f32> {
    let items = sample?.thermal.as_ref()?;
    let mut best: Option<f32> = None;
    for (_, raw) in items {
        if !raw.is_finite() || *raw <= 0.0 {
            continue;
        }
        // >1000 视为「十分之一开尔文」（如 3140 → 314.0 K）；正常开尔文约 250–450
        let kelvin = if *raw > 1000.0 { *raw / 10.0 } else { *raw };
        let celsius = (kelvin - 273.15) as f32;
        if celsius.is_finite() && (0.0..=150.0).contains(&celsius) {
            best = Some(best.map_or(celsius, |b| b.max(celsius)));
        }
    }
    best
}

/// 有效频率（MHz）= % Processor Performance / 100 × 标称基频
fn cpu_freq_mhz(sample: Option<&Sample>) -> Option<f32> {
    let perf = sample?.cpu_perf_total()?;
    if !perf.is_finite() || perf <= 0.0 {
        return None;
    }
    let base = nominal_mhz()? as f64;
    if base <= 0.0 {
        return None;
    }
    Some(((perf / 100.0) * base) as f32)
}

/// Intel RAPL 封装功耗（瓦）。取实例名以 `_pkg` 结尾者求和（多路 CPU 各有一个封装域）
fn cpu_power_w(sample: Option<&Sample>) -> Option<f32> {
    let items = sample?.cpu_power.as_ref()?;
    let mut sum_mw = 0.0f64;
    let mut found = false;
    for (name, v) in items {
        if name.ends_with("_pkg") && v.is_finite() && *v >= 0.0 {
            sum_mw += *v;
            found = true;
        }
    }
    if found {
        Some((sum_mw / 1000.0) as f32)
    } else {
        None
    }
}

/// 按卷汇总实时 IO；实例名取各计数器实例的并集（某些卷可能只挂了部分计数器）
pub fn disk_io(sample: Option<&Sample>) -> Vec<DiskIo> {
    let Some(s) = sample else {
        return Vec::new();
    };
    let mut names: Vec<String> = Vec::new();
    for slot in [
        &s.disk_read,
        &s.disk_write,
        &s.disk_idle,
        &s.disk_resp,
        &s.disk_queue,
    ] {
        if let Some(items) = slot {
            for (n, _) in items {
                if !names.iter().any(|x| x == n) {
                    names.push(n.clone());
                }
            }
        }
    }
    names.sort();
    names
        .into_iter()
        .map(|n| DiskIo {
            read_bps: Sample::value_of(&s.disk_read, &n).filter(|v| v.is_finite()),
            write_bps: Sample::value_of(&s.disk_write, &n).filter(|v| v.is_finite()),
            // 活动度 = 100 − 空闲时间占比
            activity: Sample::value_of(&s.disk_idle, &n)
                .filter(|v| v.is_finite())
                .map(|idle| (100.0 - idle.clamp(0.0, 100.0)) as f32),
            // 响应时间：秒 → 毫秒（负值/NaN 视为取不到）
            resp_ms: Sample::value_of(&s.disk_resp, &n)
                .filter(|v| v.is_finite() && *v >= 0.0)
                .map(|sec| (sec * 1000.0) as f32),
            queue: Sample::value_of(&s.disk_queue, &n)
                .filter(|v| v.is_finite() && *v >= 0.0)
                .map(|q| q as f32),
            instance: n,
        })
        .collect()
}

/// 页面文件使用率 %（实例 `_total`，超出 0–100 视为异常 → None）
pub fn paging_percent(sample: Option<&Sample>) -> Option<f32> {
    let s = sample?;
    Sample::value_of(&s.paging, "_total")
        .filter(|v| v.is_finite() && (0.0..=100.0).contains(v))
        .map(|v| v as f32)
}

// ----------------- 标称基频（powrprof.dll 运行时加载） -----------------

/// PROCESSOR_POWER_INFORMATION（6 × ULONG = 24 字节）
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct ProcessorPowerInformation {
    number: u32,
    max_mhz: u32,
    current_mhz: u32,
    mhz_limit: u32,
    max_idle_state: u32,
    current_idle_state: u32,
}

/// POWER_INFORMATION_LEVEL::ProcessorInformation
const PROCESSOR_INFORMATION: i32 = 11;
/// 缓冲容量：按 1024 个逻辑处理器给（本机 24），避免超大机型返回 STATUS_BUFFER_TOO_SMALL。
/// 实测 API 对超额缓冲是容忍的：传 256 项（6144 字节）而实际只需 576 字节，返回成功。
const MAX_LOGICAL_CPU: usize = 1024;

/// 标称基频（MHz）：取所有逻辑处理器 MaxMhz 的最大值。
/// 进程内缓存一次（该值在运行期不会变），取不到则为 None（频率降级为 N/A）。
fn nominal_mhz() -> Option<u32> {
    static CACHE: OnceLock<Option<u32>> = OnceLock::new();
    *CACHE.get_or_init(|| unsafe {
        let lib = Library::new("powrprof.dll").ok()?;
        let call: unsafe extern "C" fn(i32, *mut c_void, u32, *mut c_void, u32) -> i32 =
            *lib.get(b"CallNtPowerInformation\0").ok()?;
        // 只复制出函数指针；Library 本体有意泄漏（进程级缓存，无需卸载）——
        // 若在此 drop，FreeLibrary 会让上面的指针立刻悬空。
        std::mem::forget(lib);

        let mut buf = vec![ProcessorPowerInformation::default(); MAX_LOGICAL_CPU];
        let rc = call(
            PROCESSOR_INFORMATION,
            std::ptr::null_mut(),
            0,
            buf.as_mut_ptr().cast(),
            (buf.len() * std::mem::size_of::<ProcessorPowerInformation>()) as u32,
        );
        // NTSTATUS：0 == STATUS_SUCCESS
        if rc != 0 {
            return None;
        }
        buf.iter().map(|p| p.max_mhz).filter(|m| *m > 0).max()
    })
}
