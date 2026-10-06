// ============ Linux 原生资源采集（sysfs / proc）============
//
// 为什么单独一个模块，而不是复用 `hw_metrics.rs`：
//   `hw_metrics.rs` 整个文件是 `#[cfg(windows)]`，里面每一项都建立在 **PDH** 之上
//   （`\Processor Information`、`\Energy Meter`、`\LogicalDisk`）——这些计数器是
//   Windows 独有的。Linux 上不是「换个 API 调用」能复用，而是**换整条数据来源**。
//   所以这里平行实现，只依赖跨平台的 `sysinfo` + 读 `/proc`、`/sys`，不碰任何 Windows 代码。
//
// 数据来源与可取性（与 Windows 版逐项对照，避免「Linux 上少一列」却没人知道为什么）：
//
// · CPU 有效频率：**有**。Linux 的 `/proc/cpuinfo` 与 sysinfo 的 `cpu.frequency()`
//   都给 MHz。sysinfo 读 `/proc/cpuinfo`（需临时提权才能拿到 scaling_cur_freq，
//   但 `cpuinfo` 里的 `cpu MHz` 字段对所有用户可读），且是**瞬时值**而非 P-state 标称值。
//   ⚠ 与 Windows 口径的差别：这里没有「% Performance × 基频」的换算，直接就是当前频率。
//
// · CPU 温度：**有**，但**口径必须写明**。Linux 没有「CPU 核心温度」的标准接口，
//   唯一通用来源是 hwmon 驱动（k10temp / coretemp / zenpower）暴露的
//   `/sys/class/hwmon/hwmon*/temp*_input`，单位**毫摄氏度**。
//   ⚠ 有些机器上这个文件是**主板/机箱温度**而非 CPU 封装温度（与 Windows 的 ACPI
//   热区同样的坑），所以前端那句「部分机型为主板温区」的口径说明在 Linux 上同样适用。
//   找不到 hwmon 就返回 None，不编造。
//
// · 电池：**有**。`/sys/class/power_supply/BAT*/` 给出容量百分比与状态，
//   比 Windows 的 `GetSystemPowerStatus` 覆盖更好（能拿到充电中/未插电的细分状态）。
//
// · 磁盘实时 IO：**有**。`/proc/diskstats` 给出按设备（第 3 字段）的累计读写扇区，
//   差分即速率。⚠ 它按**块设备**（sda/nvme0n1）而非**挂载点**统计，因此
//   只能把设备映射到挂载点（`/proc/mounts` 或 sysinfo 的 `Disk::name()`）。
//   分区（sda1）与整盘（sda）的计数不同——这里**只取有挂载点的设备**，
//   避免同一份流量在整盘与分区上各算一遍。
//
// · GPU：**不取**。Windows 侧靠 DXGI + PDH + NVML 三条路，Linux 没有等价物：
//   - NVIDIA 可读 `/proc/driver/nvidia/gpus/*/information` 拿型号，
//     但实时利用率/功耗/风扇要么没有公开接口，要么要 root 读 NVML 设备节点。
//   - AMD 的 `amdgpu_top` 需要额外守护进程。
//   - 集显要区分 Intel/AMD 各自的 DRM sysfs 节点。
//   ⇒ 一律返回空 Vec，由前端「不展示」而不是「展示一排 N/A」。
//   这是**明确的取舍**：宁可少一整块，也不给用户一列假的遥测。
//
// · 页面文件：**不适用**（Linux 用 swap 分区，见 `swap_total_kb`）。
//
// 失败策略与 Windows 版一致：任何一步失败 → None / 空值 → 前端展示「—」。
// **不 panic、不报错、不影响其他指标。**
#[cfg(target_os = "linux")]
use std::collections::HashMap;

// 注：这里**没有**定义类似 Windows 侧 `CpuExtra` 的聚合结构。
// Windows 侧需要它是因为那里有 PDH 的「一次采样喂全部指标」硬约束（速率型计数器必须共享
// 同一次采样的时间差）；Linux 侧的频率/温度都是**单次读取即所得**的独立量
// （/proc/cpuinfo 与 hwmon 各自独立），不需要也不应该为了对称而包一层。
// 早先误加过一个 `LinuxCpuExtra`，结果是「定义后从未构造」的死代码 + 编译器 warning。

/// 磁盘实时 IO（按挂载点）
#[cfg(target_os = "linux")]
pub struct LinuxDiskIo {
    /// 挂载点（与 sysinfo 的 `mount_point()` 对齐）
    pub mount: String,
    pub read_bps: Option<f64>,
    pub write_bps: Option<f64>,
}

// ----------------- CPU 频率 -----------------

