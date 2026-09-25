// ============ Windows 原生 GPU / 显存采集 ============
// GPU 利用率 %：PDH「GPU Engine(*)\Utilization Percentage」计数器求和（跨 3D/其他引擎实例）。
// 显存：DXGI 主适配器 QueryVideoMemoryInfo(Local).CurrentUsage 为已用，GetDesc().DedicatedVideoMemory 为总量。
// 任何一步失败都返回 None，由调用方优雅降级为「N/A」。
use std::ptr;
use std::sync::{Mutex, OnceLock};

use windows::core::{Interface, PCWSTR};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter3, IDXGIFactory1, DXGI_MEMORY_SEGMENT_GROUP_LOCAL,
    DXGI_QUERY_VIDEO_MEMORY_INFO,
};
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
    PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
};

/// 返回 (GPU 利用率%, 显卡名, 显存总量字节, 显存已用字节)
pub fn query_gpu() -> (Option<f32>, Option<String>, Option<u64>, Option<u64>) {
    let (name, vram_total, vram_used) = vram_usage();
    let util = gpu_util_percent();
    (util, name, vram_total, vram_used)
}

// ----------------- DXGI 显存 + 显卡名 -----------------
fn vram_usage() -> (Option<String>, Option<u64>, Option<u64>) {
    unsafe {
        let factory: IDXGIFactory1 = match CreateDXGIFactory1() {
            Ok(f) => f,
            Err(_) => return (None, None, None),
        };
        let mut i = 0u32;
        let mut best: (Option<String>, Option<u64>, Option<u64>) = (None, None, None);
        loop {
            let adapter = match factory.EnumAdapters1(i) {
                Ok(a) => a,
                Err(_) => break,
            };
            i += 1;

            let name = adapter.GetDesc().ok().map(|d| {
                let slice: Vec<u16> = d
                    .Description
                    .iter()
                    .take_while(|&&c| c != 0)
                    .copied()
                    .collect();
                let s = String::from_utf16_lossy(&slice);
                // 去掉可能的尾部空白
                s.trim().to_string()
            });

            let (total, used) = if let Ok(adapt3) = adapter.cast::<IDXGIAdapter3>() {
                let mut info = DXGI_QUERY_VIDEO_MEMORY_INFO {
                    Budget: 0,
                    CurrentUsage: 0,
                    AvailableForReservation: 0,
                    CurrentReservation: 0,
                };
                if adapt3
                    .QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut info)
                    .is_ok()
                {
                    let desc = adapter.GetDesc().ok();
                    // DXGI_ADAPTER_DESC::DedicatedVideoMemory 是 usize，info.Budget 是 u64，统一到 u64
                    let total = desc
                        .map(|d| d.DedicatedVideoMemory as u64)
                        .unwrap_or(info.Budget);
                    (Some(total), Some(info.CurrentUsage))
                } else {
                    (None, None)
                }
            } else {
                (None, None)
            };

            // 取第一个能拿到显存的适配器（通常为主显卡）
            if best.1.is_none() {
                best = (name, total, used);
            }
        }
        best
    }
}

// ----------------- PDH GPU 利用率 % -----------------
#[derive(Clone, Copy)]
struct GpuPdh {
    query: PDH_HQUERY,
    counter: PDH_HCOUNTER,
}

// PDH_HQUERY / PDH_HCOUNTER 内含 *mut c_void，raw pointer 默认 !Send，
// 会让 OnceLock<Mutex<Option<GpuPdh>>> 无法作为 static（要求 Sync）。
// SAFETY: 这两个句柄是不透明的 PDH 内核句柄（HANDLE 语义，非内存地址），
// PDH API 自身可从任意线程调用；此处只承诺「句柄可随 Mutex 在线程间移动」，
// 所有访问仍严格在 RES/GPU_PDH 的 Mutex 保护下串行进行。
unsafe impl Send for GpuPdh {}

static GPU_PDH: OnceLock<Mutex<Option<GpuPdh>>> = OnceLock::new();

fn gpu_pdh_handle() -> Option<GpuPdh> {
    let cell = GPU_PDH.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().unwrap();
    if let Some(h) = *guard {
        return Some(h);
    }
    unsafe {
        let mut query: PDH_HQUERY = PDH_HQUERY(ptr::null_mut());
        if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != 0 {
            return None;
        }
        let mut counter: PDH_HCOUNTER = PDH_HCOUNTER(ptr::null_mut());
        let path: Vec<u16> = r"\\GPU Engine(*)\Utilization Percentage"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        if PdhAddEnglishCounterW(query, PCWSTR(path.as_ptr()), 0, &mut counter) != 0 {
            let _ = PdhCloseQuery(query);
            return None;
        }
        let h = GpuPdh { query, counter };
        *guard = Some(h);
        Some(h)
    }
}

fn gpu_util_percent() -> Option<f32> {
    let h = gpu_pdh_handle()?;
    unsafe {
        // 每次轮询 collect 一次；PDH 利用率反映距上次 collect 的时段（与前端 1s 轮询对齐）
        if PdhCollectQueryData(h.query) != 0 {
            return None;
        }
        let mut size: u32 = 0;
        let mut count: u32 = 0;
        // 第一次传 None 探明所需缓冲字节数（返回 PDH_MORE_DATA 属正常，不计错）
        let _ = PdhGetFormattedCounterArrayW(h.counter, PDH_FMT_DOUBLE, &mut size, &mut count, None);
        if size == 0 {
            return None;
        }
        let item_size = std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>();
        let cap = (size as usize) / item_size.max(1);
        if cap == 0 {
            return None;
        }
        let mut buf: Vec<PDH_FMT_COUNTERVALUE_ITEM_W> = Vec::with_capacity(cap);
        // PDH_FMT_COUNTERVALUE_ITEM_W 自带 Default（全零），无需手工构造 union 字段
        buf.resize_with(cap, PDH_FMT_COUNTERVALUE_ITEM_W::default);
        // 第二次取真实数组（size 作为 IN 传入缓冲字节数）
        let ret = PdhGetFormattedCounterArrayW(
            h.counter,
            PDH_FMT_DOUBLE,
            &mut size,
            &mut count,
            Some(buf.as_mut_ptr()),
        );
        if ret != 0 {
            return None;
        }
        let mut sum = 0.0f64;
        let mut valid = 0u32;
        for item in buf.iter().take(count as usize) {
            if item.FmtValue.CStatus == 0 {
                sum += item.FmtValue.Anonymous.doubleValue;
                valid += 1;
            }
        }
        if valid == 0 {
            None
        } else {
            Some(sum as f32)
        }
    }
}
