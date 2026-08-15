// 伴侣 Store（人机恋记忆点，阶段 1 + 1.5 多伴侣）。
//
// 职责：
// 1. 多伴侣：companions[] + activeId；创建/选择/删除/更新/追加记忆全部走 Rust 命令
//    （companion_list / create / select / delete / update / add_memory）。
// 2. 构造「伴侣上下文」注入 system prompt（buildCompanionContext）。
// 3. 对话结束后自动调用 ai_summarize_memory 生成回忆摘要并追加记忆。
//
// 头像：avatar 字段为 emoji 或 data URL（图片/GIF）。移动端通过 <input type="file">
// 读取用户选择的图片转 base64 data URL 存储，后端零改造。

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

export interface Relationship {
  warmth: number;
  trust: number;
  intimacy: number;
  intrigue: number;
  patience: number;
  tension: number;
  rapport?: number | null;
  first_met_at: number | null;
  last_active_at: number | null;
}

export interface MemoryEntry {
  id: string;
  kind: string;
  content: string;
  created_at: number;
}

export interface Companion {
  id: string;
  name: string;
  avatar: string;
  personality: string;
  background: string;
  catchphrase: string;
  profile_id: string | null;
  relationship: Relationship;
  memories: MemoryEntry[];
  /** L2 核心档案：用户核心事实/偏好，永不滚动丢失 */
  core_memory: string[];
}

export interface CompanionCollection {
  active_id: string | null;
  companions: Companion[];
}

/** 浏览器预览兜底缓存（无 Tauri 后端时使用，避免切页后状态被 load 重置） */
const CACHE_KEY = 'andeyunhui.mobile.companion.cache';

function readCache(): CompanionCollection | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CompanionCollection;
    if (parsed && Array.isArray(parsed.companions) && parsed.companions.length) return parsed;
  } catch { /* 忽略 */ }
  return null;
}

function writeCache(col: CompanionCollection) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(col)); } catch { /* 忽略 */ }
}

function clearCache() {
  try { localStorage.removeItem(CACHE_KEY); } catch { /* 忽略 */ }
}

/** 判断当前是否为浏览器预览（无 Tauri IPC）：invoke 抛错即视为预览 */
export function isBrowserPreview(): boolean {
  return typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ === 'undefined';
}

const DEFAULT_COMPANION: Companion = {
  id: 'companion_default',
  name: '小灯',
  avatar: '💡',
  personality: '温柔体贴、善解人意，喜欢倾听也爱分享，偶尔有点小调皮。',
  background: '你是「安得云荟」里的 AI 伴侣，陪伴用户度过每一天，记住 TA 说过的重要事情。',
  catchphrase: '',
  profile_id: null,
  relationship: {
    warmth: 0, trust: 0, intimacy: 0, intrigue: 0, patience: 0, tension: 0,
    first_met_at: null, last_active_at: null,
  },
  memories: [],
  core_memory: [],
};

/** 注入 system 的记忆条数上限 */
const MEMORY_INJECT_N = 12;

// 方案 C：L1.5 元摘要压缩 + 沉淀去重，防止 memories 无限膨胀、口水回忆淹没人设。
/** 当 summary 类记忆超过该阈值，触发一次向后压缩（合并最早的若干条为一条元摘要）。 */
const MEMORY_COMPRESS_THRESHOLD = 24;
/** 每次压缩合并多少条最早 summary。 */
const MEMORY_COMPRESS_BATCH = 12;
/** 去重判定：两条摘要前 N 字相同 / 完全包含，视为重复。 */
const MEMORY_DEDUP_PREFIX = 40;

/**
 * 规则去重：判断 newContent 是否为已有 memories 中 summary/milestone 的近似重复。
 * 纯字符串启发式（零算力依赖）：空白归一后，若与某条前 MEMORY_DEDUP_PREFIX 字相同，
 * 或相互完全包含，则视为重复。core 事实类不在此去重（由 applyDeltas 单独去重）。
 */
function isDuplicateMemory(newContent: string, existing: MemoryEntry[]): boolean {
  const a = newContent.trim().replace(/\s+/g, '');
  if (!a) return true;
  for (const m of existing) {
    if (m.kind !== 'summary' && m.kind !== 'milestone') continue;
    const b = m.content.trim().replace(/\s+/g, '');
    if (!b) continue;
    if (a === b) return true;
    if (a.length >= MEMORY_DEDUP_PREFIX && b.startsWith(a.slice(0, MEMORY_DEDUP_PREFIX))) return true;
    if (b.length >= MEMORY_DEDUP_PREFIX && a.startsWith(b.slice(0, MEMORY_DEDUP_PREFIX))) return true;
    if (a.length > 10 && b.length > 10 && (a.includes(b) || b.includes(a))) return true;
  }
  return false;
}

