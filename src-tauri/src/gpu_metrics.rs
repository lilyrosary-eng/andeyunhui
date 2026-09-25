// ============ Windows 原生多显卡采集（利用率 / 显存 / 频率 / 功耗）============
//
// 口径与 Windows 任务管理器对齐（依据微软 DirectX 官方 DevBlog「GPUs in the task manager」）：
//
// · GPU 利用率：PDH「\GPU Engine(*)\Utilization Percentage」取**最忙的那个引擎实例**。
//   官方原文："we opted to pick the percentage utilization of the busiest engine as a
//   representative of the overall GPU usage"，且明确否定了「跨引擎求平均」
//   （10 个引擎里跑满 1 个 → 平均只有 10%，严重偏低）。
//   ⇒ 取 max，**不是** sum（sum 会随引擎实例增多而虚高）。
//
//   ⚠⚠ 关键修复（上一版的 bug）：**必须先按适配器 LUID 分组，再在各组内取 max**。
//   上一版直接对全机所有引擎实例取 max，而引擎实例名里带 luid —— 于是核显负责桌面合成时
//   它的 3D 引擎最忙，读出来的「GPU 占用」实际是**核显**的，独显的读数被完全掩盖。
//   这正是用户反馈的「gpu 占用连到了我的核显」。现在每个适配器独立聚合。
//
// · 显存（VRAM）已用：PDH「\GPU Adapter Memory(<luid>)\Dedicated Usage」，按适配器 LUID
//   精确匹配实例。官方原文：性能页的专用显存 "represents the number of bytes currently
//   consumed across all processes"（全机所有进程合计）。
//   ⚠ 不要用 IDXGIAdapter3::QueryVideoMemoryInfo().CurrentUsage —— 官方定义是
//   "the application's current video memory usage"，只反映**本进程**占用。
//
// · 共享显存已用：同计数器集的「\GPU Adapter Memory(<luid>)\Shared Usage」（系统内存划给 GPU 的部分）。
//   为什么必须补它：核显的**专用**显存恒为 0（或 128MB 划拨量），只看专用字段会显示成
//   「0 / 128MB」像坏了一样；而核显实际用的是共享内存（本机实测核显 Shared=1.19GB、独显 0.78MB）。
//   与任务管理器「共享 GPU 内存」同口径 —— 专用 + 共享两行才是完整图景。
//
// · 逐引擎利用率：同一份采样里按实例名的 `_engtype_` 标记再拆出 3D / VideoDecode /
//   VideoEncode / Copy 四类（每类取最忙实例）。`util_percent` 仍是「全适配器最忙引擎」
//   （与任务管理器总口径一致，不拆），拆分是**追加**信息。
//   本机实测引擎类型共 10 种：3d / copy / gdi render / legacyoverlay / ofa_0 / security /
//   videodecode / videoencode / videoprocessing / vr，其中还有 `engtype_` 空值的引擎
//   ⇒ 解析必须容忍空值与非固定长度类型名（见 `engtype_of`）。
//   对本项目最有用的是 videodecode / videoencode：录屏与转码到底走没走硬件编解码，一眼可辨。
//
// · 温度：仅 NVIDIA 能取（NVML，见 nvml.rs）。Intel 核显无公开消费级 API、
//   AMD 需另接 ADL/ADLX，二者一律降级为 None（前端展示 N/A）。
// · 显存总量：DXGI DXGI_ADAPTER_DESC1::DedicatedVideoMemory（该适配器物理显存容量）。
//   与任务管理器「专用 GPU 内存」口径一致（核显在这里通常只有 128MB 的划拨量，
//   共享内存不计入）。
//
// · 频率 / 功耗：仅 NVIDIA 能取（走 NVML，见 nvml.rs）。Intel 核显无公开消费级 API、
//   AMD 需另接 ADL/ADLX，二者一律降级为 None（前端展示 N/A）。
//
// 任何一步失败都返回 None / 空值，由调用方优雅降级为「N/A」。
use serde::Serialize;
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE,
};

use crate::nvml;
use crate::pdh_util::Sample;