/// 当前 CPU 频率 MHz。
///
/// 读 `/proc/cpuinfo` 的 `cpu MHz` 字段（单位 MHz）。取**第一个**逻辑处理器即可：
/// 同型号核心频率一致，sysinfo 自己也只给一个值。
/// 读不到（容器里 `/proc/cpuinfo` 不可见等情况）→ None。
#[cfg(target_os = "linux")]
pub fn cpu_freq_mhz() -> Option<f32> {
    let text = std::fs::read_to_string("/proc/cpuinfo").ok()?;
    for line in text.lines() {
        // 形如 "cpu MHz\t\t: 2294.698"；只匹配小写字段名，避开 "cpu MHzs" 之类
        let Some(rest) = line.strip_prefix("cpu MHz") else {
            continue;
        };
        if let Some((_, v)) = rest.split_once(':') {
            if let Ok(mhz) = v.trim().parse::<f32>() {
                if mhz.is_finite() && mhz > 0.0 {
                    return Some(mhz);
                }
            }
        }
    }
    None
}

// ----------------- 温度（hwmon）-----------------

/// hwmon 温度 °C：扫 `/sys/class/hwmon/hwmon*/temp*_input`（单位毫摄氏度），取**最高**值。
///
/// 为什么取最高而不是取 `coretemp`/`k10temp` 那一个：不同机器的 hwmon 节点里
/// 既可能有 CPU 封装温度、也可能有主板/VRM/风扇附近的温度，取最高更接近
/// 「这套系统现在最热的地方」，且不会因为某个驱动改名就完全读不到。
/// 代价是口径不如「精确的 CPU 封装温度」——所以前端必须写明这是热区温度。
#[cfg(target_os = "linux")]
pub fn temp_c() -> Option<f32> {
    let mut best: Option<f32> = None;
    let Ok(entries) = std::fs::read_dir("/sys/class/hwmon") else {
        return None;
    };
    for e in entries.flatten() {
        let dir = e.path();
        let Ok(files) = std::fs::read_dir(&dir) else {
            continue;
        };
        for f in files.flatten() {
            let name = f.file_name();
            let name = name.to_string_lossy();
            // 只要 temp*_input（temp1_label / temp2_crit 等一律跳过）
            if !(name.starts_with("temp") && name.ends_with("_input")) {
                continue;
            }
            if let Ok(s) = std::fs::read_to_string(f.path()) {
                if let Ok(millic) = s.trim().parse::<f32>() {
                    // 毫摄氏度 → 摄氏度；顺手过滤明显不合理的读数（负值 / 超 200°C）
                    let c = millic / 1000.0;
                    if c.is_finite() && c > 0.0 && c < 200.0 {
                        best = Some(best.map_or(c, |b: f32| b.max(c)));
                    }
                }
            }
        }
    }
    best
}

// ----------------- 电池 -----------------

/// 电池状态：扫 `/sys/class/power_supply/BAT*`（没有则 `present=false`）。
///
/// 容量百分比优先用 `capacity`（内核直接给的整数），退路是用
/// `energy_now / energy_full`（charge_full 设计容量）或
/// `charge_now / charge_full`。
#[cfg(target_os = "linux")]
pub fn battery_status() -> crate::BatteryStatus {
    use crate::BatteryStatus;
    let Ok(entries) = std::fs::read_dir("/sys/class/power_supply") else {
        return BatteryStatus::default();
    };
    for e in entries.flatten() {
        let dir = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        // 只认电池本体：BAT0 / BAT1 …；排除 AC（适配器）与无线鼠标的 HID 电源节点
        if !name.starts_with("BAT") {
            continue;
        }
        let read_num = |f: &str| -> Option<f64> {
            std::fs::read_to_string(dir.join(f))
                .ok()
                .and_then(|s| s.trim().parse::<f64>().ok())
        };
        // 容量：capacity → energy_now/energy_full → charge_now/charge_full
        let percent = read_num("capacity").or_else(|| {
            let now = read_num("energy_now").or_else(|| read_num("charge_now"))?;
            let full = read_num("energy_full").or_else(|| read_num("charge_full"))?;
            if full > 0.0 {
                Some(now / full * 100.0)
            } else {
                None
            }
        });
        let status = std::fs::read_to_string(dir.join("status"))
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        // present=false 的那套语义由「percent 拿不到」体现：整块不显示
        return BatteryStatus {
            present: percent.is_some(),
            ac_online: status == "Charging" || status == "Full",
            charging: status == "Charging",
            percent: percent.filter(|p| p.is_finite()).map(|p| p as f32),
            // 剩余秒数需要容量 × 电池满充时间，sysfs 没给 ⇒ None（不编造）
            seconds_left: None,
        };
    }
    BatteryStatus::default()
}

// ----------------- 磁盘实时 IO（/proc/diskstats）-----------------