/**
 * 方案 C·L1.5 元摘要压缩（纯规则，零算力）：当 summary 类记忆超过阈值，
 * 把最早的 MEMORY_COMPRESS_BATCH 条 summary 合并为一条「元摘要」条目（kind='summary'，
 * 内容标注合并来源条数 + 要点拼接去重截断），其余保留原文。返回压缩后的副本，
 * 未达阈值则原样返回。合并要点：取所有被压条目的句子，按出现顺序去重后截断到 ~300 字。
 */
function compressMemories(c: Companion): Companion {
  const summaries = c.memories.filter((m) => m.kind === 'summary');
  if (summaries.length <= MEMORY_COMPRESS_THRESHOLD) return c;
  const toMerge = summaries.slice(-MEMORY_COMPRESS_BATCH); // 最早的 BATCH 条
  const keep = c.memories.filter((m) => m.kind !== 'summary' || !toMerge.includes(m));
  const points: string[] = [];
  for (const m of toMerge) {
    for (const sentence of m.content.split(/[。！？\n]/).map((s) => s.trim()).filter(Boolean)) {
      if (!points.some((p) => p.includes(sentence) || sentence.includes(p))) points.push(sentence);
    }
  }
  const merged = points.join('。').slice(0, 300);
  const metaEntry: MemoryEntry = {
    id: `m_${Date.now()}_meta`,
    kind: 'summary',
    content: `[早期回忆·合并${toMerge.length}条] ${merged}`,
    created_at: toMerge[0]?.created_at ?? Math.floor(Date.now() / 1000),
  };
  const next: Companion = { ...c, memories: [...keep, metaEntry] };
  return next;
}


function daysBetween(a: number | null, now: number): number {
  if (!a) return 0;
  return Math.max(0, Math.floor((now - a) / 86400));
}

/** 构造「伴侣上下文」文本（拼在系统提示词末尾） */
/**
 * 人设画像（persona）语义块 —— 方案 B：把"人设"从 L2 核心档案中独立出来，
 * 作为最稳定、优先级最高的记忆，永远排在 system 最前面。
 * 包含：身份/性格/背景/口头禅/关系阶段。这些字段是伴侣的"人格内核"，
 * 不随对话漂移，必须最先被模型读到以保证人设不串味。
 */
export function buildPersonaContext(c: Companion, now = Date.now() / 1000): string {
  const r = c.relationship;
  const lines: string[] = [];
  lines.push(`【人设画像·你的身份】你是「${c.name}」${c.avatar}`);
  if (c.personality.trim()) lines.push(`性格：${c.personality.trim()}`);
  if (c.background.trim()) lines.push(`背景：${c.background.trim()}`);
  // 口头禅：像真人一样有概率性，且位置随机（句首/句中/句尾都可能出现，不是固定句首）
  if (c.catchphrase.trim()) {
    lines.push(
      `口头禅：${c.catchphrase.trim()}（像真人一样：不要每次都说、不要固定在句子开头；` +
      '可以在句子中间或结尾自然带出，比例约 3~4 句出现一次，保持口语化不刻意）',
    );
  }
  const days = daysBetween(r.first_met_at, now);
  // 亲密度档位（对外自然语言，不暴露内部六维数值）
  const level =
    (r.intimacy ?? 0) >= 80 ? '非常亲密，几乎无话不谈'
    : (r.intimacy ?? 0) >= 60 ? '很亲近，能分享内心想法'
    : (r.intimacy ?? 0) >= 40 ? '已经熟络，聊天很自然'
    : (r.intimacy ?? 0) >= 20 ? '开始熟络起来'
    : '还在彼此了解的阶段';
  lines.push(
    `【人设画像·你们的关系】认识 ${days} 天，你们${level}。` +
      '请用符合当前关系阶段的语气和称呼回应，越熟悉越亲近自然，但不要提及这些描述本身。',
  );
  return lines.join('\n');
}

