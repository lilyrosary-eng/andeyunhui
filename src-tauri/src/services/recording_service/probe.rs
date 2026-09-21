//! 录屏运行时探针（**临时诊断模块**，定位「录屏卡」到底卡在哪一段后即可整体删除）。
//!
//! 为什么需要：过去多轮优化都是靠静态推断，结论反复被实测推翻（如「31MB 整帧读回是主因」已被证伪）。
//! 本模块只做观测、不改数据流：在 WGC 回调、投帧节拍器、写 ffmpeg 三个关键点打点，每 120 帧输出一次
//! 聚合行，停止录制时输出汇总并落盘到 `{输出文件}.probe.log`。
//!
//! 读法（每条聚合行）：
//! - `回调平均间隔` → 捕获侧真实帧率。远低于目标 fps 说明回调被拖慢、帧池饥饿。
//! - `回调耗时` → 每帧在 WGC 回调线程内同步花费的时间。持续 > 1/fps 即背压源头。
//! - `读回` → GPU→CPU 取帧时间（GPU 同设备 NV12 缩放器的阻塞 Map / 兜底的 staging 读回）。
//! - `转换` → 色彩转换/缩放时间（GPU 路径为 0；CPU 兜底为查表最近邻 + BT.709 转换）。
//! - `写入阻塞` → ffmpeg stdin 写入被编码器背压顶住的时间。大 = 编码器跟不上，会引发丢帧/顿挫。
//! - `路径` → 本次录制实际生效的分支计数（同一段录制中途可能因 GPU 失败而切换）。

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// 每多少帧输出一次聚合行（约 2~4 秒一条，不刷屏）
const REPORT_EVERY: u64 = 120;

// ── 路径标记：一眼看出这一帧走的是哪条分支 ──
/// 进程内编码器 + 同设备 GPU 缩放（RGBA 读回）+ CPU 转 NV12（feed_rgba）
pub(crate) const PATH_INPROC_GPU: u8 = 1;
/// 进程内编码器 + CPU 兜底（整帧读回 + CPU 缩放 + CPU 转 NV12）
pub(crate) const PATH_INPROC_CPU: u8 = 2;
/// ffmpeg 子进程路径 + 同设备 GPU 缩放并直接产出 NV12（~3MB/帧，CPU 仅拷贝）
pub(crate) const PATH_SUB_GPU_NV12: u8 = 3;
/// ffmpeg 子进程路径 + CPU NV12 兜底（复用 staging 读回 + 查表最近邻 → 紧凑 NV12）
pub(crate) const PATH_SUB_CPU: u8 = 4;
/// 本帧无产出（GPU 未就绪 / 读回失败）
pub(crate) const PATH_NONE: u8 = 5;
const PATH_SLOTS: usize = 6;

fn path_name(p: u8) -> &'static str {
    match p {
        PATH_INPROC_GPU => "进程内GPU缩放+CPU转NV12",
        PATH_INPROC_CPU => "进程内CPU兜底",
        PATH_SUB_GPU_NV12 => "子进程+GPU同设备NV12",
        PATH_SUB_CPU => "子进程+CPU查表NV12兜底",
        PATH_NONE => "本帧无产出",
        _ => "未标记",
    }
}

/// 录屏探针：无锁计数（原子）+ 单次聚合输出。
pub(crate) struct RecProbe {
    /// 聚合行落盘路径（`{输出文件}.probe.log`）；None = 只打 stderr
    log_path: Option<PathBuf>,
    /// 启动横幅（实际生效的管线决策），首条聚合行前输出一次
    banner: Mutex<String>,
    banner_written: AtomicU64,
    frames: AtomicU64,
    /// 各阶段累计微秒
    read_us: AtomicU64,
    conv_us: AtomicU64,
    total_us: AtomicU64,
    max_total_us: AtomicU64,
    max_read_us: AtomicU64,
    max_conv_us: AtomicU64,
    /// 相邻回调间隔累计（推算捕获侧真实帧率）
    gap_us: AtomicU64,
    gap_n: AtomicU64,
    last_ts: Mutex<Option<Instant>>,
    /// 路径计数
    paths: [AtomicU64; PATH_SLOTS],
    // ── 投递/背压 ──
    feed_ok: AtomicU64,
    feed_drop: AtomicU64,
    /// 「最新帧槽」被覆盖次数（pacer 没来得及取走，说明捕获快于投帧）
    slot_overwrite: AtomicU64,
    // ── 写 ffmpeg ──
    write_n: AtomicU64,
    write_us: AtomicU64,
    max_write_us: AtomicU64,
    write_bytes: AtomicU64,
}

