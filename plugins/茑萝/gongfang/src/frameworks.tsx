/// <reference path="../../../global.d.ts" />
import React from "react";
// 攻防模块 · 四大框架面板
// 爬虫框架：内核已就绪，接入实际 Tauri 命令（启动/停止/状态/指令注入）。
// 逆向/渗透/自动化：后端内核已就绪，前端展示技术选型（暂未接入 Tauri 命令）。
const { useState, useEffect, useCallback } = React;

import type { AuditInput } from './audit';
import { CrawlerUrlQueue, PentestAssetTree, GatewayStrategyHistory, AutomationTaskList } from './frameworkExtras';
import { DisassemblyView, ScriptEditor } from './professionalExtras';
import { CollapsibleSection } from './ui';

// ============ Tauri invoke 封装 ============
// 攻防命令（gongfang_*）尚未加入插件沙箱白名单，直接走 __TAURI_INTERNALS__.invoke。
const tauriInvoke = <T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { invoke: <U = T>(c: string, a?: Record<string, unknown>) => Promise<U> };
  };
  if (!w.__TAURI_INTERNALS__?.invoke) {
    return Promise.reject(new Error('Tauri 运行时不可用'));
  }
  return w.__TAURI_INTERNALS__.invoke<T>(cmd, args);
};

// ============ 攻防状态类型（与 Rust 端 GongfangStatus 对齐） ============
interface Strategy {
  phase: 'Idle' | 'Recon' | 'Exploit' | 'Pivot' | 'Clean';
  qps: number;
  per_ip_concurrency: number;
  tls_profile: string;
  stealth_level: number;
  focus_url: string | null;
  use_browser: boolean;
  proxy_pool_tag: string;
  generation: number;
}

interface GongfangStatus {
  running: boolean;
  strategy: Strategy;
  reward: number;
  error_rate: number;
  features: { crawler: boolean; reverse: boolean; pentest: boolean; automation: boolean; gateway: boolean };
}

// ============ 爬虫实际爬取结果类型（与 Rust 端 FetchResult 对齐） ============
interface FetchResult {
  url: string;
  status: number;
  content_type: string;
  content_length: number;
  title: string | null;
  body_preview: string;
  links: string[];
  duration_ms: number;
  error: string | null;
}

// ============ 渗透框架结果类型（与 Rust 端 commands.rs 字段对齐） ============
interface ScanPort {
  host: string;
  ip: string;
  port: number;
  protocol: string;
  service: string | null;
  tls: boolean | null;
}

interface ScanResult {
  host: string;
  open_ports: ScanPort[];
  duration_ms: number;
  error: string | null;
  naabu_path: string | null;
}

interface WafDetectResult {
  url: string;
  waf_name: string | null;
  engine: string;
  entropy: number;
  status_code: number;
  signals: string[];
}

// ============ 逆向框架结果类型 ============
interface CryptoReport {
  data_len: number;
  block_size: number | null;
  chi_square: number;
  is_uniform: boolean;
  entropy: number;
  matched_algorithm: string | null;
  confidence: number | null;
}

interface SymbolSummary {
  url: string;
  name: string;
  address: number;
  kind: string;
  meta: Record<string, string>;
}

// ============ 自动化框架结果类型 ============
interface FitnessReport {
  id: number;
  name: string;
  success: number;
  failure: number;
  success_rate: number;
  avg_divergence: number;
}

// ============ 网关框架结果类型（与 Rust 端 commands.rs 字段对齐） ============
interface GatewayNodeSummary {
  url: string;
  region: string;
  reputation: number;          // 信誉评分 [0, 100]
  error_rate: number;          // 错误率 [0, 1]
  ewma_rtt: number;            // EWMA RTT（毫秒）
  rtt_gradient: number;        // RTT 梯度（毫秒/样本）
  is_failing: boolean;         // 是否即将故障
}

interface GatewayStatusResult {
  policy_version: number;
  routing: string;             // direct / proxy / stealth
  routing_cn: string;          // 直连 / 代理 / 隐身
  bandwidth_ratio: number;     // [0.05, 1.0]
  request_timeout_ms: number;
  max_concurrent: number;
  effective_ts: number;        // Unix 毫秒
  node_count: number;
  redundancy_ratio: number;    // N+1 冗余比例
  current_entropy: number;     // 请求熵
  active_node: GatewayNodeSummary | null;
}

type InjectType = 'Focus' | 'Bypass' | 'Pause' | 'Resume';

interface FrameworkMeta {
  title: string;
  subtitle: string;
  posture: '攻' | '防' | '攻防';   // 攻防定位
  capabilities: string[];          // 核心能力清单
  techStack: { name: string; license: string }[]; // 技术选型（优先 MIT/Apache）
  status: string;                  // 当前状态
}