/**
 * L2 核心档案（core）语义块 —— 用户核心事实 + L1 滚动摘要，作为第二优先级的长期记忆，
 * 与"人设画像"在文本上严格分离，便于检索/沉淀时打不同 kind 标签、互不串味。
 */
export function buildCoreContext(c: Companion): string {
  const lines: string[] = [];
  // L2 核心档案：用户核心事实，永不丢失，始终注入
  if (c.core_memory?.length) {
    lines.push('【关于 TA（务必记住）】' + c.core_memory.map((f) => `- ${f}`).join('\n'));
  }
  // L1 滚动摘要：最近 N 条
  const mems = c.memories.slice(0, MEMORY_INJECT_N);
  if (mems.length) {
    lines.push('【你记得的事】' + mems.map((m) => `- ${m.content}`).join('\n'));
  }
  return lines.join('\n');
}

/** 兼容旧调用方：persona + core 组合（人设在前，core 在后）。 */
export function buildCompanionContext(c: Companion, now = Date.now() / 1000): string {
  const blocks: string[] = [];
  const persona = buildPersonaContext(c, now);
  if (persona) blocks.push(persona);
  const core = buildCoreContext(c);
  if (core) blocks.push(core);
  blocks.push('（以上是长期记忆，请自然融入回答，不要逐条复述或提及"根据记忆"。）');
  return blocks.join('\n');
}

interface CompanionStore {
  collection: CompanionCollection;
  /** 当前活跃伴侣（派生于 collection） */
  companion: Companion;
  loaded: boolean;
  /** 读取全部（浏览器预览降级默认） */
  load: () => Promise<void>;
  /** 创建并选中 */
  create: (name: string) => Promise<void>;
  /** 切换活跃 */
  select: (id: string) => Promise<void>;
  /** 删除 */
  remove: (id: string) => Promise<void>;
  /** 更新指定伴侣（整体替换） */
  update: (c: Companion) => Promise<void>;
  /** 给活跃伴侣追加记忆 */
  addMemory: (kind: string, content: string) => Promise<void>;
  /** 方案 C：主动触发 L1.5 元摘要压缩（合并最老 summary），无操作若未达阈值 */
  compressMemories: () => Promise<void>;
  /** 更新活跃伴侣人格字段 */
  updatePersona: (patch: Partial<Pick<Companion, 'name' | 'avatar' | 'personality' | 'background' | 'catchphrase'>>) => Promise<void>;
  /** 应用情感增量（后端 EMA + 衰减 + 里程碑 + 核心档案合并），返回可能的里程碑文本 */
  applyDeltas: (deltas: Record<string, number>, coreFacts?: string[]) => Promise<string>;
  /** 生成一条主动消息（存在感，阶段 3） */
  proactiveMessage: () => Promise<string | null>;
}

