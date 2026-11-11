import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Globe, Search, X, Loader2, AlertCircle, BookmarkPlus, Check, ExternalLink, ChevronLeft, ChevronRight } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { useNotesStore } from '@/stores/notesStore';
import { storage } from '@/core/storage';
import { KEYS } from '@/core/storage/keys';
import {
  NOTE_SOURCES,
  searchNoteSource,
  resolveSourceScope,
  toNoteMarkdown,
  type NoteWebResult,
  type NoteSourceId,
} from './noteSources';

/** 结果项：单源结果没有来源字段；聚合结果会带上它来自哪个源。 */
type ResultItem = NoteWebResult & {
  sourceId?: NoteSourceId;
  sourceName?: string;
  accent?: string;
};

/** 每页 / 每次追加的条数（分页与无限下拉共用） */
const PAGE_SIZE = 10;

/**
 * 每次向**每个源**请求多少条（分页大小，不是总量上限）。
 *
 * 聚合搜索走真实分页：无限下拉/翻页到已加载末尾时会带 offset 再向各源要下一批，
 * 因此这里只决定「一批多大」，不限制能翻多少页（arXiv=start / GitHub=page / S2=offset）。
 * HuggingFace 的 models 接口没有偏移参数，只能取首屏一批。
 */
const BATCH_SIZE = 20;

/** 单个源的翻页进度 */
interface SourceProgress {
  /** 下一次请求的 offset（= 已请求条数） */
  offset: number;
  /** 该源已没有更多（上批返回不足一批，或接口不支持翻页） */
  exhausted: boolean;
  /** 累计条数（跨批次） */
  count: number;
  /** 最近一次失败原因（下次加载更多会自动重试） */
  error?: string;
}

function emptyProgress(): Record<string, SourceProgress> {
  const m: Record<string, SourceProgress> = {};
  for (const s of NOTE_SOURCES) m[s.id] = { offset: 0, exhausted: false, count: 0 };
  return m;
}

type ResultLayout = 'paged' | 'infinite';

function loadLayout(): ResultLayout {
  return storage.getString(KEYS.notes.networkLayout.key, 'infinite') === 'paged' ? 'paged' : 'infinite';
}

/**
 * 笔记「网络」独立结果页（侧栏入口进入，不占据编辑器）。
 *
 * 数据流：输入关键词 → invoke('note_web_search') → Rust 侧按源适配官方接口 → 统一结构。
 * 选「聚合搜索」时：四个源各自按 offset 分批取数，谁先回来谁先渲染，
 * 不必等最慢的源（arXiv 限速 3s、Semantic Scholar 常 429）；
 * 滚到底 / 翻到已加载末尾时再带 offset 向各源要下一批（没有总量上限）。
 * 呈现方式（分页 / 无限下拉）由「笔记设置」决定，两者都会真正继续取数，不只是前端切片。
 * 收藏：把标题 / 作者 / 日期 / 原文链接 / 摘要写成一篇新笔记（属引用，不复制全文）。
 */
