/// <reference path="../../../global.d.ts" />
// 密码托管主容器：未建库 → 创建；锁定 → 解锁；解锁后 → 列表 / 安全体检 / 设置。
// 刻意不引入宿主 zustand：插件只通过 __HOST_API__ 与 Rust 通信（与其它茑萝子插件同口径）。
const React = window.__HOST_REACT__;
const { useEffect, useMemo, useState } = React;

import {
  blankItem,
  KIND_LABEL,
  vaultApi,
  type AuditEntry,
  type VaultItem,
} from './api';
import { errText, useVault } from './useVault';
import { UnlockScreen, VaultOnboarding, RecoveryCodesDialog } from './UnlockScreen';
import { ItemEditor } from './ItemEditor';
import { SettingsPanel } from './SettingsPanel';
import { PasswordGenerator } from '../../../_shared/PasswordGenerator';
import { setVaultView, useVaultView, type VaultView } from './nav';
import type { ComponentType, ReactNode } from 'react';

// 复用宿主侧栏壳与模块设置面板（与其它茑萝子插件同一套外观/行为）
const SecondaryNavShell = window.__HOST_UI__.SecondaryNavShell as unknown as ComponentType<{
  children?: ReactNode;
}>;
const ModuleSettingsPanel = window.__HOST_UI__.ModuleSettingsPanel as unknown as ComponentType<{
  title: string;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}>;