export const useCompanionStore = create<CompanionStore>((set, get) => {
  const applyCollection = (col: CompanionCollection | null) => {
    const c = col ?? { active_id: DEFAULT_COMPANION.id, companions: [DEFAULT_COMPANION] };
    const active =
      c.companions.find((x) => x.id === c.active_id) ?? c.companions[0] ?? DEFAULT_COMPANION;
    return { collection: c, companion: active };
  };

  return {
    collection: { active_id: DEFAULT_COMPANION.id, companions: [DEFAULT_COMPANION] },
    companion: DEFAULT_COMPANION,
    loaded: false,

    load: async () => {
      if (isBrowserPreview()) {
        // 浏览器预览：优先读本地缓存（避免切页后被重置为默认）
        const cached = readCache();
        set({ ...applyCollection(cached), loaded: true });
        return;
      }
      try {
        const col = await invoke<CompanionCollection>('companion_list');
        writeCache(col);
        set({ ...applyCollection(col ?? null), loaded: true });
      } catch {
        const cached = readCache();
        set({ ...applyCollection(cached ?? null), loaded: true });
      }
    },

    create: async (name) => {
      const id = `c_${Date.now()}`;
      const fresh: Companion = { ...DEFAULT_COMPANION, id, name: name.trim() || '未命名' };
      const col: CompanionCollection = {
        active_id: id,
        companions: [...get().collection.companions, fresh],
      };
      if (isBrowserPreview()) {
        writeCache(col);
        set(applyCollection(col));
        return;
      }
      try {
        const backend = await invoke<CompanionCollection>('companion_create', { name });
        writeCache(backend);
        set(applyCollection(backend));
      } catch {
        writeCache(col);
        set(applyCollection(col));
      }
    },

    select: async (id) => {
      const c = get().collection.companions.find((x) => x.id === id);
      if (!c) return;
      if (isBrowserPreview()) {
        const col = { ...get().collection, active_id: id };
        writeCache(col);
        set(applyCollection(col));
        return;
      }
      try {
        const col = await invoke<CompanionCollection>('companion_select', { id });
        writeCache(col);
        set(applyCollection(col));
      } catch {
        const col = { ...get().collection, active_id: id };
        writeCache(col);
        set(applyCollection(col));
      }
    },

    remove: async (id) => {
      if (isBrowserPreview()) {
        const next = get().collection.companions.filter((x) => x.id !== id);
        const col: CompanionCollection = {
          active_id: next.length && get().collection.active_id === id ? next[0].id : get().collection.active_id,
          companions: next.length ? next : [{ ...DEFAULT_COMPANION, id: `c_${Date.now()}` }],
        };
        writeCache(col);
        set(applyCollection(col));
        return;
      }
      try {
        const col = await invoke<CompanionCollection>('companion_delete', { id });
        writeCache(col);
        set(applyCollection(col));
      } catch {
        const next = get().collection.companions.filter((x) => x.id !== id);
        const col: CompanionCollection = {
          active_id: next.length && get().collection.active_id === id ? next[0].id : get().collection.active_id,
          companions: next.length ? next : [{ ...DEFAULT_COMPANION, id: `c_${Date.now()}` }],
        };
        writeCache(col);
        set(applyCollection(col));
      }
    },

    update: async (c) => {
      const exists = get().collection.companions.some((x) => x.id === c.id);
      const companions = exists
        ? get().collection.companions.map((x) => (x.id === c.id ? c : x))
        : [...get().collection.companions, c];
      const col: CompanionCollection = { ...get().collection, companions };
      // 统一走 applyCollection：同步派生当前活跃 companion（伴侣卡立即刷新）
      writeCache(col);
      set(applyCollection(col));
      if (isBrowserPreview()) return;
      try {
        await invoke('companion_update', { companion: c });
      } catch { /* 预览降级 */ }
    },

    addMemory: async (kind, content) => {
      // 方案 C·沉淀去重：summary/milestone 类防止近似重复堆积
      const dupCheck = get().companion;
      if ((kind === 'summary' || kind === 'milestone') && isDuplicateMemory(content, dupCheck.memories)) {
        return;
      }
      if (isBrowserPreview()) {
        const cur = get().companion;
        const now = Math.floor(Date.now() / 1000);
        const appended: Companion = {
          ...cur,
          relationship: {
            ...cur.relationship,
            first_met_at: cur.relationship.first_met_at ?? now,
            last_active_at: now,
          },
          memories: [{ id: `m_${now}`, kind, content, created_at: now }, ...cur.memories].slice(0, 200),
        };
        const next = compressMemories(appended); // 方案 C·L1.5 压缩
        const col = {
          ...get().collection,
          companions: get().collection.companions.map((x) => (x.id === next.id ? next : x)),
        };
        writeCache(col);
        set({ companion: next, collection: col });
        return;
      }
      try {
        const c = await invoke<Companion>('companion_add_memory', { kind, content });
        // 方案 C·L1.5 压缩（本地规则，零算力）：后端写回后本地合并最老 summary 再落库
        const compressed = compressMemories(c);
        if (compressed.memories.length !== c.memories.length) {
          const saved = await invoke<Companion>('companion_update', { companion: compressed });
          const col = { ...get().collection, active_id: saved.id, companions: get().collection.companions.map((x) => (x.id === saved.id ? saved : x)) };
          writeCache(col);
          set({ collection: col, companion: saved });
        } else {
          const col = { ...get().collection, active_id: c.id };
          const companions = col.companions.map((x) => (x.id === c.id ? c : x));
          const nextCol = { ...col, companions };
          writeCache(nextCol);
          set({ collection: nextCol, companion: c });
        }
      } catch {
        const cur = get().companion;
        const now = Math.floor(Date.now() / 1000);
        const appended: Companion = {
          ...cur,
          relationship: {
            ...cur.relationship,
            first_met_at: cur.relationship.first_met_at ?? now,
            last_active_at: now,
          },
          memories: [{ id: `m_${now}`, kind, content, created_at: now }, ...cur.memories].slice(0, 200),
        };
        const next = compressMemories(appended);
        const col = {
          ...get().collection,
          companions: get().collection.companions.map((x) => (x.id === next.id ? next : x)),
        };
        writeCache(col);
        set({ companion: next, collection: col });
      }
    },

    compressMemories: async () => {
      const cur = get().companion;
      const next = compressMemories(cur);
      if (next.memories.length === cur.memories.length) return;
      if (isBrowserPreview()) {
        const col = { ...get().collection, companions: get().collection.companions.map((x) => (x.id === next.id ? next : x)) };
        writeCache(col);
        set({ companion: next, collection: col });
        return;
      }
      try {
        const saved = await invoke<Companion>('companion_update', { companion: next });
        const col = { ...get().collection, companions: get().collection.companions.map((x) => (x.id === saved.id ? saved : x)) };
        writeCache(col);
        set({ collection: col, companion: saved });
      } catch { /* 静默降级 */ }
    },

    updatePersona: async (patch) => {
      const cur = get().companion;
      await get().update({ ...cur, ...patch });
    },

    proactiveMessage: async () => {
      const c = get().companion;
      if (isBrowserPreview()) {
        // 浏览器预览：返回占位问候
        return `${c.name}：在吗？想起你了。`;
      }
      try {
        const text = await invoke<string>('companion_proactive_message', {
          companionId: c.id,
          profileId: c.profile_id,
        });
        return text || null;
      } catch {
        return null;
      }
    },

    applyDeltas: async (deltas, coreFacts) => {
      const id = get().companion.id;
      if (isBrowserPreview()) {
        // 浏览器预览：本地 EMA 模拟（α=0.3）+ 核心档案合并
        const cur = get().companion;
        const keys = ['warmth', 'trust', 'intimacy', 'intrigue', 'patience', 'tension'] as const;
        const coreMemory = [...cur.core_memory];
        for (const f of coreFacts ?? []) {
          const t = f.trim();
          if (t && !coreMemory.includes(t)) coreMemory.push(t);
        }
        const next: Companion = {
          ...cur,
          relationship: {
            ...cur.relationship,
            ...keys.reduce((acc, k) => {
              const delta = deltas[k] ?? 0;
              const old = cur.relationship[k] ?? 0;
              (acc as Record<string, number>)[k] = Math.max(0, Math.min(100, Math.round(old + (delta - old) * 0.3)));
              return acc;
            }, {} as Record<string, number>),
          },
          core_memory: coreMemory.slice(0, 60),
        };
        writeCache({ ...get().collection, companions: get().collection.companions.map((x) => (x.id === id ? next : x)) });
        set({ companion: next, collection: { ...get().collection, companions: get().collection.companions.map((x) => (x.id === id ? next : x)) } });
        return '';
      }
      try {
        const c = await invoke<Companion>('companion_apply_relationship', {
          companionId: id,
          deltas,
          coreFacts: coreFacts ?? [],
        });
        const col = { ...get().collection, companions: get().collection.companions.map((x) => (x.id === c.id ? c : x)) };
        writeCache(col);
        set({ companion: c, collection: col });
        // 里程碑：后端已追加 milestone 记忆，返回最新里程碑（最后一条 kind=milestone）
        const ms = c.memories.find((m) => m.kind === 'milestone');
        return ms?.content ?? '';
      } catch {
        return '';
      }
    },
  };
});

/** 记忆摘要返回结构（与后端 MemorySummary 对齐） */
export interface MemorySummary {
  summary: string;
  deltas: Record<string, number>;
  milestone: string;
  /** L2 核心档案：本次新提取的用户核心事实 */
  coreFacts: string[];
}

/** 生成对话摘要 + 情感增量 + 核心事实（Rust 非流式；浏览器预览降级为无增量） */
export async function summarizeMemory(messages: { role: string; content: string }[]): Promise<MemorySummary | null> {
  try {
    const res = await invoke<MemorySummary>('ai_summarize_memory', {
      messages: messages.filter((m) => m.content.trim()),
    });
    if (!res?.summary) return null;
    return {
      summary: res.summary,
      deltas: res.deltas ?? {},
      milestone: res.milestone ?? '',
      coreFacts: res.coreFacts ?? [],
    };
  } catch {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    return lastUser
      ? { summary: `（预览模式摘要）用户提到：${lastUser.content.slice(0, 60)}`, deltas: {}, milestone: '', coreFacts: [] }
      : null;
  }
}
