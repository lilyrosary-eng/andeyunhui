// AI 对话共用工具函数：id 生成、标题推断、会话工厂、localStorage 持久化。
import type { ChatMsg, Conversation, MsgVersion } from '@/components/capsule/types';
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
export function freezeVersions(m: Pick<ChatMsg, 'content' | 'versions' | 'versionIndex'>): MsgVersion[] {
  // 老数据（2026-10-21 之前）里 versions 是 string[]，统一成 { text } 形状
  const raw = (m.versions ?? []) as (MsgVersion | string)[];
  const vs: MsgVersion[] = raw.length
    ? raw.map((v) => (typeof v === 'string' ? { text: v } : { ...v }))
    : [{ text: m.content }];
  const vi = Math.min(Math.max(m.versionIndex ?? 0, 0), vs.length - 1);
  vs[vi] = { ...vs[vi], text: m.content };
  return vs;
}

/**
 * 把「当前这条消息之后还活着的对话」压回它当前所在的版本槽位。
 *
 * 切版本、重新生成之前都必须先做：否则活跃尾巴会跟着新版本走丢，
 * 用户切回旧版就永远看不到那段后续了。空尾巴要显式写成 `undefined`，
 * 不能保留旧值 —— 否则「这一版之后本来没有对话」会被上一版的尾巴污染。
 */
export function stashTail(vs: MsgVersion[], index: number, tail: ChatMsg[]): MsgVersion[] {
  const i = Math.min(Math.max(index, 0), vs.length - 1);
  const out = vs.slice();
  out[i] = { ...out[i], tail: tail.length ? tail : undefined };
  return out;
}

/** 取出某一版要装回消息列表的东西（正文 + 该版本的后续）。 */
export function pickVersion(vs: MsgVersion[], index: number): { text: string; tail: ChatMsg[] } {
  const i = Math.min(Math.max(index, 0), vs.length - 1);
  return { text: vs[i]?.text ?? '', tail: vs[i]?.tail ?? [] };
}

export function resolveTitle(
  conv: { title: string; titleLocked?: boolean },
  firstUserText: string,
): string {
  if (conv.titleLocked) return conv.title;
  return isPlaceholderTitle(conv.title) ? genTitle(firstUserText) : conv.title;
}

/** DOM 节点 / React 合成事件的辨识特征。 */
function looksLikeDomOrEvent(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.nodeType === 'number' && typeof o.nodeName === 'string') return true;
  if ('nativeEvent' in o || '_reactName' in o || 'isPersistent' in o) return true;
  return false;
}

/**
 * 校验 `newConversation(seed)` 的种子：**只接受普通对象**。
 *
 * ## 血案（2026-10-21，用户实测"新建对话就报错"）
 * `ModuleSidebarShell` 的 `onClick={primaryAction.onClick}` 把 MouseEvent 当第一参传了出去，
 * 而 AI 对话的 `newConversation(seed?: Partial<Conversation>)` 正好收下并
 * `{ ...makeConv(), ...seed }` —— 事件对象自己的 `target`（HTMLButtonElement）
 * 就这样进了会话，持久化时 `JSON.stringify` 撞上 `__reactFiber$… → FiberNode → stateNode`
 * 的循环引用，整份历史写不进去。
 *
 * 修法分三层：shell 不再传事件（根因）、插件显式 `() => newConversation()`（意图）、
 * 这里拒绝非普通对象（兜住这一类：往后谁再写 `onClick={someFactory}` 也不会污染数据）。
 */
