/// <reference path="../../../global.d.ts" />
// 密码库状态钩子：唯一数据入口，负责「状态 + 条目」拉取、忙碌态与错误收敛。
// 后端会在闲置超时后自行锁定，所以这里定时轻量轮询 status，避免 UI 停在过期解锁态。
const React = window.__HOST_REACT__;
const { useCallback, useEffect, useState } = React;

import { vaultApi, type VaultItem, type VaultStatus } from './api';

export function errText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

export interface VaultHook {
  status: VaultStatus | null;
  items: VaultItem[];
  busy: boolean;
  error: string | null;
  setError: (v: string | null) => void;
  reload: () => Promise<void>;
  run: <T>(fn: () => Promise<T>) => Promise<T | null>;
}

export function useVault(): VaultHook {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [items, setItems] = useState<VaultItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const st = await vaultApi.status();
      setStatus(st);
      if (st.unlocked) {
        setItems(await vaultApi.list());
      } else {
        setItems([]);
      }
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const timer = setInterval(() => {
      void reload();
    }, 30000);
    return () => clearInterval(timer);
  }, [reload]);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | null> => {
      setBusy(true);
      setError(null);
      try {
        const value = await fn();
        await reload();
        return value;
      } catch (e) {
        setError(errText(e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  return { status, items, busy, error, setError, reload, run };
}
