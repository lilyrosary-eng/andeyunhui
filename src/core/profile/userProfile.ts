// 本地账号显示名（不接云）。
// 与 core/avatar/userAvatar.ts 同一套订阅/事件模式：任何模块都能读写，无需 zustand。
import { useSyncExternalStore } from 'react';
import { storage } from '@/core/storage';
import { KEYS } from '@/core/storage/keys';

const KEY = KEYS.desktop.userName.key;
const DEFAULT_NAME = '本地用户';

type Listener = () => void;
const listeners = new Set<Listener>();

function read(): string {
  return storage.getString(KEY, DEFAULT_NAME);
}

let cached: string = read();

function notify() {
  for (const l of listeners) l();
}

function subscribe(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getDisplayName(): string {
  return cached;
}

export function setDisplayName(value: string): void {
  const next = typeof value === 'string' && value.trim() ? value.trim().slice(0, 32) : DEFAULT_NAME;
  if (next === cached) return;
  cached = next;
  storage.setString(KEY, next);
  window.dispatchEvent(new CustomEvent('user-name-changed'));
  notify();
}

export function useDisplayName(): string {
  return useSyncExternalStore(subscribe, () => cached, () => DEFAULT_NAME);
}
