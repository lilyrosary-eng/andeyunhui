/// <reference path="../../../global.d.ts" />
// 哔哩哔哩原生视图（纯 API）：首页（推荐 / 热门 / 分区） + 搜索 → 取真实播放地址 → 我们的播放器；支持下载。
//
// 本次新增（用户反馈「只有搜索，没有分区和推荐」）：
//  - 首页 tab：推荐流 / 热门 / 19 个分区（rid 均经实测验证可用）
//  - 卡片补播放量
//
// 既有修复：
//  - qn 贯通：清晰度下拉真正参与取流与下载
//  - 多段 durl：urls 整段交给播放器/下载器按序处理
//  - 下载目录：改调 pick_directory
//  - 下载队列：补「清空已完成」
//  - 登录态：显示游客态/已登录，并只列出当前可用清晰度
import React from 'react';
import {
  searchBili,
  resolveBili,
  getBiliNav,
  getBiliRecommend,
  getBiliPopular,
  getBiliRanking,
  setBiliCookie,
  hasVisitorCookie,
  BILI_QUALITIES,
  BILI_REGIONS,
  DEFAULT_QN,
  BILI_REFERER,
  type BiliSearchResult,
} from './bilibiliApi';
import { videoDownloadManager, VIDEO_DOWNLOAD_DIR_KEY, type VideoDownloadTask } from './OnlineVideoDownloadManager';
import { toPlayableUrl, checkMediaRelay, type RelayCheckResult } from './mediaProxy';
import { pickDownloadDir } from './pickDir';
import { bumpPlay } from './stats';
import type { OnlineVideoItem } from './videoPlatforms';
import { SearchIcon, PlayIcon, DownloadIcon, CloudIcon, CloseIcon } from '@shared/icons';

const { useState, useEffect, useCallback } = React;

interface Props {
  onPlayVideo: (item: OnlineVideoItem) => void;
}

type Tab = { key: string; label: string; kind: 'recommend' | 'popular' | 'region'; rid?: number };

/** 首页 tab：推荐 / 热门 + 各分区（分区表来自实测可用的 rid） */
const HOME_TABS: Tab[] = [
  { key: 'recommend', label: '推荐', kind: 'recommend' },
  { key: 'popular', label: '热门', kind: 'popular' },
  ...BILI_REGIONS.map((r) => ({ key: `rid-${r.rid}`, label: r.name, kind: 'region' as const, rid: r.rid })),
];