impl RecProbe {
    /// 在 `output_path` 旁创建 `{output_path}.probe.log`（失败则只打 stderr，不阻断录制）。
    pub(crate) fn new(output_path: &str) -> Arc<Self> {
        Arc::new(Self {
            log_path: Some(PathBuf::from(format!("{}.probe.log", output_path))),
            banner: Mutex::new(String::new()),
            banner_written: AtomicU64::new(0),
            frames: AtomicU64::new(0),
            read_us: AtomicU64::new(0),
            conv_us: AtomicU64::new(0),
            total_us: AtomicU64::new(0),
            max_total_us: AtomicU64::new(0),
            max_read_us: AtomicU64::new(0),
            max_conv_us: AtomicU64::new(0),
            gap_us: AtomicU64::new(0),
            gap_n: AtomicU64::new(0),
            last_ts: Mutex::new(None),
            paths: std::array::from_fn(|_| AtomicU64::new(0)),
            feed_ok: AtomicU64::new(0),
            feed_drop: AtomicU64::new(0),
            slot_overwrite: AtomicU64::new(0),
            write_n: AtomicU64::new(0),
            write_us: AtomicU64::new(0),
            max_write_us: AtomicU64::new(0),
            write_bytes: AtomicU64::new(0),
        })
    }

    /// 记录启动横幅：一眼看出本次实际生效的管线（编码器 / 分辨率 / 分支开关 / ffmpeg 参数）。
    pub(crate) fn set_banner(&self, s: String) {
        if let Ok(mut b) = self.banner.lock() {
            *b = s;
        }
    }

    /// 取一个「帧计时守卫」：作用域结束（含提前 return）自动记账，杜绝漏点。
    pub(crate) fn guard(self: &Arc<Self>) -> FrameGuard {
        FrameGuard {
            probe: Arc::clone(self),
            t0: Instant::now(),
            mark: Instant::now(),
            read_us: 0,
            conv_us: 0,
            path: 0,
        }
    }

    /// 聚合输出（stderr + 落盘）。`final_` 为真时带上总帧数与平均帧率。
    fn emit(&self, line: &str) {
        eprintln!("{}", line);
        if let Some(p) = &self.log_path {
            if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(p) {
                let _ = writeln!(f, "{}", line);
            }
        }
    }

    fn report(&self, force: bool) {
        let n = self.frames.load(Ordering::Relaxed);
        if n == 0 || (!force && n % REPORT_EVERY != 0) {
            return;
        }
        if self.banner_written.swap(1, Ordering::Relaxed) == 0 {
            let b = self.banner.lock().map(|b| b.clone()).unwrap_or_default();
            for l in b.lines() {
                self.emit(l);
            }
        }
        let avg = |total: &AtomicU64| (total.load(Ordering::Relaxed) as f64) / n as f64 / 1000.0;
        let gn = self.gap_n.load(Ordering::Relaxed);
        let gap_avg = if gn > 0 {
            (self.gap_us.load(Ordering::Relaxed) as f64) / gn as f64 / 1000.0
        } else {
            0.0
        };
        let eff_fps = if gap_avg > 0.01 { 1000.0 / gap_avg } else { 0.0 };
        let paths: Vec<String> = (1..PATH_SLOTS)
            .map(|i| {
                let c = self.paths[i].load(Ordering::Relaxed);
                format!("{}={}", path_name(i as u8), c)
            })
            .filter(|s| !s.ends_with("=0"))
            .collect();
        let wus = self.write_us.load(Ordering::Relaxed);
        let wn = self.write_n.load(Ordering::Relaxed).max(1);
        self.emit(&format!(
            "[录屏探针] 帧={} 回调间隔均={:.1}ms(捕获≈{:.1}fps) 回调耗时均={:.1}ms 最大={:.1}ms | 读回均={:.1}ms 最大={:.1}ms | 转换均={:.1}ms 最大={:.1}ms",
            n, gap_avg, eff_fps, avg(&self.total_us),
            (self.max_total_us.load(Ordering::Relaxed) as f64) / 1000.0,
            avg(&self.read_us),
            (self.max_read_us.load(Ordering::Relaxed) as f64) / 1000.0,
            avg(&self.conv_us),
            (self.max_conv_us.load(Ordering::Relaxed) as f64) / 1000.0,
        ));
        self.emit(&format!(
            "[录屏探针] 路径: {} | 投递 成功={} 通道满丢帧={} | 帧槽覆盖={} | 写ffmpeg 帧={} 均耗时={:.2}ms 最大={:.1}ms 总量={:.1}MB",
            if paths.is_empty() { "无".to_string() } else { paths.join(" ") },
            self.feed_ok.load(Ordering::Relaxed),
            self.feed_drop.load(Ordering::Relaxed),
            self.slot_overwrite.load(Ordering::Relaxed),
            self.write_n.load(Ordering::Relaxed),
            (wus as f64) / wn as f64 / 1000.0,
            (self.max_write_us.load(Ordering::Relaxed) as f64) / 1000.0,
            (self.write_bytes.load(Ordering::Relaxed) as f64) / 1048576.0,
        ));
    }

