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
import { UnlockScreen, VaultOnboarding } from './UnlockScreen';
import { ItemEditor } from './ItemEditor';
import { SettingsPanel } from './SettingsPanel';
import { PasswordGenerator } from '../../../_shared/PasswordGenerator';

type Tab = 'all' | 'favorites' | 'trash' | 'security' | 'settings';

const TABS: { key: Tab; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'favorites', label: '收藏' },
  { key: 'trash', label: '回收站' },
  { key: 'security', label: '安全' },
  { key: 'settings', label: '设置' },
];

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
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<VaultItem | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [confirmPurgeId, setConfirmPurgeId] = useState<string | null>(null);

  const visible = useMemo(() => {
    let list = items.filter((i) => (tab === 'trash' ? !!i.deletedAtMs : !i.deletedAtMs));
    if (tab === 'favorites') list = list.filter((i) => i.favorite);
    list = list.filter((i) => matches(query, i));
    return list.sort(
      (a, b) => Number(b.favorite) - Number(a.favorite) || b.updatedAtMs - a.updatedAtMs,
    );
  }, [items, tab, query]);

  if (!status) {
    return (
      <div className="h-full flex items-center justify-center bg-[#f5f5f0] dark:bg-[#1c1917] text-xs text-neutral-400">
        正在读取密码库状态…
      </div>
    );
  }

  if (!status.exists) {
    return <VaultOnboarding run={run} />;
  }

  if (!status.unlocked) {
    return <UnlockScreen status={status} run={run} busy={busy} error={error} />;
  }

  const openNew = () => {
    setDraft(blankItem());
    setIsNew(true);
    setTab('all');
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
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索标题 / 账号 / 网址 / 标签"
          className="w-56 px-2.5 py-1.5 rounded-lg text-xs bg-white/70 dark:bg-stone-800/60 border border-neutral-200/80 dark:border-stone-700/60 outline-none"
        />
        <button
          onClick={() => setGeneratorOpen(true)}
          className="px-2.5 py-1.5 rounded-lg text-xs hairline hover:bg-black/5 dark:hover:bg-white/10"
        >
          生成器
        </button>
        <button
          onClick={openNew}
          className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[var(--element-muted)] text-[var(--element-bg)]"
        >
          + 新建
        </button>
        <button
          onClick={() => void run(() => vaultApi.lock())}
          className="px-2.5 py-1.5 rounded-lg text-xs hairline hover:bg-black/5 dark:hover:bg-white/10"
        >
          锁定
        </button>
      </div>

      <div className="flex items-center gap-1 px-4 py-1.5 border-b border-white/80 dark:border-stone-700/50">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              tab === t.key
                ? 'bg-[var(--element-muted)] text-[var(--element-bg)]'
                : 'text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5'
            }`}
          >
            {t.label}
            {t.key === 'trash' && status.trashedCount > 0 ? ` (${status.trashedCount})` : ''}
          </button>
        ))}
        {busy && <span className="ml-2 text-[11px] text-neutral-400">处理中…</span>}
        {error && <span className="ml-2 text-[11px] text-red-600 dark:text-red-400 truncate">{error}</span>}
      </div>

      {tab === 'security' ? (
        <SecurityPanel items={items} busy={busy} />
      ) : tab === 'settings' ? (
        <SettingsPanel status={status} run={run} busy={busy} error={error} />
      ) : (
        <div className="flex-1 min-h-0 flex">
          <div className="w-72 shrink-0 border-r border-white/80 dark:border-stone-700/50 overflow-auto">
            {visible.length === 0 && (
              <div className="p-4 text-xs text-neutral-400 dark:text-stone-500">
                {tab === 'trash' ? '回收站是空的' : query ? '没有匹配的条目' : '还没有条目，点右上角「新建」'}
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
                onClick={() => (tab === 'trash' ? undefined : select(item))}
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
                {tab === 'trash' && (
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
            {tab === 'trash' && items.some((i) => i.deletedAtMs) && (
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
    </div>
  );
}

function VaultSidebar() {
  return (
    <div className="p-4 text-xs text-neutral-400 dark:text-stone-500">
      密码托管 · v0.1
      <div className="mt-2">主密码 + 本机免密 · 备用码兜底</div>
      <div className="mt-1">数据仅存本机，自动锁定</div>
    </div>
  );
}

export { VaultModule, VaultSidebar };
