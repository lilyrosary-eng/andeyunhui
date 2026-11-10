import { useCallback, useEffect, useState } from 'react';
import { FileDiff, RotateCcw, Download, Package, X, FolderOpen, AlertTriangle } from 'lucide-react';
import { api, type ChangesetSummary, type ChangesetFile } from '@/lib/api';
import { logger } from '@/lib/logger';

/**
 * 安装基线变更集面板。
 *
 * 这是**额外**的一层对照：永远是「刚下载的版本 → 当前」，
 * 不管改了多少次、改了多久，基线都不推进（除非用户主动"重置基线"）。
 * AI 编程自带的会话级回退 / 审阅不在这里，也不受这里影响。
 */
export function ChangesetPanel({
  pluginId,
  pluginName,
  onClose,
  onRestored,
}: {
  pluginId: string;
  pluginName: string;
  onClose: () => void;
  onRestored?: () => void;
}) {
  const [summary, setSummary] = useState<ChangesetSummary | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [diff, setDiff] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const s = await api.changesetSummary(pluginId);
      setSummary(s);
      setSelected((prev) => (prev && s.files.some((f) => f.path === prev) ? prev : s.files[0]?.path ?? ''));
    } catch (err) {
      setMsg(`读取变更失败：${String(err)}`);
      logger.log('[Changeset] 读取失败:', err);
    }
  }, [pluginId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!selected) { setDiff(''); return; }
    let alive = true;
    void api.changesetDiff(pluginId, selected)
      .then((text) => { if (alive) setDiff(text); })
      .catch((err) => { if (alive) setDiff(`读取差异失败：${String(err)}`); });
    return () => { alive = false; };
  }, [pluginId, selected]);

  const reloadPlugin = () => {
    const hot = (window as unknown as { __pluginHot__?: { reload: (id: string) => Promise<void> } }).__pluginHot__;
    void hot?.reload(pluginId).catch(() => {});
  };

  const handleRestoreFile = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await api.changesetRestoreFile(pluginId, selected);
      reloadPlugin();
      setMsg(`已恢复 ${selected}`);
      await load();
      onRestored?.();
    } catch (err) {
      setMsg(`恢复失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRestoreAll = async () => {
    if (!window.confirm(`把「${pluginName}」整体恢复到下载时的版本？本插件所有本地改动都会丢失。`)) return;
    setBusy(true);
    try {
      const r = await api.changesetRestoreAll(pluginId);
      reloadPlugin();
      setMsg(`已恢复 ${r.restored} 个文件，删除 ${r.removed} 个新增文件`);
      await load();
      onRestored?.();
    } catch (err) {
      setMsg(`恢复失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async () => {
    setBusy(true);
    try {
      const path = await api.changesetExportPatch(pluginId);
      setMsg(`已导出 patch：${path}`);
    } catch (err) {
      setMsg(`导出失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handlePack = async () => {
    setBusy(true);
    try {
      const path = await api.changesetPackPlugin(pluginId);
      setMsg(`已打包：${path}`);
    } catch (err) {
      setMsg(`打包失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleResetBaseline = async () => {
    if (!window.confirm('把当前内容设为新的对比基线？之后差异将从零开始，旧的「下载版本」对照会丢失。')) return;
    setBusy(true);
    try {
      await api.changesetResetBaseline(pluginId);
      setMsg('基线已重置为当前版本');
      await load();
    } catch (err) {
      setMsg(`重置失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const files = summary?.files ?? [];
  const total = files.length;

  return (
    <div className="fixed inset-0 z-[var(--layer-fullscreen)] flex items-center justify-center bg-black/35 p-6 backdrop-blur-sm">
      <div className="flex h-[min(760px,100%)] w-[min(1120px,100%)] flex-col overflow-hidden rounded-2xl border border-white/80 bg-white shadow-2xl dark:border-stone-700 dark:bg-stone-900">
        {/* 头部 */}
        <div className="flex items-center gap-3 border-b border-neutral-200/60 px-5 py-3.5 dark:border-stone-700/60">
          <FileDiff size={17} className="text-neutral-400 dark:text-stone-500" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-neutral-800 dark:text-stone-100">
              {pluginName} · 相对下载版本的改动
            </div>
            <div className="text-[11px] text-neutral-400 dark:text-stone-500">
              {summary
                ? `${total} 个文件 · +${summary.additions} −${summary.deletions} · 基线 ${new Date(summary.baselineAt * 1000).toLocaleString()}`
                : '读取中…'}
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

        {/* 工具条 */}
        <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200/60 px-5 py-2.5 dark:border-stone-700/60">
          <button
            onClick={handleRestoreAll}
            disabled={busy || total === 0}
            className="btn-press inline-flex items-center gap-1.5 rounded-lg border border-neutral-200/70 px-2.5 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50 disabled:opacity-40 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800"
          >
            <RotateCcw size={13} />全部恢复
          </button>
          <button
            onClick={handleExport}
            disabled={busy || total === 0}
            className="btn-press inline-flex items-center gap-1.5 rounded-lg border border-neutral-200/70 px-2.5 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50 disabled:opacity-40 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800"
          >
            <Download size={13} />导出 patch
          </button>
          <button
            onClick={handlePack}
            disabled={busy}
            className="btn-press inline-flex items-center gap-1.5 rounded-lg border border-neutral-200/70 px-2.5 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50 disabled:opacity-40 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800"
          >
            <Package size={13} />打包 .mufurong
          </button>
          <button
            onClick={handleResetBaseline}
            disabled={busy || total === 0}
            className="ml-auto rounded-lg px-2.5 py-1.5 text-[11px] text-neutral-400 hover:text-neutral-600 disabled:opacity-40 dark:text-stone-500 dark:hover:text-stone-300"
            title="把这些改动确认为新起点"
          >
            重置基线
          </button>
        </div>

        {(msg || summary?.baselineStale) && (
          <div className="flex items-start gap-2 px-5 py-2 text-[11px]">
            {summary?.baselineStale && (
              <span className="inline-flex items-start gap-1 text-amber-600 dark:text-amber-400">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                应用已升级，但本地有改动，基线仍停在你下载时的版本。
              </span>
            )}
            {msg && (
              <span className="inline-flex min-w-0 items-center gap-2 text-neutral-500 dark:text-stone-400">
                <span className="truncate">{msg}</span>
                {msg.includes('：') && (
                  <button
                    onClick={() => void api.changesetRevealFile(msg.slice(msg.indexOf('：') + 1)).catch(() => {})}
                    className="inline-flex shrink-0 items-center gap-1 text-[11px] text-neutral-500 underline-offset-2 hover:underline dark:text-stone-400"
                  >
                    <FolderOpen size={12} />定位
                  </button>
                )}
              </span>
            )}
          </div>
        )}

        {/* 主体 */}
        <div className="flex min-h-0 flex-1">
          <div className="w-[300px] shrink-0 overflow-y-auto border-r border-neutral-200/60 py-2 dark:border-stone-700/60">
            {total === 0 ? (
              <div className="px-4 py-10 text-center text-xs text-neutral-400 dark:text-stone-500">
                这个插件与下载版本一致
              </div>
            ) : (
              files.map((f) => (
                <FileRow
                  key={f.path}
                  file={f}
                  active={selected === f.path}
                  onClick={() => setSelected(f.path)}
                />
              ))
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto bg-neutral-50/60 dark:bg-stone-950/40">
            {selected ? (
              <DiffView text={diff} />
            ) : (
              <div className="px-4 py-10 text-center text-xs text-neutral-400 dark:text-stone-500">
                选一个文件查看差异
              </div>
            )}
          </div>
        </div>

        {/* 底部 */}
        <div className="flex items-center gap-2 border-t border-neutral-200/60 px-5 py-2.5 dark:border-stone-700/60">
          <span className="text-[11px] text-neutral-400 dark:text-stone-500">
            与「下载时版本」对比，不受 AI 会话与中间修改次数影响。
          </span>
          {selected && (
            <button
              onClick={handleRestoreFile}
              disabled={busy}
              className="btn-press ml-auto inline-flex items-center gap-1.5 rounded-lg border border-neutral-200/70 px-2.5 py-1.5 text-[11px] text-neutral-600 hover:bg-neutral-50 disabled:opacity-40 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800"
            >
              <RotateCcw size={12} />恢复此文件
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const STATUS_META: Record<ChangesetFile['status'], { label: string; cls: string }> = {
  added: { label: 'A', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
  modified: { label: 'M', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  deleted: { label: 'D', cls: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-300' },
};

function FileRow({ file, active, onClick }: { file: ChangesetFile; active: boolean; onClick: () => void }) {
  const meta = STATUS_META[file.status];
  return (
    <button
      onClick={onClick}
      title={file.path}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
        active
          ? 'bg-neutral-100 text-neutral-800 dark:bg-stone-800 dark:text-stone-100'
          : 'text-neutral-600 hover:bg-neutral-50 dark:text-stone-400 dark:hover:bg-stone-800/60'
      }`}
    >
      <span className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-medium ${meta.cls}`}>
        {meta.label}
      </span>
      <span className="min-w-0 flex-1 truncate">{file.path}</span>
      <span className="shrink-0 font-mono text-[10px] text-neutral-400 dark:text-stone-500">
        {file.binary ? 'bin' : `+${file.additions} −${file.deletions}`}
      </span>
    </button>
  );
}

function DiffView({ text }: { text: string }) {
  if (!text.trim()) {
    return <div className="px-4 py-10 text-center text-xs text-neutral-400 dark:text-stone-500">没有可显示的文本差异</div>;
  }
  return (
    <pre className="min-h-full px-1 py-2 font-mono text-[12px] leading-[1.55]">
      {text.split('\n').map((line, i) => {
        let cls = 'text-neutral-600 dark:text-stone-400';
        if (line.startsWith('@@')) {
          cls = 'text-sky-600 bg-sky-50/70 dark:text-sky-400 dark:bg-sky-900/20';
        } else if (line.startsWith('+++') || line.startsWith('---')) {
          cls = 'text-neutral-400 dark:text-stone-500';
        } else if (line.startsWith('+')) {
          cls = 'text-emerald-700 bg-emerald-50/70 dark:text-emerald-400 dark:bg-emerald-900/20';
        } else if (line.startsWith('-')) {
          cls = 'text-red-700 bg-red-50/70 dark:text-red-400 dark:bg-red-900/20';
        }
        return (
          <div key={i} className={`whitespace-pre-wrap break-all px-3 ${cls}`}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}