/// 读 `/proc/diskstats` → `设备名 -> (读扇区, 写扇区)`。
///
/// 字段位置（第 1 行为总量，其后逐设备）：major minor **name** rd_iosec wr_iosec rd_sectors **wr_sectors** …
///
/// ⚠ **扇区不是字节**：`/proc/diskstats` 的 `rd_sectors`/`wr_sectors` 是 512 字节扇区数
///   （无论设备逻辑块多大都按 512 计，这是内核的固定约定），所以要 ×512。
///   这与 `iostat` 的行为一致。
#[cfg(target_os = "linux")]
fn read_diskstats() -> HashMap<String, (u64, u64)> {
    let mut map = HashMap::new();
    let Ok(text) = std::fs::read_to_string("/proc/diskstats") else {
        return map;
    };
    for line in text.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        // 需要至少 6 个字段：major minor name rd_sectors wr_sectors
        if f.len() < 6 {
            continue;
        }
        let name = f[2].to_string();
        let rd = f[5].parse::<u64>().unwrap_or(0);
        let wr = f[9].parse::<u64>().unwrap_or(0);
        map.insert(name, (rd, wr));
    }
    map
}

/// 上一拍 diskstats 快照（与 `/proc/diskstats` 的累计值差分算速率）
#[cfg(target_os = "linux")]
static DISK_PREV: std::sync::OnceLock<
    std::sync::Mutex<(HashMap<String, (u64, u64)>, Option<std::time::Instant>)>,
> = std::sync::OnceLock::new();

/// 逐挂载点的实时读写速率（字节/秒）。
///
/// 只给**有挂载点的设备**（`nvme0n1p2`、`/dev/sda1` 等）：`/proc/diskstats` 同时包含
/// 整盘（sda）与分区（sda1）的计数，两者相加会把同一份流量算两遍。
/// 挂载点由调用方传入（sysinfo 的 `disk.name()` 已给出设备名，可直接查表）。
#[cfg(target_os = "linux")]
pub fn disk_io(device_to_mount: &[(String, String)], dt_secs: f64) -> Vec<LinuxDiskIo> {
    let now = read_diskstats();
    let cell = DISK_PREV.get_or_init(|| std::sync::Mutex::new((HashMap::new(), None)));
    let Ok(mut guard) = cell.lock() else {
        return Vec::new();
    };
    let (prev, prev_ts) = &mut *guard;
    let first_run = prev_ts.is_none() || !dt_secs.is_finite() || dt_secs <= 0.0;
    let out: Vec<LinuxDiskIo> = device_to_mount
        .iter()
        .filter_map(|(dev, mount)| {
            let &(rd, wr) = now.get(dev)?;
            let (p_rd, p_wr) = prev.get(dev).copied().unwrap_or((rd, wr));
            // 首次采样没有「上一拍」⇒ 速率不可知 ⇒ None（**不是 0**：
            // 0 会让用户以为盘没在读写）
            let (read_bps, write_bps) = if first_run {
                (None, None)
            } else {
                (
                    rd.checked_sub(p_rd).map(|d| d as f64 * 512.0 / dt_secs),
                    wr.checked_sub(p_wr).map(|d| d as f64 * 512.0 / dt_secs),
                )
            };
            Some(LinuxDiskIo {
                mount: mount.clone(),
                read_bps,
                write_bps,
            })
        })
        .collect();
    *prev = now;
    *prev_ts = Some(std::time::Instant::now());
    out
}

// ============================================================================
// GPU（NVIDIA）与风扇转速
// ============================================================================
//
// 【修正一条此前的错误结论】本文件原来的文件头写着「GPU ← **不取**
// （Linux 无等价的三条路，宁可整块不显示）」。那个前提**没有复核**：
// Windows 侧走的是 PDH 计数器 + `nvml.dll` + IGCL `ControlLib.dll`，这三条确实都是
// Windows 专属；但 Linux 侧**本来就不需要它们** —— `nvidia-smi` 是 NVIDIA 驱动
// 自带的官方工具，随驱动安装、输出稳定的 CSV，且本机实测可用：
//   $ nvidia-smi --query-gpu=name,utilization.gpu,... --format=csv,noheader,nounits
//   NVIDIA GeForce RTX 3080 Ti Laptop GPU, 0, 17, 16384, 55, 43.61
// 用它换掉「整块不显示」，代价为零（不新增任何 Rust 依赖，只 spawn 一个官方二进制）。
//
// 口径与降级：
//   · 显存：nvidia-smi 给 MiB → ×1024 转 KB，与 Windows 侧 `Dedicated Usage` 同单位。
//   · 共享显存、逐引擎利用率（3D/解码/编码/拷贝）：nvidia-smi 不提供 ⇒ 保持 None，
//     **不用别的量去凑**（前端会显示「—」）。这是与 Windows 的实质差异。
//   · 核显/AMD：nvidia-smi 只报独显 ⇒ 核显那条整块缺失。Windows 侧靠 PDH 能拿到
//     核显，这确实是 Linux 的短板，但比「什么都不显示」好得多。
//
// 风扇：**笔记本 GPU 的风扇由主板 EC 统一管控，NVML 取不到**（gpu_metrics.rs
// 里有同样的结论，所以 Windows 上也是 None）。但 Linux 内核的 hwmon 驱动
// 会把 EC 暴露的风扇转速挂在 `/sys/class/hwmon/hwmon*/fan*_input` —— 本机实测：
//   /sys/class/hwmon/hwmon5/name        = hp
//   /sys/class/hwmon/hwmon5/fan1_input  = 2028      （RPM）
//   /sys/class/hwmon/hwmon5/fan2_input  = ...
// ⇒ **Linux 反而能拿到 Windows 拿不到的风扇转速**。取所有 fan*_input 的最大值
//   作为代表值（多风扇机器上取最快的那个，与任务管理器口径一致）。
//   `fan_percent` 保持 None：hwmon 不提供百分比，也不该用 RPM 猜一个百分比出来。

