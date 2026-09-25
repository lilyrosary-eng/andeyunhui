// ============ Windows 原生 GPU / 显存采集 ============
// 口径与 Windows 任务管理器对齐（依据微软 DirectX 官方 DevBlog「GPUs in the task manager」）：
//
// · GPU 利用率：PDH「\GPU Engine(*)\Utilization Percentage」，取**最忙的那个引擎实例**。
//   官方原文："we opted to pick the percentage utilization of the busiest engine as a
//   representative of the overall GPU usage"，且明确否定了「跨引擎求平均」
//   （10 个引擎里跑满 1 个 → 平均只有 10%，严重偏低）。
//   故此处取 max，**不是** sum（sum 会随引擎实例增多而虚高）。
//
// · 显存（VRAM）已用：PDH「\GPU Adapter Memory(<luid>)\Dedicated Usage」，按主适配器的
//   LUID 精确匹配实例。官方原文：performance 页的专用显存 "represents the number of
//   bytes currently consumed across all processes"（全机所有进程合计）。
//   ⚠ 不要用 IDXGIAdapter3::QueryVideoMemoryInfo().CurrentUsage —— 官方定义是
//   "the application's current video memory usage"，只反映**本进程**占用，
//   拿它当「显存占用」会严重偏小（实测本机该路径读出的量级与整卡占用差几个数量级）。
//   这里只借 DXGI 取显卡名 / 物理显存容量 / LUID。
//
// · 显存总量：DXGI DXGI_ADAPTER_DESC1::DedicatedVideoMemory（该适配器物理显存容量）。
//
// 任何一步失败都返回 None，由调用方优雅降级为「N/A」。
use std::ptr;
use std::sync::{Mutex, OnceLock};

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE,
};
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
    PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
};

/// GPU 采集结果；任一项取不到为 None（前端显示 N/A）
#[derive(Default)]
pub struct GpuInfo {
    /// GPU 利用率 %（最忙引擎）
    pub util_percent: Option<f32>,
    /// 显卡名
    pub name: Option<String>,
    /// 显存总量（字节，物理显存容量）
    pub vram_total: Option<u64>,
    /// 显存已用（字节，全机所有进程合计）
    pub vram_used: Option<u64>,
}

/// 引擎利用率计数器路径（英文路径；PdhAddEnglishCounterW 在中文系统上同样可用）
const ENGINE_COUNTER: &str = r"\GPU Engine(*)\Utilization Percentage";
/// 适配器专用显存计数器路径（全机口径）
const VRAM_COUNTER: &str = r"\GPU Adapter Memory(*)\Dedicated Usage";

/// 一次性采集 GPU 利用率 + 显存 + 显卡名/容量。
/// 内部只做**一次** PdhCollectQueryData：速率计数器（利用率）要求两次采样之间有时长间隔，
/// 同一轮里重复 collect 会把间隔压到 ~0，导致读数失真。
pub fn query_gpu() -> GpuInfo {
    let primary = primary_adapter();
    let name = primary.as_ref().and_then(|a| a.name.clone());
    let vram_total = primary.as_ref().and_then(|a| a.vram_total);
    let luid_prefix = primary.as_ref().and_then(|a| a.luid_prefix.clone());

    let (util_percent, vram_used) = sample_pdh(luid_prefix.as_deref());
    GpuInfo {
        util_percent,
        name,
        vram_total,
        vram_used,
    }
}

// ----------------- DXGI：主适配器（名称 / 容量 / LUID） -----------------

struct PrimaryAdapter {
    name: Option<String>,
    /// 物理显存容量（字节）
    vram_total: Option<u64>,
    /// PDH 实例名前缀，形如 `luid_0x00000000_0x00013e32_`（小写）
    luid_prefix: Option<String>,
}

/// 选「主适配器」：排除软件适配器（WARP / Basic Render，Flags 含 DXGI_ADAPTER_FLAG_SOFTWARE）
/// 后取 DedicatedVideoMemory 最大的一块 —— 独显的该值远大于核显共享内存，故等价于选独显。
fn primary_adapter() -> Option<PrimaryAdapter> {
    unsafe {
        // CreateDXGIFactory1 是泛型 fn（T: Interface），必须显式标注目标接口类型
        let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
        let mut best: Option<(usize, PrimaryAdapter)> = None;
        let mut i = 0u32;
        while let Ok(adapter) = factory.EnumAdapters1(i) {
            i += 1;
            // 用 GetDesc1 而非 GetDesc：只有 DXGI_ADAPTER_DESC1 带 Flags，才能识别软件适配器
            let Ok(desc) = adapter.GetDesc1() else {
                continue;
            };
            if desc.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0 {
                continue;
            }
            let name = decode_wide(&desc.Description);
            let dedicated = desc.DedicatedVideoMemory;
            let luid_prefix = format!(
                "luid_0x{:08x}_0x{:08x}_",
                desc.AdapterLuid.HighPart as u32, desc.AdapterLuid.LowPart
            );
            let cand = PrimaryAdapter {
                name: if name.is_empty() { None } else { Some(name) },
                vram_total: if dedicated > 0 {
                    Some(dedicated as u64)
                } else {
                    None
                },
                luid_prefix: Some(luid_prefix),
            };
            if best.as_ref().map(|(s, _)| dedicated > *s).unwrap_or(true) {
                best = Some((dedicated, cand));
            }
        }
        best.map(|(_, a)| a)
    }
}