export function sanitizeSeed(seed: unknown): Partial<Conversation> | undefined {
  if (!seed || typeof seed !== 'object' || Array.isArray(seed)) return undefined;
  if (looksLikeDomOrEvent(seed)) {
    console.warn('[ai-chat] newConversation 收到 DOM 节点/React 事件当 seed，已忽略（检查传入方的 onClick 是否多传了事件）');
    return undefined;
  }
  const proto = Object.getPrototypeOf(seed);
  if (proto !== Object.prototype && proto !== null) {
    console.warn('[ai-chat] newConversation 的 seed 不是普通对象，已忽略：', proto?.constructor?.name ?? '<null prototype>');
    return undefined;
  }
  return seed as Partial<Conversation>;
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
/** 每个版本尾巴最多留多少条消息（重新生成中间某条时，旧分支的后续）。 */
const MAX_TAIL_MESSAGES = 40;
/** 分支嵌套深度上限：尾巴里还能再分支，但不许无限套。 */
const MAX_TAIL_DEPTH = 3;

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

/**
 * 单条消息的瘦身（内容截断 + 多版本裁剪 + 媒体预算），**递归**处理版本尾巴。
 *
 * depth 用于兜住"分支里再分支"的递归：超过 MAX_TAIL_DEPTH 就把尾巴丢掉，
 * 宁可丢极端嵌套的历史，也不能让持久化递归到爆栈或把配额吃光。
 */
function sanitizeMessage(m: ChatMsg, budget: { left: number }, depth: number): ChatMsg {
  if (!m) return m;
  let out = m;
  if (typeof m.content === 'string' && m.content.length > MSG_CONTENT_MAX) {
    out = { ...out, content: m.content.slice(0, MSG_CONTENT_MAX) + '…（内容过长已截断）' };
  }
  const rawVersions = (m.versions ?? []) as (MsgVersion | string)[];
  if (rawVersions.length) {
    const dropped = Math.max(0, rawVersions.length - MAX_VERSIONS);
    const kept = rawVersions.slice(dropped).map((v) => {
      const mv: MsgVersion = typeof v === 'string' ? { text: v } : v;
      const text = typeof mv.text === 'string' && mv.text.length > MSG_CONTENT_MAX
        ? mv.text.slice(0, MSG_CONTENT_MAX) + '…（内容过长已截断）'
        : mv.text;
      if (!mv.tail?.length || depth >= MAX_TAIL_DEPTH) return { text } as MsgVersion;
      const cut = mv.tail.length > MAX_TAIL_MESSAGES ? mv.tail.slice(-MAX_TAIL_MESSAGES) : mv.tail;
      return { text, tail: cut.map((tm) => sanitizeMessage(tm, budget, depth + 1)) } as MsgVersion;
    });
    const rawIdx = out.versionIndex ?? rawVersions.length - 1;
    const idx = Math.min(Math.max(rawIdx - dropped, 0), kept.length - 1);
    out = { ...out, versions: kept, versionIndex: idx };
  }
  return slimMessageMedia(out, budget) as ChatMsg;
}

/**
 * 会话持久化前的瘦身：内容截断、版本裁剪（含分支尾巴）、媒体按预算丢弃。
 *
 * 传了共享预算就复用（persistConversations 用一份预算跨全部会话），否则单会话一份。
 */
export function sanitizeConv(
  c: Conversation,
  sharedBudget?: { left: number },
): Conversation {
  if (!c || !Array.isArray(c.messages)) return { ...c, updatedAt: c?.updatedAt ?? Date.now(), messages: [] };
  const budget = sharedBudget ?? { left: MEDIA_BUDGET_CHARS };
  const trimmed: Conversation = {
    ...c,
    updatedAt: c.updatedAt ?? Date.now(),
    messages: c.messages.map((m) => sanitizeMessage(m, budget, 0)),
  };
  return slimWorkOutput(trimmed, budget) as Conversation;
}

export function loadConversations(key: string): Conversation[] {
  const arr = storage.getJSON<Conversation[]>(key, []);
  if (!Array.isArray(arr)) return [];
  // 注意：不能写成 `.map(sanitizeConv)` —— map 会把 index 作为第二个实参传进去，
  // 而第二个形参现在是 sharedBudget（对象），类型不兼容且运行期会把 index 当预算用。
  return arr.map((c) => sanitizeConv(c)).filter(Boolean);
}

/**
 * 序列化会话：正常路径就是 `JSON.stringify`；只有数据结构坏掉时（混进 DOM 节点/事件/循环引用）
 * 才走兜底，并且**大声说清**发生了什么。
 *
 * 为什么要有：2026-10-21 那次 `JSON.stringify` 抛 "Converting circular structure to JSON"，
 * 直接让新建对话整个失败。任何一条脏数据都不该让整份历史写不进去。
 */
function serializeConversations(list: Conversation[]): string {
  try {
    return JSON.stringify(list);
  } catch (e) {
    console.error('[ai-chat] 会话序列化失败（有 DOM 节点 / 事件对象 / 循环引用混进来了），尝试剔除可疑字段重试：', e);
  }
  const strip = (v: unknown, depth = 0): unknown => {
    if (depth > 12) return undefined;
    if (Array.isArray(v)) return v.map((x) => strip(x, depth + 1));
    if (!v || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
    if (looksLikeDomOrEvent(v)) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const s = strip(val, depth + 1);
      if (s !== undefined) out[k] = s;
    }
    return out;
  };
  try {
    const cleaned = strip(list) as Conversation[];
    const json = JSON.stringify(cleaned);
    console.warn('[ai-chat] 已剔除不可序列化字段后写入；请按上面的报错去找污染源');
    return json;
  } catch (e2) {
    console.error('[ai-chat] 剔除后仍无法序列化，本次只保留每条的骨架（id/role/content）：', e2);
    return JSON.stringify(
      list.map((c) => ({
        ...c,
        messages: (c.messages ?? []).map((m) => ({ id: m.id, role: m.role, content: m.content })),
      })),
    );
  }
}

export function persistConversations(key: string, list: Conversation[]): void {
  const top = list.slice(0, 50);
  // 一份预算跨全部会话：否则"每会话 1.5M 字符"的累计值远超 localStorage 配额
  const budget = { left: MEDIA_BUDGET_CHARS };
  const prepared = top.map((c) => sanitizeConv(c, budget));
  const json = serializeConversations(prepared);
  if (json.length <= TOTAL_PERSIST_CHARS) {
    storage.setString(key, json);
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
  storage.setString(key, retry);
}
