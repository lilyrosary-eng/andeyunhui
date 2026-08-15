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

export function loadConversations(key: string): Conversation[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map((c: Conversation) => ({ ...c, updatedAt: c.updatedAt ?? Date.now() }));
  } catch {
    return [];
  }
}

export function persistConversations(key: string, list: Conversation[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list.slice(0, 50)));
  } catch {
    /* 容量超限忽略 */
  }
}
