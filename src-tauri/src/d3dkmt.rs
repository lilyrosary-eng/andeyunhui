// ============ D3DKMT 兜底（PDH 计数器不可用时）============
//
// 用途：当 PDH 的 `\GPU Engine(*)` / `\GPU Adapter Memory(*)` **在本机不存在**时，用
// `gdi32.dll` 的 `D3DKMTQueryStatistics` 直接取「GPU 引擎累计运行时间」与「显存段用量」，
// 顶上「GPU 利用率 + 专用/共享显存」这两项。
//
// 什么时候会走到这条路（PDH 那些计数器是 Win10 1709 / WDDM 2.x 才有的）：
//   · Windows 7/8.1（WDDM 1.x）—— 这些计数器根本不存在
//   · Windows Server 2016/2019 —— 官方口径要 Server 2022+ 才能在任务管理器看 GPU
//   · 虚拟机（Hyper-V 不直通时以 WDDM 1.x 暴露适配器）
// 这些机器上原本是「一列 N/A」，现在能拿到真值。成熟实现 LibreHardwareMonitor 的
// D3DDisplayDevice 走的也是这条路。
//
// ★ 本机实测（Win11 + Intel UHD + RTX 3080 Ti，与 PDH 同时刻交叉对照，全部实跑确认）：
//   · `sizeof(D3DKMT_QUERYSTATISTICS)` = **808**，与 SDK 的 `C_ASSERT(...==0x328)` 完全吻合
//   · 显存：`BytesResident` 按段求和，**与 PDH 逐字节相等**（RTX ded=235134976、shr=815104，Δ=0；
//     Intel 共享 1319944192 vs PDH 1334755328，差 1.1% 是采样时差）
//   · 利用率：节点 `RunningTime` 是 **100ns 累计值**，差分后 4.35% ≈ PDH 4.41%
//     （若按 SDK 注释里写的"微秒"算会得到 43%，自相矛盾 ⇒ 单位确认为 100ns）
//
// ★ 显存分类规则（实测钉死，**别用 SegmentProperties 位域那条路**）：
//   段的 `Aperture` 字段（+40）== 0 → 专用；== 1 → 共享。
//   实测用位域路线会得 ded=235819008，与 PDH 的 235134976 不符 ⇒ 错的路子。
//
// ⚠ 三个致命偏移（写错不会报错，只会静默读垃圾或返回 0xC000000D）：
//   · `AdapterLuid` 在 **+4** 而不是 +8（LUID 只对齐 4，填充在它之后）
//   · 结果要从 `QueryResult`（绝对 +24）的**起点**按偏移读；`QueryElement`（绝对 +800）填 NodeId/SegmentId
//   · 查询类型用**全局** `ADAPTER=0 / SEGMENT=3 / NODE=5`；`PROCESS_*` 系列（2/4/6）实测全部
//     返回 0xC000000D，即使传真实进程句柄也一样 ⇒ 只做「整卡」口径
//
// ⚠ 无进程归属：拿不到「哪个进程占了多少 GPU」，那是 PDH `GPU Engine(pid_...)` 独有的粒度。
// ⚠ Windows 版本风险：808 字节布局只在 Win11 实测过。老系统上结构体更小，我们传更大的缓冲
//   不会越界，但字段偏移可能不同 ⇒ 一律做「数值合理性过滤」（段数/节点数上限、总量上限），
//   不合理就整体返回 None（宁可 N/A，也不给一个看不出错的假读数）。
use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use libloading::Library;

/// 单个适配器的兜底读数
#[derive(Default, Clone, Copy)]
pub struct Sample {
    /// GPU 利用率 %（整卡口径：所有引擎节点累计运行时间之和的差分）
    pub util_percent: Option<f32>,
    /// 专用显存已用（字节）
    pub dedicated_bytes: Option<u64>,
    /// 共享显存已用（字节）
    pub shared_bytes: Option<u64>,
}

/// 全局适配器 / 段 / 节点三种查询的 Type 值（实测确认）
const QT_ADAPTER: u32 = 0;
const QT_SEGMENT: u32 = 3;
const QT_NODE: u32 = 5;

/// `QueryResult` 起点的偏移（相对绝对 +24）
const OFF_ADAPTER_NB_SEGMENTS: usize = 0;
const OFF_ADAPTER_NODE_COUNT: usize = 4;
/// 段：BytesResident(u64)@16、Aperture(u32)@40
const OFF_SEG_BYTES_RESIDENT: usize = 16;
const OFF_SEG_APERTURE: usize = 40;
/// 节点：GlobalInformation.RunningTime(i64)@0（单位 100ns）
const OFF_NODE_RUNNING_TIME: usize = 0;