export function BilibiliView({ onPlayVideo }: Props) {
  const [keyword, setKeyword] = useState('');
  const [tab, setTab] = useState<Tab>(HOME_TABS[0]);
  const [items, setItems] = useState<BiliSearchResult[]>([]);
  /** true 表示当前列表来自搜索结果（点 tab 会退出搜索模式） */
  const [searchMode, setSearchMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qn, setQn] = useState(DEFAULT_QN);
  const [showDownloads, setShowDownloads] = useState(false);
  const [dlQueue, setDlQueue] = useState<VideoDownloadTask[]>([]);
  const [dlDir, setDlDir] = useState(localStorage.getItem(VIDEO_DOWNLOAD_DIR_KEY) || '');
  const [loggedIn, setLoggedIn] = useState(false);
  const [uname, setUname] = useState<string | undefined>();
  const [showLogin, setShowLogin] = useState(false);
  const [cookieDraft, setCookieDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 链路自检结果（排查「封面裂 + 播放没反应」用） */
  const [diag, setDiag] = useState<RelayCheckResult | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);

  useEffect(() => {
    const unsub = videoDownloadManager.subscribe(setDlQueue);
    return unsub;
  }, []);

  // 读取登录态（同时会顺带触发游客态 Cookie 初始化）
  useEffect(() => {
    let alive = true;
    getBiliNav().then((nav) => {
      if (!alive) return;
      setLoggedIn(nav.isLogin);
      setUname(nav.uname);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 加载首页内容（推荐 / 热门 / 分区）
  const loadTab = useCallback(async (t: Tab) => {
    setLoading(true);
    setError(null);
    setSearchMode(false);
    try {
      const list =
        t.kind === 'recommend'
          ? await getBiliRecommend(24)
          : t.kind === 'popular'
            ? await getBiliPopular(24)
            : await getBiliRanking(t.rid ?? 0, 24);
      setItems(list);
      if (list.length === 0) setError('该分类暂无内容');
    } catch (e: unknown) {
      setError(String(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // 首次进入加载「推荐」
  useEffect(() => {
    void loadTab(HOME_TABS[0]);
  }, [loadTab]);

  const doSearch = async () => {
    const kw = keyword.trim();
    if (!kw) return;
    setLoading(true);
    setError(null);
    try {
      const r = await searchBili(kw, 1);
      setItems(r);
      setSearchMode(true);
      if (r.length === 0) setError('没有找到相关视频');
    } catch (e: unknown) {
      setError(String(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  const exitSearch = () => {
    setKeyword('');
    void loadTab(tab);
  };

  const handlePlay = async (item: BiliSearchResult) => {
    setBusy(true);
    setError(null);
    try {
      const info = await resolveBili(item, qn);
      bumpPlay('bilibili');
      onPlayVideo({
        id: item.id,
        title: item.title,
        author: item.author,
        cover: item.cover,
        url: info.urls[0],
        urls: info.urls.length > 1 ? info.urls : undefined,
        // B 站 CDN 强制校验 Referer，播放前会经 mediaProxy 交给 Rust 代取
        referer: BILI_REFERER,
        meta: { bvid: item.id, qn: info.quality },
      });
      if (info.segmentCount > 1) {
        setNotice(`该视频为 ${info.segmentCount} 段流，已按序连续播放；下载会自动拼接为完整文件。`);
      }
    } catch (e: unknown) {
      setError(`播放失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDownload = (item: BiliSearchResult) => {
    if (!dlDir) {
      setNotice('请先设置下载目录（右上角「目录」）');
      return;
    }
    videoDownloadManager.enqueue([
      { title: item.title, ref: item.id, kind: 'bili', platformId: 'bilibili', qn, subDir: '来自哔哩哔哩' },
    ]);
    setShowDownloads(true);
  };

  const pickDir = async () => {
    const r = await pickDownloadDir();
    if (r) {
      localStorage.setItem(VIDEO_DOWNLOAD_DIR_KEY, r);
      setDlDir(r);
      setNotice(null);
    } else {
      setNotice('未选择目录');
    }
  };

  /** 链路自检：拿当前列表里第一张封面做「直连 vs 中继」对比 */
  const runDiag = async () => {
    const sample = items.find((x) => x.cover)?.cover;
    if (!sample) {
      setNotice('当前列表还没有封面可用于自检，先等首页加载完');
      return;
    }
    setDiagBusy(true);
    setNotice(null);
    try {
      setDiag(await checkMediaRelay(sample, BILI_REFERER));
    } finally {
      setDiagBusy(false);
    }
  };

  const applyLogin = () => {
    const c = cookieDraft.trim();
    if (!c) return;
    setBiliCookie(c);
    setShowLogin(false);
    setCookieDraft('');
    getBiliNav().then((nav) => {
      setLoggedIn(nav.isLogin);
      setUname(nav.uname);
      setNotice(nav.isLogin ? `已登录：${nav.uname || ''}` : 'Cookie 已写入，但未识别到登录态（可能已过期）');
    });
  };

  const qualityOptions = BILI_QUALITIES.filter((q) => loggedIn || !q.needLogin);
  const activeDl = dlQueue.filter((q) => q.status === 'downloading' || q.status === 'queued').length;
  const finishedDl = dlQueue.filter((q) => q.status === 'done' || q.status === 'error' || q.status === 'canceled').length;
  const fmtPlay = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n));

  return React.createElement(
    'div',
    { className: 'absolute inset-0 flex flex-col' },
    // ===== 顶部工具条 =====
    React.createElement(
      'div',
      { className: 'shrink-0 flex flex-wrap items-center gap-2 px-4 py-3 border-b border-neutral-200/60 dark:border-stone-700/60 bg-white/70 dark:bg-stone-800/70 backdrop-blur' },
      React.createElement('span', { className: 'inline-flex', style: { color: '#fb7299' } }, React.createElement(CloudIcon, { size: 16 })),
      React.createElement('span', { className: 'text-sm font-semibold', style: { color: '#fb7299' } }, '哔哩哔哩'),
      React.createElement(
        'div',
        { className: 'flex items-center gap-2 flex-1 min-w-[240px] max-w-xl' },
        React.createElement(
          'div',
          { className: 'flex items-center gap-2 flex-1 bg-neutral-100 dark:bg-stone-700 rounded-xl px-3 py-1.5' },
          React.createElement('span', { className: 'inline-flex text-neutral-400' }, React.createElement(SearchIcon, { size: 16 })),
          React.createElement('input', {
            value: keyword,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => setKeyword(e.target.value),
            onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') doSearch();
            },
            placeholder: '搜索 B 站视频…（回车）',
            className: 'flex-1 bg-transparent text-sm text-neutral-700 dark:text-stone-200 outline-none',
          }),
          searchMode &&
            React.createElement(
              'button',
              {
                onClick: exitSearch,
                className: 'inline-flex text-neutral-400 hover:text-neutral-700 dark:hover:text-stone-200',
                title: '退出搜索，回到首页',
              },
              React.createElement(CloseIcon, { size: 14 }),
            ),
        ),
        React.createElement(
          'button',
          { onClick: doSearch, disabled: busy, className: 'btn-press px-3 py-1.5 rounded-xl text-sm text-white disabled:opacity-50', style: { background: '#fb7299' } },
          busy ? '处理中…' : '搜索',
        ),
      ),
      React.createElement(
        'select',
        {
          value: qn,
          onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setQn(Number(e.target.value)),
          className: 'text-xs bg-white dark:bg-stone-700 border border-neutral-200 dark:border-stone-600 rounded-lg px-2 py-1.5 text-neutral-700 dark:text-stone-200',
          title: loggedIn ? '清晰度' : '游客态仅可选 480P 及以下；登录后可解锁 720P+',
        },
        qualityOptions.map((q) => React.createElement('option', { key: q.qn, value: q.qn }, q.label)),
      ),
      React.createElement(
        'button',
        {
          onClick: () => setShowLogin((v) => !v),
          className: 'btn-press px-2 py-1.5 rounded-lg text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-stone-700 transition-colors',
          title: loggedIn ? `已登录：${uname || ''}` : '未登录（游客态）。点击填入登录 Cookie 以解锁 720P+',
        },
        loggedIn ? `已登录${uname ? `：${uname}` : ''}` : hasVisitorCookie() ? '游客态' : '未登录',
      ),
      React.createElement(
        'button',
        { onClick: pickDir, className: 'btn-press px-2 py-1.5 rounded-lg text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-stone-700 transition-colors', title: '下载目录' },
        dlDir ? '目录✓' : '目录',
      ),
      React.createElement(
        'button',
        { onClick: () => setShowDownloads((v) => !v), className: 'btn-press px-2 py-1.5 rounded-lg text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-stone-700 transition-colors' },
        `下载(${activeDl})`,
      ),
      React.createElement(
        'button',
        {
          onClick: runDiag,
          disabled: diagBusy,
          className: 'btn-press px-2 py-1.5 rounded-lg text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-stone-700 transition-colors disabled:opacity-50',
          title: '链路自检：对比封面「直连」与「经媒体中继」的状态码，用于排查封面裂/播放无反应',
        },
        diagBusy ? '自检中…' : '自检',
      ),
    ),
    // ===== 首页 tab 条（推荐 / 热门 / 分区）=====
    React.createElement(
      'div',
      { className: 'shrink-0 flex items-center gap-1 px-3 py-2 border-b border-neutral-200/60 dark:border-stone-700/60 overflow-x-auto scrollbar-thin' },
      HOME_TABS.map((t) => {
        const active = !searchMode && tab.key === t.key;
        return React.createElement(
          'button',
          {
            key: t.key,
            onClick: () => {
              setTab(t);
              void loadTab(t);
            },
            className: `shrink-0 px-3 py-1 rounded-full text-xs transition-colors ${
              active ? 'text-white font-medium' : 'text-neutral-600 dark:text-stone-300 hover:bg-neutral-100 dark:hover:bg-stone-700'
            }`,
            style: active ? { background: '#fb7299' } : undefined,
          },
          t.label,
        );
      }),
    ),
    // ===== 登录 Cookie 输入（内联，不用 prompt）=====
    showLogin &&
      React.createElement(
        'div',
        { className: 'shrink-0 flex items-center gap-2 px-4 py-2 border-b border-neutral-200/60 dark:border-stone-700/60 bg-neutral-50 dark:bg-stone-800/50' },
        React.createElement('span', { className: 'text-xs text-neutral-500 dark:text-stone-400 shrink-0' }, '登录 Cookie'),
        React.createElement('input', {
          value: cookieDraft,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setCookieDraft(e.target.value),
          onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') applyLogin();
          },
          placeholder: 'SESSDATA=xxx; bili_jct=yyy（从浏览器登录后复制）',
          className: 'flex-1 text-xs bg-white dark:bg-stone-700 border border-neutral-200 dark:border-stone-600 rounded-lg px-2 py-1.5 text-neutral-700 dark:text-stone-200',
        }),
        React.createElement(
          'button',
          { onClick: applyLogin, className: 'btn-press px-3 py-1.5 rounded-lg text-xs text-white', style: { background: '#fb7299' } },
          '应用',
        ),
        React.createElement(
          'button',
          {
            onClick: () => {
              setBiliCookie('');
              setShowLogin(false);
              setLoggedIn(false);
              setUname(undefined);
            },
            className: 'btn-press px-2 py-1.5 rounded-lg text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-stone-700',
          },
          '退出',
        ),
      ),
    notice && React.createElement('div', { className: 'shrink-0 px-4 py-1.5 text-xs text-sky-700 dark:text-sky-300 bg-sky-50/70 dark:bg-sky-950/30' }, notice),
    // 链路自检结果
    diag &&
      React.createElement(
        'div',
        { className: 'shrink-0 px-4 py-2 text-xs bg-neutral-50 dark:bg-stone-800/60 border-b border-neutral-200/60 dark:border-stone-700/60 space-y-0.5' },
        React.createElement('div', { className: 'flex items-center gap-2' }, [
          React.createElement('span', { key: 'v', className: 'text-neutral-700 dark:text-stone-200 font-medium' }, diag.verdict),
          React.createElement(
            'button',
            { key: 'x', onClick: () => setDiag(null), className: 'ml-auto text-neutral-400 hover:text-neutral-700 dark:hover:text-stone-200' },
            '×',
          ),
        ]),
        React.createElement('div', { className: 'text-neutral-500 dark:text-stone-400 font-mono break-all' }, `直连  = ${diag.directStatus}`),
        React.createElement('div', { className: 'text-neutral-500 dark:text-stone-400 font-mono break-all' }, `中继  = ${diag.relayStatus}`),
        React.createElement('div', { className: 'text-neutral-400 dark:text-stone-500 font-mono break-all' }, `中继URL = ${diag.relayUrl.slice(0, 160)}`),
      ),
    // ===== 主体 =====
    React.createElement(
      'div',
      { className: 'relative flex-1 overflow-hidden' },
      React.createElement(
        'div',
        { className: 'absolute inset-0 overflow-y-auto p-4' },
        error && React.createElement('p', { className: 'text-sm text-red-500 mb-3' }, error),
        loading && React.createElement('p', { className: 'text-sm text-neutral-400 dark:text-stone-500' }, searchMode ? '搜索中…' : '加载中…'),
        React.createElement(
          'div',
          { className: 'grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-4' },
          items.map((it) =>
            React.createElement(
              'div',
              {
                key: it.id,
                className: 'group rounded-2xl overflow-hidden border border-neutral-200/70 dark:border-stone-700/60 bg-white dark:bg-stone-800/60 hover:shadow-md transition-shadow',
              },
              React.createElement(
                'div',
                { className: 'relative aspect-video bg-neutral-100 dark:bg-stone-700' },
                // 封面同样要走中继：B 站图片 CDN（i0.hdslb.com）也强制校验 Referer，
                // 直连会 403（实测日志里成片的 .jpg 403 就是它）
                it.cover &&
                  React.createElement('img', {
                    src: toPlayableUrl(it.cover, BILI_REFERER),
                    alt: '',
                    className: 'w-full h-full object-cover',
                    loading: 'lazy',
                  }),
                React.createElement('span', { className: 'absolute bottom-1 right-1 text-[10px] px-1 rounded bg-black/60 text-white' }, it.durationText),
                React.createElement(
                  'button',
                  {
                    onClick: () => handlePlay(it),
                    className: 'absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/30 transition-opacity',
                    title: '播放',
                  },
                  React.createElement(PlayIcon, { size: 32, className: 'text-white' }),
                ),
              ),
              React.createElement(
                'div',
                { className: 'p-2.5' },
                React.createElement('p', { className: 'text-sm font-medium text-neutral-800 dark:text-stone-100 line-clamp-2 leading-snug', title: it.title }, it.title),
                React.createElement(
                  'div',
                  { className: 'flex items-center gap-2 mt-1' },
                  React.createElement('p', { className: 'text-xs text-neutral-400 dark:text-stone-500 truncate flex-1' }, it.author || ''),
                  it.play > 0 &&
                    React.createElement('span', { className: 'text-[10px] text-neutral-400 dark:text-stone-500 shrink-0' }, `${fmtPlay(it.play)}播放`),
                ),
                React.createElement(
                  'button',
                  { onClick: () => handleDownload(it), className: 'mt-2 flex items-center gap-1 text-xs text-[#fb7299] hover:underline' },
                  React.createElement(DownloadIcon, { size: 13 }),
                  '下载',
                ),
              ),
            ),
          ),
        ),
        !loading &&
          items.length === 0 &&
          !error &&
          React.createElement('p', { className: 'text-sm text-neutral-400 dark:text-stone-500' }, '暂无内容'),
      ),
      // ===== 下载队列浮层 =====
      showDownloads &&
        React.createElement(
          'div',
          { className: 'absolute right-3 top-3 w-80 max-h-[70%] overflow-y-auto rounded-2xl border border-neutral-200/70 dark:border-stone-700/60 bg-white/95 dark:bg-stone-800/95 backdrop-blur shadow-xl p-3 z-20' },
          React.createElement(
            'div',
            { className: 'flex items-center justify-between mb-2' },
            React.createElement('span', { className: 'text-sm font-medium text-neutral-800 dark:text-stone-100' }, '下载队列'),
            React.createElement(
              'div',
              { className: 'flex items-center gap-2' },
              finishedDl > 0 &&
                React.createElement(
                  'button',
                  { onClick: () => videoDownloadManager.clearFinished(), className: 'text-xs text-neutral-400 hover:text-neutral-700 dark:hover:text-stone-200' },
                  '清空已完成',
                ),
              React.createElement('button', { onClick: () => setShowDownloads(false), className: 'text-xs text-neutral-400 hover:text-neutral-700' }, '关闭'),
            ),
          ),
          !dlDir && React.createElement('p', { className: 'text-xs text-amber-600 dark:text-amber-400 mb-2' }, '尚未设置下载目录，任务会直接失败。'),
          dlQueue.length === 0
            ? React.createElement('p', { className: 'text-xs text-neutral-400' }, '暂无任务')
            : dlQueue.map((q) => {
                const pct = q.total > 0 ? Math.min(100, Math.round((q.downloaded / q.total) * 100)) : q.status === 'done' ? 100 : 0;
                return React.createElement(
                  'div',
                  { key: q.id, className: 'mb-2' },
                  React.createElement(
                    'div',
                    { className: 'flex items-center gap-2' },
                    React.createElement('span', { className: 'text-xs flex-1 truncate text-neutral-700 dark:text-stone-200' }, q.title),
                    React.createElement(
                      'span',
                      { className: 'text-[10px] text-neutral-400' },
                      q.status === 'downloading' ? `${pct}%` : q.status === 'done' ? '完成' : q.status === 'error' ? '失败' : q.status === 'canceled' ? '已取消' : '排队',
                    ),
                    React.createElement(
                      'button',
                      { onClick: () => videoDownloadManager.remove(q.id), className: 'text-[10px] text-neutral-400 hover:text-red-500', title: '移除' },
                      '×',
                    ),
                  ),
                  React.createElement(
                    'div',
                    { className: 'h-1 mt-1 rounded bg-neutral-200 dark:bg-stone-600 overflow-hidden' },
                    React.createElement('div', { className: 'h-full bg-[#fb7299]', style: { width: `${pct}%` } }),
                  ),
                  q.status === 'error' && React.createElement('p', { className: 'text-[10px] text-red-500 break-all' }, q.error),
                );
              }),
        ),
    ),
  );
}

export default BilibiliView;