/// 单块显卡的采集结果；任一项取不到为 None（前端显示 N/A）
#[derive(Serialize, Clone)]
pub struct GpuUsage {
    /// 稳定标识，前端用它持久化「要监视哪几块卡」。形如 `NVIDIA GeForce ...#0`。
    ///
    /// ⚠ **故意不用 DXGI LUID 当这个键**：LUID 只保证「系统运行期间唯一」，重启后会被重新
    ///   分配 —— 拿它存选择会导致用户每次开机都得重选一遍。显卡名虽然理论上可能重复
    ///   （同型号双卡），但配一个「同名序号」后缀就足够区分，且跨重启稳定。
    pub id: String,
    /// 显卡名（DXGI_ADAPTER_DESC1.Description）
    pub name: String,
    /// GPU 利用率 %（该适配器最忙引擎）
    pub util_percent: Option<f32>,
    /// 显存总量（KB，物理显存容量）
    pub vram_total_kb: Option<u64>,
    /// 显存已用（KB，全机所有进程合计）
    pub vram_used_kb: Option<u64>,
    /// 共享显存已用（KB，系统内存划给 GPU 的部分；核显主要吃这块）
    pub vram_shared_kb: Option<u64>,
    /// 3D 引擎利用率 %（该适配器内最忙的 3D 实例）
    pub util_3d: Option<f32>,
    /// 视频解码引擎利用率 %（VideoDecode；硬解是否生效看它）
    pub util_video_decode: Option<f32>,
    /// 视频编码引擎利用率 %（VideoEncode；硬编是否生效看它）
    pub util_video_encode: Option<f32>,
    /// 拷贝引擎利用率 %（Copy）
    pub util_copy: Option<f32>,
    /// 图形时钟（MHz，仅 NVIDIA）
    pub clock_mhz: Option<u32>,
    /// 核心温度（°C，仅 NVIDIA）
    pub temp_c: Option<u32>,
    /// 整卡功耗（W，仅 NVIDIA）
    pub power_w: Option<f32>,
}

/// 枚举本机所有硬件适配器，并合并 PDH / NVML 读数。
/// 返回顺序：独占显存大的在前（独显优先，便于前端把「GPU1」自然落在独显上）。
pub fn query_gpus(sample: Option<&Sample>) -> Vec<GpuUsage> {
    let mut list = dedup_adapters(enumerate_adapters(), sample);    // 独占显存降序；显存相同（如都是 0）时按名称升序，保证展示顺序稳定
    list.sort_by(|a, b| {
        b.vram_total
            .unwrap_or(0)
            .cmp(&a.vram_total.unwrap_or(0))
            .then_with(|| a.name.cmp(&b.name))
    });
    // 同名适配器（同型号双卡）用「#序号」区分，保证 id 唯一且跨重启稳定
    let mut name_seen: Vec<(String, usize)> = Vec::new();
    list.into_iter()
        .map(|a| {
            let id = match name_seen.iter_mut().find(|(n, _)| *n == a.name) {
                Some((_, c)) => {
                    *c += 1;
                    format!("{}#{}", a.name, *c)
                }
                None => {
                    name_seen.push((a.name.clone(), 0));
                    format!("{}#0", a.name)
                }
            };
            // PDH 实例名前缀（含结尾下划线，避免前缀误伤别的 luid）
            let key = format!("{}_", a.luid);
            // 引擎实例只取一次：下面「全适配器最忙引擎」与「逐引擎拆分」共用这份切片，
            // 保证两者读数来自同一次采样（否则两条曲线会互相错拍）。
            let engines = sample.and_then(|s| s.gpu_engine.as_deref());
            let util = engines.and_then(|items| busiest_engine_for(items, &key));
            let util_of = |t: &str| engines.and_then(|items| engine_util_for(items, &key, t));
            let vram_used = sample
                .and_then(|s| s.gpu_vram.as_deref())
                .map(|items| adapter_usage_for(items, &key));
            // 共享显存：核显的专用显存恒为 0，只有这一项能反映它真实吃了多少内存
            let vram_shared = sample
                .and_then(|s| s.gpu_vram_shared.as_deref())
                .map(|items| adapter_usage_for(items, &key));
            let nv = nvml::sample_by_name(&a.name);
            GpuUsage {
                id,
                name: a.name,
                util_percent: util,
                vram_total_kb: a.vram_total.map(|b| b / 1024),
                vram_used_kb: vram_used.map(|b| b / 1024),
                vram_shared_kb: vram_shared.map(|b| b / 1024),
                util_3d: util_of("3d"),
                util_video_decode: util_of("videodecode"),
                util_video_encode: util_of("videoencode"),
                util_copy: util_of("copy"),
                clock_mhz: nv.and_then(|n| n.clock_mhz),
                temp_c: nv.and_then(|n| n.temp_c),
                power_w: nv.and_then(|n| n.power_w),
            }
        })
        .collect()
}

