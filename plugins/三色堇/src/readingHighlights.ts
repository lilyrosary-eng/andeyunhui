/// <reference path="../../global.d.ts" />
// 阅读高亮 / 批注分片存储（纯逻辑，无 DOM 依赖，可单测）
//
// 设计要点：
// - 按「书路径 hash」分片：每本书一个 localStorage key（andeyunhui.reading.highlights.v1.b.<hash>），
//   避免单一大 JSON 随书籍数量膨胀；另有一个轻量索引 key 记录 hash → 书路径，供全局枚举。
// - 不触碰用户书籍目录（不写 .adyh 之类文件），数据全部留在应用 localStorage。
// - 锚点：chapterId 为主锚（流式加载后章节 id 稳定），chapterIndex 为辅助锚；
//   start/end 是「章节规范化纯文本」中的 UTF-16 码元偏移（与 ReadingView 的 text node 遍历同源）。
// - quote/prefix/suffix 用于文本漂移校验：重放时先按位置精确匹配，失配再全文/上下文搜索；
//   彻底找不到只标 stale（防丢数据），绝不静默删除。
// - 导出一本书 → 一篇笔记：noteId = 'reading-' + 稳定 hash（一书一笔记，天然幂等），
//   Markdown 按章分组、内容确定性生成（同输入必同输出）。

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';

/** 高亮背景色（mark 仅允许背景着色；点色供侧栏/工具条复用）。顺序即工具条展示顺序 */
export const HIGHLIGHT_COLORS: HighlightColor[] = ['yellow', 'green', 'blue', 'pink'];
export const HIGHLIGHT_BG: Record<HighlightColor, string> = {
  yellow: 'rgba(250, 204, 21, 0.45)',
  green: 'rgba(74, 222, 128, 0.42)',
  blue: 'rgba(96, 165, 250, 0.42)',
  pink: 'rgba(244, 114, 182, 0.42)',
};

export interface HighlightRecord {
  id: string;
  /** 主锚：章节 id（与 ReadingBook.chapters[i].id 对齐） */
  chapterId: string;
  /** 辅助锚：章节序号（旧数据/无 id 书籍兜底） */
  chapterIndex: number;
  /** 章节规范化纯文本中的 UTF-16 偏移（[start, end)） */
  start: number;
  end: number;
  /** 选中的原文（校验锚点是否漂移的依据） */
  quote: string;
  /** 选区前最多 30 码元上下文（漂移搜索用） */
  prefix: string;
  /** 选区后最多 30 码元上下文 */
  suffix: string;
  color: HighlightColor;
  /** 批注正文 */
  note: string;
  /** 关联笔记 id（导出后回填） */
  noteId?: string | null;
  createdAt: number;
  updatedAt: number;
  /** quote 校验彻底失败时为 true；stale 记录不重放、不导出正文，但不删除 */
  stale?: boolean;
}

/** 新建高亮的输入（id/时间戳由存储层补齐；note/color 可省略取默认值） */
export type NewHighlight =
  Omit<HighlightRecord, 'id' | 'createdAt' | 'updatedAt' | 'stale' | 'note' | 'color' | 'noteId'> &
  Partial<Pick<HighlightRecord, 'id' | 'noteId' | 'note' | 'color'>>;

// ============ hash 与分片 key ============