/// 合理性上限：段数 / 节点数超过这个值说明布局对不上（老系统的偏移差异），直接判不可用
const MAX_SEGMENTS: u32 = 64;
const MAX_NODES: u32 = 64;
/// 单个适配器显存总量上限（1 TB）：超过即视为读到了垃圾
const MAX_BYTES: u64 = 1u64 << 40;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Luid {
    low: u32,
    high: i32,
}

/// D3DKMT_QUERYSTATISTICS（808 字节，实测与 SDK 的 C_ASSERT 一致）
#[repr(C)]
struct QueryStatistics {
    ty: u32,                  // +0
    adapter_luid: Luid,       // +4（注意：不是 +8）
    h_process: *mut c_void,   // +16（12..16 为隐式填充）
    query_result: [u8; 776],  // +24
    query_element: [u8; 8],   // +800
}

#[repr(C)]
struct OpenAdapterFromLuid {
    adapter_luid: Luid,
    h_adapter: u32,
}

#[repr(C)]
struct CloseAdapter {
    h_adapter: u32,
}

struct Gdi {
    _lib: Library,
    open: unsafe extern "system" fn(*mut OpenAdapterFromLuid) -> i32,
    query: unsafe extern "system" fn(*mut QueryStatistics) -> i32,
    close: unsafe extern "system" fn(*mut CloseAdapter) -> i32,
}

// SAFETY: 只存放 gdi32 的函数指针（函数指针天然 Send）；所有调用都无共享可变状态。
unsafe impl Send for Gdi {}
unsafe impl Sync for Gdi {}

static GDI: OnceLock<Option<Gdi>> = OnceLock::new();
/// 每个适配器上一拍的「节点累计运行时间之和」+ 时刻，用于算利用率
static PREV: OnceLock<Mutex<HashMap<u64, (f64, Instant)>>> = OnceLock::new();

fn gdi() -> Option<&'static Gdi> {
    GDI.get_or_init(|| unsafe {
        let lib = Library::new("gdi32.dll").ok()?;
        let open = *lib.get(b"D3DKMTOpenAdapterFromLuid\0").ok()?;
        let query = *lib.get(b"D3DKMTQueryStatistics\0").ok()?;
        let close = *lib.get(b"D3DKMTCloseAdapter\0").ok()?;
        Some(Gdi {
            _lib: lib,
            open,
            query,
            close,
        })
    })
    .as_ref()
}

/// 取一个适配器的兜底读数；任何一步失败都返回 None（调用方保持 N/A）。
/// `low`/`high` 是 DXGI 的 `AdapterLuid.LowPart` / `HighPart`。
pub fn sample(low: u32, high: i32) -> Option<Sample> {
    let g = gdi()?;
    unsafe {
        let mut open = OpenAdapterFromLuid {
            adapter_luid: Luid { low, high },
            h_adapter: 0,
        };
        if (g.open)(&mut open) != 0 || open.h_adapter == 0 {
            return None;
        }
        let h = open.h_adapter;
        let out = collect(g, h, low, high);
        // 无论成功与否都要收起句柄，避免每次轮询泄漏一个内核对象
        let mut close = CloseAdapter { h_adapter: h };
        let _ = (g.close)(&mut close);
        out
    }
}