function fmtDate(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function matches(query: string, item: VaultItem): boolean {
  const q = query.trim();
  if (!q) return true;
  const hay = `${item.title} ${item.username} ${item.urls.join(' ')} ${item.tags.join(' ')} ${item.notes}`;
  const scorer = window.__HOST_API__.fuzzyScore;
  if (typeof scorer === 'function') return scorer(q, hay) > 0;
  return hay.toLowerCase().includes(q.toLowerCase());
}

function SecurityPanel({ items, busy }: { items: VaultItem[]; busy: boolean }) {
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditError, setAuditError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const rows = await vaultApi.auditLog(80);
        if (alive) setAudit(rows);
      } catch (e) {
        if (alive) setAuditError(errText(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [busy]);

  const active = items.filter((i) => !i.deletedAtMs);

  const weak = active.filter(
    (i) =>
      i.password &&
      (i.password.length < 12 || /^[a-zA-Z]+$/.test(i.password) || /^\d+$/.test(i.password)),
  );

  const reuseCount = new Map<string, number>();
  for (const i of active) if (i.password) reuseCount.set(i.password, (reuseCount.get(i.password) ?? 0) + 1);
  const reused = active.filter((i) => i.password && (reuseCount.get(i.password) ?? 0) > 1);

  const halfYear = Date.now() - 180 * 24 * 3600 * 1000;
  const stale = active.filter((i) => i.updatedAtMs > 0 && i.updatedAtMs < halfYear);

  const noTotp = active.filter((i) => i.kind === 'login' && !i.totpSecret);

  const card = (title: string, count: number, hint: string, list: VaultItem[], tone: string) => (
    <div className="rounded-xl bg-white/60 dark:bg-stone-900/40 p-3.5">
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-medium">{title}</div>
        <div className={`text-lg font-semibold ${tone}`}>{count}</div>
      </div>
      <div className="text-[11px] text-neutral-400 dark:text-stone-500">{hint}</div>
      {list.length > 0 && (
        <div className="mt-2 flex flex-col gap-0.5 max-h-36 overflow-auto">
          {list.slice(0, 30).map((i) => (
            <div key={i.id} className="text-xs truncate text-neutral-600 dark:text-stone-300">
              · {i.title || i.username || '(未命名)'}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="h-full overflow-auto p-4 flex flex-col gap-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {card('弱密码', weak.length, '少于 12 位、纯字母或纯数字', weak, 'text-amber-600 dark:text-amber-400')}
        {card('重复使用', reused.length, '多个条目共用同一密码', reused, 'text-red-600 dark:text-red-400')}
        {card('超过半年未更新', stale.length, '180 天内没有修改过', stale, 'text-amber-600 dark:text-amber-400')}
        {card('未绑定 TOTP', noTotp.length, '网站账号建议开启二次验证', noTotp, 'text-neutral-500 dark:text-stone-400')}
      </div>

      <div className="rounded-xl bg-white/60 dark:bg-stone-900/40 p-3.5">
        <div className="text-sm font-medium">操作审计（最近 {audit.length} 条）</div>
        <div className="text-[11px] text-neutral-400 dark:text-stone-500">
          只记录动作与条目标题，不记录任何密码或口令。
        </div>
        {auditError && <div className="mt-2 text-xs text-red-600 dark:text-red-400">{auditError}</div>}
        <div className="mt-2 flex flex-col gap-1 max-h-72 overflow-auto">
          {audit.length === 0 && <div className="text-xs text-neutral-400 dark:text-stone-500">暂无记录</div>}
          {audit
            .slice()
            .reverse()
            .map((row, idx) => (
              <div key={`${row.atMs}-${idx}`} className="flex items-center gap-2 text-xs">
                <span className="w-28 shrink-0 text-neutral-400 dark:text-stone-500">
                  {fmtDate(row.atMs)}
                </span>
                <span className="w-32 shrink-0 font-mono text-[11px] text-neutral-500 dark:text-stone-400">
                  {row.action}
                </span>
                <span className="flex-1 truncate">{row.detail}</span>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

function VaultModule() {
  const hook = useVault();
  const { status, items, busy, error, reload, run } = hook;
  const view = useVaultView();
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<VaultItem | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [confirmPurgeId, setConfirmPurgeId] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const visible = useMemo(() => {
    let list = items.filter((i) => (view === 'trash' ? !!i.deletedAtMs : !i.deletedAtMs));
    if (view === 'favorites') list = list.filter((i) => i.favorite);
    list = list.filter((i) => matches(query, i));
    return list.sort(
      (a, b) => Number(b.favorite) - Number(a.favorite) || b.updatedAtMs - a.updatedAtMs,
    );
  }, [items, view, query]);

  // 宿主侧栏齿轮：派发 module-settings-toggle → 打开本模块设置（与其它子插件同一契约）
  useEffect(() => {
    const onModuleSettings = (e: Event) => {
      const detail = (e as CustomEvent<{ moduleId?: string }>).detail;
      if (!detail?.moduleId || detail.moduleId === 'vault') setVaultView('settings');
    };
    window.addEventListener('module-settings-toggle', onModuleSettings);
    return () => window.removeEventListener('module-settings-toggle', onModuleSettings);
  }, []);

  if (!status) {
    return (
      <div className="h-full flex items-center justify-center bg-[#f5f5f0] dark:bg-[#1c1917] text-xs text-neutral-400">
        正在读取密码库状态…
      </div>
    );
  }

  if (!status.exists) {
    return (
      <VaultOnboarding
        run={run}
        minPasswordChars={status.minPasswordChars}
        busy={busy}
        error={error}
        onCreated={setRecoveryCodes}
      />
    );
  }

  if (!status.unlocked) {
    return <UnlockScreen status={status} run={run} busy={busy} error={error} />;
  }

  const openNew = () => {
    setDraft(blankItem());
    setIsNew(true);
    setVaultView('all');
  };

  const select = (item: VaultItem) => {
    setDraft(item);
    setIsNew(false);
  };

  const save = async (item: VaultItem): Promise<string | null> => {
    try {
      const saved = await vaultApi.saveItem(item);
      await reload();
      setDraft(saved);
      setIsNew(false);
      return null;
    } catch (e) {
      return errText(e);
    }
  };

  const trash = async (item: VaultItem) => {
    try {
      await vaultApi.deleteItem(item.id, false);
      await reload();
      setDraft(null);
      setIsNew(false);
    } catch (e) {
      window.console.error('[vault] 移入回收站失败', e);
    }
  };

  return (
    <div className="h-full flex flex-col bg-[#f5f5f0] dark:bg-[#1c1917]" data-vault-ui>
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/80 dark:border-stone-700/50">
        <div className="text-sm font-semibold shrink-0">密码托管</div>
        <div className="text-[11px] text-neutral-400 dark:text-stone-500 shrink-0">
          {status.itemCount} 条 · 回收站 {status.trashedCount}
        </div>
        <div className="flex-1" />
        {(view === 'all' || view === 'favorites' || view === 'trash') && (
          <>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索标题 / 账号 / 网址 / 标签"
              className="w-56 px-2.5 py-1.5 rounded-lg text-xs bg-white/70 dark:bg-stone-800/60 border border-neutral-200/80 dark:border-stone-700/60 outline-none"
            />
            <button
              onClick={openNew}
              className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[var(--element-muted)] text-[var(--element-bg)]"
            >
              + 新建
            </button>
          </>
        )}
        <button
          onClick={() => setGeneratorOpen(true)}
          className="px-2.5 py-1.5 rounded-lg text-xs hairline hover:bg-black/5 dark:hover:bg-white/10"
        >
          生成器
        </button>
        <button
          onClick={() => void run(() => vaultApi.lock())}
          className="px-2.5 py-1.5 rounded-lg text-xs hairline hover:bg-black/5 dark:hover:bg-white/10"
        >
          锁定
        </button>
      </div>

      {(busy || error) && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-white/80 dark:border-stone-700/50">
          {busy && <span className="text-[11px] text-neutral-400">处理中…</span>}
          {error && (
            <span className="text-[11px] text-red-600 dark:text-red-400 truncate">{error}</span>
          )}
        </div>
      )}

      {view === 'security' ? (
        <SecurityPanel items={items} busy={busy} />
      ) : view === 'settings' ? (
        <ModuleSettingsPanel
          title="密码托管"
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
          }
          onClose={() => setVaultView('all')}
        >
          <SettingsPanel status={status} run={run} busy={busy} error={error} />
        </ModuleSettingsPanel>
      ) : (
        <div className="flex-1 min-h-0 flex">
          <div className="w-72 shrink-0 border-r border-white/80 dark:border-stone-700/50 overflow-auto">
            {visible.length === 0 && (
              <div className="p-4 text-xs text-neutral-400 dark:text-stone-500">
                {view === 'trash' ? '回收站是空的' : query ? '没有匹配的条目' : '还没有条目，点右上角「新建」'}
              </div>
            )}
            {visible.map((item) => (
              <div
                key={item.id}
                className={`mx-1.5 my-1 px-2.5 py-2 rounded-lg cursor-pointer ${
                  draft?.id === item.id
                    ? 'bg-[var(--element-muted)]/15'
                    : 'hover:bg-black/5 dark:hover:bg-white/5'
                }`}
                onClick={() => (view === 'trash' ? undefined : select(item))}
              >
                <div className="flex items-center gap-1.5">
                  {item.favorite && <span className="text-amber-500 text-[11px]">★</span>}
                  <span className="flex-1 text-xs font-medium truncate">
                    {item.title || item.username || '(未命名)'}
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/10 text-neutral-500 dark:text-stone-400 shrink-0">
                    {KIND_LABEL[item.kind]}
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] text-neutral-400 dark:text-stone-500 truncate">
                  {item.username || item.urls[0] || '—'}
                </div>
                {view === 'trash' && (
                  <div className="mt-1 flex items-center gap-1">
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        try {
                          await vaultApi.restoreItem(item.id);
                          await reload();
                        } catch (err) {
                          window.console.error('[vault] 还原失败', err);
                        }
                      }}
                      className="text-[10px] px-1.5 py-0.5 rounded hairline hover:bg-black/5 dark:hover:bg-white/10"
                    >
                      还原
                    </button>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (confirmPurgeId !== item.id) {
                          setConfirmPurgeId(item.id);
                          setTimeout(() => setConfirmPurgeId(null), 3000);
                          return;
                        }
                        try {
                          await vaultApi.deleteItem(item.id, true);
                          setConfirmPurgeId(null);
                          await reload();
                        } catch (err) {
                          window.console.error('[vault] 永久删除失败', err);
                        }
                      }}
                      className="text-[10px] px-1.5 py-0.5 rounded text-red-500 hover:bg-red-500/10"
                    >
                      {confirmPurgeId === item.id ? '确认永久删除？' : '永久删除'}
                    </button>
                  </div>
                )}
              </div>
            ))}
            {view === 'trash' && items.some((i) => i.deletedAtMs) && (
              <div className="p-2">
                <button
                  onClick={async () => {
                    try {
                      await vaultApi.emptyTrash();
                      await reload();
                    } catch (err) {
                      window.console.error('[vault] 清空回收站失败', err);
                    }
                  }}
                  className="w-full px-2 py-1.5 rounded-md text-[11px] text-red-500 hover:bg-red-500/10"
                >
                  清空回收站
                </button>
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0">
            {draft ? (
              <ItemEditor
                item={draft}
                isNew={isNew}
                saving={busy}
                onSave={save}
                onDelete={trash}
                onClose={() => {
                  setDraft(null);
                  setIsNew(false);
                }}
              />
            ) : (
              <div className="h-full flex flex-col items-center justify-center gap-2 text-neutral-400 dark:text-stone-500">
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <div className="text-xs">左侧选择一条，或点「+ 新建」</div>
              </div>
            )}
          </div>
        </div>
      )}

      {generatorOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
          <div className="w-full max-w-md rounded-2xl bg-[#f5f5f0] dark:bg-[#1c1917] p-5 shadow-2xl">
            <PasswordGenerator onClose={() => setGeneratorOpen(false)} />
          </div>
        </div>
      )}

      {recoveryCodes && (
        <RecoveryCodesDialog
          codes={recoveryCodes}
          onDone={() => setRecoveryCodes(null)}
          title="备用验证码（只显示这一次）"
        />
      )}
    </div>
  );
}

const SIDEBAR_VIEWS: { key: VaultView; label: string; icon: ReactNode }[] = [
  {
    key: 'all',
    label: '全部条目',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 9h18" />
      </svg>
    ),
  },
  {
    key: 'favorites',
    label: '收藏',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="m12 3 2.9 6.1 6.6.9-4.8 4.6 1.2 6.6L12 18.1 6.1 21.2l1.2-6.6L2.5 10l6.6-.9z" />
      </svg>
    ),
  },
  {
    key: 'trash',
    label: '回收站',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
      </svg>
    ),
  },
  {
    key: 'security',
    label: '安全体检',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    ),
  },
  {
    key: 'settings',
    label: '设置',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
      </svg>
    ),
  },
];

function VaultSidebar() {
  const view = useVaultView();
  return (
    <SecondaryNavShell>
      <div className="px-3 pt-2 pb-1 text-[11px] font-medium text-neutral-400 dark:text-stone-500">
        密码库
      </div>
      {SIDEBAR_VIEWS.map((item) => (
        <button
          key={item.key}
          onClick={() => setVaultView(item.key)}
          className={`mx-1 mb-0.5 w-[calc(100%-8px)] flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-sm transition-colors ${
            view === item.key
              ? 'bg-black/5 dark:bg-white/10 text-neutral-800 dark:text-stone-100 font-medium'
              : 'text-neutral-600 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5'
          }`}
        >
          <span className="w-4 h-4 shrink-0">{item.icon}</span>
          <span className="flex-1 truncate">{item.label}</span>
        </button>
      ))}
      <div className="px-3 pt-3 text-[11px] leading-relaxed text-neutral-400 dark:text-stone-500">
        仅存本机 · 自动锁定
        <br />
        主密码 / 本机免密 / 备用码
      </div>
    </SecondaryNavShell>
  );
}

export { VaultModule, VaultSidebar };