    /// 停止录制时输出最终汇总。
    pub(crate) fn finish(&self) {
        self.report(true);
        self.emit("[录屏探针] ===== 本次录制观测结束 =====");
    }

    pub(crate) fn note_slot_overwrite(&self) {
        self.slot_overwrite.fetch_add(1, Ordering::Relaxed);
    }

    /// 投帧节拍器：非阻塞入队结果（满即丢瞬时帧）
    pub(crate) fn note_feed(&self, ok: bool) {
        if ok {
            self.feed_ok.fetch_add(1, Ordering::Relaxed);
        } else {
            self.feed_drop.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// 写 ffmpeg stdin 一次：`us` 为该次 write_all 阻塞耗时（大 = 编码器背压）。
    pub(crate) fn note_write(&self, us: u64, bytes: u64) {
        self.write_n.fetch_add(1, Ordering::Relaxed);
        self.write_us.fetch_add(us, Ordering::Relaxed);
        self.write_bytes.fetch_add(bytes, Ordering::Relaxed);
        self.max_write_us.fetch_max(us, Ordering::Relaxed);
    }
}

/// 帧计时守卫：回调作用域结束时自动记账（含任意提前 return 的分支）。
pub(crate) struct FrameGuard {
    probe: Arc<RecProbe>,
    t0: Instant,
    mark: Instant,
    read_us: u64,
    conv_us: u64,
    path: u8,
}

impl FrameGuard {
    /// 标记「读回阶段」结束（`frame.buffer()` / `Map` 读回 / `scaler.scale`）。
    pub(crate) fn mark_read(&mut self) {
        self.read_us = self.mark.elapsed().as_micros() as u64;
        self.mark = Instant::now();
    }

    /// 标记「缩放/裁剪/色彩转换阶段」结束。
    pub(crate) fn mark_conv(&mut self) {
        self.conv_us = self.mark.elapsed().as_micros() as u64;
        self.mark = Instant::now();
    }

    /// 丢弃当前标记区间（不计入任何阶段）：用于分支切换后重新起算，避免把无关前序计入。
    pub(crate) fn reset_mark(&mut self) {
        self.mark = Instant::now();
    }

    /// 标记本帧走的分支。
    pub(crate) fn set_path(&mut self, p: u8) {
        self.path = p;
    }
}

impl Drop for FrameGuard {
    fn drop(&mut self) {
        let p = &self.probe;
        let now = Instant::now();
        let total = self.t0.elapsed().as_micros() as u64;
        p.frames.fetch_add(1, Ordering::Relaxed);
        p.total_us.fetch_add(total, Ordering::Relaxed);
        p.read_us.fetch_add(self.read_us, Ordering::Relaxed);
        p.conv_us.fetch_add(self.conv_us, Ordering::Relaxed);
        p.max_total_us.fetch_max(total, Ordering::Relaxed);
        p.max_read_us.fetch_max(self.read_us, Ordering::Relaxed);
        p.max_conv_us.fetch_max(self.conv_us, Ordering::Relaxed);
        if (self.path as usize) < PATH_SLOTS {
            p.paths[self.path as usize].fetch_add(1, Ordering::Relaxed);
        }
        // 回调间隔：反映捕获侧真实供帧节奏（远低于目标 fps = 回调被拖慢 / 帧池饥饿）
        let gap = {
            let mut g = p.last_ts.lock().unwrap_or_else(|e| e.into_inner());
            match *g {
                Some(prev) => {
                    let d = now.duration_since(prev).as_micros() as u64;
                    *g = Some(now);
                    d
                }
                None => {
                    *g = Some(now);
                    0
                }
            }
        };
        if gap > 0 {
            p.gap_us.fetch_add(gap, Ordering::Relaxed);
            p.gap_n.fetch_add(1, Ordering::Relaxed);
        }
        p.report(false);
    }
}