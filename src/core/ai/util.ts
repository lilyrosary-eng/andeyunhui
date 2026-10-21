// AI 对话共用工具函数：id 生成、标题推断、会话工厂、localStorage 持久化。
import type { ChatMsg, Conversation } from '@/components/capsule/types';
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

/**
 * 这些标题是"还没起名"的占位，不是用户的选择。
 *
 * `makeConv()` 给的默认标题是「新对话」——如果自动命名只判"标题是否为空"，
 * 新建的会话会永远叫「新对话」（2026-10-21 修正命名逻辑时差点踩到）。
 */
const PLACEHOLDER_TITLES = new Set(['新对话', '新会话', '新聊天', '群聊']);

export function isPlaceholderTitle(title: string): boolean {
  const t = title.trim();
  return !t || PLACEHOLDER_TITLES.has(t);
}

/**
 * 这一轮该用什么标题 —— **只在占位标题上生成一次**，之后永不改动。
 *
 * 为什么要抽成纯函数：原来的实现写成
 * `c.title || c.messages.length === 0 ? genTitle(content) : c.title`，
 * `||` 优先级高于 `?:`，整个前项被当成条件 ⇒ **每轮都重新命名**
 * （用户实测"每轮对话都被改名"）。这种优先级 bug 写在 hook 里没人测得到，
 * 抽出来才能用单测钉住"第二次调用必须原样返回"。
 */
/**
 * 把"当前显示的文本"回填到它自己的版本槽位（重新生成的多版本）。
 *
 * 版本模型：`versions[i]` 是第 i 版的定稿文本，`content` 永远等于 `versions[versionIndex]`。
 * 流式期间 `content` 是活的、`versions[最后一位]` 是空占位 —— 所以任何动版本的操作
 * （切版本 / 再次重新生成）都必须先做这一步，否则会把空串固化、或把旧文本写错槽位。
 */
export function freezeVersions(m: Pick<ChatMsg, 'content' | 'versions' | 'versionIndex'>): string[] {
  const vs = m.versions?.length ? m.versions.slice() : [m.content];
  const vi = Math.min(Math.max(m.versionIndex ?? 0, 0), vs.length - 1);
  vs[vi] = m.content;
  return vs;
}

export function resolveTitle(
  conv: { title: string; titleLocked?: boolean },
  firstUserText: string,
): string {
  if (conv.titleLocked) return conv.title;
  return isPlaceholderTitle(conv.title) ? genTitle(firstUserText) : conv.title;
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
/** 单条回复最多保留的历史版本数（重新生成产生）。超出按最旧丢弃。 */
const MAX_VERSIONS = 5;

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
/**
 * **整个持久化列表**（最多 50 个会话共享）的字符上限。
 *
 * 血案（2026-10-19）：MEDIA_BUDGET_CHARS 是**每个会话各一份**，50 个会话理论上能写
 * 50 × 1.5M = 7500 万字符；localStorage 配额只有 5MB（UTF-16 约 260 万字符），
 * 而且还要和 IDE 设置 / 办公文档 / 桌宠设置共用。一旦撞满，`setJSON` 抛
 * QuotaExceededError → 用户看到的是"历史记录莫名丢失"。
 * 这里给**整个列表**设 120 万字符（≈2.4MB）硬上限，超出就整体降级为纯文本再写一次：
 * 宁可少存几张图，也不能让整份历史写不进去。
 */
const TOTAL_PERSIST_CHARS = 1_200_000;
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

export function sanitizeConv(
  c: Conversation,
  sharedBudget?: { left: number },
): Conversation {
  if (!c || !Array.isArray(c.messages)) return { ...c, updatedAt: c?.updatedAt ?? Date.now(), messages: [] };
  // 传了共享预算就复用（persistConversations 用一份预算跨全部会话），否则单会话一份
  const budget = sharedBudget ?? { left: MEDIA_BUDGET_CHARS };
  const trimmed = {
    ...c,
    updatedAt: c.updatedAt ?? Date.now(),
    messages: c.messages.map((m) => {
      if (!m) return m;
      let out = m;
      if (typeof m.content === 'string' && m.content.length > MSG_CONTENT_MAX) {
        out = { ...out, content: m.content.slice(0, MSG_CONTENT_MAX) + '…（内容过长已截断）' };
      }
      // 多版本（重新生成）：只留最近 MAX_VERSIONS 版，且每版同样截断。
      // 不截断的话 10 次重新生成 × 20KB 就是 200KB/条，配额很快见底。
      if (out.versions?.length) {
        const all = out.versions;
        const dropped = Math.max(0, all.length - MAX_VERSIONS);
        const kept = all.slice(dropped).map((v) => (
          typeof v === 'string' && v.length > MSG_CONTENT_MAX
            ? v.slice(0, MSG_CONTENT_MAX) + '…（内容过长已截断）'
            : v
        ));
        const rawIdx = out.versionIndex ?? all.length - 1;
        const idx = Math.min(Math.max(rawIdx - dropped, 0), kept.length - 1);
        out = { ...out, versions: kept, versionIndex: idx };
      }
      return out;
    }),
  };
  const withSlimMedia = { ...trimmed, messages: trimmed.messages.map((m) => slimMessageMedia(m, budget)) };
  return slimWorkOutput(withSlimMedia, budget) as Conversation;
}

export function loadConversations(key: string): Conversation[] {
  const arr = storage.getJSON<Conversation[]>(key, []);
  if (!Array.isArray(arr)) return [];
  // 注意：不能写成 `.map(sanitizeConv)` —— map 会把 index 作为第二个实参传进去，
  // 而第二个形参现在是 sharedBudget（对象），类型不兼容且运行期会把 index 当预算用。
  return arr.map((c) => sanitizeConv(c)).filter(Boolean);
}

export function persistConversations(key: string, list: Conversation[]): void {
  const top = list.slice(0, 50);
  // 一份预算跨全部会话：否则"每会话 1.5M 字符"的累计值远超 localStorage 配额
  const budget = { left: MEDIA_BUDGET_CHARS };
  const prepared = top.map((c) => sanitizeConv(c, budget));
  const json = JSON.stringify(prepared);
  if (json.length <= TOTAL_PERSIST_CHARS) {
    storage.setJSON(key, prepared);
    if (budget.left < MEDIA_BUDGET_CHARS) {
      console.info(
        `[ai-chat] 会话持久化：${prepared.length} 个，媒体占用 ${MEDIA_BUDGET_CHARS - budget.left} 字符`,
      );
    }
    return;
  }
  // 仍然超限 → 整体去掉媒体再写一次（正文与结构保留），并显式告警具体数字
  const textOnly = JSON.parse(json, (_k, v) =>
    typeof v === 'string' && v.startsWith('data:') ? '' : v,
  ) as Conversation[];
  const retry = JSON.stringify(textOnly);
  console.warn(
    `[ai-chat] 会话持久化超限（${json.length} > ${TOTAL_PERSIST_CHARS} 字符），` +
      `已丢弃全部内嵌媒体后重写（${retry.length} 字符）；图片/音频不再随历史保存`,
  );
  storage.setJSON(key, textOnly);
}