/// 去掉 DXGI 重复枚举出来的「影子」适配器。
///
/// 本机实测：DXGI 把同一块 Intel UHD Graphics 枚举了 **3 次**（LUID 各不相同：
/// 0x00013e32 / 0x000ab8e7 / 0x0001d30c，DedicatedVideoMemory 都是 128MB），
/// 但 `\GPU Engine` 与 `\GPU Adapter Memory` 只对其中 **1 个** LUID 存在实例 ——
/// 另外两个拿不到任何读数，界面上只会多出两行全是「—」的噪音。
///
/// 判据刻意做得很窄，避免误删真双卡：
///   · 只有 (名称, VendorId, DeviceId, SubSysId, Revision) **完全一致**的条目才进候选；
///   · 候选内**只有**当一方完全没有 PDH 实例（= 影子）时才丢弃它；
///   · 两台同型号真机同时在线时双方都有自己的 PDH 实例 ⇒ 一条都不丢。
fn dedup_adapters(list: Vec<AdapterDesc>, sample: Option<&Sample>) -> Vec<AdapterDesc> {
    let mut kept: Vec<AdapterDesc> = Vec::new();
    for a in list {
        let a_has = has_pdh_presence(sample, &format!("{}_", a.luid));
        let twin = kept
            .iter()
            .position(|b| b.name == a.name && b.identity == a.identity);
        match twin {
            None => kept.push(a),
            Some(pos) => {
                let b_has = has_pdh_presence(sample, &format!("{}_", kept[pos].luid));
                match (b_has, a_has) {
                    // 老的是影子、新的是真身 → 用新的替换
                    (false, true) => kept[pos] = a,
                    // 新的是影子 → 丢弃（老的无论真假都留着）
                    (true, false) | (false, false) => {}
                    // 双方都是真身 → 真双卡，保留
                    (true, true) => kept.push(a),
                }
            }
        }
    }
    kept
}

/// 该适配器在 PDH 里是否有实例（引擎实例名含该 LUID，或显存计数器实例名以该 LUID 开头）
fn has_pdh_presence(sample: Option<&Sample>, luid_key: &str) -> bool {
    let Some(s) = sample else { return false };
    if let Some(items) = s.gpu_engine.as_ref() {
        if items.iter().any(|(n, _)| n.contains(luid_key)) {
            return true;
        }
    }
    if let Some(items) = s.gpu_vram.as_ref() {
        if items.iter().any(|(n, _)| n.starts_with(luid_key)) {
            return true;
        }
    }
    false
}

// ----------------- DXGI：枚举全部硬件适配器 -----------------

struct AdapterDesc {
    /// PDH 实例名前缀（去掉结尾下划线），形如 `luid_0x00000000_0x00013e32`
    luid: String,
    name: String,
    /// 物理显存容量（字节）
    vram_total: Option<u64>,
    /// (VendorId, DeviceId, SubSysId, Revision)：用来识别「同一块物理设备被枚举多次」
    identity: (u32, u32, u32, u32),
}

