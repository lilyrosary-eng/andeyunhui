import { useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from '@/lib/i18n';
import { KeepButton } from '@/components/KeepButton';

interface SearchResult {
  path: string;
  name: string;
  size: number;
  modified: number;
  is_dir: boolean;
}

const GOLD = '#e6c35c';

// —— 内联 SVG 图标（零外部依赖）——
const svgProps = {
  width: 20, height: 20, viewBox: '0 0 24 24',
  fill: 'none', stroke: 'currentColor', strokeWidth: 2,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
};
const IconSearchGlass = () => (
  <svg {...svgProps} width={18} height={18}><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></svg>
);
const IconFolder = () => (
  <svg {...svgProps} width={16} height={16}><path d="M3 6h5l2 2h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z" /></svg>
);
const IconFileDoc = () => (
  <svg {...svgProps} width={16} height={16}><path d="M6 3h8l4 4v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M14 3v4h4" /></svg>
);
const IconClose = () => (
  <svg {...svgProps} width={16} height={16}><path d="M6 6l12 12M18 6L6 18" /></svg>
);

interface FileSearchPanelProps {
  variant: 'panel' | 'overlay';
  onClose?: () => void;
  keepOpen?: boolean;
  onKeepToggle?: () => void;
}

export function FileSearchPanel({ variant, onClose, keepOpen, onKeepToggle }: FileSearchPanelProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [status, setStatus] = useState<{ indexing: boolean; count: number; last_indexed: string | null } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); return; }
    try {
      const r = await invoke('fs_search', { query: q, limit: 60 }) as SearchResult[];
      setResults(r);
    } catch { setResults([]); }
  }, []);

  const onInput = useCallback((val: string) => {
    setQuery(val);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void runSearch(val), 180);
  }, [runSearch]);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await invoke('fs_index_status') as { indexing: boolean; count: number; last_indexed: string | null });
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const id = setInterval(() => void refreshStatus(), 1500);
    return () => clearInterval(id);
  }, [refreshStatus]);

  // 挂载后自动聚焦搜索框（panel 模式）
  useEffect(() => {
    if (variant === 'panel' && inputRef.current) inputRef.current.focus();
  }, [variant]);

  if (variant === 'overlay') {
    // ===== 浮岛风格（深色底 + 金色强调，与 src/Capsule.tsx 搜索面板完全一致） =====
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: '10px 12px 10px' }} onClick={(e) => {
        if (e.target === e.currentTarget && onClose) onClose();
        e.stopPropagation();
      }}>
        {/* 顶部：图标 + 标题 + 索引状态 + 返回播放器 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 40, height: 40, borderRadius: 9, flex: '0 0 40px', background: 'rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: GOLD }}>
            <IconSearchGlass />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#f6f6f8' }}>{t('niaoluo.search.title')}</div>
            <div style={{ fontSize: 11, color: 'rgba(244,244,246,0.62)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {status?.indexing ? t('niaoluo.search.indexing') : t('niaoluo.search.indexed', { count: status?.count ?? 0 })}
              {status?.last_indexed ? ` · ${status.last_indexed}` : ''}
            </div>
          </div>
          {variant === 'overlay' && onKeepToggle && (
            <KeepButton pinned={!!keepOpen} onToggle={onKeepToggle} size={28} />
          )}
          {onClose && (
            <button onClick={onClose} title={t('common.close')} style={{ appearance: 'none', border: 'none', background: 'transparent', color: GOLD, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', borderRadius: 10, width: 28, height: 28 }}>
              <IconClose />
            </button>
          )}
        </div>

        {/* 搜索框 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <input
            autoFocus
            value={query}
            onChange={(e) => onInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void runSearch(query); } }}
            placeholder={t('niaoluo.search.placeholder')}
            style={{ flex: 1, borderRadius: 10, border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(0,0,0,0.25)', color: '#f4f4f6', padding: '8px 10px', fontSize: 12.5, outline: 'none', fontFamily: 'inherit' }}
          />
        </div>

        {/* 结果列表 */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {results.length === 0 && (
            <div style={{ fontSize: 12, color: 'rgba(244,244,246,0.55)', textAlign: 'center', marginTop: 12 }}>
              {query.trim() ? t('niaoluo.search.noResults') : status?.indexing ? t('niaoluo.search.waitIndex') : t('niaoluo.search.prompt')}
            </div>
          )}
          {results.map((r) => (
            <button
              key={r.path}
              onClick={() => invoke('fs_open_path', { path: r.path }).catch(() => {})}
              title={r.path}
              style={{ display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', padding: '7px 8px', borderRadius: 9, border: 'none', background: 'rgba(255,255,255,0.05)', cursor: 'pointer', color: '#f2f2f4' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.12)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
            >
              <span style={{ fontSize: 16, color: GOLD, flex: '0 0 18px', textAlign: 'center' }}>{r.is_dir ? <IconFolder /> : <IconFileDoc />}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5 }}>{r.name}</span>
              <span style={{ fontSize: 10.5, color: 'rgba(244,244,246,0.5)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150, flex: '0 0 auto' }}>{r.path}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ===== 主窗口面板风格（CSS 变量自适应主题） =====
  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden main-panel-bg fade-in">
      {/* 标题栏 */}
      <div className="flex items-center gap-3 px-6 pt-5 pb-2 shrink-0">
        <div className="w-10 h-10 rounded-xl bg-[var(--element-bg)]/10 flex items-center justify-center text-[var(--element-color-raw)]">
          <IconSearchGlass />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold text-neutral-800 dark:text-stone-100">{t('niaoluo.search.title')}</h2>
          <p className="text-xs text-neutral-400 dark:text-stone-500 mt-0.5 truncate">
            {status?.indexing ? t('niaoluo.search.indexing') : t('niaoluo.search.indexed', { count: status?.count ?? 0 })}
            {status?.last_indexed ? ` · ${status.last_indexed}` : ''}
          </p>
        </div>
      </div>

      {/* 搜索框 */}
      <div className="px-6 pb-3 shrink-0">
        <div className="relative">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => onInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void runSearch(query); } }}
            placeholder={t('niaoluo.search.placeholder')}
            className="w-full rounded-xl border border-white/50 dark:border-stone-600/40 bg-white/60 dark:bg-stone-700/40 px-4 py-2.5 text-sm text-neutral-700 dark:text-stone-200 placeholder:text-neutral-400 dark:placeholder:text-stone-500 focus:outline-none focus:ring-2 focus:ring-[var(--element-border)] focus:border-transparent transition-all font-[inherit]"
          />
        </div>
      </div>

      {/* 结果列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6">
        {results.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-neutral-400 dark:text-stone-500">
              {query.trim() ? t('niaoluo.search.noResults') : status?.indexing ? t('niaoluo.search.waitIndex') : t('niaoluo.search.prompt')}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {results.map((r) => (
              <button
                key={r.path}
                onClick={() => invoke('fs_open_path', { path: r.path }).catch(() => {})}
                title={r.path}
                className="flex items-center gap-3 text-left px-3 py-2.5 rounded-xl border border-transparent hover:bg-white/60 dark:hover:bg-stone-700/30 hover:border-white/40 dark:hover:border-stone-600/30 active:bg-white/80 dark:active:bg-stone-700/50 transition-all cursor-pointer group"
              >
                <span className="flex-shrink-0 w-7 h-7 rounded-lg bg-[var(--element-bg)]/8 flex items-center justify-center text-[var(--element-color-raw)]">
                  {r.is_dir ? <IconFolder /> : <IconFileDoc />}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-neutral-700 dark:text-stone-200 truncate">{r.name}</span>
                  <span className="block text-[11px] text-neutral-400 dark:text-stone-500 truncate">{r.path}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default FileSearchPanel;