/** 规范化书路径：反斜杠→正斜杠、去尾斜杠、大小写折叠（Windows 路径大小写不敏感） */
export function normalizeBookPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** FNV-1a 32bit → 16 进制短 hash（与宿主 manifestHash 同源算法，稳定、无依赖） */
export function hashBookPath(filePath: string): string {
  const s = normalizeBookPath(filePath);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const KEY_PREFIX = 'andeyunhui.reading.highlights.v1';
/** 分片 key：一书一 key */
export function shardKeyFor(filePath: string): string {
  return `${KEY_PREFIX}.b.${hashBookPath(filePath)}`;
}
/** 索引 key：hash → 书路径（供命令面板等全局枚举，不承载高亮本体） */
const INDEX_KEY = `${KEY_PREFIX}.index`;

/** 一书一笔记的固定 noteId（safe_join 友好：仅 'reading-' + hex） */
export function noteIdForBook(filePath: string): string {
  return `reading-${hashBookPath(filePath)}`;
}

// ============ 存储原语（localStorage；无 window 环境回退内存，便于单测） ============

interface Shard {
  v: 1;
  bookPath: string;
  items: HighlightRecord[];
}

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const memoryStore = new Map<string, string>();
const memoryFallback: StorageLike = {
  getItem: (k) => (memoryStore.has(k) ? memoryStore.get(k)! : null),
  setItem: (k, v) => { memoryStore.set(k, v); },
  removeItem: (k) => { memoryStore.delete(k); },
};

function storage(): StorageLike {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch { /* 隐私模式等 */ }
  return memoryFallback;
}

/** 单测/重置用：清空内存回退存储 */
export function __resetMemoryStorageForTests(): void {
  memoryStore.clear();
}

function readShard(filePath: string): Shard {
  try {
    const raw = storage().getItem(shardKeyFor(filePath));
    if (!raw) return { v: 1, bookPath: filePath, items: [] };
    const parsed = JSON.parse(raw) as Shard;
    if (!parsed || !Array.isArray(parsed.items)) return { v: 1, bookPath: filePath, items: [] };
    return { v: 1, bookPath: parsed.bookPath || filePath, items: parsed.items };
  } catch {
    return { v: 1, bookPath: filePath, items: [] };
  }
}

function writeShard(filePath: string, items: HighlightRecord[]): void {
  const shard: Shard = { v: 1, bookPath: filePath, items };
  try {
    storage().setItem(shardKeyFor(filePath), JSON.stringify(shard));
  } catch { /* 配额满等异常静默忽略，数据不落盘但会话内仍可用 */ }
  updateIndex(filePath);
}

interface IndexEntry { hash: string; bookPath: string }

function readIndex(): IndexEntry[] {
  try {
    const raw = storage().getItem(INDEX_KEY);
    const parsed = raw ? (JSON.parse(raw) as IndexEntry[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function updateIndex(filePath: string): void {
  try {
    const hash = hashBookPath(filePath);
    const idx = readIndex();
    if (!idx.some((e) => e.hash === hash)) {
      idx.push({ hash, bookPath: filePath });
      storage().setItem(INDEX_KEY, JSON.stringify(idx));
    }
  } catch { /* 忽略 */ }
}

// ============ CRUD ============

function genId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* 忽略 */ }
  return `hl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sortRecords(items: HighlightRecord[]): HighlightRecord[] {
  return [...items].sort((a, b) =>
    a.chapterIndex - b.chapterIndex || a.start - b.start || (a.createdAt - b.createdAt),
  );
}

/** 列出一本书的全部高亮（按章节序号 + 章内偏移排序） */
export function listHighlights(filePath: string): HighlightRecord[] {
  return sortRecords(readShard(filePath).items);
}

export function getHighlight(filePath: string, id: string): HighlightRecord | null {
  return readShard(filePath).items.find((h) => h.id === id) || null;
}

/** 批量新增（跨章选区拆分后一次落盘），返回按入参顺序的完整记录 */
export function addHighlights(filePath: string, inputs: NewHighlight[]): HighlightRecord[] {
  if (inputs.length === 0) return [];
  const shard = readShard(filePath);
  const now = Date.now();
  const created = inputs.map((input) => {
    const rec: HighlightRecord = {
      ...input,
      note: input.note ?? '',
      color: input.color ?? 'yellow',
      noteId: input.noteId ?? null,
      id: input.id || genId(),
      createdAt: now,
      updatedAt: now,
    };
    return rec;
  });
  writeShard(filePath, [...shard.items, ...created]);
  return created;
}

export function addHighlight(filePath: string, input: NewHighlight): HighlightRecord {
  return addHighlights(filePath, [input])[0];
}

/** 局部更新（含 stale/漂移位置回写） */
export function updateHighlight(
  filePath: string,
  id: string,
  patch: Partial<Omit<HighlightRecord, 'id' | 'createdAt'>>,
  opts?: { touch?: boolean },
): HighlightRecord | null {
  const shard = readShard(filePath);
  const idx = shard.items.findIndex((h) => h.id === id);
  if (idx < 0) return null;
  const prev = shard.items[idx];
  const next: HighlightRecord = { ...prev, ...patch, id: prev.id, createdAt: prev.createdAt };
  if (opts?.touch !== false) next.updatedAt = Date.now();
  const items = [...shard.items];
  items[idx] = next;
  writeShard(filePath, items);
  return next;
}

export function deleteHighlight(filePath: string, id: string): boolean {
  const shard = readShard(filePath);
  const items = shard.items.filter((h) => h.id !== id);
  if (items.length === shard.items.length) return false;
  writeShard(filePath, items);
  return true;
}

/** 删除一本书的所有分片数据（含索引条目） */
export function clearBookHighlights(filePath: string): void {
  try {
    storage().removeItem(shardKeyFor(filePath));
    const idx = readIndex().filter((e) => e.hash !== hashBookPath(filePath));
    storage().setItem(INDEX_KEY, JSON.stringify(idx));
  } catch { /* 忽略 */ }
}

/** 按章索引表：chapterId → 该章高亮（章内按 start 排序）。无 id 的书兜底用 'idx:<chapterIndex>' */
export function buildChapterIndexMap(items: HighlightRecord[]): Map<string, HighlightRecord[]> {
  const map = new Map<string, HighlightRecord[]>();
  for (const h of sortRecords(items)) {
    const key = h.chapterId || `idx:${h.chapterIndex}`;
    const arr = map.get(key);
    if (arr) arr.push(h);
    else map.set(key, [h]);
  }
  return map;
}

/** 枚举所有有高亮数据的书籍路径（供命令面板全局搜索；经索引 key） */
export function listBooksWithPath(): string[] {
  return readIndex().map((e) => e.bookPath);
}

// ============ quote 漂移校验 ============

/**
 * 在章节纯文本中定位高亮。返回命中起点；彻底找不到返回 null（调用方标 stale，不删除）。
 * 顺序：1) 原位置精确匹配 → 2) quote 全文唯一 → 3) prefix+quote / quote+suffix 上下文定位。
 */
export function findQuotePosition(
  text: string,
  h: Pick<HighlightRecord, 'start' | 'end' | 'quote' | 'prefix' | 'suffix'>,
): number | null {
  if (!h.quote) return null;
  // 1) 位置精确命中
  if (h.start >= 0 && h.end <= text.length && text.slice(h.start, h.end) === h.quote) return h.start;
  // 2) 全文唯一命中：直接采用新位置（漂移）
  const first = text.indexOf(h.quote);
  if (first >= 0 && text.indexOf(h.quote, first + 1) === -1) return first;
  // 3) 上下文消歧：prefix+quote 或 quote+suffix 组合命中（各自唯一也算）
  const combos = [
    h.prefix ? h.prefix + h.quote : null,
    h.suffix ? h.quote + h.suffix : null,
  ].filter((s): s is string => !!s);
  for (const combo of combos) {
    const i = text.indexOf(combo);
    if (i < 0) continue;
    const quoteStart = i + (combo === combos[0] && h.prefix ? h.prefix.length : 0);
    if (text.indexOf(combo, i + 1) === -1) return quoteStart;
    // 多处命中时取离原 start 最近的一处
    let best = -1;
    let cursor = i;
    while (cursor !== -1) {
      if (best < 0 || Math.abs(cursor - h.start) < Math.abs(best - h.start)) best = cursor;
      cursor = text.indexOf(combo, cursor + 1);
    }
    return best + (combo === combos[0] && h.prefix ? h.prefix.length : 0);
  }
  return null;
}

export interface ValidateResult {
  record: HighlightRecord;
  /** 位置相对存储值发生变化（含 stale→恢复） */
  changed: boolean;
  /** 已漂移（位置更新，quote 仍可显示） */
  drifted: boolean;
  /** 原文彻底找不到 */
  stale: boolean;
}

/**
 * 用当前章节纯文本校验一条高亮：命中则回写新 start/end（end = start + quote.length），
 * 未命中则标 stale。只做纯计算，落盘由调用方决定（避免每帧写 localStorage）。
 */
export function validateHighlightAgainstText(record: HighlightRecord, text: string): ValidateResult {
  const pos = findQuotePosition(text, record);
  if (pos == null) {
    return { record: { ...record, stale: true }, changed: !record.stale, drifted: false, stale: true };
  }
  const end = pos + record.quote.length;
  const changed = record.stale === true || record.start !== pos || record.end !== end;
  const drifted = !record.stale && (record.start !== pos || record.end !== end);
  const next: HighlightRecord = { ...record, start: pos, end, stale: undefined };
  if (record.stale) delete next.stale;
  return { record: next, changed, drifted, stale: false };
}

// ============ 笔记导出（Markdown 幂等生成） ============

export interface NoteChapter {
  index: number;
  id: string;
  title: string;
}

/**
 * 生成「读书笔记」Markdown（纯函数、确定性输出 → 同输入两次导出内容逐字节一致，幂等）。
 * 按章分组；每条高亮：引用原文 + 批注 + HTML 注释（内嵌高亮 id，回链用）。
 */
export function buildReadingNoteMarkdown(
  bookTitle: string,
  filePath: string,
  chapters: NoteChapter[],
  items: HighlightRecord[],
): string {
  const noteId = noteIdForBook(filePath);
  const live = items.filter((h) => !h.stale);
  const byChapter = buildChapterIndexMap(live);
  const lines: string[] = [];
  lines.push(`# ${bookTitle} 读书笔记`);
  lines.push('');
  lines.push(`<!-- reading-note:${noteId} · 由「${bookTitle}」的高亮与批注导出 -->`);
  lines.push('');

  if (live.length === 0) {
    lines.push('（暂无高亮批注）');
    lines.push('');
    return lines.join('\n');
  }

  // 章节顺序 = chapterIndex 升序；章内 = start 升序（buildChapterIndexMap 已排序）
  const consumed = new Set<string>();
  const ordered = chapters
    .map((c) => {
      const list = byChapter.get(c.id) || byChapter.get(`idx:${c.index}`) || [];
      if (list.length > 0) consumed.add(c.id || `idx:${c.index}`);
      return { c, list };
    })
    .filter((g) => g.list.length > 0);

  // 孤儿记录（章节列表中找不到：书未加载完/章节重排）单独归组，不静默丢弃
  const orphans: HighlightRecord[] = [];
  for (const [key, list] of byChapter) {
    if (!consumed.has(key)) orphans.push(...list);
  }
  if (orphans.length > 0) {
    ordered.push({ c: { index: -1, id: '', title: '未归章' }, list: sortRecords(orphans) });
  }

  for (const g of ordered) {
    lines.push(`## ${g.c.index + 1}. ${g.c.title || `第 ${g.c.index + 1} 章`}`);
    lines.push('');
    for (const h of g.list) {
      lines.push(`> ${h.quote.replace(/\n/g, '\n> ')}`);
      if (h.note && h.note.trim()) {
        lines.push('>');
        lines.push(`> —— ${h.note.trim().replace(/\n/g, '\n> —— ')}`);
      }
      lines.push('');
      lines.push(`<!-- highlight:${h.id} · ${h.color} -->`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

// ============ 变更广播（ReadingView 与 Sidebar 之间的弱耦合通道） ============

export const HIGHLIGHTS_CHANGED_EVENT = 'andy:reading-highlights-changed';

export function emitHighlightsChanged(filePath: string): void {
  try {
    if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
      window.dispatchEvent(new CustomEvent(HIGHLIGHTS_CHANGED_EVENT, { detail: { filePath } }));
    }
  } catch { /* 非浏览器环境 */ }
}

/** 订阅高亮变更（返回取消函数；测试环境无 window 时为 no-op） */
export function onHighlightsChanged(handler: (filePath: string) => void): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
  const listener = (e: Event) => {
    const fp = (e as CustomEvent<{ filePath?: string }>).detail?.filePath;
    if (fp) handler(fp);
  };
  window.addEventListener(HIGHLIGHTS_CHANGED_EVENT, listener);
  return () => { try { window.removeEventListener(HIGHLIGHTS_CHANGED_EVENT, listener); } catch { /* 忽略 */ } };
}
