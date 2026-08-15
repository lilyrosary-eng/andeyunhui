// AI 对话共用工具函数：id 生成、标题推断、会话工厂、localStorage 持久化。
import type { Conversation } from '@/components/capsule/types';

export function uid(): string {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 胶囊浮窗与主窗口「AI 对话」共用的历史键（值保持历史命名，不丢胶囊已有数据）。
// 两者共用同一份对话历史，并通过跨 webview 事件实时同步。
export const AI_CHAT_CONVERSATIONS_KEY = 'andeyunhui.capsule.conversations';

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

function sanitizeConv(c: Conversation): Conversation {
  if (!c || !Array.isArray(c.messages)) return { ...c, updatedAt: c?.updatedAt ?? Date.now(), messages: [] };
  return {
    ...c,
    updatedAt: c.updatedAt ?? Date.now(),
    messages: c.messages.map((m) => {
      if (m && typeof m.content === 'string' && m.content.length > MSG_CONTENT_MAX) {
        return { ...m, content: m.content.slice(0, MSG_CONTENT_MAX) + '…（内容过长已截断）' };
      }
      return m;
    }),
  };
}

export function loadConversations(key: string): Conversation[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map((c: Conversation) => sanitizeConv(c));
  } catch {
    return [];
  }
}

export function persistConversations(key: string, list: Conversation[]): void {
  try {
    const safe = list.slice(0, 50).map(sanitizeConv);
    localStorage.setItem(key, JSON.stringify(safe));
  } catch {
    /* 容量超限忽略 */
  }
}