/// 定长 WCHAR 数组 → String（截到首个 NUL，并去掉首尾空白）
fn decode_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end]).trim().to_string()
}

// ----------------- PDH：利用率 + 专用显存 -----------------

#[derive(Clone, Copy)]
struct GpuPdh {
    query: PDH_HQUERY,
    /// 引擎利用率计数器；`\GPU Engine(*)` 不可用时为 None
    engine: Option<PDH_HCOUNTER>,
    /// 专用显存计数器；`\GPU Adapter Memory(*)` 不可用时为 None
    vram: Option<PDH_HCOUNTER>,
}

// PDH_HQUERY / PDH_HCOUNTER 内含 *mut c_void（raw pointer 默认 !Send），
// 会让 OnceLock<Mutex<Option<GpuPdh>>> 无法作为 static（要求 Sync）。
// SAFETY: 这两个句柄是不透明的 PDH 内核句柄（HANDLE 语义，非内存地址），
// PDH API 自身可从任意线程调用；此处只承诺「句柄可随 Mutex 在线程间移动」，
// 所有访问仍严格在 GPU_PDH 的 Mutex 保护下串行进行。
unsafe impl Send for GpuPdh {}

static GPU_PDH: OnceLock<Mutex<Option<GpuPdh>>> = OnceLock::new();

/// 惰性建立 PDH 查询与计数器（失败返回 None，调用方降级为 N/A）
fn gpu_pdh_handle() -> Option<GpuPdh> {
    let cell = GPU_PDH.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().ok()?;
    if let Some(h) = *guard {
        return Some(h);
    }
    unsafe {
        let mut query = PDH_HQUERY(ptr::null_mut());
        if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != 0 {
            return None;
        }
        let engine = add_counter(query, ENGINE_COUNTER);
        let vram = add_counter(query, VRAM_COUNTER);
        // 两个计数器都挂不上才认为 PDH 路径整体不可用
        if engine.is_none() && vram.is_none() {
            let _ = PdhCloseQuery(query);
            return None;
        }
        // 预热一次：Utilization Percentage 是速率计数器，需要两个采样点才有意义。
        // 先 collect 建立基线，使随后第一次读取（约 1s 后）即可拿到有效值而非首帧 0。
        let _ = PdhCollectQueryData(query);
        let h = GpuPdh { query, engine, vram };
        *guard = Some(h);
        Some(h)
    }
}

/// 向查询添加英文路径计数器；单个计数器失败返回 None，不影响另一个
unsafe fn add_counter(query: PDH_HQUERY, path: &str) -> Option<PDH_HCOUNTER> {
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut c = PDH_HCOUNTER(ptr::null_mut());
    if PdhAddEnglishCounterW(query, PCWSTR(wide.as_ptr()), 0, &mut c) != 0 {
        None
    } else {
        Some(c)
    }
}

/// 单次采样：返回（GPU 利用率 %，显存已用字节）。
/// 两者共用同一次 PdhCollectQueryData，保证速率计数器的时间间隔正确。
fn sample_pdh(luid_prefix: Option<&str>) -> (Option<f32>, Option<u64>) {
    let Some(h) = gpu_pdh_handle() else {
        return (None, None);
    };
    unsafe {
        if PdhCollectQueryData(h.query) != 0 {
            return (None, None);
        }
        let util = h
            .engine
            .and_then(|c| read_counter_array(c))
            .and_then(|items| busiest(items));
        let vram = match (h.vram, luid_prefix) {
            (Some(c), Some(prefix)) => {
                read_counter_array(c).and_then(|items| matching_instance(items, prefix))
            }
            _ => None,
        };
        (util, vram)
    }
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

/// 取「最忙引擎」的利用率（与任务管理器口径一致），并夹到 0..=100
fn busiest(items: Vec<(String, f64)>) -> Option<f32> {
    let max = items
        .iter()
        .map(|(_, v)| *v)
        .filter(|v| v.is_finite())
        .fold(f64::NEG_INFINITY, f64::max);
    if max.is_finite() {
        Some(max.clamp(0.0, 100.0) as f32)
    } else {
        None
    }
}

/// 按 LUID 前缀匹配适配器实例，取专用显存字节数
fn matching_instance(items: Vec<(String, f64)>, luid_prefix: &str) -> Option<u64> {
    let prefix = luid_prefix.to_lowercase();
    items
        .into_iter()
        .find(|(n, _)| n.starts_with(&prefix))
        .map(|(_, v)| v.max(0.0) as u64)
}

/// PWSTR → 小写 String（PDH 实例名大小写在不同查询路径下不一致，统一小写后比较）
unsafe fn pwstr_to_string_lower(p: PWSTR) -> String {
    if p.0.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    while *p.0.add(len) != 0 {
        len += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(p.0, len)).to_lowercase()
}
