// 资源监视 · 共享数据模型与格式化
//
// 主窗口（ResourceMonitor）与桌面浮岛（CapsuleResource）读的是**同一个后端命令**
// `get_resource_usage`，字段含义必须只有一处定义 —— 否则后端一改字段，两个面板会各自漂移。
// 这里集中放：接口类型、单位换算、配色、显卡名简写、以及 GPU 选择键的读取。
//
// 字段口径（与后端 main.rs 一一对应）：
//   · 所有 *_kb 都是 KB（内存/显存/磁盘空间一致）
//   · 所有 *_bps 都是「字节/秒」（网络与磁盘 IO 一致）
//   · cpu_freq_mhz 是 MHz，cpu_power_w / power_w 是瓦，clock_mhz 是 MHz
//   · activity 是 0–100 的百分比
//   · 取不到的指标一律为 null（不是 0）—— 前端必须区分「不可用」和「真的为 0」

/** 单块显卡（对应后端 gpu_metrics::GpuUsage） */
export interface GpuUsage {
  /**
   * 稳定标识，用于持久化「监视哪块卡」。
   * ⚠ 后端**没有**用 DXGI LUID 当这个键：LUID 只保证「系统运行期间唯一」，重启会变，
   *   拿它存选择会导致每次开机都被重置。后端给的是「显卡名#同名序号」。
   */
  id: string;
  /** 显卡名（DXGI_ADAPTER_DESC1.Description） */
  name: string;
  /** GPU 利用率 %（该适配器最忙引擎；与任务管理器同口径） */
  util_percent: number | null;
  vram_total_kb: number | null;
  vram_used_kb: number | null;
  /** 共享显存已用 KB（系统内存划给 GPU 的部分；核显主要吃这块，独显通常极小） */
  vram_shared_kb: number | null;
  /** 3D 引擎利用率 %（该适配器内最忙 3D 实例） */
  util_3d: number | null;
  /** 视频解码引擎利用率 %（硬解是否生效看它） */
  util_video_decode: number | null;
  /** 视频编码引擎利用率 %（硬编是否生效看它） */
  util_video_encode: number | null;
  /** 拷贝引擎利用率 % */
  util_copy: number | null;
  /** 图形时钟 MHz（仅 NVIDIA 可取值） */
  clock_mhz: number | null;
  /** 核心温度 °C（仅 NVIDIA 可取值） */
  temp_c: number | null;
  /** 整卡功耗 W（仅 NVIDIA 可取值） */
  power_w: number | null;
}

/** 单个分区（对应后端 DiskUsage） */
export interface DiskUsage {
  mount: string;
  total_kb: number;
  used_kb: number;
  percent: number;
  /** 实时读取字节/秒 */
  read_bps: number | null;
  /** 实时写入字节/秒 */
  write_bps: number | null;
  /** 活动度 %（100 − 空闲时间占比） */
  activity: number | null;
  /** 平均响应时间 ms（该卷无对应计数器时为 null） */
  resp_ms: number | null;
  /** 当前队列长度（排队中的请求数） */
  queue: number | null;
}

export interface ResourceUsage {
  cpu_percent: number;
  cpu_per_core: number[];
  /** CPU 有效频率 MHz（= %ProcessorPerformance × 标称基频） */
  cpu_freq_mhz: number | null;
  /** CPU 封装功耗 W（Intel RAPL；AMD 等平台为 null） */
  cpu_power_w: number | null;
  /** ACPI 热区最高温 °C（跨厂商免驱动；部分机型为主板温区，非 CPU 核心温度） */
  thermal_temp_c: number | null;
  mem_total_kb: number;
  mem_used_kb: number;
  mem_percent: number;
  /** 页面文件使用率 %（Windows 专有；无页面文件为 null） */
  paging_percent: number | null;
  net_up_bps: number;
  net_down_bps: number;
  gpus: GpuUsage[];
  disks: DiskUsage[];
}

/** 迷你曲线保留的采样点数（约 48s @1s 轮询） */
export const HISTORY = 48;

// ----------------- 格式化 -----------------

/** KB → 人类可读（后端所有空间字段都是 KB 口径） */
export function fmtBytes(kb: number): string {
  const gb = kb / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(kb / 1024).toFixed(0)} MB`;
}

/** 字节/秒 → 人类可读（网络与磁盘 IO 共用） */
export function fmtSpeed(bps: number): string {
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1024 / 1024).toFixed(2)} MB/s`;
}

/** 频率：≥1GHz 用 GHz 两位小数，否则整数 MHz。null → 「—」 */
export function fmtFreq(mhz: number | null): string {
  if (mhz == null || !Number.isFinite(mhz)) return '—';
  if (mhz >= 1000) return `${(mhz / 1000).toFixed(2)} GHz`;
  return `${Math.round(mhz)} MHz`;
}

/** 功耗：一位小数瓦。null → 「—」 */
export function fmtPower(w: number | null): string {
  if (w == null || !Number.isFinite(w)) return '—';
  return `${w.toFixed(1)} W`;
}

/** 温度：整数摄氏度。null → 「—」（PDH 热区给的是开尔文，后端已换算成 °C） */
export function fmtTemp(c: number | null): string {
  if (c == null || !Number.isFinite(c)) return '—';
  return `${Math.round(c)} °C`;
}

/** 百分比：null → 「—」 */
export function fmtPercent(p: number | null, digits = 1): string {
  if (p == null || !Number.isFinite(p)) return '—';
  return `${p.toFixed(digits)}%`;
}

/** 毫秒：≥10ms 取整，<10ms 保留一位小数（磁盘响应时间多在 1–20ms 区间）。null → 「—」 */
export function fmtMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  return ms >= 10 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`;
}

/**
 * 占用率配色。<60 绿，60–85 琥珀，>85 红。
 * `dark` 用于浮岛（深底上需要更高亮度），主窗口用默认的浅底配色。
 */
export function levelColor(p: number, dark = false): string {
  if (p > 85) return dark ? '#ff6b6b' : '#ef4444';
  if (p > 60) return dark ? '#f7b955' : '#f59e0b';
  return dark ? '#4ade80' : '#10b981';
}

/** 显存占用百分比；总量或已用缺失时返回 null */
export function vramPercent(g: GpuUsage): number | null {
  if (!g.vram_total_kb || g.vram_used_kb == null) return null;
  return (g.vram_used_kb / g.vram_total_kb) * 100;
}

/**
 * 显卡名简写：去掉厂商/系列前缀，好在窄卡片里显示。
 * 「NVIDIA GeForce RTX 3080 Ti Laptop GPU」→「RTX 3080 Ti Laptop GPU」
 * 「Intel(R) UHD Graphics」→「UHD Graphics」
 */
export function shortGpuName(name: string): string {
  let s = name.trim();
  const prefixes = ['NVIDIA ', 'GeForce ', 'Intel(R) ', 'AMD ', 'Radeon '];
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of prefixes) {
      if (s.startsWith(p) && s.length > p.length) {
        s = s.slice(p.length);
        changed = true;
      }
    }
  }
  return s;
}