export function NotesNetworkPage() {
  const source = useNotesStore((s) => s.networkSource);
  const setNetworkOpen = useNotesStore((s) => s.setNetworkOpen);
  const createNoteWith = useNotesStore((s) => s.createNoteWith);
  const isAggregate = source === 'all';

  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  /** 追加批次（加载更多）进行中 */
  const [loadingMore, setLoadingMore] = useState(false);
  /** 本批次里尚未返回的源数量（流式进度用） */
  const [pendingSources, setPendingSources] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [failedSources, setFailedSources] = useState<{ name: string; error: string }[]>([]);
  const [items, setItems] = useState<ResultItem[]>([]);
  const [searched, setSearched] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());
  /** 各源翻页游标（state 用于渲染，ref 用于在并发回调里读写最新值） */
  const [progress, setProgress] = useState<Record<string, SourceProgress>>(emptyProgress);
  const progressRef = useRef<Record<string, SourceProgress>>(emptyProgress());
  /** 搜索结果呈现方式（设置页可改，改完立即生效） */
  const [layout, setLayout] = useState<ResultLayout>(loadLayout);
  /** 分页：当前页（从 0 开始） */
  const [page, setPage] = useState(0);
  /** 无限下拉：已展示条数 */
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  /** 已见过的结果 URL（跨源、跨批次去重） */
  const seenRef = useRef<Set<string>>(new Set());
  /** 当前结果对应的关键词（「加载更多」沿用它翻下一页） */
  const queryRef = useRef('');
  /** 批次进行中标记（只用于挡住「加载更多」的重复触发；新一轮搜索永远可以打断） */
  const busyRef = useRef(false);
  /** 搜索批次序号：新一代搜索会递增，旧批次的回调据此丢弃，避免把旧结果写进新列表 */
  const runSeqRef = useRef(0);

  const activeSource = useMemo(() => resolveSourceScope(source), [source]);

  // 设置页改「结果呈现」时立刻生效（同窗口走自定义事件，跨窗口走 storage 事件）
  useEffect(() => {
    const sync = () => setLayout(loadLayout());
    window.addEventListener('andy:notes-network-layout', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('andy:notes-network-layout', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  // 换源（在左侧栏点）时清空旧结果，避免把 A 源的结果当成 B 源的
  useEffect(() => {
    setItems([]);
    setSearched(false);
    setError(null);
    setFailedSources([]);
    setPendingSources(0);
    progressRef.current = emptyProgress();
    setProgress(progressRef.current);
    setPage(0);
    setVisibleCount(PAGE_SIZE);
    seenRef.current = new Set();
  }, [source]);

  /** 把一批新结果按 URL 去重后追加（流式到达时逐批调用） */
  const appendItems = useCallback((batch: ResultItem[]) => {
    if (batch.length === 0) return;
    const fresh: ResultItem[] = [];
    for (const it of batch) {
      const key = (it.url || it.id || '').trim();
      if (!key || seenRef.current.has(key)) continue;
      seenRef.current.add(key);
      fresh.push(it);
    }
    if (fresh.length === 0) return;
    setItems((prev) => [...prev, ...fresh]);
  }, []);

  /** 本次搜索涉及的源（单源 or 四源） */
  const activeSourceIds = useMemo(
    () => NOTE_SOURCES.filter((s) => source === 'all' || s.id === source).map((s) => s.id),
    [source],
  );

  /** 还有没有能继续翻的源（已耗尽的源不再重复请求） */
  const hasUnfinishedSources = activeSourceIds.some((id) => !progress[id]?.exhausted);

  /**
   * 向「尚未耗尽」的源请求下一批。
   * `reset=true`：新一轮搜索（offset 归零、清空游标）；否则是「加载更多」，沿用各源游标。
   */
  const fetchBatch = useCallback(
    async (q: string, reset: boolean) => {
      // 只有「加载更多」会被进行中的批次挡住；新一轮搜索必须能立刻打断旧批次
      if (!reset && busyRef.current) return;
      const seq = reset ? ++runSeqRef.current : runSeqRef.current;
      const targets = NOTE_SOURCES.filter(
        (s) =>
          (source === 'all' || s.id === source) &&
          (reset || !progressRef.current[s.id]?.exhausted),
      );
      if (targets.length === 0) return;

      busyRef.current = true;
      if (reset) setLoading(true);
      else setLoadingMore(true);
      setPendingSources(targets.length);
      const failed: { name: string; error: string }[] = [];

      await Promise.allSettled(
        targets.map(async (def) => {
          const prev = progressRef.current[def.id] ?? { offset: 0, exhausted: false, count: 0 };
          const offset = reset ? 0 : prev.offset;
          try {
            const list = await searchNoteSource(def.id, q, BATCH_SIZE, offset);
            // 旧批次的迟到结果直接丢弃（否则会把上一轮关键词的结果混进新列表）
            if (seq !== runSeqRef.current) return;
            appendItems(
              list.map((it) => ({
                ...it,
                sourceId: def.id,
                sourceName: def.name,
                accent: def.accent,
              })),
            );
            // 任意一个源回来就进入「已检索」态：有数据就应当渲染，不等四个源齐
            if (list.length > 0) setSearched(true);
            progressRef.current[def.id] = {
              offset: offset + list.length,
              // 不足一批 = 该源没有更多；恰好取满时下一轮会再请求一次并拿到空数组
              exhausted: list.length < BATCH_SIZE,
              count: (reset ? 0 : prev.count) + list.length,
            };
          } catch (e) {
            if (seq !== runSeqRef.current) return;
            const msg = typeof e === 'string' ? e : (e as any)?.message || String(e);
            failed.push({ name: def.name, error: msg });
            // 失败不前进 offset：下次「加载更多」会重试该源
            progressRef.current[def.id] = { ...prev, error: msg };
          } finally {
            if (seq === runSeqRef.current) {
              setPendingSources((n) => Math.max(0, n - 1));
              setProgress({ ...progressRef.current });
            }
          }
        }),
      );

      // 旧批次收尾：不能覆盖新一代搜索的状态
      if (seq !== runSeqRef.current) return;

      setFailedSources(failed);
      setSearched(true);
      busyRef.current = false;
      setLoading(false);
      setLoadingMore(false);
      if (failed.length === targets.length) {
        setError(
          `${targets.length} 个源都没返回结果：${failed.map((f) => `${f.name}（${f.error}）`).join('；')}`,
        );
      }
    },
    [appendItems, source],
  );

  const runSearch = useCallback(
    async (override?: string) => {
      const q = (override ?? query).trim();
      if (!q) {
        setError('请输入搜索关键词');
        return;
      }
      queryRef.current = q;
      // 新一轮搜索：清空上一轮的一切流式状态与游标
      seenRef.current = new Set();
      progressRef.current = emptyProgress();
      setProgress(progressRef.current);
      setItems([]);
      setSearched(false);
      setError(null);
      setFailedSources([]);
      setPage(0);
      setVisibleCount(PAGE_SIZE);
      await fetchBatch(q, true);
    },
    [fetchBatch, query],
  );

  // ===== 呈现层：分页 / 无限下拉 =====
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  // 页码兜底：加载更多/重新搜索后页数会变，旧 page 可能越界（越界会让 slice 返回空 → 有数据却不渲染）
  const pageSafe = Math.min(page, pageCount - 1);
  const shownItems = layout === 'paged'
    ? items.slice(pageSafe * PAGE_SIZE, pageSafe * PAGE_SIZE + PAGE_SIZE)
    : items.slice(0, visibleCount);

  /** 无限下拉：先多展示一批；已展示到已加载末尾时再向各源要下一批 */
  const loadMore = useCallback(() => {
    if (busyRef.current) return;
    if (layout === 'infinite' && visibleCount < items.length) {
      setVisibleCount((n) => Math.min(items.length, n + PAGE_SIZE));
      return;
    }
    if (hasUnfinishedSources) void fetchBatch(queryRef.current, false);
  }, [fetchBatch, hasUnfinishedSources, items.length, layout, visibleCount]);

  /** 分页：翻到已加载末尾时自动再取一批 */
  const goNextPage = useCallback(() => {
    if (pageSafe < pageCount - 1) {
      setPage(pageSafe + 1);
      return;
    }
    if (hasUnfinishedSources) {
      void fetchBatch(queryRef.current, false).then(() =>
        // 新一批返回后页数会变大；这里只前进一页，越界由 pageSafe 兜住
        setPage((p) => p + 1),
      );
    }
  }, [fetchBatch, hasUnfinishedSources, pageCount, pageSafe]);

  /** 滚动到底部附近自动追加（无限下拉模式） */
  const onListScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (layout !== 'infinite' || busyRef.current) return;
      const el = e.currentTarget;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) loadMore();
    },
    [layout, loadMore],
  );

  /**
   * 打开原文：优先用**独立浏览器窗口**（browser_open，与视频/图片/Web 接口同一套）。
   *
   * 为什么不在主界面内嵌：Windows/WebView2 下子 webview 会被宿主合成层盖住（白屏），
   * 视频模块已经踩过这个坑（见 src-tauri/src/embedded_browser.rs 头注释）。
   * 独立窗口既能带着登录态浏览，又不会把人甩到系统 Edge。
   * 命令失败（内核拒绝等）时才退回到系统浏览器，保证有兜底。
   */
  const openOriginal = useCallback((url: string) => {
    if (!url) return;
    void invoke('browser_open', {
      target: 'note-web',
      url,
      title: '安得云荟 · 笔记原文',
      // 位置/尺寸由窗口管理器接管，保留字段只为兼容旧签名
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    }).catch(() => {
      void openUrl(url).catch(() => {
        window.open(url, '_blank', 'noopener');
      });
    });
  }, []);

  const saveAsNote = useCallback(
    async (item: ResultItem) => {
      // 聚合结果的归属源在 item 上（一次检索可能横跨四个源），单源则用当前源
      const key = `${item.sourceId ?? source}:${item.id}`;
      setSavingId(key);
      try {
        await createNoteWith(
          item.title || '网络检索结果',
          toNoteMarkdown(item, item.sourceName ?? activeSource.name),
        );
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

      {/* ===== 当前源（切换在左侧栏的源列表里，这里只回显 ） ===== */}
      <div className="shrink-0 mt-3 flex items-center gap-2">
        <span
          className="rounded-full px-2.5 py-0.5 text-[11px] text-white shrink-0"
          style={{ background: activeSource.accent }}
        >
          {activeSource.name}
        </span>
        <span className="text-[11px] text-neutral-400 dark:text-stone-500 truncate">
          {activeSource.desc}
          {isAggregate && '（并发检索四个源；某个源限流失败不影响其余结果）'}
        </span>
      </div>

      {/* 各源贡献：把「为什么只有 N 条」讲清楚（失败标黄，可继续翻的源带 +） */}
      {isAggregate && (items.length > 0 || failedSources.length > 0) && (
        <div className="shrink-0 mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-neutral-400 dark:text-stone-500">
          {NOTE_SOURCES.map((s) => {
            const p = progress[s.id];
            const failed = !!p?.error;
            const label = failed
              ? '失败'
              : !p || (p.count === 0 && !p.exhausted)
                ? '…'
                : `${p.count} 条${p.exhausted ? '' : '+'}`;
            return (
              <span key={s.id} className="inline-flex items-center gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: s.accent }} />
                <span>{s.name}</span>
                <span className={failed ? 'text-amber-600 dark:text-amber-400' : 'tabular-nums'}>
                  {label}
                </span>
              </span>
            );
          })}
          {loadingMore && <span className="opacity-70">正在加载下一批…</span>}
        </div>
      )}

      {/* 聚合搜索中部分源失败：明确列出，避免用户误以为该源没有结果 */}
      {isAggregate && failedSources.length > 0 && (
        <div className="shrink-0 mt-2 flex items-start gap-2 rounded-xl bg-amber-50/70 dark:bg-amber-950/25 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300 break-all">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span>
            {failedSources.length} 个源本次未返回：
            {failedSources.map((f) => `${f.name}（${f.error}）`).join('；')}
          </span>
        </div>
      )}

      {/* 流式进度：已有结果时不再挡住列表，只在顶部提示还剩几个源 */}
      {isAggregate && loading && items.length > 0 && (
        <div className="shrink-0 mt-2 flex items-center gap-1.5 text-[11px] text-neutral-400 dark:text-stone-500">
          <Loader2 size={12} className="animate-spin shrink-0" />
          <span>
            检索中：已收 {items.length} 条（{NOTE_SOURCES.length - pendingSources}/{NOTE_SOURCES.length} 个源已返回）
          </span>
        </div>
      )}

      {/* 换源时的清理在下面用 effect 做，这里不留占位节点 */}

      {/* ===== 状态条 ===== */}
      {error && (
        <div className="shrink-0 mt-3 flex items-start gap-2 rounded-xl bg-red-50/70 dark:bg-red-950/30 px-3 py-2 text-xs text-red-500 break-all">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* ===== 结果列表（分页 / 无限下拉只是切片，数据在流式到达时就已全部收集） ===== */}
      <div
        className="flex-1 min-h-0 overflow-y-auto mt-3 -mr-2 pr-2 space-y-2"
        onScroll={onListScroll}
      >
        {/* 渲染优先级：有数据就画（哪怕此时还有源在返回），否则才显示「请求中 / 未检索 / 无结果」 */}
        {items.length > 0 ? (
          shownItems.map((item) => {
            const key = `${item.sourceId ?? source}:${item.id}`;
            const saved = savedKeys.has(key);
            const saving = savingId === key;
            return (
              <div
                key={key}
                className="rounded-2xl bg-white/70 dark:bg-stone-800/50 border border-black/5 dark:border-white/5 px-4 py-3 hover:bg-white/95 dark:hover:bg-stone-800/80 transition-colors"
              >
                <div className="flex items-start gap-2">
                  {/* 聚合结果标注来源，避免把四个源的结果看成一锅粥 */}
                  {item.sourceName && (
                    <span
                      className="mt-[3px] shrink-0 rounded px-1.5 py-[1px] text-[10px] font-medium text-white"
                      style={{ background: item.accent || activeSource.accent }}
                    >
                      {item.sourceName}
                    </span>
                  )}
                  <button
                    onClick={() => openOriginal(item.url)}
                    className="block flex-1 min-w-0 text-left"
                    title="在应用内的浏览器窗口打开原文"
                  >
                    <p className="text-sm font-medium text-neutral-800 dark:text-stone-100 leading-snug line-clamp-2">
                      {item.title}
                    </p>
                  </button>
                </div>
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
        ) : loading ? (
          <p className="text-sm text-neutral-400 dark:text-stone-500 py-10 text-center">
            {isAggregate
              ? `正在请求官方接口…（${NOTE_SOURCES.length - pendingSources}/${NOTE_SOURCES.length} 个源已返回）`
              : '正在请求官方接口…'}
          </p>
        ) : !searched ? (
          <div className="py-10 text-center text-sm text-neutral-400 dark:text-stone-500 leading-relaxed">
            输入关键词开始检索。<br />
            {isAggregate
              ? '聚合搜索会同时请求四个源，结果按来源标注；只调用站点公开文档化的接口。'
              : '只调用站点公开文档化的接口；不抓正文、不绕登录与付费墙。'}
          </div>
        ) : (
          <p className="text-sm text-neutral-400 dark:text-stone-500 py-10 text-center">没有结果。</p>
        )}
      </div>

      {/* ===== 呈现控件：分页 / 无限下拉（都会真正向各源继续取数，不只是前端切片） ===== */}
      {(items.length > PAGE_SIZE || hasUnfinishedSources) && (
        <div className="shrink-0 mt-2 flex items-center justify-center gap-3 text-[11px] text-neutral-500 dark:text-stone-400">
          {layout === 'paged' ? (
            <>
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page <= 0}
                className="btn-press inline-flex items-center gap-0.5 rounded-lg px-2 py-1 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <ChevronLeft size={13} /> 上一页
              </button>
              <span className="tabular-nums">
                第 {pageSafe + 1} / {pageCount} 页 · 已加载 {items.length} 条
              </span>
              <button
                onClick={goNextPage}
                disabled={loading || loadingMore || (pageSafe >= pageCount - 1 && !hasUnfinishedSources)}
                className="btn-press inline-flex items-center gap-0.5 rounded-lg px-2 py-1 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                {pageSafe < pageCount - 1 ? (
                  <>下一页 <ChevronRight size={13} /></>
                ) : loadingMore ? (
                  <>加载中… <Loader2 size={13} className="animate-spin" /></>
                ) : (
                  <>加载更多 <ChevronRight size={13} /></>
                )}
              </button>
            </>
          ) : (
            <>
              <span className="tabular-nums">
                已显示 {Math.min(visibleCount, items.length)} / 已加载 {items.length} 条
              </span>
              {hasUnfinishedSources ? (
                <button
                  onClick={loadMore}
                  disabled={loading || loadingMore}
                  className="btn-press rounded-lg px-2 py-1 bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 disabled:opacity-50"
                >
                  {loadingMore ? '加载中…' : '加载更多'}
                </button>
              ) : (
                items.length > 0 && <span className="opacity-60">已到各源末尾</span>
              )}
            </>
          )}
        </div>
      )}

      {/* ===== 底部合规说明 ===== */}
      <p className="shrink-0 mt-3 text-[11px] text-neutral-400 dark:text-stone-500 leading-relaxed">
        说明：
        {isAggregate
          ? '聚合搜索并发请求 arXiv / HuggingFace / GitHub / Semantic Scholar 的公开接口（单源失败不影响其余）'
          : '结果来自 arXiv / HuggingFace / GitHub / Semantic Scholar 的公开接口'}
        ，可能受各站限流；「收藏为笔记」保存的是标题、摘要与原文链接（引用），不复制全文。
      </p>
    </div>
  );
}

export default NotesNetworkPage;
