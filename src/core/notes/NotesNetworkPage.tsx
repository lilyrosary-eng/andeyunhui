import { useState, useCallback, useMemo } from 'react';
import { Globe, Search, X, Loader2, AlertCircle, BookmarkPlus, Check, ExternalLink } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useNotesStore } from '@/stores/notesStore';
import {
  NOTE_SOURCES,
  searchNoteSource,
  toNoteMarkdown,
  type NoteSourceId,
  type NoteWebResult,
} from './noteSources';

/**
 * 笔记「网络」独立结果页（侧栏入口进入，不占据编辑器）。
 *
 * 数据流：输入关键词 → invoke('note_web_search') → Rust 侧按源适配官方接口 → 统一结构。
 * 收藏：把标题 / 作者 / 日期 / 原文链接 / 摘要写成一篇新笔记（属引用，不复制全文）。
 */
export function NotesNetworkPage() {
  const setNetworkOpen = useNotesStore((s) => s.setNetworkOpen);
  const createNoteWith = useNotesStore((s) => s.createNoteWith);

  const [source, setSource] = useState<NoteSourceId>('arxiv');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<NoteWebResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());

  const activeSource = useMemo(
    () => NOTE_SOURCES.find((s) => s.id === source) ?? NOTE_SOURCES[0],
    [source],
  );

  const runSearch = useCallback(
    async (override?: string) => {
      const q = (override ?? query).trim();
      if (!q) {
        setError('请输入搜索关键词');
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const list = await searchNoteSource(source, q);
        setItems(list);
        setSearched(true);
        if (list.length === 0) setError('没有匹配结果，换个关键词试试');
      } catch (e) {
        const msg = typeof e === 'string' ? e : (e as any)?.message || String(e);
        setItems([]);
        setSearched(true);
        setError(msg);
      } finally {
        setLoading(false);
      }
    },
    [query, source],
  );

  const openOriginal = useCallback((url: string) => {
    if (!url) return;
    void openUrl(url).catch(() => {
      window.open(url, '_blank', 'noopener');
    });
  }, []);

  const saveAsNote = useCallback(
    async (item: NoteWebResult) => {
      const key = `${source}:${item.id}`;
      setSavingId(key);
      try {
        await createNoteWith(item.title || '网络检索结果', toNoteMarkdown(item, activeSource.name));
        setSavedKeys((prev) => {
          const next = new Set(prev);
          next.add(key);
          return next;
        });
      } catch (e) {
        setError(`收藏失败：${typeof e === 'string' ? e : (e as any)?.message || String(e)}`);
      } finally {
        setSavingId(null);
      }
    },
    [activeSource.name, createNoteWith, source],
  );

  return (
    <div className="flex h-full flex-col">
      {/* ===== 顶部：标题 + 返回 ===== */}
      <div className="shrink-0 flex items-center gap-2.5">
        <Globe size={20} className="text-neutral-500 dark:text-stone-400" />
        <h2 className="text-lg font-semibold text-neutral-800 dark:text-stone-100">网络</h2>
        <span className="text-xs text-neutral-400 dark:text-stone-500 truncate">
          学术与技术站点检索 · 结果可一键收藏为笔记
        </span>
        <button
          onClick={() => setNetworkOpen(false)}
          className="ml-auto btn-press flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          title="返回笔记编辑"
        >
          <X size={14} /> 返回笔记
        </button>
      </div>

      {/* ===== 搜索行 ===== */}
      <div className="shrink-0 mt-4 flex items-center gap-2">
        <div className="flex flex-1 min-w-0 items-center gap-2 rounded-xl bg-white/70 dark:bg-stone-800/60 border border-black/5 dark:border-white/10 px-3 py-2">
          <Search size={15} className="shrink-0 text-neutral-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch();
            }}
            placeholder={`在 ${activeSource.name} 搜索…（回车开始）`}
            className="flex-1 min-w-0 bg-transparent text-sm text-neutral-800 dark:text-stone-100 outline-none placeholder:text-neutral-400"
          />
        </div>
        <button
          onClick={() => void runSearch()}
          disabled={loading}
          className="btn-press shrink-0 inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm text-white disabled:opacity-50"
          style={{ background: activeSource.accent }}
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          {loading ? '搜索中' : '搜索'}
        </button>
      </div>

      {/* ===== 源切换 ===== */}
      <div className="shrink-0 mt-3 flex flex-wrap items-center gap-2">
        {NOTE_SOURCES.map((s) => {
          const active = s.id === source;
          return (
            <button
              key={s.id}
              onClick={() => {
                setSource(s.id);
                setItems([]);
                setSearched(false);
                setError(null);
              }}
              className={`btn-press rounded-full px-3 py-1 text-xs transition-colors ${
                active
                  ? 'text-white'
                  : 'text-neutral-500 dark:text-stone-400 bg-neutral-100 dark:bg-stone-800 hover:bg-neutral-200 dark:hover:bg-stone-700'
              }`}
              style={active ? { background: s.accent } : undefined}
              title={s.desc}
            >
              {s.name}
            </button>
          );
        })}
        <span className="text-[11px] text-neutral-400 dark:text-stone-500 truncate">{activeSource.desc}</span>
      </div>

      {/* ===== 状态条 ===== */}
      {error && (
        <div className="shrink-0 mt-3 flex items-start gap-2 rounded-xl bg-red-50/70 dark:bg-red-950/30 px-3 py-2 text-xs text-red-500 break-all">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* ===== 结果列表 ===== */}
      <div className="flex-1 min-h-0 overflow-y-auto mt-3 -mr-2 pr-2 space-y-2">
        {loading && items.length === 0 ? (
          <p className="text-sm text-neutral-400 dark:text-stone-500 py-10 text-center">正在请求官方接口…</p>
        ) : !searched ? (
          <div className="py-10 text-center text-sm text-neutral-400 dark:text-stone-500 leading-relaxed">
            输入关键词开始检索。<br />
            只调用站点公开文档化的接口；不抓正文、不绕登录与付费墙。
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-neutral-400 dark:text-stone-500 py-10 text-center">没有结果。</p>
        ) : (
          items.map((item) => {
            const key = `${source}:${item.id}`;
            const saved = savedKeys.has(key);
            const saving = savingId === key;
            return (
              <div
                key={key}
                className="rounded-2xl bg-white/70 dark:bg-stone-800/50 border border-black/5 dark:border-white/5 px-4 py-3 hover:bg-white/95 dark:hover:bg-stone-800/80 transition-colors"
              >
                <button
                  onClick={() => openOriginal(item.url)}
                  className="block w-full text-left"
                  title="在系统浏览器打开原文"
                >
                  <p className="text-sm font-medium text-neutral-800 dark:text-stone-100 leading-snug line-clamp-2">
                    {item.title}
                  </p>
                </button>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-neutral-400 dark:text-stone-500">
                  {item.authors && <span className="truncate max-w-full">{item.authors}</span>}
                  {item.date && <span className="tabular-nums">{item.date}</span>}
                  {item.meta && <span>{item.meta}</span>}
                </div>
                {item.summary && (
                  <p className="mt-1.5 text-xs text-neutral-600 dark:text-stone-400 leading-relaxed line-clamp-3">
                    {item.summary}
                  </p>
                )}
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => void saveAsNote(item)}
                    disabled={saved || saving}
                    className="btn-press inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-neutral-600 dark:text-stone-300 bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 disabled:opacity-60 transition-colors"
                  >
                    {saved ? <Check size={13} /> : saving ? <Loader2 size={13} className="animate-spin" /> : <BookmarkPlus size={13} />}
                    {saved ? '已收藏' : saving ? '保存中' : '收藏为笔记'}
                  </button>
                  <button
                    onClick={() => openOriginal(item.url)}
                    className="btn-press inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                  >
                    <ExternalLink size={13} /> 原文
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ===== 底部合规说明 ===== */}
      <p className="shrink-0 mt-3 text-[11px] text-neutral-400 dark:text-stone-500 leading-relaxed">
        说明：结果来自 arXiv / HuggingFace / GitHub / Semantic Scholar 的公开接口，可能受各站限流；
        「收藏为笔记」保存的是标题、摘要与原文链接（引用），不复制全文。
      </p>
    </div>
  );
}

export default NotesNetworkPage;