// ============ 通用框架占位模板 ============
function FrameworkPlaceholder({ meta, addLog }: { meta: FrameworkMeta; addLog: (i: AuditInput) => void }) {
  const postureCls = meta.posture === '攻'
    ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
    : meta.posture === '防'
    ? 'bg-sky-500/15 text-sky-600 dark:text-sky-400'
    : 'bg-violet-500/15 text-violet-600 dark:text-violet-400';

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-6 space-y-5">
        {/* 框架标题 */}
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-[var(--element-bg)]">{meta.title}</h2>
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${postureCls}`}>{meta.posture}</span>
          <span className="px-2 py-0.5 rounded text-[11px] bg-amber-500/15 text-amber-600 dark:text-amber-400">{meta.status}</span>
        </div>
        <p className="text-sm text-neutral-500 dark:text-stone-400 leading-relaxed">{meta.subtitle}</p>

        {/* 核心能力 */}
        <CollapsibleSection title="核心能力规划" storageKey="fw_placeholder_capabilities" defaultOpen={false}>
          <div className="grid grid-cols-2 gap-2">
            {meta.capabilities.map((cap) => (
              <div key={cap} className="flex items-center gap-2 text-[13px] text-neutral-600 dark:text-stone-300">
                <span className="inline-block w-1 h-1 rounded-full bg-neutral-400" />
                {cap}
              </div>
            ))}
          </div>
        </CollapsibleSection>

        {/* 技术选型 */}
        <CollapsibleSection title="技术选型（优先 MIT/Apache 协议）" storageKey="fw_placeholder_techstack" defaultOpen={false}>
          <div className="flex flex-wrap gap-2">
            {meta.techStack.map((t) => (
              <span
                key={t.name}
                className="px-2.5 py-1 rounded-lg text-xs bg-black/[0.04] dark:bg-white/[0.05] text-neutral-600 dark:text-stone-300 border border-black/5 dark:border-stone-700/50"
              >
                {t.name}
                <span className="ml-1.5 text-[10px] text-neutral-400">{t.license}</span>
              </span>
            ))}
          </div>
        </CollapsibleSection>

        {/* 操作占位区 */}
        <section className="bg-white/60 dark:bg-white/[0.03] rounded-xl border border-dashed border-black/10 dark:border-stone-700/60 p-6">
          <div className="flex flex-col items-center justify-center text-center gap-2">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-neutral-400">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
            <p className="text-sm text-neutral-500 dark:text-stone-400">功能开发中</p>
            <p className="text-xs text-neutral-400 max-w-md">
              当前为骨架占位阶段。后续将按 {meta.title} 的技术路线逐步接入能力，
              所有操作将记录至审计日志。
            </p>
            <button
              onClick={() => addLog({ action: '试探性操作', target: meta.title, status: 'warn', detail: '骨架阶段，功能未实现' })}
              className="btn-press mt-2 px-3 py-1.5 rounded-lg text-xs text-neutral-500 dark:text-stone-400 border border-black/10 dark:border-stone-700/50 hover:bg-black/5 dark:hover:bg-white/5"
            >
              记录测试日志
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

// ============ 框架一：网络爬虫 ============
const crawlerMeta: FrameworkMeta = {
  title: '网络爬虫框架',
  subtitle: '反检测、反封锁、智能调度。分布式浏览器农场 + TLS 指纹伪装 + CDP 协议控制，针对反爬对抗场景。',
  posture: '攻防',
  capabilities: [
    '浏览器农场连接池预热（<80ms 取实例）',
    '20+ 维度指纹矩阵生成（Canvas/WebGL/字体/音频）',
    'TLS JA4/JA3 签名伪装（rustls 重写 ClientHello）',
    'HTTP/2 帧序列伪装（SETTINGS/WINDOW_UPDATE 时序）',
    'CDP 调用乱序抖动（规避反爬特征检测）',
    'LocalStorage/IndexedDB 持久化（老访客身份）',
    '429/503 智能退避调度器',
    'Geo 一致性强绑定（IP/语言/时区）',
  ],
  techStack: [
    { name: 'chromiumoxide', license: 'MPL-2.0' },
    { name: 'rustls', license: 'Apache-2.0' },
    { name: 'reqwest', license: 'MIT' },
    { name: 'tokio', license: 'MIT' },
  ],
  status: '内核就绪',
};

// ============ 状态卡片（模块级组件，避免渲染内重定义导致重挂载） ============
function StatusCard({ label, value, valueCls }: { label: string; value: React.ReactNode; valueCls?: string }) {
  return (
    <div className="bg-black/[0.03] dark:bg-white/[0.03] rounded-lg p-2.5 border border-black/5 dark:border-stone-700/50">
      <div className="text-[10px] text-neutral-400 mb-0.5">{label}</div>
      <div className={`text-sm font-medium text-[var(--element-bg)] ${valueCls ?? ''}`}>{value}</div>
    </div>
  );
}

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

        {/* 核心能力 */}
        <CollapsibleSection title="核心能力规划" storageKey="fw_crawler_capabilities" defaultOpen={false} accent="attack">
          <div className="grid grid-cols-2 gap-2">
            {crawlerMeta.capabilities.map((cap) => (
              <div key={cap} className="flex items-center gap-2 text-[13px] text-neutral-600 dark:text-stone-300">
                <span className="inline-block w-1 h-1 rounded-full bg-neutral-400" />
                {cap}
              </div>
            ))}
          </div>
        </CollapsibleSection>

        {/* 技术选型 */}
        <CollapsibleSection title="技术选型（优先 MIT/Apache 协议）" storageKey="fw_crawler_techstack" defaultOpen={false} accent="attack">
          <div className="flex flex-wrap gap-2">
            {crawlerMeta.techStack.map((t) => (
              <span
                key={t.name}
                className="px-2.5 py-1 rounded-lg text-xs bg-black/[0.04] dark:bg-white/[0.05] text-neutral-600 dark:text-stone-300 border border-black/5 dark:border-stone-700/50"
              >
                {t.name}
                <span className="ml-1.5 text-[10px] text-neutral-400">{t.license}</span>
              </span>
            ))}
          </div>
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
            <StatusCard label="TLS 指纹" value={strategy?.tls_profile ?? '—'} valueCls="font-mono text-[12px]" />
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
      </div>
    </div>
  );
}

// ============ 框架二：逆向工程 ============
const reverseMeta: FrameworkMeta = {
  title: '逆向工程框架',
  subtitle: '协议分析、加解密绕过。静态分析（WASM/字节码）+ 动态插桩（Frida/ptrace）双轨并行推理机。',
  posture: '攻防',
  capabilities: [
    'WASM 语义解析（wasmparser 建 CFG/DFG）',
    '常量池提取（锁定 Salt/IV）',
    'Frida-gum 动态 Hook（SSL_write/strcmp）',
    '协议状态机重建（PrefixSpan 序列挖掘）',
    'SIGTRAP 反调试对抗',
    '内存快照热加载脱壳（process_vm_readv）',
    '加密算法特征向量库匹配',
    'P-Code → Rust 伪代码翻译（AI 辅助）',
  ],
  techStack: [
    { name: 'petgraph', license: 'MIT' },
    { name: 'ghidra_headless', license: 'Apache-2.0' },
    { name: 'frida-gum', license: 'wxWindows' },
    { name: 'tokio', license: 'MIT' },
  ],
  status: '内核就绪',
};

function ReversePanel({ addLog }: { addLog: (i: AuditInput) => void }) {
  // 加密识别状态
  const [hexInput, setHexInput] = useState('');
  const [cryptoReport, setCryptoReport] = useState<CryptoReport | null>(null);
  const [cryptoBusy, setCryptoBusy] = useState(false);
  const [cryptoError, setCryptoError] = useState<string | null>(null);

  // 符号库查询状态
  const [symUrl, setSymUrl] = useState('');
  const [symbols, setSymbols] = useState<SymbolSummary[]>([]);
  const [symBusy, setSymBusy] = useState(false);
  const [symError, setSymError] = useState<string | null>(null);

  const handleCryptoIdentify = useCallback(async () => {
    const trimmed = hexInput.replace(/\s+/g, '');
    if (!trimmed) {
      setCryptoError('请输入 hex 字符串');
      return;
    }
    if (!/^[0-9a-fA-F]+$/.test(trimmed)) {
      setCryptoError('包含非 hex 字符（仅允许 0-9, a-f, A-F）');
      return;
    }
    if (trimmed.length % 2 !== 0) {
      setCryptoError('hex 长度必须为偶数');
      return;
    }
    setCryptoBusy(true);
    setCryptoError(null);
    try {
      const r = await tauriInvoke<CryptoReport>('gongfang_crypto_identify', { hexData: trimmed });
      setCryptoReport(r);
      addLog({
        action: '加密识别',
        target: `${r.data_len} 字节`,
        status: 'success',
        detail: r.matched_algorithm
          ? `匹配 ${r.matched_algorithm}（置信度 ${((r.confidence ?? 0) * 100).toFixed(0)}%）`
          : `未匹配已知算法（卡方=${r.chi_square.toFixed(1)}, 熵=${r.entropy.toFixed(2)}）`,
      });
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setCryptoError(msg);
      addLog({ action: '加密识别', target: 'hex 数据', status: 'error', detail: msg });
    } finally {
      setCryptoBusy(false);
    }
  }, [hexInput, addLog]);

  const handleSymbolsQuery = useCallback(async () => {
    setSymBusy(true);
    setSymError(null);
    try {
      const url = symUrl.trim() || null;
      const r = await tauriInvoke<SymbolSummary[]>('gongfang_symbols', { url });
      setSymbols(r);
      addLog({
        action: '符号库查询',
        target: symUrl.trim() || '全部',
        status: 'success',
        detail: `共 ${r.length} 个符号`,
      });
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setSymError(msg);
      addLog({ action: '符号库查询', target: symUrl.trim() || '全部', status: 'error', detail: msg });
    } finally {
      setSymBusy(false);
    }
  }, [symUrl, addLog]);

  // 置信度百分比（0-1 → 0-100）
  const confidencePct = cryptoReport?.confidence != null
    ? Math.round(cryptoReport.confidence * 100)
    : null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-6 space-y-5">
        {/* 框架标题 */}
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-[var(--element-bg)]">{reverseMeta.title}</h2>
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-violet-500/15 text-violet-600 dark:text-violet-400">{reverseMeta.posture}</span>
          <span className="px-2 py-0.5 rounded text-[11px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">{reverseMeta.status}</span>
        </div>
        <p className="text-sm text-neutral-500 dark:text-stone-400 leading-relaxed">{reverseMeta.subtitle}</p>

        {/* 技术选型 */}
        <CollapsibleSection title="技术选型（优先 MIT/Apache 协议）" storageKey="fw_reverse_techstack" defaultOpen={false} accent="info">
          <div className="flex flex-wrap gap-2">
            {reverseMeta.techStack.map((t) => (
              <span key={t.name} className="px-2.5 py-1 rounded-lg text-xs bg-black/[0.04] dark:bg-white/[0.05] text-neutral-600 dark:text-stone-300 border border-black/5 dark:border-stone-700/50">
                {t.name}<span className="ml-1.5 text-[10px] text-neutral-400">{t.license}</span>
              </span>
            ))}
          </div>
        </CollapsibleSection>

        {/* 加密识别 */}
        <CollapsibleSection
          title="加密算法识别（卡方检验 + 特征向量库）"
          storageKey="fw_reverse_crypto"
          defaultOpen={true}
          accent="info"
          right={<span className="text-[10px] text-neutral-400">零依赖自实现 · 替代 DFA/Gröbner</span>}
        >
          <div className="space-y-2">
            <textarea
              value={hexInput}
              onChange={(e) => setHexInput(e.target.value)}
              placeholder="粘贴 hex 字符串（空格/换行会自动忽略），如 6e3a5f2c8b1d4a7e..."
              rows={3}
              className="w-full px-2.5 py-1.5 rounded-lg text-xs font-mono bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)] placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-[var(--element-bg)] resize-y"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={handleCryptoIdentify}
                disabled={cryptoBusy || !hexInput.trim()}
                className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
              >
                {cryptoBusy ? '识别中...' : '识别算法'}
              </button>
              <button
                onClick={() => { setHexInput(''); setCryptoReport(null); setCryptoError(null); }}
                disabled={!hexInput.trim() && !cryptoReport}
                className="btn-press px-2.5 py-1.5 rounded-lg text-xs text-neutral-500 dark:text-stone-400 border border-black/10 dark:border-stone-700/50 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40"
              >
                清空
              </button>
              <span className="text-[10px] text-neutral-400">
                {hexInput.replace(/\s+/g, '').length} 字符 · {hexInput.replace(/\s+/g, '').length / 2} 字节
              </span>
            </div>
            {cryptoError && (
              <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-500/10 rounded-lg px-2.5 py-1.5">
                {cryptoError}
              </div>
            )}
          </div>

          {/* 加密识别结果 */}
          {cryptoReport && (
            <div className="space-y-2 pt-1">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <StatusCard label="数据长度" value={`${cryptoReport.data_len} 字节`} />
                <StatusCard label="块大小" value={cryptoReport.block_size ? `${cryptoReport.block_size} 字节` : '—'} valueCls="font-mono text-[11px]" />
                <StatusCard
                  label="分布判定"
                  value={cryptoReport.is_uniform ? '均匀（疑似加密）' : '非均匀（疑似编码）'}
                  valueCls={cryptoReport.is_uniform ? 'text-amber-600 dark:text-amber-400' : 'text-sky-600 dark:text-sky-400'}
                />
                <StatusCard
                  label="卡方值"
                  value={cryptoReport.chi_square.toFixed(1)}
                  valueCls={cryptoReport.chi_square > 300 ? 'text-rose-600 dark:text-rose-400' : ''}
                />
                <StatusCard
                  label="香农熵"
                  value={cryptoReport.entropy.toFixed(3)}
                  valueCls={cryptoReport.entropy > 7.5 ? 'text-amber-600 dark:text-amber-400' : ''}
                />
                <StatusCard
                  label="匹配算法"
                  value={cryptoReport.matched_algorithm ?? '未匹配'}
                  valueCls={cryptoReport.matched_algorithm ? 'text-emerald-600 dark:text-emerald-400 font-mono text-[11px]' : ''}
                />
              </div>
              {cryptoReport.matched_algorithm && confidencePct != null && (
                <div className="bg-black/[0.03] dark:bg-white/[0.03] rounded-lg p-2.5 border border-black/5 dark:border-stone-700/50">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-neutral-400">置信度</span>
                    <span className="text-xs font-mono text-[var(--element-bg)]">{confidencePct}%</span>
                  </div>
                  <div className="h-1.5 bg-black/5 dark:bg-white/10 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-emerald-500 rounded-full transition-all"
                      style={{ width: `${confidencePct}%` }}
                    />
                  </div>
                </div>
              )}
              <p className="text-[10px] text-neutral-400 leading-relaxed">
                卡方值 &gt; 300 → p &lt; 0.05 非均匀分布（可能非标准加密）；熵 &gt; 7.5 → 高熵（疑似加密或压缩）。
              </p>
            </div>
          )}
        </CollapsibleSection>

        {/* 符号库查询 */}
        <CollapsibleSection
          title="符号库查询（跨会话复用资产）"
          storageKey="fw_reverse_symbols"
          defaultOpen={true}
          accent="info"
          right={<span className="text-[10px] text-neutral-400">内存 HashMap · @reset 仅清断点</span>}
        >
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={symUrl}
              onChange={(e) => setSymUrl(e.target.value)}
              placeholder="目标 URL（留空查询全部）"
              className="flex-1 px-2.5 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)] placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-[var(--element-bg)]"
            />
            <button
              onClick={handleSymbolsQuery}
              disabled={symBusy}
              className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
            >
              {symBusy ? '查询中...' : '查询'}
            </button>
          </div>
          {symError && (
            <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-500/10 rounded-lg px-2.5 py-1.5">
              {symError}
            </div>
          )}
          {symbols.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-neutral-400 border-b border-black/5 dark:border-stone-700/50">
                    <th className="py-1.5 pr-3">URL</th>
                    <th className="py-1.5 pr-3">符号名</th>
                    <th className="py-1.5 pr-3">地址</th>
                    <th className="py-1.5 pr-3">类型</th>
                    <th className="py-1.5">元信息</th>
                  </tr>
                </thead>
                <tbody>
                  {symbols.map((s, i) => (
                    <tr key={i} className="border-b border-black/[0.03] dark:border-stone-700/30 align-top">
                      <td className="py-1.5 pr-3 font-mono text-neutral-500 dark:text-stone-400 max-w-[160px] truncate" title={s.url}>{s.url || '—'}</td>
                      <td className="py-1.5 pr-3 font-mono text-[var(--element-bg)]">{s.name}</td>
                      <td className="py-1.5 pr-3 font-mono text-neutral-500 dark:text-stone-400">0x{s.address.toString(16).padStart(8, '0')}</td>
                      <td className="py-1.5 pr-3">
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-violet-500/15 text-violet-600 dark:text-violet-400">{s.kind}</span>
                      </td>
                      <td className="py-1.5 text-neutral-500 dark:text-stone-400 max-w-[200px]">
                        {Object.keys(s.meta).length === 0
                          ? '—'
                          : Object.entries(s.meta).map(([k, v]) => (
                              <span key={k} className="inline-block mr-2 font-mono text-[10px]">
                                <span className="text-neutral-400">{k}=</span>
                                <span className="text-[var(--element-bg)]">{v}</span>
                              </span>
                            ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {symbols.length === 0 && !symBusy && !symError && symUrl !== '' && (
            <p className="text-[11px] text-neutral-400">该 URL 暂无已学习符号。逆向过程中识别到的函数/S盒/协议字段会自动入库。</p>
          )}
        </CollapsibleSection>

        {/* P2：反汇编视图（IDA/Ghidra 风格符号表 + 伪反汇编预览） */}
        <DisassemblyView symbols={symbols} />
      </div>
    </div>
  );
}

// ============ 框架三：渗透测试 ============
const pentestMeta: FrameworkMeta = {
  title: '渗透测试框架',
  subtitle: '漏洞扫描、WAF 绕过。三层引擎：静态参数分析 + 动态变异 + 多层编码混淆链，语义感知 Payload 生成。',
  posture: '攻',
  capabilities: [
    '参数边界推演（OpenAPI/Swagger 解析）',
    'WAF 指纹主动探测（cf-ray/aliyun-waf）',
    'SQL 注入编码链（URL/Unicode/双重编码/注释符）',
    'XSS 编码链（SVG/JSFuck/HTML 实体）',
    'RCE 编码链（Base64/变量拼接/通配符）',
    'Transfer-Encoding chunked 分块绕过',
    'HPP 参数污染（Tomcat vs WebLogic 差异）',
    'JSON 不可见 Unicode 混淆',
    'PPO 强化学习自适应变异（AI）',
  ],
  techStack: [
    { name: 'naabu', license: 'MIT' },
    { name: 'nuclei', license: 'MIT' },
    { name: 'httpx', license: 'MIT' },
    { name: 'petgraph', license: 'MIT' },
    { name: 'reqwest', license: 'MIT' },
  ],
  status: '内核就绪',
};

function PentestPanel({ addLog }: { addLog: (i: AuditInput) => void }) {
  const [scanHost, setScanHost] = useState('');
  const [scanPorts, setScanPorts] = useState('');
  const [useCustomPorts, setUseCustomPorts] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  // P1：累积所有扫描结果（用于资产树聚合）
  const [scanHistory, setScanHistory] = useState<ScanResult[]>([]);

  const [wafUrl, setWafUrl] = useState('');
  const [wafResult, setWafResult] = useState<WafDetectResult | null>(null);
  const [wafBusy, setWafBusy] = useState(false);

  const handleScan = useCallback(async () => {
    if (!scanHost.trim()) return;
    setScanBusy(true);
    try {
      const ports = useCustomPorts && scanPorts.trim()
        ? scanPorts.split(',').map((p) => parseInt(p.trim(), 16)).filter((p) => !isNaN(p) && p > 0 && p <= 65535)
        : null;
      const r = await tauriInvoke<ScanResult>('gongfang_scan', { host: scanHost.trim(), ports });
      setScanResult(r);
      // P1：累积到历史
      if (!r.error && r.open_ports.length > 0) {
        setScanHistory((prev) => [...prev, r]);
      }
      addLog({
        action: '端口扫描',
        target: scanHost.trim(),
        status: r.error ? 'warn' : 'success',
        detail: r.error ? r.error : `发现 ${r.open_ports.length} 个开放端口（${r.duration_ms}ms）`,
      });
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      addLog({ action: '端口扫描', target: scanHost.trim(), status: 'error', detail: msg });
    } finally {
      setScanBusy(false);
    }
  }, [scanHost, scanPorts, useCustomPorts, addLog]);

  const handleWafDetect = useCallback(async () => {
    if (!wafUrl.trim()) return;
    setWafBusy(true);
    try {
      const r = await tauriInvoke<WafDetectResult>('gongfang_waf_detect', { url: wafUrl.trim() });
      setWafResult(r);
      addLog({
        action: 'WAF 检测',
        target: wafUrl.trim(),
        status: 'success',
        detail: r.waf_name ? `检测到 ${r.waf_name}（${r.engine}）` : '未检测到 WAF',
      });
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      addLog({ action: 'WAF 检测', target: wafUrl.trim(), status: 'error', detail: msg });
    } finally {
      setWafBusy(false);
    }
  }, [wafUrl, addLog]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-6 space-y-5">
        {/* 框架标题 */}
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-[var(--element-bg)]">{pentestMeta.title}</h2>
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-rose-500/15 text-rose-600 dark:text-rose-400">{pentestMeta.posture}</span>
          <span className="px-2 py-0.5 rounded text-[11px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">{pentestMeta.status}</span>
        </div>
        <p className="text-sm text-neutral-500 dark:text-stone-400 leading-relaxed">{pentestMeta.subtitle}</p>

        {/* 技术选型 */}
        <CollapsibleSection title="技术选型（全 MIT 协议，替代 NPSL/GPL）" storageKey="fw_pentest_techstack" defaultOpen={false} accent="attack">
          <div className="flex flex-wrap gap-2">
            {pentestMeta.techStack.map((t) => (
              <span key={t.name} className="px-2.5 py-1 rounded-lg text-xs bg-black/[0.04] dark:bg-white/[0.05] text-neutral-600 dark:text-stone-300 border border-black/5 dark:border-stone-700/50">
                {t.name}<span className="ml-1.5 text-[10px] text-neutral-400">{t.license}</span>
              </span>
            ))}
          </div>
        </CollapsibleSection>

        {/* 端口扫描 */}
        <CollapsibleSection
          title="端口扫描（naabu 外部进程）"
          storageKey="fw_pentest_scan"
          defaultOpen={true}
          accent="attack"
          right={<span className="text-[10px] text-neutral-400">MIT 协议 · 替代 nmap/masscan</span>}
        >
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={scanHost}
              onChange={(e) => setScanHost(e.target.value)}
              placeholder="目标主机（IP 或域名，如 example.com）"
              className="flex-1 px-2.5 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)] placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-[var(--element-bg)]"
            />
            <select
              value={useCustomPorts ? 'custom' : 'top100'}
              onChange={(e) => setUseCustomPorts(e.target.value === 'custom')}
              className="px-2 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)]"
            >
              <option value="top100">Top-100</option>
              <option value="custom">自定义端口</option>
            </select>
            {useCustomPorts && (
              <input
                type="text"
                value={scanPorts}
                onChange={(e) => setScanPorts(e.target.value)}
                placeholder="80,443,8080（逗号分隔）"
                className="w-48 px-2.5 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)] placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-[var(--element-bg)]"
              />
            )}
            <button
              onClick={handleScan}
              disabled={scanBusy || !scanHost.trim()}
              className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
            >
              {scanBusy ? '扫描中...' : '扫描'}
            </button>
          </div>

          {/* 扫描结果 */}
          {scanResult && (
            <div className="space-y-2">
              {scanResult.error && (
                <div className="text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 rounded-lg px-2.5 py-1.5">
                  {scanResult.error}
                </div>
              )}
              {scanResult.naabu_path && (
                <div className="text-[10px] text-neutral-400">naabu 路径：{scanResult.naabu_path} · 耗时 {scanResult.duration_ms}ms</div>
              )}
              {scanResult.open_ports.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-neutral-400 border-b border-black/5 dark:border-stone-700/50">
                        <th className="py-1.5 pr-3">端口</th>
                        <th className="py-1.5 pr-3">协议</th>
                        <th className="py-1.5 pr-3">IP</th>
                        <th className="py-1.5 pr-3">服务</th>
                        <th className="py-1.5">TLS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scanResult.open_ports.map((p, i) => (
                        <tr key={i} className="border-b border-black/[0.03] dark:border-stone-700/30">
                          <td className="py-1.5 pr-3 font-mono text-[var(--element-bg)]">{p.port}</td>
                          <td className="py-1.5 pr-3 text-neutral-500 dark:text-stone-400">{p.protocol}</td>
                          <td className="py-1.5 pr-3 font-mono text-neutral-500 dark:text-stone-400">{p.ip || '—'}</td>
                          <td className="py-1.5 pr-3 text-neutral-500 dark:text-stone-400">{p.service || '—'}</td>
                          <td className="py-1.5">{p.tls ? <span className="text-emerald-600 dark:text-emerald-400">✓</span> : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </CollapsibleSection>

        {/* WAF 检测 */}
        <CollapsibleSection title="WAF 指纹检测" storageKey="fw_pentest_waf" defaultOpen={true} accent="attack">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={wafUrl}
              onChange={(e) => setWafUrl(e.target.value)}
              placeholder="目标 URL（如 https://example.com）"
              className="flex-1 px-2.5 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)] placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-[var(--element-bg)]"
            />
            <button
              onClick={handleWafDetect}
              disabled={wafBusy || !wafUrl.trim()}
              className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
            >
              {wafBusy ? '检测中...' : '检测'}
            </button>
          </div>

          {wafResult && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <StatusCard label="WAF" value={wafResult.waf_name || '未检测到'} valueCls={wafResult.waf_name ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'} />
              <StatusCard label="正则引擎" value={wafResult.engine} valueCls="font-mono text-[11px]" />
              <StatusCard label="状态码" value={wafResult.status_code} />
              <StatusCard label="响应熵" value={wafResult.entropy.toFixed(2)} valueCls={wafResult.entropy > 7.5 ? 'text-amber-600 dark:text-amber-400' : ''} />
              {wafResult.signals.length > 0 && (
                <div className="col-span-2 sm:col-span-3">
                  <div className="text-[10px] text-neutral-400 mb-1">WAF 信号</div>
                  <div className="flex flex-wrap gap-1">
                    {wafResult.signals.map((s, i) => (
                      <span key={i} className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/15 text-amber-600 dark:text-amber-400">{s}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </CollapsibleSection>

        {/* P1：资产树 + Payload 库（按主机聚合扫描结果 + 预设注入模板） */}
        <PentestAssetTree scanResults={scanHistory.map((r) => ({ host: r.host, ip: r.host, open_ports: r.open_ports, duration_ms: r.duration_ms }))} />
      </div>
    </div>
  );
}

// ============ 框架四：自动化测试 ============
const automationMeta: FrameworkMeta = {
  title: '自动化测试框架',
  subtitle: '验证码绕过、行为模拟。多模态决策体：视觉解构 + 逻辑推理 + 贝塞尔曲线行为模型 + 人类噪声注入。',
  posture: '攻防',
  capabilities: [
    '图形验证码 OCR（Tesseract + imageproc 降噪）',
    '滑块/点选验证码（YOLOv8 ONNX 定位）',
    '鼠标轨迹（三次贝塞尔 + 布朗运动噪声）',
    '键盘输入（正态分布延迟 + 误触纠错）',
    '视口非匀速平滑滚动',
    'Ticket 窗口期预测复用',
    '语音验证码旁路（Twilio + Whisper）',
    'Canvas 像素噪点反检测',
    'VLM 语义验证码推理（AI）',
  ],
  techStack: [
    { name: 'winapi (SendInput)', license: 'MIT' },
    { name: 'arc-swap', license: 'MIT/Apache-2.0' },
    { name: 'tokio', license: 'MIT' },
    { name: 'petgraph', license: 'MIT' },
  ],
  status: '内核就绪',
};

function AutomationPanel({ addLog }: { addLog: (i: AuditInput) => void }) {
  // 拟人化等级状态
  const [humanizeLevel, setHumanizeLevel] = useState(5);
  const [currentTemplate, setCurrentTemplate] = useState<string | null>(null);
  const [humanizeBusy, setHumanizeBusy] = useState(false);
  const [humanizeError, setHumanizeError] = useState<string | null>(null);

  // 适应度报告状态
  const [fitness, setFitness] = useState<FitnessReport[]>([]);
  const [fitnessBusy, setFitnessBusy] = useState(false);
  const [fitnessError, setFitnessError] = useState<string | null>(null);
  const [migrateMsg, setMigrateMsg] = useState<string | null>(null);

  // 根据等级返回说明
  const levelDesc = (lv: number): { label: string; cls: string } => {
    if (lv === 0) return { label: '机械精度模式', cls: 'text-rose-600 dark:text-rose-400' };
    if (lv <= 3) return { label: '低拟人化', cls: 'text-amber-600 dark:text-amber-400' };
    if (lv <= 7) return { label: '中拟人化', cls: 'text-sky-600 dark:text-sky-400' };
    return { label: '高拟人化', cls: 'text-violet-600 dark:text-violet-400' };
  };

  const handleApplyLevel = useCallback(async () => {
    setHumanizeBusy(true);
    setHumanizeError(null);
    try {
      const name = await tauriInvoke<string>('gongfang_humanize', { level: humanizeLevel });
      setCurrentTemplate(name);
      addLog({
        action: '设置拟人化等级',
        target: `L${humanizeLevel}`,
        status: 'success',
        detail: `当前模板：${name}`,
      });
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setHumanizeError(msg);
      addLog({ action: '设置拟人化等级', target: `L${humanizeLevel}`, status: 'error', detail: msg });
    } finally {
      setHumanizeBusy(false);
    }
  }, [humanizeLevel, addLog]);

  const handleRefreshFitness = useCallback(async () => {
    setFitnessBusy(true);
    setFitnessError(null);
    try {
      const r = await tauriInvoke<FitnessReport[]>('gongfang_fitness');
      setFitness(r);
      addLog({
        action: '查询适应度报告',
        target: '自动化框架',
        status: 'success',
        detail: `共 ${r.length} 个模板`,
      });
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setFitnessError(msg);
      addLog({ action: '查询适应度报告', target: '自动化框架', status: 'error', detail: msg });
    } finally {
      setFitnessBusy(false);
    }
  }, [addLog]);

  const handleMigrate = useCallback(async () => {
    setHumanizeBusy(true);
    setMigrateMsg(null);
    try {
      const msg = await tauriInvoke<string>('gongfang_fitness_migrate');
      setMigrateMsg(msg);
      // migrate 返回 "已迁移到: <模板名>"，直接解析提取模板名
      const match = msg.match(/已迁移到:\s*(.+)$/);
      if (match) setCurrentTemplate(match[1].trim());
      addLog({
        action: '触发热迁移',
        target: '自动化框架',
        status: 'success',
        detail: msg,
      });
      // 自动刷新适应度报告
      await handleRefreshFitness();
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setFitnessError(msg);
      addLog({ action: '触发热迁移', target: '自动化框架', status: 'error', detail: msg });
    } finally {
      setHumanizeBusy(false);
    }
  }, [addLog, handleRefreshFitness]);

  const handleReset = useCallback(async () => {
    setHumanizeBusy(true);
    setMigrateMsg(null);
    try {
      await tauriInvoke('gongfang_fitness_reset');
      addLog({
        action: '重置适应度统计',
        target: '自动化框架',
        status: 'success',
      });
      // 自动刷新
      await handleRefreshFitness();
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setFitnessError(msg);
      addLog({ action: '重置适应度统计', target: '自动化框架', status: 'error', detail: msg });
    } finally {
      setHumanizeBusy(false);
    }
  }, [addLog, handleRefreshFitness]);

  const lvInfo = levelDesc(humanizeLevel);

  // 找出成功率最高的模板（热迁移的目标）
  const bestIdx = fitness.length > 0
    ? fitness.reduce((best, cur, i) => cur.success_rate > fitness[best].success_rate ? i : best, 0)
    : -1;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-6 space-y-5">
        {/* 框架标题 */}
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-[var(--element-bg)]">{automationMeta.title}</h2>
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-violet-500/15 text-violet-600 dark:text-violet-400">{automationMeta.posture}</span>
          <span className="px-2 py-0.5 rounded text-[11px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">{automationMeta.status}</span>
        </div>
        <p className="text-sm text-neutral-500 dark:text-stone-400 leading-relaxed">{automationMeta.subtitle}</p>

        {/* 技术选型 */}
        <CollapsibleSection title="技术选型（优先 MIT/Apache 协议）" storageKey="fw_automation_techstack" defaultOpen={false} accent="info">
          <div className="flex flex-wrap gap-2">
            {automationMeta.techStack.map((t) => (
              <span key={t.name} className="px-2.5 py-1 rounded-lg text-xs bg-black/[0.04] dark:bg-white/[0.05] text-neutral-600 dark:text-stone-300 border border-black/5 dark:border-stone-700/50">
                {t.name}<span className="ml-1.5 text-[10px] text-neutral-400">{t.license}</span>
              </span>
            ))}
          </div>
        </CollapsibleSection>

        {/* 拟人化等级控制 */}
        <CollapsibleSection
          title="行为拟人化等级（@humanize）"
          storageKey="fw_automation_humanize"
          defaultOpen={true}
          accent="info"
          right={<span className="text-[10px] text-neutral-400">arc-swap 策略热交换</span>}
        >
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={10}
                step={1}
                value={humanizeLevel}
                onChange={(e) => setHumanizeLevel(Number(e.target.value))}
                className="flex-1 h-1.5 bg-black/10 dark:bg-white/10 rounded-full appearance-none cursor-pointer accent-[var(--element-bg)]"
              />
              <div className="flex items-baseline gap-2 min-w-[120px]">
                <span className="text-2xl font-mono font-semibold text-[var(--element-bg)]">{humanizeLevel}</span>
                <span className={`text-xs font-medium ${lvInfo.cls}`}>{lvInfo.label}</span>
              </div>
              <button
                onClick={handleApplyLevel}
                disabled={humanizeBusy}
                className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
              >
                {humanizeBusy ? '应用中...' : '应用'}
              </button>
            </div>
            {/* 等级刻度 */}
            <div className="flex justify-between text-[9px] text-neutral-400 px-1">
              <span>0 机械</span>
              <span>3</span>
              <span>5 中</span>
              <span>7</span>
              <span>10 疲劳</span>
            </div>
            {currentTemplate && (
              <div className="text-[11px] text-neutral-500 dark:text-stone-400">
                当前模板：<span className="font-mono text-[var(--element-bg)]">{currentTemplate}</span>
              </div>
            )}
            {humanizeError && (
              <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-500/10 rounded-lg px-2.5 py-1.5">
                {humanizeError}
              </div>
            )}
            <p className="text-[10px] text-neutral-400 leading-relaxed">
              等级越高，鼠标贝塞尔曲线噪声越大、键盘延迟越长，越接近人类疲劳/醉酒状态；L0 关闭所有噪声，用于压力测试。
            </p>
          </div>
        </CollapsibleSection>

        {/* 适应度报告 */}
        <CollapsibleSection
          title="模板适应度报告"
          storageKey="fw_automation_fitness"
          defaultOpen={true}
          accent="info"
          right={
            <div className="flex items-center gap-1.5">
              <button
                onClick={handleRefreshFitness}
                disabled={fitnessBusy}
                className="btn-press px-2.5 py-1 rounded-lg text-[11px] text-neutral-600 dark:text-stone-300 border border-black/10 dark:border-stone-700/50 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {fitnessBusy ? '刷新中...' : '刷新'}
              </button>
              <button
                onClick={handleMigrate}
                disabled={humanizeBusy || fitness.length === 0}
                title="切换到适应度最高的模板"
                className="btn-press px-2.5 py-1 rounded-lg text-[11px] text-white bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                热迁移
              </button>
              <button
                onClick={handleReset}
                disabled={humanizeBusy || fitness.length === 0}
                title="清空所有模板的适应度统计"
                className="btn-press px-2.5 py-1 rounded-lg text-[11px] text-rose-600 dark:text-rose-400 border border-rose-500/30 hover:bg-rose-500/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                重置
              </button>
            </div>
          }
        >
          {migrateMsg && (
            <div className="text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 rounded-lg px-2.5 py-1.5">
              {migrateMsg}
            </div>
          )}
          {fitnessError && (
            <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-500/10 rounded-lg px-2.5 py-1.5">
              {fitnessError}
            </div>
          )}

          {fitness.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-neutral-400 border-b border-black/5 dark:border-stone-700/50">
                    <th className="py-1.5 pr-3">ID</th>
                    <th className="py-1.5 pr-3">模板名</th>
                    <th className="py-1.5 pr-3">成功</th>
                    <th className="py-1.5 pr-3">失败</th>
                    <th className="py-1.5 pr-3">成功率</th>
                    <th className="py-1.5">平均偏离度</th>
                  </tr>
                </thead>
                <tbody>
                  {fitness.map((f, i) => {
                    const isBest = i === bestIdx;
                    const ratePct = (f.success_rate * 100).toFixed(1);
                    const rateCls = f.success_rate > 0.8
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : f.success_rate > 0.5
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-rose-600 dark:text-rose-400';
                    return (
                      <tr key={f.id} className={`border-b border-black/[0.03] dark:border-stone-700/30 ${isBest ? 'bg-emerald-500/[0.04]' : ''}`}>
                        <td className="py-1.5 pr-3 font-mono text-neutral-500 dark:text-stone-400">{f.id}</td>
                        <td className="py-1.5 pr-3 font-mono text-[var(--element-bg)]">
                          {f.name}
                          {isBest && (
                            <span className="ml-1.5 px-1 py-0.5 rounded text-[9px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">BEST</span>
                          )}
                        </td>
                        <td className="py-1.5 pr-3 text-emerald-600 dark:text-emerald-400">{f.success}</td>
                        <td className="py-1.5 pr-3 text-rose-600 dark:text-rose-400">{f.failure}</td>
                        <td className={`py-1.5 pr-3 font-mono ${rateCls}`}>{ratePct}%</td>
                        <td className="py-1.5 font-mono text-neutral-500 dark:text-stone-400">{f.avg_divergence.toFixed(3)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            !fitnessBusy && !fitnessError && (
              <p className="text-[11px] text-neutral-400">暂无适应度数据。自动化任务执行时会自动累计成功/失败计数，热迁移将切换到成功率最高且偏离度最低的模板。</p>
            )
          )}
          <p className="text-[10px] text-neutral-400 leading-relaxed">
            热迁移：在运行时不重启内核的前提下，通过 arc-swap 切换策略指针到最优模板；偏离度越低，行为越接近真实人类。
          </p>
        </CollapsibleSection>

        {/* P1：任务列表 + 模板对比（前端状态机 + 基于 fitness 找最优模板） */}
        <AutomationTaskList fitness={fitness} />

        {/* P2：脚本编辑器（CodeMirror 6 + 语法高亮 + 模板插入 + localStorage 持久化） */}
        <ScriptEditor storageKey="gongfang_automation_script" />
      </div>
    </div>
  );
}

export { CrawlerPanel, ReversePanel, PentestPanel, AutomationPanel, GatewayPanel };

// ============ 框架五：API 网关 ============
const gatewayMeta: FrameworkMeta = {
  title: 'API 网关框架',
  subtitle: '自适应流量整形器。节点信誉矩阵 + Poisson 间隔 + 头序随机化 + Payload 混淆 + 预测性故障转移，让所有流量看起来像正常业务聚合。',
  posture: '攻防',
  capabilities: [
    '节点信誉矩阵（错误率 + EWMA RTT + 梯度惩罚）',
    'N+1 冗余池（备用节点 ≥ 活跃 50%）',
    '预测性故障转移（RTT 梯度递增 → 提前切换）',
    'Poisson 间隔生成器（突发-静默模式模拟人类浏览）',
    'HTTP 头序随机化（对齐 Chrome/Firefox/Safari 高频分布）',
    'JSON Payload 混淆（冗余字段 + 字段顺序随机化）',
    '请求熵监控器（Shannon 熵低于阈值时自动注入假请求）',
    'OS 指纹加权随机（Win+Chrome 65% / macOS+Safari 15% / ...）',
    'arc-swap 策略热交换（@rotate/@throttle 亚毫秒级切换）',
    'JSON 快照恢复（灾难性故障 < 100ms 重建）',
  ],
  techStack: [
    { name: 'arc-swap', license: 'MIT' },
    { name: 'parking_lot', license: 'Apache-2.0' },
    { name: 'reqwest', license: 'MIT' },
    { name: 'serde', license: 'MIT' },
    { name: 'xorshift64*', license: '内置' },
  ],
  status: '内核就绪',
};

// 路由模式徽标配色
const ROUTING_BADGE: Record<string, { cls: string; desc: string }> = {
  direct: { cls: 'bg-sky-500/15 text-sky-600 dark:text-sky-400', desc: '直连，无代理无整形' },
  proxy: { cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400', desc: '代理池模式 + 流量整形' },
  stealth: { cls: 'bg-violet-500/15 text-violet-600 dark:text-violet-400', desc: '隐身模式 + 全整形 + 熵注入' },
};

function GatewayPanel({ addLog }: { addLog: (i: AuditInput) => void }) {
  const [status, setStatus] = useState<GatewayStatusResult | null>(null);
  const [nodes, setNodes] = useState<GatewayNodeSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rotateMsg, setRotateMsg] = useState<string | null>(null);
  const [throttleRatio, setThrottleRatio] = useState(100);
  const [throttleMsg, setThrottleMsg] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const s = await tauriInvoke<GatewayStatusResult>('gongfang_gateway_status');
      setStatus(s);
      setError(null);
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setError(msg);
    }
  }, []);

  const fetchNodes = useCallback(async () => {
    try {
      const n = await tauriInvoke<GatewayNodeSummary[]>('gongfang_gateway_pool');
      setNodes(n);
    } catch (e) {
      // 静默：节点列表失败不阻塞主状态展示
      console.warn('[gateway] 节点列表加载失败', e);
    }
  }, []);

  // 初次挂载：拉取状态 + 节点列表
  useEffect(() => {
    fetchStatus();
    fetchNodes();
  }, [fetchStatus, fetchNodes]);

  // 每 3 秒自动刷新状态（即使未运行，也保留轮询以便看到策略变化）
  useEffect(() => {
    const id = setInterval(fetchStatus, 3000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  const handleRotate = useCallback(async (mode: 'direct' | 'proxy' | 'stealth') => {
    setBusy(true);
    setRotateMsg(null);
    try {
      const msg = await tauriInvoke<string>('gongfang_gateway_rotate', { mode });
      setRotateMsg(msg);
      addLog({
        action: '切换路由模式',
        target: mode,
        status: 'success',
        detail: msg,
      });
      await fetchStatus();
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setError(msg);
      addLog({ action: '切换路由模式', target: mode, status: 'error', detail: msg });
    } finally {
      setBusy(false);
    }
  }, [addLog, fetchStatus]);

  const handleThrottle = useCallback(async () => {
    setBusy(true);
    setThrottleMsg(null);
    try {
      const ratio = throttleRatio / 100;
      const msg = await tauriInvoke<string>('gongfang_gateway_throttle', { ratio });
      setThrottleMsg(msg);
      addLog({
        action: '调整带宽',
        target: `${throttleRatio}%`,
        status: 'success',
        detail: msg,
      });
      await fetchStatus();
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setError(msg);
      addLog({ action: '调整带宽', target: `${throttleRatio}%`, status: 'error', detail: msg });
    } finally {
      setBusy(false);
    }
  }, [throttleRatio, addLog, fetchStatus]);

  const fmtTime = (ts: number) => {
    if (!ts) return '-';
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  const routingInfo = status ? ROUTING_BADGE[status.routing] : null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-6 space-y-5">
        {/* 框架标题 */}
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-[var(--element-bg)]">{gatewayMeta.title}</h2>
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-violet-500/15 text-violet-600 dark:text-violet-400">{gatewayMeta.posture}</span>
          <span className="px-2 py-0.5 rounded text-[11px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">{gatewayMeta.status}</span>
        </div>
        <p className="text-sm text-neutral-500 dark:text-stone-400 leading-relaxed">{gatewayMeta.subtitle}</p>

        {/* 技术选型 */}
        <CollapsibleSection title="技术选型（优先 MIT/Apache 协议）" storageKey="fw_gateway_techstack" defaultOpen={false} accent="defense">
          <div className="flex flex-wrap gap-2">
            {gatewayMeta.techStack.map((t) => (
              <span key={t.name} className="px-2.5 py-1 rounded-lg text-xs bg-black/[0.04] dark:bg-white/[0.05] text-neutral-600 dark:text-stone-300 border border-black/5 dark:border-stone-700/50">
                {t.name}<span className="ml-1.5 text-[10px] text-neutral-400">{t.license}</span>
              </span>
            ))}
          </div>
        </CollapsibleSection>

        {/* 错误提示 */}
        {error && (
          <div className="px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-600 dark:text-rose-400">
            <span className="font-medium">网关错误：</span>{error}
            <span className="ml-2 text-[10px] text-rose-400/70">（若未启用 gongfang-gateway feature，所有命令将返回此错误）</span>
          </div>
        )}

        {/* 状态概览 */}
        <CollapsibleSection
          title="网关状态"
          storageKey="fw_gateway_status"
          defaultOpen={true}
          accent="defense"
          right={<span className="text-[10px] text-neutral-400">策略 v{status?.policy_version ?? '-'} · 生效 {fmtTime(status?.effective_ts ?? 0)}</span>}
        >
          <div className="grid grid-cols-4 gap-2">
            <StatusCard
              label="路由模式"
              value={status ? (
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${routingInfo?.cls ?? ''}`}>{status.routing_cn}</span>
              ) : '-'}
            />
            <StatusCard label="带宽比例" value={status ? `${Math.round(status.bandwidth_ratio * 100)}%` : '-'} />
            <StatusCard label="请求超时" value={status ? `${(status.request_timeout_ms / 1000).toFixed(1)}s` : '-'} />
            <StatusCard label="最大并发" value={status?.max_concurrent ?? '-'} />
            <StatusCard label="节点总数" value={status?.node_count ?? '-'} />
            <StatusCard
              label="N+1 冗余"
              value={status ? `${Math.round(status.redundancy_ratio * 100)}%` : '-'}
              valueCls={status && status.redundancy_ratio >= 0.5 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}
            />
            <StatusCard
              label="请求熵"
              value={status ? status.current_entropy.toFixed(2) : '-'}
              valueCls={status && status.current_entropy < 2.0 ? 'text-rose-600 dark:text-rose-400' : ''}
            />
            <StatusCard label="活跃节点" value={status?.active_node?.url ?? '-'} valueCls="font-mono text-[11px] truncate" />
          </div>
          {routingInfo && (
            <p className="text-[11px] text-neutral-400 leading-relaxed">{routingInfo.desc}</p>
          )}
        </CollapsibleSection>

        {/* 路由模式切换（@rotate） */}
        <CollapsibleSection
          title="路由模式切换（@rotate）"
          storageKey="fw_gateway_rotate"
          defaultOpen={true}
          accent="defense"
          right={<span className="text-[10px] text-neutral-400">arc-swap 无锁热交换</span>}
        >
          <div className="grid grid-cols-3 gap-2">
            {(['direct', 'proxy', 'stealth'] as const).map((mode) => {
              const info = ROUTING_BADGE[mode];
              const isActive = status?.routing === mode;
              return (
                <button
                  key={mode}
                  onClick={() => handleRotate(mode)}
                  disabled={busy}
                  className={`btn-press px-3 py-2 rounded-lg text-xs font-medium border transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                    isActive
                      ? `${info.cls} border-current`
                      : 'border-black/10 dark:border-stone-700/50 text-neutral-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/5'
                  }`}
                >
                  <div className="flex flex-col items-center gap-0.5">
                    <span>{info.desc.split('，')[0]}</span>
                    <span className="text-[10px] opacity-70">{info.desc.split('，').slice(1).join('，')}</span>
                  </div>
                </button>
              );
            })}
          </div>
          {rotateMsg && (
            <p className="text-[11px] text-emerald-600 dark:text-emerald-400">{rotateMsg}</p>
          )}
        </CollapsibleSection>

        {/* 带宽调节（@throttle） */}
        <CollapsibleSection
          title="带宽调节（@throttle）"
          storageKey="fw_gateway_throttle"
          defaultOpen={true}
          accent="defense"
          right={<span className="text-[10px] text-neutral-400">超时/并发联动调整</span>}
        >
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={5}
              max={100}
              step={5}
              value={throttleRatio}
              onChange={(e) => setThrottleRatio(Number(e.target.value))}
              className="flex-1 h-1.5 bg-black/10 dark:bg-white/10 rounded-full appearance-none cursor-pointer accent-[var(--element-bg)]"
            />
            <div className="flex items-baseline gap-1 min-w-[80px]">
              <span className="text-2xl font-mono font-semibold text-[var(--element-bg)]">{throttleRatio}</span>
              <span className="text-xs text-neutral-400">%</span>
            </div>
            <button
              onClick={handleThrottle}
              disabled={busy}
              className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
            >
              {busy ? '应用中...' : '应用'}
            </button>
          </div>
          <div className="flex justify-between text-[9px] text-neutral-400 px-1">
            <span>5% 极慢</span>
            <span>50%</span>
            <span>100% 全速</span>
          </div>
          <div className="text-[11px] text-neutral-400 leading-relaxed">
            当前策略 → 超时 <span className="font-mono text-neutral-500 dark:text-stone-300">{status ? `${(status.request_timeout_ms / 1000).toFixed(1)}s` : '-'}</span>
            ，并发 <span className="font-mono text-neutral-500 dark:text-stone-300">{status?.max_concurrent ?? '-'}</span>
            。ratio 越小，超时越长（避免误杀慢请求），并发越少。
          </div>
          {throttleMsg && (
            <p className="text-[11px] text-emerald-600 dark:text-emerald-400">{throttleMsg}</p>
          )}
        </CollapsibleSection>

        {/* 节点池表格 */}
        <CollapsibleSection
          title="代理节点池"
          storageKey="fw_gateway_pool"
          defaultOpen={true}
          accent="defense"
          right={
            <button
              onClick={fetchNodes}
              className="btn-press px-2 py-1 rounded text-[11px] text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5"
            >
              刷新
            </button>
          }
        >
          {nodes.length === 0 ? (
            <p className="text-[11px] text-neutral-400 text-center py-4">暂无节点数据。默认包含一个 direct 虚拟节点。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] text-neutral-400 border-b border-black/5 dark:border-stone-700/50">
                    <th className="py-1.5 pr-2 font-normal">URL</th>
                    <th className="py-1.5 px-2 font-normal">区域</th>
                    <th className="py-1.5 px-2 font-normal text-right">信誉</th>
                    <th className="py-1.5 px-2 font-normal text-right">错误率</th>
                    <th className="py-1.5 px-2 font-normal text-right">EWMA RTT</th>
                    <th className="py-1.5 px-2 font-normal text-right">梯度</th>
                    <th className="py-1.5 pl-2 font-normal text-center">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {nodes.map((n, i) => {
                    const repCls = n.reputation >= 70
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : n.reputation >= 40
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-rose-600 dark:text-rose-400';
                    return (
                      <tr key={i} className="border-b border-black/[0.03] dark:border-stone-700/30">
                        <td className="py-1.5 pr-2 font-mono text-[11px] text-[var(--element-bg)] truncate max-w-[200px]">{n.url}</td>
                        <td className="py-1.5 px-2 text-neutral-500 dark:text-stone-400">{n.region}</td>
                        <td className={`py-1.5 px-2 text-right font-mono ${repCls}`}>{n.reputation.toFixed(0)}</td>
                        <td className="py-1.5 px-2 text-right font-mono text-neutral-500 dark:text-stone-400">{(n.error_rate * 100).toFixed(1)}%</td>
                        <td className="py-1.5 px-2 text-right font-mono text-neutral-500 dark:text-stone-400">{n.ewma_rtt.toFixed(0)}ms</td>
                        <td className={`py-1.5 px-2 text-right font-mono ${n.rtt_gradient > 10 ? 'text-rose-600 dark:text-rose-400' : 'text-neutral-500 dark:text-stone-400'}`}>
                          {n.rtt_gradient > 0 ? '+' : ''}{n.rtt_gradient.toFixed(1)}
                        </td>
                        <td className="py-1.5 pl-2 text-center">
                          {n.is_failing ? (
                            <span className="px-1.5 py-0.5 rounded text-[10px] bg-rose-500/15 text-rose-600 dark:text-rose-400">故障</span>
                          ) : (
                            <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">正常</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[10px] text-neutral-400 leading-relaxed">
            信誉评分综合错误率（40%权重）+ EWMA RTT（10-20%权重）+ RTT 梯度（15%权重）。梯度 &gt; 10ms/样本 时触发预测性切换；错误率 &gt; 10% 或梯度 &gt; 15ms/样本 时标记故障。
          </p>
        </CollapsibleSection>

        {/* P1：策略历史时间轴（订阅 strategy_committed 事件 + 拉取历史） */}
        <GatewayStrategyHistory />

        {/* 核心能力清单 */}
        <CollapsibleSection title="核心能力" storageKey="fw_gateway_capabilities" defaultOpen={false} accent="defense">
          <div className="grid grid-cols-2 gap-2">
            {gatewayMeta.capabilities.map((cap) => (
              <div key={cap} className="flex items-start gap-2 text-[13px] text-neutral-600 dark:text-stone-300">
                <span className="inline-block w-1 h-1 mt-1.5 rounded-full bg-neutral-400 shrink-0" />
                <span>{cap}</span>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      </div>
    </div>
  );
}
