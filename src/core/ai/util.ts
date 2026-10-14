// AI 对话共用工具函数：id 生成、标题推断、会话工厂、localStorage 持久化。
import type { Conversation } from '@/components/capsule/types';
import { storage } from '@/core/storage';

export function uid(): string {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 胶囊浮窗与主窗口「AI 对话」共用的历史键（值保持历史命名，不丢胶囊已有数据）。
// 两者共用同一份对话历史，并通过跨 webview 事件实时同步。
export const AI_CHAT_CONVERSATIONS_KEY = 'andeyunhui.capsule.conversations';

// AIWork（AIGC 专业模块）独立的对话历史键：与 AI 对话完全隔离，互不串号。
// 保存自 AIWork 子模块的对话，已从笔记联动中解耦，产出走独立产物库。
export const AI_AIWORK_CONVERSATIONS_KEY = 'andeyunhui.aiwork.conversations';

/**
 * 跨 webview 合并两端会话：按 id 去重，远端更新时间更晚或本地缺失则采用远端，
 * 本地有而远端没有的会话保留（避免任一端操作丢失对端历史）。结果按更新时间倒序。
 */
export function mergeConversations(local: Conversation[], remote: Conversation[]): Conversation[] {
  const map = new Map<string, Conversation>();
  for (const c of local) map.set(c.id, c);
  for (const c of remote) {
    const ex = map.get(c.id);
    if (!ex || (c.updatedAt ?? 0) >= (ex.updatedAt ?? 0)) map.set(c.id, c);
  }
  return [...map.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export function genTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > 18 ? t.slice(0, 18) + '…' : t || '新对话';
}

export function makeConv(): Conversation {
  return {
    id: uid(),
    title: '新对话',
    messages: [],
    updatedAt: Date.now(),
  };
}

/**
 * 群聊会话工厂：必须提供 ≥2 个参与者（companion.id）。
 * 群聊不对胶囊开放，仅主窗口「AI 对话」模块使用。
 * groupCost.calls 初始为 0，仅用于"本次群聊已调用 N 次 AI"的轻量成本提示（不暴露 severity 详情）。
 */
export function makeGroupConv(participantIds: string[], groupName?: string): Conversation {
  const ids = participantIds.filter(Boolean);
  if (ids.length < 2) throw new Error('群聊至少需要 2 个伴侣参与');
  return {
    id: uid(),
    title: groupName?.trim() || `群聊（${ids.length}人）`,
    messages: [],
    updatedAt: Date.now(),
    mode: 'group',
    participants: ids,
    groupName: groupName?.trim() || undefined,
    groupCost: { calls: 0 },
  };
}

// 单条消息 content 安全上限：超过则截断（防止某次流式重复 append 写入的脏数据
// 被持久化后无限回灌，导致群聊把巨 message 带进 history 触发上游 1048576 token 超限）。
// 该上限与后端 truncate_messages_for_safety 的 PER_MSG_TOKEN_CAP(30k) 对齐。
const MSG_CONTENT_MAX = 30_000;

/** 单条媒体 data URL 的持久化上限（字符数；≈220KB 二进制）。超过的一律不进历史。 */
const MEDIA_MAX_CHARS = 300_000;
/**
 * 单个会话持久化的媒体**总量**上限（字符数；≈1.1MB），超出部分按「新的优先」丢弃。
 *
 * 为什么必须有：`agentSteps[].meta` 与蓝图 `node.output` 里挂的是**完整 media data URL**。
 * 早先 sanitizeConv 只截断 `m.content`、完全不碰这两处，于是数 MB 的 base64 被原样写进
 * localStorage；而 `storage.setJSON` 又会静默吞掉 QuotaExceededError —— 表现为
 * 「历史记录莫名丢失」，丢的不是一张图，是**整个会话**。
 * 宁可少存几张图，也不能悄悄丢会话。
 */
const MEDIA_BUDGET_CHARS = 1_500_000;
/** 需要按预算瘦身的媒体字段（与后端 card 词汇一致）。 */
const MEDIA_KEYS = ['image', 'audio', 'video'] as const;

/** 从 data URL 取 MIME（供省略提示用）。 */
function dataUrlMime(u: string): string {
  if (!u.startsWith('data:')) return '';
  const semi = u.indexOf(';');
  return u.slice(5, semi >= 0 ? semi : undefined);
}

/**
 * 按预算瘦身一条消息里的媒体。返回原引用（无变化）或副本。
 * 超预算的媒体**清空本体**并留下 `omitted: <mime>`，UI 据此说明「未随历史保存」。
 */
function slimMessageMedia(m: unknown, budget: { left: number }): unknown {
  if (!m || typeof m !== 'object') return m;
  const msg = m as { agentSteps?: unknown };
  const steps = msg.agentSteps;
  if (!Array.isArray(steps) || steps.length === 0) return m;
  let touched = false;
  const next = steps.slice() as unknown[];
  // 倒序遍历：让**最近生成**的媒体优先占用预算（用户更常回看最近的）
  for (let i = next.length - 1; i >= 0; i--) {
    const step = next[i] as { meta?: Record<string, unknown> } | undefined;
    const meta = step?.meta;
    if (!meta || typeof meta !== 'object') continue;
    const slimmed: Record<string, unknown> = { ...meta };
    let changed = false;
    for (const key of MEDIA_KEYS) {
      const v = slimmed[key];
      if (typeof v !== 'string' || !v.startsWith('data:')) continue;
      if (v.length <= MEDIA_MAX_CHARS && v.length <= budget.left) {
        budget.left -= v.length;
        continue;
      }
      slimmed[key] = '';
      slimmed.omitted = dataUrlMime(v);
      changed = true;
    }
    if (changed) {
      next[i] = { ...step, meta: slimmed };
      touched = true;
    }
  }
  return touched ? { ...msg, agentSteps: next } : m;
}

/** 蓝图节点的 `output` 同样是 media data URL，走同一份预算。 */
function slimWorkOutput(c: unknown, budget: { left: number }): unknown {
  const work = (c as { aiWork?: { nodes?: unknown[] } } | null)?.aiWork;
  if (!work || !Array.isArray(work.nodes)) return c;
  let touched = false;
  const nodes = (work.nodes as unknown[]).map((n) => {
    if (!n || typeof n !== 'object') return n;
    const node = n as { output?: unknown };
    const out = node.output;
    if (typeof out !== 'string' || !out.startsWith('data:')) return n;
    if (out.length <= MEDIA_MAX_CHARS && out.length <= budget.left) {
      budget.left -= out.length;
      return n;
    }
    touched = true;
    return { ...(n as Record<string, unknown>), output: '', outputOmitted: dataUrlMime(out) };
  });
  return touched ? { ...(c as Record<string, unknown>), aiWork: { ...work, nodes } } : c;
}

export function sanitizeConv(c: Conversation): Conversation {
  if (!c || !Array.isArray(c.messages)) return { ...c, updatedAt: c?.updatedAt ?? Date.now(), messages: [] };
  const budget = { left: MEDIA_BUDGET_CHARS };
  const trimmed = {
    ...c,
    updatedAt: c.updatedAt ?? Date.now(),
    messages: c.messages.map((m) => {
      if (m && typeof m.content === 'string' && m.content.length > MSG_CONTENT_MAX) {
        return { ...m, content: m.content.slice(0, MSG_CONTENT_MAX) + '…（内容过长已截断）' };
      }
      return m;
    }),
  };
  const withSlimMedia = { ...trimmed, messages: trimmed.messages.map((m) => slimMessageMedia(m, budget)) };
  return slimWorkOutput(withSlimMedia, budget) as Conversation;
}

export function loadConversations(key: string): Conversation[] {
  const arr = storage.getJSON<Conversation[]>(key, []);
  if (!Array.isArray(arr)) return [];
  return arr.map(sanitizeConv).filter(Boolean);
}

export function persistConversations(key: string, list: Conversation[]): void {
  storage.setJSON(key, list.slice(0, 50).map(sanitizeConv));
}
