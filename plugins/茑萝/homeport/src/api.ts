// 凌霄 · 下载中心：与宿主 download-kit 命令层对接的最小 API 封装。
// 插件沙箱会自动把 pluginId 注入 invoke 参数，这里无需手动传。

export type EngineKind =
  | 'auto'
  | 'native'
  | 'simple'
  | 'aria2'
  | 'ffmpeg'
  | 'curl'
  | 'wget'
  | 'gopeed';

export type TaskStatus =
  | 'queued'
  | 'probing'
  | 'downloading'
  | 'paused'
  | 'merging'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface DownloadTask {
  id: string;
  urls: string[];
  savePath: string;
  filename: string;
  referer?: string | null;
  cookie?: string | null;
  userAgent?: string | null;
  headers: Record<string, string>;
  engine: EngineKind;
  resolvedEngine?: EngineKind | null;
  status: TaskStatus;
  totalBytes: number;
  downloadedBytes: number;
  maxBytes?: number | null;
  mirrors: string[];
  sha256?: string | null;
  maxSpeed?: number | null;
  priority: number;
  etag?: string | null;
  lastModified?: string | null;
  connections: number;
  error?: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt?: number | null;
}

export interface DownloadPart {
  index: number;
  url: string;
  start: number;
  end: number;
  downloaded: number;
  state: string;
  tempPath: string;
}

export interface TaskDetail extends DownloadTask {
  parts: DownloadPart[];
}

export interface EngineInfo {
  kind: EngineKind;
  name: string;
  description: string;
  builtin: boolean;
  platform: string;
  available: boolean;
  path?: string | null;
  default: boolean;
}

export interface EngineStatus {
  defaultEngine: EngineKind;
  engines: EngineInfo[];
}

export interface EngineConfig {
  defaultEngine: EngineKind;
  connections: number;
  maxConcurrentTasks: number;
  maxPerHost: number;
  retries: number;
  taskRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
  connectTimeoutSecs: number;
  readTimeoutSecs: number;
  userAgent: string;
  speedLimit: number;
  totalSpeedLimit: number;
  proxy?: string | null;
  aria2Path?: string | null;
  ffmpegPath?: string | null;
  curlPath?: string | null;
  wgetPath?: string | null;
  gopeedPath?: string | null;
  resumeOnStart: boolean;
  notifyOnComplete: boolean;
  browserTakeover: boolean;
}

export interface ProbeResult {
  finalUrl: string;
  totalBytes: number;
  acceptRanges: boolean;
  contentType?: string | null;
  filename?: string | null;
  etag?: string | null;
  lastModified?: string | null;
}

export interface ProgressPayload {
  taskId: string;
  status: TaskStatus;
  downloaded: number;
  total: number;
  speed: number;
  connections: number;
  partsTotal: number;
  partsDone: number;
  error?: string | null;
}

export interface DownloadSpec {
  urls: string[];
  savePath: string;
  /** 目录目标时优先使用的文件名（通常来自「解析地址」的结果）。 */
  filename?: string | null;
  referer?: string | null;
  cookie?: string | null;
  userAgent?: string | null;
  headers?: Record<string, string>;
  engine: EngineKind;
  connections?: number | null;
  maxBytes?: number | null;
  mirrors?: string[];
  sha256?: string | null;
  maxSpeed?: number | null;
  priority: number;
}

export interface HlsVariant {
  url: string;
  bandwidth: number;
  resolution?: string | null;
  codecs?: string | null;
  name: string;
}

/** 内置浏览器里被拦截、等待凌霄接管的一次下载。 */
export interface BrowserCapture {
  url: string;
  createdAt: number;
}

export interface ProbeRequest {
  url: string;
  referer?: string | null;
  cookie?: string | null;
  userAgent?: string | null;
  headers?: Record<string, string>;
}

const invoke = <T,>(cmd: string, args?: Record<string, unknown>) =>
  window.__HOST_API__.invoke<T>(cmd, args);

export const dl = {
  list: (status?: TaskStatus | null, limit = 200) =>
    invoke<DownloadTask[]>('dl_list', { status: status ?? null, limit }),
  get: (id: string) => invoke<TaskDetail>('dl_get', { id }),
  enqueue: (spec: DownloadSpec) => invoke<string>('dl_enqueue', { spec }),
  pause: (id: string) => invoke<void>('dl_pause', { id }),
  resume: (id: string) => invoke<void>('dl_resume', { id }),
  pauseAll: () => invoke<number>('dl_pause_all'),
  resumeAll: () => invoke<number>('dl_resume_all'),
  updateOptions: (id: string, priority: number, connections: number, maxSpeed: number) =>
    invoke<void>('dl_update_options', { id, priority, connections, maxSpeed }),
  retry: (id: string) => invoke<void>('dl_retry', { id }),
  cancel: (id: string, deleteFile = true) =>
    invoke<void>('dl_cancel', { id, deleteFile }),
  forget: (id: string) => invoke<void>('dl_forget', { id }),
  configGet: () => invoke<EngineConfig>('dl_config_get'),
  configSet: (config: EngineConfig) => invoke<EngineConfig>('dl_config_set', { config }),
  engines: () => invoke<EngineStatus>('dl_engines'),
  probe: (request: ProbeRequest) => invoke<ProbeResult>('dl_probe', { request }),
  hlsVariants: (request: ProbeRequest) =>
    invoke<HlsVariant[]>('dl_hls_variants', { request }),
  readClipboard: () => invoke<string>('clipboard_read'),
  takeBrowserCaptures: () =>
    invoke<BrowserCapture[]>('browser_download_captures_take'),
  openPath: (path: string) => invoke<void>('fs_open_path', { path }),
  pickDirectory: () => invoke<string | null>('pick_directory', {}),
};

export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: '排队中',
  probing: '解析中',
  downloading: '下载中',
  paused: '已暂停',
  merging: '合并中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
};

export const ENGINE_LABEL: Record<EngineKind, string> = {
  auto: '自动',
  native: '引擎1',
  simple: '引擎2',
  aria2: 'aria2c',
  ffmpeg: 'ffmpeg',
  curl: 'cURL',
  wget: 'Wget',
  gopeed: 'Gopeed',
};

export function isActiveStatus(status: TaskStatus): boolean {
  return status === 'queued' || status === 'probing' || status === 'downloading' || status === 'merging';
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.length > 48 ? `${url.slice(0, 48)}…` : url;
  }
}

export function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function ensureDirPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  if (trimmed.endsWith('/') || trimmed.endsWith('\\')) return trimmed;
  return `${trimmed}${trimmed.includes('\\') ? '\\' : '/'}`;
}
