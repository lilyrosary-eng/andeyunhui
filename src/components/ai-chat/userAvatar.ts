// 用户头像订阅（ai-chat 模块）。
// 仅该模块用，所以放模块内。如未来要全局，提到 src/core/。
import { useSyncExternalStore } from 'react';

const KEY = 'andeyunhui.aichat.user.avatar';

/** 默认即「你」字图标，与未设置时表现一致。 */
const DEFAULT_AVATAR = '你';

type Listener = () => void;
const listeners = new Set<Listener>();
let cached: string = read();

function read(): string {
  try {
    return localStorage.getItem(KEY) ?? DEFAULT_AVATAR;
  } catch {
    return DEFAULT_AVATAR;
  }
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
  try { localStorage.setItem(KEY, next); } catch { /* 忽略 */ }
  window.dispatchEvent(new CustomEvent('user-avatar-changed'));
  notify();
}

export function useUserAvatar(): string {
  return useSyncExternalStore(subscribe, () => cached, () => DEFAULT_AVATAR);
}