/// 读取一组 hwmon 里的全部风扇转速（RPM），返回最大值。
pub fn fan_rpm() -> Option<u32> {
    let mut best: Option<u32> = None;
    let Ok(entries) = std::fs::read_dir("/sys/class/hwmon") else {
        return None;
    };
    for hw in entries.flatten() {
        let dir = hw.path();
        // 该目录下形如 fan1_input / fan2_input …（单位 RPM，Linux 内核统一约定）
        let Ok(fans) = std::fs::read_dir(&dir) else {
            continue;
        };
        for f in fans.flatten() {
            let name = f.file_name();
            let name = name.to_string_lossy();
            if !(name.starts_with("fan") && name.ends_with("_input")) {
                continue;
            }
            if let Ok(v) = std::fs::read_to_string(f.path()) {
                if let Ok(rpm) = v.trim().parse::<u32>() {
                    // 过滤掉明显无效的读数（0 与 0xFFFFFFFF 都常见于驱动未就绪）
                    if rpm > 0 && rpm < 100_000 {
                        best = Some(best.map_or(rpm, |b: u32| b.max(rpm)));
                    }
                }
            }
        }
    }
    best
}

/// 用 `nvidia-smi` 采集独显遥测。驱动缺失 / 无 NVIDIA 卡时返回空 Vec（前端整块不显示）。
pub fn nvidia_gpus() -> Vec<crate::GpuInfo> {
    let out = std::process::Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,clocks.gr",
            "--format=csv,noheader,nounits",
        ])
        .output();
    let Ok(out) = out else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let fan = fan_rpm(); // 同一拍里只读一次 sysfs
    let mut v = Vec::new();
    // 同名显卡（多卡机器）按出现次序加 `#N` 后缀，与 Windows 侧 id 生成规则保持一致
    let mut same_name_count: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split(',').map(str::trim).collect();
        if cols.len() < 7 || cols[0].is_empty() {
            continue;
        }
        let name = cols[0].to_string();
        let n = same_name_count.entry(name.clone()).or_insert(0);
        let id = if *n == 0 {
            name.clone()
        } else {
            format!("{name}#{n}")
        };
        *n += 1;
        // nvidia-smi 缺失值输出为 "[N/A]" / "[Not Supported]"，统一归一为 None
        let num = |s: &str| -> Option<f32> {
            if s.starts_with('[') {
                None
            } else {
                s.parse::<f32>().ok()
            }
        };
        let kib = |s: &str| -> Option<u64> {
            if s.starts_with('[') {
                None
            } else {
                s.parse::<u64>().ok().map(|mib| mib * 1024) // MiB → KiB
            }
        };
        v.push(crate::GpuInfo {
            id,
            name,
            vendor: "nvidia".to_string(),
            util_percent: num(cols[1]),
            vram_total_kb: kib(cols[3]),
            vram_used_kb: kib(cols[2]),
            // nvidia-smi 不提供「共享显存」与「逐引擎利用率」⇒ None，不凑数
            vram_shared_kb: None,
            util_3d: None,
            util_video_decode: None,
            util_video_encode: None,
            util_copy: None,
            clock_mhz: num(cols[6]).map(|c| c as u32),
            temp_c: num(cols[4]),
            power_w: num(cols[5]),
            // 笔记本 GPU 风扇由 EC 管，NVML 取不到；改用内核 hwmon 暴露的 EC 风扇
            fan_rpm: fan,
            fan_percent: None,
        });
    }
    v
}
