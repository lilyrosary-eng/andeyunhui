// 用户头像订阅（跨模块通用能力）。
// 任何模块（AI 对话 / 设置 / 伴侣 / 宿主）都可读写用户头像。storage key 沿用历史值以向后兼容。
import { useSyncExternalStore } from 'react';
import { storage } from '@/core/storage';
import { KEYS } from '@/core/storage/keys';

const KEY = KEYS.desktop.userAvatar.key;

/** 默认即「你」字图标，与未设置时表现一致。 */
const DEFAULT_AVATAR = '你';

type Listener = () => void;
const listeners = new Set<Listener>();
let cached: string = read();

function read(): string {
  return storage.getString(KEY, DEFAULT_AVATAR);
}
function notify() {
  for (const l of listeners) l();
}
function subscribe(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getUserAvatar(): string {
  return cached;
}

/** 设置用户头像：emoji 单字符，或 data:image/*base64 全 URL 字符串。
 *  非字符串会被忽略。其它模块通过 CustomEvent 'user-avatar-changed' 也能感知。 */
export function setUserAvatar(value: string): void {
  const next = typeof value === 'string' && value.trim() ? value : DEFAULT_AVATAR;
  if (next === cached) return;
  cached = next;
  storage.setString(KEY, next);
  window.dispatchEvent(new CustomEvent('user-avatar-changed'));
  notify();
}

export function useUserAvatar(): string {
  return useSyncExternalStore(subscribe, () => cached, () => DEFAULT_AVATAR);
}