unsafe fn collect(g: &Gdi, h: u32, low: u32, high: i32) -> Option<Sample> {
    // ① 适配器：拿段数与节点数
    let mut q = QueryStatistics {
        ty: QT_ADAPTER,
        adapter_luid: Luid { low, high },
        h_process: std::ptr::null_mut(),
        query_result: [0u8; 776],
        query_element: [0u8; 8],
    };
    if (g.query)(&mut q) != 0 {
        return None;
    }
    let res = q.query_result.as_ptr();
    let nb_segments = u32_at(res, OFF_ADAPTER_NB_SEGMENTS);
    let node_count = u32_at(res, OFF_ADAPTER_NODE_COUNT);
    if nb_segments == 0 || nb_segments > MAX_SEGMENTS || node_count == 0 || node_count > MAX_NODES {
        return None;
    }

    // ② 各节点累计运行时间求和（100ns 累计值）
    let mut run_sum: f64 = 0.0;
    for node in 0..node_count {
        let mut q = node_query(low, high, node);
        if (g.query)(&mut q) != 0 {
            continue;
        }
        let rt = i64_at(q.query_result.as_ptr(), OFF_NODE_RUNNING_TIME);
        if rt > 0 {
            run_sum += rt as f64;
        }
    }

    // ③ 各段已驻留字节按 Aperture 分到「专用 / 共享」
    let mut dedicated: u64 = 0;
    let mut shared: u64 = 0;
    let mut seg_ok = 0u32;
    for seg in 0..nb_segments {
        let mut q = segment_query(low, high, seg);
        if (g.query)(&mut q) != 0 {
            continue;
        }
        let res = q.query_result.as_ptr();
        let resident = u64_at(res, OFF_SEG_BYTES_RESIDENT);
        if u32_at(res, OFF_SEG_APERTURE) == 1 {
            shared = shared.saturating_add(resident);
        } else {
            dedicated = dedicated.saturating_add(resident);
        }
        seg_ok += 1;
    }
    if dedicated > MAX_BYTES || shared > MAX_BYTES {
        return None;
    }

    // ④ 利用率：与上一拍差分（首拍只记录基线，返回 0 而不是把累计值当速率）
    let util_percent = upd_util(low, high, run_sum);

    let sample = Sample {
        util_percent,
        dedicated_bytes: if seg_ok > 0 { Some(dedicated) } else { None },
        shared_bytes: if seg_ok > 0 { Some(shared) } else { None },
    };
    // 只在**首次**真正兜底成功时打一条日志：真机上遇到「GPU 一列 N/A」时，先看有没有这一行
    // 就能区分「这条路没走通」还是「走了但被合理性过滤挡下」。
    static LOGGED: OnceLock<()> = OnceLock::new();
    if LOGGED.set(()).is_ok() {
        log::info!(
            "[RES] D3DKMT 兜底生效: luid_low=0x{low:08x} 节点数={node_count} 段数={nb_segments} \
             利用率={:?}% 专用={:?}B 共享={:?}B（PDH 计数器在本机不可用时才会走到这里）",
            sample.util_percent,
            sample.dedicated_bytes,
            sample.shared_bytes
        );
    }
    Some(sample)
}

/// 更新并计算利用率：`Δ累计运行时间 / (dt × 1e7) × 100`（1 秒 = 1e7 个 100ns tick）
fn upd_util(low: u32, high: i32, run_sum: f64) -> Option<f32> {
    let key = ((high as u32 as u64) << 32) | low as u64;
    let m = PREV.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = m.lock().ok()?;
    let now = Instant::now();
    let prev = map.insert(key, (run_sum, now));
    let (prev_sum, prev_at) = prev?;
    let dt = now.duration_since(prev_at).as_secs_f64();
    if dt <= 0.0 {
        return None;
    }
    // 实测混合本上独显节点计数可能「冻结」（Δ=0），此处不特殊处理：那本来就是 0% 的意思
    let delta = run_sum - prev_sum;
    if !delta.is_finite() || delta < 0.0 {
        return None;
    }
    Some(((delta / (dt * 1e7)) * 100.0).clamp(0.0, 100.0) as f32)
}

unsafe fn node_query(low: u32, high: i32, node: u32) -> QueryStatistics {
    let mut q = QueryStatistics {
        ty: QT_NODE,
        adapter_luid: Luid { low, high },
        h_process: std::ptr::null_mut(),
        query_result: [0u8; 776],
        query_element: [0u8; 8],
    };
    // QueryElement 的首个 u32 即 NodeId
    q.query_element[..4].copy_from_slice(&node.to_le_bytes());
    q
}

unsafe fn segment_query(low: u32, high: i32, seg: u32) -> QueryStatistics {
    let mut q = QueryStatistics {
        ty: QT_SEGMENT,
        adapter_luid: Luid { low, high },
        h_process: std::ptr::null_mut(),
        query_result: [0u8; 776],
        query_element: [0u8; 8],
    };
    // 同一个 union：SEGMENT 类型下首个 u32 即 SegmentId
    q.query_element[..4].copy_from_slice(&seg.to_le_bytes());
    q
}

// 结果缓冲区按字节偏移读：一律 read_unaligned，避免依赖缓冲区的对齐（它来自栈上的 [u8; 776]）
unsafe fn u32_at(p: *const u8, off: usize) -> u32 {
    std::ptr::read_unaligned(p.add(off) as *const u32)
}

unsafe fn u64_at(p: *const u8, off: usize) -> u64 {
    std::ptr::read_unaligned(p.add(off) as *const u64)
}

unsafe fn i64_at(p: *const u8, off: usize) -> i64 {
    std::ptr::read_unaligned(p.add(off) as *const i64)
}