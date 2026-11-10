import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert, Check, Trash2, X } from 'lucide-react';
import { api, type DraftMeta } from '@/lib/api';
import { DiffView } from './ChangesetPanel';
import { logger } from '@/lib/logger';

/**
 * 高危文件草稿区。
 *
 * AI 改「插件清单 / 插件入口 / 宿主核心文件」时不再直接落盘，而是先存成草稿；
 * 这里逐条展示草稿与当前磁盘的差异，由用户决定应用还是丢弃。
 *
 * 用户自己手动保存的文件不走这里（明确点保存就该直接生效）。
 */
const KIND_LABEL: Record<DraftMeta['kind'], string> = {
  manifest: '插件清单',
  entry: '插件入口',
  'host-core': '宿主核心文件',
};

const KIND_CLASS: Record<DraftMeta['kind'], string> = {
  manifest: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  entry: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
  'host-core': 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-300',
};

export function DraftPanel({
  onClose,
  onApplied,
}: {
  onClose: () => void;
  onApplied?: () => void;
}) {
  const [drafts, setDrafts] = useState<DraftMeta[]>([]);
  const [selected, setSelected] = useState('');
  const [diff, setDiff] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const list = await api.draftList();
      setDrafts(list);
      setSelected((prev) => (prev && list.some((d) => d.id === prev) ? prev : list[0]?.id ?? ''));
    } catch (err) {
      setMsg(`读取草稿失败：${String(err)}`);
      logger.log('[Draft] 读取失败:', err);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!selected) { setDiff(''); return; }
    let alive = true;
    void api.draftDiff(selected)
      .then((text) => { if (alive) setDiff(text); })
      .catch((err) => { if (alive) setDiff(`读取差异失败：${String(err)}`); });
    return () => { alive = false; };
  }, [selected]);

  const handleApply = async (d: DraftMeta) => {
    setBusy(true);
    try {
      const meta = await api.draftApply(d.id);
      if (meta.pluginId) {
        const hot = (window as unknown as { __pluginHot__?: { reload: (id: string) => Promise<void> } }).__pluginHot__;
        void hot?.reload(meta.pluginId).catch(() => {});
      }
      setMsg(
        meta.kind === 'host-core'
          ? `已写入 ${meta.path}（宿主文件需重新构建/重启才生效）`
          : `已应用：${meta.path}（插件已热重载）`
      );
      await load();
      onApplied?.();
    } catch (err) {
      setMsg(`应用失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = async (d: DraftMeta) => {
    if (!window.confirm(`丢弃这份草稿？磁盘文件不会变化。\n${d.path}`)) return;
    setBusy(true);
    try {
      await api.draftDiscard(d.id);
      setMsg(`已丢弃：${d.path}`);
      await load();
    } catch (err) {
      setMsg(`丢弃失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const current = drafts.find((d) => d.id === selected);

  return (
    <div className="fixed inset-0 z-[var(--layer-fullscreen)] flex items-center justify-center bg-black/35 p-6 backdrop-blur-sm">
      <div className="flex h-[min(720px,100%)] w-[min(1080px,100%)] flex-col overflow-hidden rounded-2xl border border-white/80 bg-white shadow-2xl dark:border-stone-700 dark:bg-stone-900">
        <div className="flex items-center gap-3 border-b border-neutral-200/60 px-5 py-3.5 dark:border-stone-700/60">
          <ShieldAlert size={17} className="text-amber-500" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-neutral-800 dark:text-stone-100">
              待审阅草稿
            </div>
            <div className="text-[11px] text-neutral-400 dark:text-stone-500">
              {drafts.length > 0
                ? `${drafts.length} 个高危文件改动尚未生效`
                : '没有待审阅的草稿'}
            </div>
          </div>
          <button
            onClick={onClose}
            className="ml-auto rounded-lg p-1.5 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:text-stone-500 dark:hover:bg-stone-800 dark:hover:text-stone-300"
            title="关闭"
          >
            <X size={16} />
          </button>
        </div>

        {msg && (
          <div className="truncate px-5 py-2 text-[11px] text-neutral-500 dark:text-stone-400">{msg}</div>
        )}

        <div className="flex min-h-0 flex-1">
          <div className="w-[330px] shrink-0 overflow-y-auto border-r border-neutral-200/60 py-2 dark:border-stone-700/60">
            {drafts.length === 0 ? (
              <div className="px-4 py-10 text-center text-xs text-neutral-400 dark:text-stone-500">
                高危文件（插件清单 / 插件入口 / 宿主核心）的 AI 改动会先出现在这里
              </div>
            ) : (
              drafts.map((d) => (
                <button
                  key={d.id}
                  onClick={() => setSelected(d.id)}
                  className={`flex w-full flex-col gap-1 px-3 py-2 text-left transition-colors ${
                    selected === d.id
                      ? 'bg-neutral-100 dark:bg-stone-800'
                      : 'hover:bg-neutral-50 dark:hover:bg-stone-800/60'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${KIND_CLASS[d.kind]}`}>
                      {KIND_LABEL[d.kind]}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-500 dark:text-stone-400">
                      {d.path.split(/[\\/]/).slice(-2).join('/')}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-neutral-400 dark:text-stone-500">
                    <span>{new Date(d.createdAt * 1000).toLocaleString()}</span>
                    <span>{d.pluginId ?? '宿主'}</span>
                    <span>{d.targetExists ? '覆盖' : '新建'}</span>
                  </div>
                </button>
              ))
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto bg-neutral-50/60 dark:bg-stone-950/40">
            {selected ? <DiffView text={diff} /> : null}
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-neutral-200/60 px-5 py-2.5 dark:border-stone-700/60">
          <span className="truncate text-[11px] text-neutral-400 dark:text-stone-500">
            {current ? current.path : '草稿只影响被拦下的高危文件，其它改动仍按原流程直接生效。'}
          </span>
          {current && (
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <button
                onClick={() => void handleDiscard(current)}
                disabled={busy}
                className="btn-press inline-flex items-center gap-1.5 rounded-lg border border-neutral-200/70 px-2.5 py-1.5 text-[11px] text-neutral-600 hover:bg-neutral-50 disabled:opacity-40 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800"
              >
                <Trash2 size={12} />丢弃
              </button>
              <button
                onClick={() => void handleApply(current)}
                disabled={busy}
                className="btn-press inline-flex items-center gap-1.5 rounded-lg bg-[var(--element-bg)] px-3 py-1.5 text-[11px] text-white hover:opacity-90 disabled:opacity-40"
              >
                <Check size={12} />应用到磁盘
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
