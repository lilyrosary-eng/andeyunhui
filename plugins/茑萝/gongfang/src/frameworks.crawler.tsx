/// <reference path="../../../global.d.ts" />
import React from 'react';
const { useCallback, useEffect, useState } = React;
import { AuditInput, CrawlerUrlQueue, CrawlerProxyPool, CollapsibleSection } from './frameworksShared';
import { tauriInvoke, CapabilityGrid, TechStackChips, crawlerMeta, StatusCard } from './frameworksShared';
import type { GongfangStatus, FetchResult, InjectType } from './frameworksShared';
// ============ 框架一：网络爬虫（内核已就绪，实际控制面板） ============
const PHASE_MAP: Record<string, { label: string; cls: string }> = {
  Idle: { label: '待命', cls: 'text-neutral-500 dark:text-stone-400' },
  Recon: { label: '侦察', cls: 'text-sky-600 dark:text-sky-400' },
  Exploit: { label: '利用', cls: 'text-rose-600 dark:text-rose-400' },
  Pivot: { label: '横向移动', cls: 'text-amber-600 dark:text-amber-400' },
  Clean: { label: '清理', cls: 'text-violet-600 dark:text-violet-400' },
};

function CrawlerPanel({ addLog }: { addLog: (i: AuditInput) => void }) {
  const [status, setStatus] = useState<GongfangStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [injectType, setInjectType] = useState<InjectType>('Focus');
  const [injectInput, setInjectInput] = useState('');
  // 快速爬取：直接发 HTTP GET，看实际页面数据（不需要启动内核）
  const [fetchUrl, setFetchUrl] = useState('');
  const [fetchResult, setFetchResult] = useState<FetchResult | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchHistory, setFetchHistory] = useState<FetchResult[]>([]);

  const fetchStatus = useCallback(async () => {
    try {
      const s = await tauriInvoke<GongfangStatus>('gongfang_status');
      setStatus(s);
      setError(null);
    } catch (e) {
      setError(typeof e === 'string' ? e : (e as Error)?.message ?? String(e));
    }
  }, []);

  // 初次挂载：拉取一次状态
  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  // running 时每 2 秒自动刷新
  useEffect(() => {
    if (!status?.running) return;
    const id = setInterval(fetchStatus, 2000);
    return () => clearInterval(id);
  }, [status?.running, fetchStatus]);

  const handleStart = useCallback(async () => {
    setBusy(true);
    try {
      await tauriInvoke('gongfang_start', { profileId: null });
      addLog({ action: '启动攻防内核', target: '爬虫框架', status: 'success' });
      await fetchStatus();
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setError(msg);
      addLog({ action: '启动攻防内核', target: '爬虫框架', status: 'error', detail: msg });
    } finally {
      setBusy(false);
    }
  }, [addLog, fetchStatus]);

  const handleStop = useCallback(async () => {
    setBusy(true);
    try {
      await tauriInvoke('gongfang_stop');
      addLog({ action: '停止攻防内核', target: '爬虫框架', status: 'success' });
      await fetchStatus();
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setError(msg);
      addLog({ action: '停止攻防内核', target: '爬虫框架', status: 'error', detail: msg });
    } finally {
      setBusy(false);
    }
  }, [addLog, fetchStatus]);

  const handleInject = useCallback(async () => {
    let cmd: unknown;
    let detail: string | undefined;
    switch (injectType) {
      case 'Focus':
        if (!injectInput.trim()) { setError('Focus 指令需要输入目标 URL'); return; }
        cmd = { Focus: { url: injectInput.trim() } };
        detail = injectInput.trim();
        break;
      case 'Bypass':
        if (!injectInput.trim()) { setError('Bypass 指令需要输入挑战类型'); return; }
        cmd = { Bypass: { challenge: injectInput.trim() } };
        detail = injectInput.trim();
        break;
      case 'Pause':
        cmd = 'Pause';
        break;
      case 'Resume':
        cmd = 'Resume';
        break;
    }
    setBusy(true);
    try {
      await tauriInvoke('gongfang_inject', { cmd });
      addLog({ action: `注入指令 ${injectType}`, target: '爬虫框架', status: 'success', detail });
      setInjectInput('');
      await fetchStatus();
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setError(msg);
      addLog({ action: `注入指令 ${injectType}`, target: '爬虫框架', status: 'error', detail: msg });
    } finally {
      setBusy(false);
    }
  }, [injectType, injectInput, addLog, fetchStatus]);

  // 快速爬取：直接发 HTTP GET，立即返回页面数据（不需要启动内核）
  // 这是"看到数据"的核心入口 —— 用户输入 URL → 立刻看到标题/链接/内容
  const handleFetch = useCallback(async (targetUrl?: string) => {
    let url = (targetUrl ?? fetchUrl).trim();
    if (!url) {
      setError('请输入要爬取的 URL');
      return;
    }
    // URL 自动补全：无协议时补 https://
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }
    setFetching(true);
    setError(null);
    try {
      const r = await tauriInvoke<FetchResult>('gongfang_fetch', { url });
      setFetchResult(r);
      if (!r.error) {
        setFetchHistory((prev) => [r, ...prev.filter((h) => h.url !== r.url)].slice(0, 10));
        addLog({
          action: '快速爬取',
          target: r.url,
          status: 'success',
          detail: `${r.status} · ${r.title ?? '无标题'} · ${r.content_length}B · ${r.links.length} 链接 · ${r.duration_ms}ms`,
        });
      } else {
        addLog({ action: '快速爬取', target: r.url, status: 'error', detail: r.error });
      }
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setError(msg);
      addLog({ action: '快速爬取', target: url, status: 'error', detail: msg });
    } finally {
      setFetching(false);
    }
  }, [fetchUrl, addLog]);

  // 从爬取结果中点击链接 → 自动爬取该链接（形成"爬取链"工作流）
  const handleFetchLink = useCallback((link: string) => {
    setFetchUrl(link);
    handleFetch(link);
  }, [handleFetch]);

  const running = status?.running ?? false;
  const strategy = status?.strategy;
  const phase = strategy ? (PHASE_MAP[strategy.phase] ?? PHASE_MAP.Idle) : PHASE_MAP.Idle;
  const inputDisabled = injectType === 'Pause' || injectType === 'Resume';

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-6 space-y-5">
        {/* 框架标题 */}
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-[var(--element-bg)]">{crawlerMeta.title}</h2>
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-violet-500/15 text-violet-600 dark:text-violet-400">{crawlerMeta.posture}</span>
          <span className="px-2 py-0.5 rounded text-[11px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">{crawlerMeta.status}</span>
        </div>
        <p className="text-sm text-neutral-500 dark:text-stone-400 leading-relaxed">{crawlerMeta.subtitle}</p>

        {/* 核心能力（已交付 / 计划中 分栏） */}
        <CollapsibleSection title="核心能力" storageKey="fw_crawler_capabilities" defaultOpen={false} accent="attack">
          <CapabilityGrid meta={crawlerMeta} />
        </CollapsibleSection>

        {/* 技术选型 */}
        <CollapsibleSection title="技术选型（优先 MIT/Apache 协议）" storageKey="fw_crawler_techstack" defaultOpen={false} accent="attack">
          <TechStackChips items={crawlerMeta.techStack} />
        </CollapsibleSection>

        {/* 使用指引（解决"不知道怎么用、不知道下一步"） */}
        <CollapsibleSection
          title="使用指引（4 步上手）"
          storageKey="fw_crawler_guide"
          defaultOpen={true}
          accent="attack"
        >
          <ol className="space-y-2 text-[13px] text-neutral-600 dark:text-stone-300">
            <li className="flex gap-2">
              <span className="shrink-0 w-5 h-5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[11px] font-semibold flex items-center justify-center">1</span>
              <div>
                <span className="font-medium">快速爬取</span>：在下方"快速爬取"区输入 URL（如 <code className="px-1 rounded bg-black/5 dark:bg-white/10 text-[11px]">https://example.com</code>），点"爬取"按钮，立刻看到页面标题、链接、内容预览。<span className="text-neutral-400">无需启动内核。</span>
              </div>
            </li>
            <li className="flex gap-2">
              <span className="shrink-0 w-5 h-5 rounded-full bg-sky-500/15 text-sky-600 dark:text-sky-400 text-[11px] font-semibold flex items-center justify-center">2</span>
              <div>
                <span className="font-medium">点击链接递归爬取</span>：爬取结果里的每个链接都可点击，点击后自动爬取该 URL，形成"爬取链"。
              </div>
            </li>
            <li className="flex gap-2">
              <span className="shrink-0 w-5 h-5 rounded-full bg-violet-500/15 text-violet-600 dark:text-violet-400 text-[11px] font-semibold flex items-center justify-center">3</span>
              <div>
                <span className="font-medium">启动内核</span>：需要自动化侦察（持续监控、策略自适应）时，在"内核控制"区点"启动内核"，然后注入 <code className="px-1 rounded bg-black/5 dark:bg-white/10 text-[11px]">Focus</code> 指令锁定目标 URL。
              </div>
            </li>
            <li className="flex gap-2">
              <span className="shrink-0 w-5 h-5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[11px] font-semibold flex items-center justify-center">4</span>
              <div>
                <span className="font-medium">用 AI 对话</span>：右侧 AI 对话框直接说"爬取 xxx"，AI 会自动调用 <code className="px-1 rounded bg-black/5 dark:bg-white/10 text-[11px]">fetch</code> 命令并总结结果。<span className="text-neutral-400">对话即攻防。</span>
              </div>
            </li>
          </ol>
        </CollapsibleSection>

        {/* 快速爬取（核心数据入口 —— 解决"没有数据、不知道进度"） */}
        <CollapsibleSection
          title="快速爬取（立即看到数据）"
          storageKey="fw_crawler_fetch"
          defaultOpen={true}
          accent="attack"
          right={fetching ? (
            <span className="flex items-center gap-1 text-[10px] text-sky-600 dark:text-sky-400">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-sky-500 animate-pulse" />
              爬取中...
            </span>
          ) : fetchResult ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
              {fetchResult.status} · {fetchResult.links.length} 链接
            </span>
          ) : null}
        >
          {/* URL 输入区 */}
          <div className="flex gap-2 mb-3">
            <input
              type="text"
              value={fetchUrl}
              onChange={(e) => setFetchUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !fetching) handleFetch(); }}
              placeholder="输入 URL，如 https://example.com 或 example.com"
              className="flex-1 px-3 py-1.5 rounded-lg text-[13px] bg-black/[0.03] dark:bg-white/[0.05] border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)] placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-sky-500/30"
            />
            <button
              onClick={() => handleFetch()}
              disabled={fetching || !fetchUrl.trim()}
              className="btn-press px-4 py-1.5 rounded-lg text-xs font-medium text-white bg-sky-500 hover:bg-sky-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
            >
              {fetching ? (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  爬取中
                </>
              ) : '爬取'}
            </button>
          </div>

          {/* URL 自动补全提示（未输入时） */}
          {!fetchUrl && !fetchResult && (
            <div className="text-[11px] text-neutral-400 mb-3">
              提示：URL 可不带协议（自动补 https://）。按回车键也可触发爬取。
            </div>
          )}

          {/* 错误提示 */}
          {error && (
            <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-500/10 rounded-lg px-2.5 py-1.5 mb-3">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span className="truncate flex-1">{error}</span>
              <button onClick={() => setError(null)} className="text-[10px] hover:underline shrink-0">忽略</button>
            </div>
          )}

          {/* 爬取结果卡片（核心数据展示） */}
          {fetchResult && (
            <div className="rounded-lg border border-black/10 dark:border-stone-700/50 overflow-hidden mb-3">
              {/* 状态栏 */}
              <div className="flex items-center gap-2 px-3 py-2 bg-black/[0.03] dark:bg-white/[0.05] border-b border-black/5 dark:border-stone-700/50">
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold ${
                  fetchResult.error ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
                  : fetchResult.status >= 200 && fetchResult.status < 300 ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : fetchResult.status >= 300 && fetchResult.status < 400 ? 'bg-sky-500/15 text-sky-600 dark:text-sky-400'
                  : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                }`}>
                  {fetchResult.error ? 'ERR' : fetchResult.status}
                </span>
                <span className="text-[11px] text-neutral-500 dark:text-stone-400 truncate flex-1 font-mono">{fetchResult.url}</span>
                <span className="text-[10px] text-neutral-400 shrink-0">{fetchResult.duration_ms}ms</span>
              </div>

              {fetchResult.error ? (
                <div className="px-3 py-3 text-xs text-rose-600 dark:text-rose-400">
                  {fetchResult.error}
                </div>
              ) : (
                <div className="px-3 py-3 space-y-2.5">
                  {/* 标题 */}
                  {fetchResult.title && (
                    <div>
                      <div className="text-[10px] text-neutral-400 mb-0.5">页面标题</div>
                      <div className="text-sm font-medium text-[var(--element-bg)]">{fetchResult.title}</div>
                    </div>
                  )}

                  {/* 元信息 */}
                  <div className="grid grid-cols-3 gap-2 text-[11px]">
                    <div className="bg-black/[0.03] dark:bg-white/[0.05] rounded px-2 py-1">
                      <div className="text-neutral-400">内容类型</div>
                      <div className="text-neutral-600 dark:text-stone-300 truncate font-mono">{fetchResult.content_type || '未知'}</div>
                    </div>
                    <div className="bg-black/[0.03] dark:bg-white/[0.05] rounded px-2 py-1">
                      <div className="text-neutral-400">内容长度</div>
                      <div className="text-neutral-600 dark:text-stone-300 font-mono">{fetchResult.content_length.toLocaleString()} B</div>
                    </div>
                    <div className="bg-black/[0.03] dark:bg-white/[0.05] rounded px-2 py-1">
                      <div className="text-neutral-400">发现链接</div>
                      <div className="text-neutral-600 dark:text-stone-300 font-mono">{fetchResult.links.length} 个</div>
                    </div>
                  </div>

                  {/* 链接列表（可点击递归爬取） */}
                  {fetchResult.links.length > 0 && (
                    <div>
                      <div className="text-[10px] text-neutral-400 mb-1">链接列表（点击可递归爬取）</div>
                      <div className="max-h-40 overflow-y-auto rounded border border-black/5 dark:border-stone-700/50 divide-y divide-black/5 dark:divide-stone-700/50">
                        {fetchResult.links.slice(0, 30).map((link, i) => (
                          <button
                            key={i}
                            onClick={() => handleFetchLink(link)}
                            disabled={fetching}
                            className="block w-full text-left px-2 py-1 text-[11px] font-mono text-sky-600 dark:text-sky-400 hover:bg-sky-500/10 disabled:opacity-40 truncate transition-colors"
                            title={link}
                          >
                            <span className="text-neutral-400 mr-1.5">{i + 1}.</span>{link}
                          </button>
                        ))}
                        {fetchResult.links.length > 30 && (
                          <div className="px-2 py-1 text-[10px] text-neutral-400">... 还有 {fetchResult.links.length - 30} 个链接</div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* 内容预览（可折叠） */}
                  {fetchResult.body_preview && (
                    <details className="group">
                      <summary className="cursor-pointer text-[11px] text-neutral-500 dark:text-stone-400 hover:text-neutral-700 dark:hover:text-stone-200 select-none">
                        ▶ 查看内容预览（前 2000 字符）
                      </summary>
                      <pre className="mt-1.5 max-h-60 overflow-auto text-[10px] font-mono text-neutral-600 dark:text-stone-300 bg-black/[0.03] dark:bg-white/[0.05] rounded p-2 whitespace-pre-wrap break-all">
                        {fetchResult.body_preview}
                      </pre>
                    </details>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 爬取历史（最近 10 次，可点击重新查看） */}
          {fetchHistory.length > 0 && (
            <div>
              <div className="text-[10px] text-neutral-400 mb-1.5">爬取历史（{fetchHistory.length}）</div>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {fetchHistory.map((h, i) => (
                  <button
                    key={i}
                    onClick={() => setFetchResult(h)}
                    className="block w-full text-left px-2 py-1 rounded text-[11px] hover:bg-black/[0.04] dark:hover:bg-white/[0.05] transition-colors"
                  >
                    <span className={`inline-block px-1 py-0.5 rounded text-[9px] font-mono mr-1.5 ${
                      h.status >= 200 && h.status < 300 ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                      : h.status >= 300 && h.status < 400 ? 'bg-sky-500/15 text-sky-600 dark:text-sky-400'
                      : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                    }`}>{h.status}</span>
                    <span className="text-neutral-600 dark:text-stone-300 font-mono truncate">{h.url}</span>
                    <span className="text-neutral-400 ml-1.5">· {h.links.length} 链接</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </CollapsibleSection>

        {/* 内核控制面板 */}
        <CollapsibleSection
          title="内核控制"
          storageKey="fw_crawler_kernel"
          defaultOpen={false}
          accent="attack"
          right={status && !status.features.crawler ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400">
              后端未启用 crawler feature
            </span>
          ) : null}
        >
          {/* 启动/停止按钮 */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleStart}
              disabled={running || busy}
              className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              启动内核
            </button>
            <button
              onClick={handleStop}
              disabled={!running || busy}
              className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-rose-500 hover:bg-rose-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              停止内核
            </button>
            {busy && <span className="text-[11px] text-neutral-400">处理中...</span>}
          </div>

          {/* 错误提示 */}
          {error && (
            <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-500/10 rounded-lg px-2.5 py-1.5">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span className="truncate">{error}</span>
              <button onClick={() => setError(null)} className="ml-auto text-[10px] hover:underline shrink-0">忽略</button>
            </div>
          )}

          {/* 状态显示区 */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <StatusCard
              label="运行状态"
              value={
                <span className="flex items-center gap-1.5">
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${running ? 'bg-emerald-500 shadow-[0_0_6px] shadow-emerald-500/60' : 'bg-neutral-400'}`} />
                  {running ? '运行中' : '已停止'}
                </span>
              }
            />
            <StatusCard label="当前阶段" value={<span className={phase.cls}>{phase.label}</span>} />
            <StatusCard label="QPS" value={strategy?.qps ?? 0} />
            <StatusCard label="隐身等级" value={`${strategy?.stealth_level ?? 0}/100`} />
            {/* 诚实标注：未接入真实 TLS 指纹通道时，该项只是 UA 档案（不含 JA3/JA4） */}
            <StatusCard
              label={status?.features?.tls_impersonate ? 'TLS 指纹' : 'UA 档案'}
              value={strategy?.tls_profile ?? '—'}
              valueCls="font-mono text-[12px]"
            />
            <StatusCard label="奖励值" value={status?.reward ?? 0} />
            <StatusCard
              label="错误率"
              value={`${((status?.error_rate ?? 0) * 100).toFixed(1)}%`}
              valueCls={status && status.error_rate > 0.5 ? 'text-rose-600 dark:text-rose-400' : ''}
            />
          </div>

          {/* 指令注入区 */}
          <div className="pt-2 border-t border-black/5 dark:border-stone-700/50">
            <h4 className="text-xs font-medium text-[var(--element-bg)] mb-2">指令注入</h4>
            <div className="flex items-center gap-2">
              <select
                value={injectType}
                onChange={(e) => setInjectType(e.target.value as InjectType)}
                className="px-2 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)] focus:outline-none focus:ring-1 focus:ring-[var(--element-bg)]"
              >
                <option value="Focus">Focus（聚焦目标）</option>
                <option value="Bypass">Bypass（绕过挑战）</option>
                <option value="Pause">Pause（软着陆暂停）</option>
                <option value="Resume">Resume（恢复）</option>
              </select>
              <input
                type="text"
                value={injectInput}
                onChange={(e) => setInjectInput(e.target.value)}
                disabled={inputDisabled}
                placeholder={injectType === 'Focus' ? '目标 URL' : injectType === 'Bypass' ? '挑战类型（cloudflare/waf/captcha）' : '无需参数'}
                className="flex-1 px-2.5 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)] placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-[var(--element-bg)] disabled:opacity-50"
              />
              <button
                onClick={handleInject}
                disabled={busy || (!inputDisabled && !injectInput.trim())}
                className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
              >
                注入
              </button>
            </div>
            <p className="text-[10px] text-neutral-400 mt-1.5">
              指令经优先级队列抢占：P0（Focus/Pause/Resume）立即生效，P1（Bypass）下一推理周期注入。
            </p>
          </div>
        </CollapsibleSection>

        {/* P1：URL 队列（事件累积 + 手动添加） */}
        <CrawlerUrlQueue />
        {/* P1.5：代理池（爬取走代理 + 风控自动死亡/回退） */}
        <CrawlerProxyPool />
      </div>
    </div>
  );
}


export { CrawlerPanel };