/// 枚举 DGXI 适配器，排除软件适配器（WARP / Basic Render）。
/// 虚拟显示适配器（如模拟器的 IDD 驱动）不在 DXGI 的 SOFTWARE 标记内，会照常列出，
/// 由前端选择器决定是否展示 —— 不做名称猜测式的硬过滤。
fn enumerate_adapters() -> Vec<AdapterDesc> {
    let mut out = Vec::new();
    unsafe {
        // CreateDXGIFactory1 是泛型 fn（T: Interface），必须显式标注目标接口类型
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else {
            return out;
        };
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
            out.push(AdapterDesc {
                // 与 PDH 实例名前缀逐字对齐：luid_0x{HighPart:08x}_0x{LowPart:08x}_（全小写）
                luid: format!(
                    "luid_0x{:08x}_0x{:08x}",
                    desc.AdapterLuid.HighPart as u32, desc.AdapterLuid.LowPart
                ),
                name: if name.is_empty() {
                    format!("GPU {}", i)
                } else {
                    name
                },
                vram_total: if dedicated > 0 {
                    Some(dedicated as u64)
                } else {
                    None
                },
                identity: (desc.VendorId, desc.DeviceId, desc.SubSysId, desc.Revision),
            });
        }
    }
    out
}

/// 定长 WCHAR 数组 → String（截到首个 NUL，并去掉首尾空白）
fn decode_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end]).trim().to_string()
}

// ----------------- PDH 实例聚合 -----------------

/// 取「指定适配器内最忙引擎」的利用率（与任务管理器口径一致），并夹到 0..=100。
/// `luid_key` 形如 `luid_0x00000000_0x00013e32_`（含结尾下划线，避免前缀误伤）。
fn busiest_engine_for(items: &[(String, f64)], luid_key: &str) -> Option<f32> {
    max_util(items.iter().filter(|(n, _)| n.contains(luid_key)))
}

/// 取「指定适配器内某一类引擎」的利用率（同类可能有多个实例，取最忙的那个）。
/// `engtype` 用小写类型名，取值见文件头（`3d` / `videodecode` / `videoencode` / `copy`…）。
fn engine_util_for(items: &[(String, f64)], luid_key: &str, engtype: &str) -> Option<f32> {
    max_util(
        items
            .iter()
            .filter(|(n, _)| n.contains(luid_key) && engtype_of(n) == Some(engtype)),
    )
}

/// 一组引擎实例里取最大利用率；全为 NaN/非有限值时返回 None（宁可 N/A 也不要伪 0）
fn max_util<'a>(iter: impl Iterator<Item = &'a (String, f64)>) -> Option<f32> {
    let max = iter
        .map(|(_, v)| *v)
        .filter(|v| v.is_finite())
        .fold(f64::NEG_INFINITY, f64::max);
    if max.is_finite() {
        Some(max.clamp(0.0, 100.0) as f32)
    } else {
        None
    }
}

/// 从 PDH 引擎实例名里取出引擎类型标记。
///
/// 实例名形如 `pid_10964_luid_0x00000000_0x00013e32_phys_0_eng_0_engtype_3d`（已转小写），
/// 标记位于**末尾**。本机实测两类边界必须容忍：
///   · `..._engtype_gdi render` —— 类型名里带空格（GDI Render）
///   · `..._engtype_`           —— 空值（无类型引擎）
/// 故取标记后 trim，空串按「无类型」返回 None（这样它不会被误认成任何一类）。
fn engtype_of(instance: &str) -> Option<&str> {
    const MARK: &str = "_engtype_";
    let i = instance.rfind(MARK)?;
    let t = instance[i + MARK.len()..].trim();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

/// 指定适配器在某个「按 luid 匹配」的显存计数器里的用量（字节）。
/// 专用显存与共享显存共用本函数：两者实例名规则一致（`luid_..._phys_N`）。
/// 多 tile 适配器（同一 luid 出现 phys_0 / phys_1…）**求和**，与 DXGI 报告的整卡容量口径一致。
fn adapter_usage_for(items: &[(String, f64)], luid_key: &str) -> u64 {
    items
        .iter()
        .filter(|(n, _)| n.starts_with(luid_key))
        .map(|(_, v)| if v.is_finite() { v.max(0.0) } else { 0.0 })
        .sum::<f64>() as u64
}
