// 密码库条目选择器：给「API Key / 平台凭据」字段提供引用（不复制明文）。
// 锁定态支持**就地临时解锁**（主密码 / 生物识别），不必跳到密码托管模块。
// 解锁沿用同一套后端命令与自动锁定策略；引用的密钥在发请求时解析，故解锁态需保持到自动锁定。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { KeyRound, X } from 'lucide-react';

interface VaultItemLite {
  id: string;
  kind: string;
  title: string;
  username: string;
  deletedAtMs: number | null;
}

interface VaultStatusLite {
  exists: boolean;
  unlocked: boolean;
  biometricSupported: boolean;
  biometricDetail: string;
}

function errText(e: unknown): string {
  return typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
}

export function VaultRefPicker({
  onPick,
  onClose,
}: {
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<VaultStatusLite | null>(null);
  const [items, setItems] = useState<VaultItemLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [password, setPassword] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const st = await invoke<VaultStatusLite>('vault_status');
      setStatus(st);
      if (st.exists && st.unlocked) {
        const list = await invoke<VaultItemLite[]>('vault_list');
        setItems(list.filter((i) => !i.deletedAtMs && (i.kind === 'apiKey' || i.kind === 'login')));
      } else {
        setItems([]);
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const unlock = async (mode: 'password' | 'biometric') => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'password') {
        if (!password) return;
        await invoke('vault_unlock', { password });
        setPassword('');
      } else {
        await invoke('vault_unlock_biometric');
      }
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const filtered = useMemo(() => {
    const list = items ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((i) => `${i.title} ${i.username}`.toLowerCase().includes(q));
  }, [items, query]);

  const locked = !!status?.exists && !status.unlocked;
  const missing = status !== null && !status.exists;

  return (
    <div className="fixed inset-0 z-[var(--layer-fullscreen)] flex items-center justify-center bg-black/40 p-6">
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-stone-900 shadow-2xl border border-neutral-200 dark:border-stone-700 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-200/70 dark:border-stone-700/60">
          <div className="flex items-center gap-2 text-sm font-medium text-neutral-800 dark:text-stone-100">
            <KeyRound size={15} />
            从密码库引用
          </div>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600 dark:hover:text-stone-200">
            <X size={16} />
          </button>
        </div>

        {locked ? (
          <div className="p-4 flex flex-col gap-3">
            <div className="text-xs text-neutral-500 dark:text-stone-400">
              密码库已锁定。可直接在这里解锁（与密码托管模块共用同一解锁态，受自动锁定约束）。
            </div>
            <input
              autoFocus
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void unlock('password');
              }}
              placeholder="主密码"
              className="w-full px-3 py-2 rounded-lg text-sm bg-neutral-50 dark:bg-stone-800 border border-neutral-200 dark:border-stone-700 outline-none"
            />
            <div className="flex items-center justify-between gap-2">
              <button
                onClick={() => void unlock('password')}
                disabled={busy || !password}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--element-muted)] text-[var(--element-bg)] disabled:opacity-50"
              >
                {busy ? '解锁中…' : '解锁'}
              </button>
              {status?.biometricSupported && (
                <button
                  onClick={() => void unlock('biometric')}
                  disabled={busy}
                  className="px-3 py-1.5 rounded-lg text-xs hairline hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-50"
                  title={status.biometricDetail}
                >
                  🖐 生物识别解锁
                </button>
              )}
            </div>
            {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
          </div>
        ) : (
          <>
            <div className="p-3">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索条目"
                className="w-full px-3 py-2 rounded-lg text-sm bg-neutral-50 dark:bg-stone-800 border border-neutral-200 dark:border-stone-700 outline-none"
              />
            </div>
            <div className="max-h-72 overflow-auto px-2 pb-2">
              {missing && (
                <div className="px-2 py-3 text-xs text-neutral-500 dark:text-stone-400">
                  尚未创建密码库，请先到 茑萝 → 密码托管 创建。
                </div>
              )}
              {error && <div className="px-2 py-3 text-xs text-red-600 dark:text-red-400">{error}</div>}
              {!error && !missing && items === null && (
                <div className="px-2 py-3 text-xs text-neutral-400 dark:text-stone-500">读取中…</div>
              )}
              {!error && !missing && items !== null && filtered.length === 0 && (
                <div className="px-2 py-3 text-xs text-neutral-400 dark:text-stone-500">
                  {items.length === 0 ? '密码库里没有可引用的条目（API Key / 网站账号）' : '没有匹配条目'}
                </div>
              )}
              {filtered.map((item) => (
                <button
                  key={item.id}
                  onClick={() => onPick(item.id)}
                  className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <div className="text-sm text-neutral-800 dark:text-stone-100 truncate">
                    {item.title || item.username || '(未命名)'}
                  </div>
                  <div className="text-[11px] text-neutral-400 dark:text-stone-500 truncate">
                    {item.kind === 'apiKey' ? 'API Key' : '网站账号'} · {item.username || '—'}
                  </div>
                </button>
              ))}
            </div>
            <div className="px-4 py-2 border-t border-neutral-200/70 dark:border-stone-700/60 text-[11px] text-neutral-400 dark:text-stone-500">
              只保存条目引用，不复制明文；密码库锁定或条目被删时，使用方会明确报错。
            </div>
          </>
        )}
      </div>
    </div>
  );
}
