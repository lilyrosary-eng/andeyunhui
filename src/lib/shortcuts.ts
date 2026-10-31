// 应用内快捷键的读取与匹配（命令面板 / 笔记编辑器共用）
// 配置存放在 storage 的 shortcuts key（GlobalSettingsPanel 的「快捷键」列表）。
import { storage } from '@/core/storage';
import { KEYS } from '@/core/storage/keys';

export interface StoredShortcut {
  id: string;
  label: string;
  keys: string;
}

export interface ParsedShortcut {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

/** 读取某个快捷键的配置值；没有配置时用 fallback。 */
export function loadShortcutKeys(id: string, fallback: string): string {
  try {
    const list = storage.getJSON<StoredShortcut[]>(KEYS.desktop.shortcuts.key, []);
    const hit = Array.isArray(list) ? list.find((s) => s?.id === id) : undefined;
    const keys = hit?.keys?.trim();
    if (!keys) return fallback;
    // 兼容旧配置：链接曾占用 Ctrl+K，现让位给全局命令面板
    if (id === 'link' && keys.replace(/\s+/g, '').toLowerCase() === 'ctrl+k') {
      return 'Ctrl + Shift + K';
    }
    return keys;
  } catch {
    return fallback;
  }
}

export function parseShortcut(keys: string): ParsedShortcut | null {
  const parts = keys.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  let ctrl = false;
  let shift = false;
  let alt = false;
  let key = '';
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (['ctrl', 'control', 'cmd', 'command', 'meta'].includes(lower)) ctrl = true;
    else if (lower === 'shift') shift = true;
    else if (lower === 'alt' || lower === 'option') alt = true;
    else key = lower;
  }
  if (!key) return null;
  return { ctrl, shift, alt, key };
}

/** 判断一次键盘事件是否命中配置的快捷键。 */
export function matchesShortcut(keys: string, e: KeyboardEvent): boolean {
  const parsed = parseShortcut(keys);
  if (!parsed) return false;
  const ctrl = e.ctrlKey || e.metaKey;
  return ctrl === parsed.ctrl
    && e.shiftKey === parsed.shift
    && e.altKey === parsed.alt
    && e.key.toLowerCase() === parsed.key;
}

/** 快捷键配置变化时触发（GlobalSettingsPanel 保存/重置后） */
export const SHORTCUTS_CHANGED_EVENT = 'shortcuts-changed';
