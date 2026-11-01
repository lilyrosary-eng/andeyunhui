/**
 * localStorage 占用体检（供 DevConsole 的 `:storage` 指令使用）。
 *
 * 起因：选壁纸当背景时抛 QuotaExceededError，而那个壁纸值只有 235KB —— 说明配额不是被
 * 一次大写入打爆的，是被许多键慢慢占满的；而任何键写失败都只在失败那一刻弹一个笼统告警
 * （文案还会误指"对话记录可能丢了"）。所以给一个能主动查的排行，别等丢数据才发现。
 */

export interface StorageAuditItem {
  key: string;
  /** 估算字节数：键 + 值，按 UTF-16 计 */
  bytes: number;
}

export interface StorageAudit {
  /** 按字节降序 */
  items: StorageAuditItem[];
  totalBytes: number;
  /** 该 origin 的存储配额；非安全上下文或引擎不支持时为 null */
  quotaBytes: number | null;
  /** totalBytes / quotaBytes；拿不到配额时为 null */
  usedRatio: number | null;
}

/** 只读的最小 Storage 形状：便于用 Map 假实现做单测 */
export interface StringStore {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
}

/**
 * localStorage 按 UTF-16 码元计配额：一个中文算 2 字节。
 * 用 s.length * 2 而不是 new Blob([s]).size，是为了不把整值复制一份出来做统计。
 */
function utf16Bytes(s: string): number {
  return s.length * 2;
}

export function collectStorageItems(store: StringStore): StorageAuditItem[] {
  const items: StorageAuditItem[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key === null) continue;
    items.push({ key, bytes: utf16Bytes(key) + utf16Bytes(store.getItem(key) ?? '') });
  }
  return items.sort((a, b) => b.bytes - a.bytes);
}

export async function auditStorage(): Promise<StorageAudit> {
  const items = collectStorageItems(localStorage);
  const totalBytes = items.reduce((n, it) => n + it.bytes, 0);
  let quotaBytes: number | null = null;
  try {
    const est = await navigator.storage?.estimate?.();
    quotaBytes = est?.quota ?? null;
  } catch {
    quotaBytes = null;
  }
  return {
    items,
    totalBytes,
    quotaBytes,
    usedRatio: quotaBytes && quotaBytes > 0 ? totalBytes / quotaBytes : null,
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

/** 配额接近上限时给一句话警告；无风险或未知配额返回 null */
export function storageWarning(audit: StorageAudit): string | null {
  if (audit.usedRatio === null) return null;
  if (audit.usedRatio < 0.8) return null;
  return `配额已用 ${(audit.usedRatio * 100).toFixed(1)}%：再写入大值可能静默失败（设置不持久、会话存不下）。可清理上面排名靠前的键。`;
}
