/// <reference path="../../../global.d.ts" />
// 攻防模块 · P1 各框架专业信息台补强
// 四大增强组件：
//   CrawlerUrlQueue — 爬虫 URL 队列（事件累积 + 手动添加 + 状态标记）
//   PentestAssetTree — 渗透资产树（按主机分组累积扫描结果 + 漏洞列表 + Payload 库）
//   GatewayStrategyHistory — 网关策略历史时间轴（订阅 StrategyCommitted 事件）
//   AutomationTaskList — 自动化任务列表（前端状态机 + 模板对比卡片）
// 设计：订阅 gongfang_event 累积状态 + 前端本地状态，无需新增后端命令
const React = window.__HOST_REACT__;
const { useState, useEffect, useRef, useCallback, useMemo } = React;
const hostApi = window.__HOST_API__;

import { CollapsibleSection, useKernelRunning } from './ui';

// ============ 通用：监听 gongfang_event 中的特定 kind ============
function useEventFilter<T extends { kind: string; ts: number }>(
  kindFilter: string | string[],
  max = 100,
): T[] {
  const [events, setEvents] = useState<T[]>([]);
  const kinds = Array.isArray(kindFilter) ? new Set(kindFilter) : new Set([kindFilter]);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    hostApi
      .listen<T>('gongfang_event', (e) => {
        if (!kinds.has(e.payload.kind)) return;
        setEvents((prev) => {
          const next = [...prev, e.payload];
          if (next.length > max) next.splice(0, next.length - max);
          return next;
        });
      })
      .then((u) => (unsub = u))
      .catch(() => {});
    return () => {
      if (unsub) unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return events;
}

// ============ 通用：相对时间 ============
function fmtRel(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  return `${Math.floor(diff / 3_600_000)}h`;
}

function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// ============================================================
// 1. CrawlerUrlQueue — 爬虫抓取控制台（真实队列 stats + 结果事件回流）
//    由后端全局队列驱动：stats 反映待抓/已抓，crawl_result 事件实时回流结果
// ============================================================
interface CrawlStats {
  pending: number;
  visited: number;
  total: number;
  seed: string | null;
}
interface CrawlResultEvt {
  kind: string;
  ts: number;
  url: string;
  status: number;
  title: string | null;
  link_count: number;
  success: boolean;
  error: string | null;
}

export function CrawlerUrlQueue() {
  const [stats, setStats] = useState<CrawlStats | null>(null);
  const [results, setResults] = useState<CrawlResultEvt[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const running = useKernelRunning();
  const invoke = (hostApi as { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> }).invoke;

  const refreshStats = useCallback(async () => {
    try {
      const s = await invoke<CrawlStats>('gongfang_crawler_stats');
      setStats(s);
    } catch { /* feature 未启用或内核未运行 */ }
  }, [invoke]);

  // 订阅 crawl_result 事件：实时回流抓取结果，并刷新统计
  useEffect(() => {
    let unsub: (() => void) | null = null;
    hostApi
      .listen<CrawlResultEvt>('gongfang_event', (e) => {
        if (e.payload.kind !== 'crawl_result') return;
        setResults((prev) => [e.payload, ...prev].slice(0, 200));
        refreshStats();
      })
      .then((u) => (unsub = u))
      .catch(() => {});
    return () => { if (unsub) unsub(); };
  }, [refreshStats]);

  // 定时刷新 stats：仅内核运行中才轮询（避免空转）
  useEffect(() => {
    refreshStats();
    if (!running) return;
    const id = setInterval(refreshStats, 2000);
    return () => clearInterval(id);
  }, [running, refreshStats]);

  // 输入 URL → Focus 指令播种，接管内核爬取（同域递归、深度内扩散）
  const handleCrawl = useCallback(async () => {
    const url = input.trim();
    if (!url) return;
    setBusy(true);
    try {
      await invoke('gongfang_inject', { cmd: { Focus: { url } } });
      setInput('');
      refreshStats();
    } catch (e) {
      console.warn('[crawler] 播种失败（需先启动内核）：', e);
    } finally {
      setBusy(false);
    }
  }, [input, invoke, refreshStats]);

  const shown = results.slice(0, 50);

  return (
    <CollapsibleSection
      title="爬虫抓取控制台"
      storageKey="fw_crawler_queue_console"
      defaultOpen={true}
      accent="attack"
      right={
        stats ? (
          <span className="flex items-center gap-1 text-[10px] text-neutral-400">
            <span className="px-1 py-0.5 rounded bg-sky-500/15 text-sky-600 dark:text-sky-400">待爬 {stats.pending}</span>
            <span className="px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">已抓 {stats.visited}</span>
            <span className="px-1 py-0.5 rounded bg-neutral-500/15 text-neutral-500 dark:text-stone-400">共 {stats.total}</span>
          </span>
        ) : (
          <span className="text-[10px] text-neutral-400">内核未启动</span>
        )
      }
    >
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCrawl()}
          placeholder="https://目标URL（回车开始抓取，同域递归默认 2 层）"
          className="flex-1 px-2.5 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)] placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-[var(--element-bg)]"
        />
        <button
          onClick={handleCrawl}
          disabled={busy || !input.trim() || !running}
          title={running ? '' : '需先启动内核'}
          className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-sky-500 hover:bg-sky-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? '播种中...' : '开始抓取'}
        </button>
        <button
          onClick={() => setResults([])}
          className="btn-press px-2 py-1.5 rounded-lg text-xs text-neutral-500 dark:text-stone-400 border border-black/10 dark:border-stone-700/50 hover:bg-black/5 dark:hover:bg-white/5"
        >
          清空
        </button>
      </div>
      <p className="text-[10px] text-neutral-400 leading-relaxed mt-2">
        输入种子 URL → 内核按同域、深度限制（默认 2 层）递归扩散抓取，抓取限速由 QPS 控制。
        {stats?.seed ? `  当前 seed：${stats.seed}` : '  尚未播种。'}
      </p>

      {results.length > 0 ? (
        <div className="overflow-x-auto max-h-[320px] overflow-y-auto rounded border border-black/5 dark:border-stone-700/50">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-white/80 dark:bg-stone-900/80 backdrop-blur">
              <tr className="text-left text-neutral-400 border-b border-black/5 dark:border-stone-700/50">
                <th className="py-1.5 pl-3 pr-2">状态</th>
                <th className="py-1.5 pr-2">URL</th>
                <th className="py-1.5 pr-2">标题</th>
                <th className="py-1.5 pr-3">链接</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={i} className="border-b border-black/[0.03] dark:border-stone-700/30">
                  <td className="py-1.5 pl-3 pr-2">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                      !r.success
                        ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
                        : r.status >= 200 && r.status < 300
                          ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                          : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                    }`}>
                      {r.success ? r.status : 'ERR'}
                    </span>
                  </td>
                  <td className="py-1.5 pr-2 font-mono text-[var(--element-bg)] max-w-[260px] truncate" title={r.url}>{r.url}</td>
                  <td className="py-1.5 pr-2 text-neutral-600 dark:text-stone-300 max-w-[150px] truncate" title={r.title ?? ''}>
                    {r.title ?? (r.error ? r.error.slice(0, 40) : '—')}
                  </td>
                  <td className="py-1.5 pr-3 text-neutral-400 tabular-nums">{r.link_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {results.length > 50 && <div className="px-3 py-1 text-[10px] text-neutral-400">仅显示最近 50/{results.length} 条</div>}
        </div>
      ) : (
        <p className="text-[11px] text-neutral-400">
          暂无抓取结果。启动内核后输入 URL 点「开始抓取」，内核会按同域递归抓取，结果实时列在这里。
        </p>
      )}
    </CollapsibleSection>
  );
}

// ============================================================
// 2. PentestAssetTree — 渗透资产树（按主机分组 + 漏洞列表 + Payload 库）
// ============================================================
interface ScanPortLite {
  port: number;
  protocol: string;
  service: string | null;
  tls: boolean | null;
}
interface AssetHost {
  host: string;
  ip: string;
  ports: ScanPortLite[];
  scannedAt: number;
}

// 预设 Payload 库（前端常量，MIT 协议公开技术资料）
const PAYLOAD_LIBRARY: { category: string; payloads: { name: string; payload: string; risk: 'low' | 'med' | 'high' }[] }[] = [
  {
    category: 'SQL 注入',
    payloads: [
      { name: '报错注入', payload: `' AND EXTRACTVALUE(1, CONCAT(0x7e, (SELECT VERSION()))) -- `, risk: 'med' },
      { name: '布尔盲注', payload: `' AND 1=1 -- `, risk: 'low' },
      { name: '时间盲注', payload: `' AND SLEEP(5) -- `, risk: 'low' },
      { name: 'UNION 注入', payload: `' UNION SELECT NULL, NULL, NULL -- `, risk: 'med' },
    ],
  },
  {
    category: 'XSS',
    payloads: [
      { name: '基础弹窗', payload: `<script>alert(1)</script>`, risk: 'med' },
      { name: 'SVG onload', payload: `<svg onload=alert(1)>`, risk: 'med' },
      { name: 'img onerror', payload: `<img src=x onerror=alert(1)>`, risk: 'med' },
      { name: 'JSFuck', payload: `[][(![]+[])[+[]]+([![]]+[][[]])[+!+[]+[+[]]]+(![]+[])[!+[]+!+[]]`, risk: 'high' },
    ],
  },
  {
    category: '命令注入',
    payloads: [
      { name: '基础命令', payload: `; id`, risk: 'high' },
      { name: '管道命令', payload: `| whoami`, risk: 'high' },
      { name: '反引号', payload: '``id``', risk: 'high' },
    ],
  },
  {
    category: 'SSTI',
    payloads: [
      { name: 'Jinja2', payload: `{{ 7*7 }}`, risk: 'high' },
      { name: 'Twig', payload: `{{ 7*'7' }}`, risk: 'high' },
      { name: 'Freemarker', payload: `${7*7}`, risk: 'high' },
    ],
  },
];

export function PentestAssetTree({ scanResults }: { scanResults: { host: string; ip: string; open_ports: ScanPortLite[]; duration_ms: number }[] }) {
  const [expandedHost, setExpandedHost] = useState<string | null>(null);
  const [showPayloads, setShowPayloads] = useState(false);

  // 按 host 聚合
  const hosts: AssetHost[] = useMemo(() => {
    const map = new Map<string, AssetHost>();
    scanResults.forEach((r) => {
      if (r.open_ports.length === 0) return;
      const existing = map.get(r.host);
      if (existing) {
        // 合并端口（去重）
        const existingPorts = new Set(existing.ports.map((p) => p.port));
        r.open_ports.forEach((p) => {
          if (!existingPorts.has(p.port)) existing.ports.push(p);
        });
        existing.scannedAt = Date.now();
      } else {
        map.set(r.host, {
          host: r.host,
          ip: r.ip,
          ports: [...r.open_ports],
          scannedAt: Date.now(),
        });
      }
    });
    return Array.from(map.values());
  }, [scanResults]);

  const totalPorts = hosts.reduce((sum, h) => sum + h.ports.length, 0);

  return (
    <CollapsibleSection
      title="资产树 + Payload 库"
      storageKey="fw_pentest_asset_tree"
      defaultOpen={false}
      accent="attack"
      right={
        <span className="text-[10px] text-neutral-400">
          {hosts.length} 主机 · {totalPorts} 端口
        </span>
      }
    >
      {hosts.length === 0 ? (
        <p className="text-[11px] text-neutral-400">暂无资产。执行端口扫描后，结果将自动聚合到资产树。</p>
      ) : (
        <div className="space-y-1 max-h-[260px] overflow-y-auto">
          {hosts.map((h) => {
            const expanded = expandedHost === h.host;
            return (
              <div key={h.host} className="rounded-lg border border-black/5 dark:border-stone-700/40 overflow-hidden">
                <div
                  onClick={() => setExpandedHost(expanded ? null : h.host)}
                  className="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                >
                  <span className="text-[10px] text-neutral-400">{expanded ? '▼' : '▶'}</span>
                  <span className="text-xs font-mono text-[var(--element-bg)]">{h.host}</span>
                  {h.ip && <span className="text-[10px] text-neutral-400">({h.ip})</span>}
                  <span className="ml-auto px-1.5 py-0.5 rounded text-[10px] bg-rose-500/15 text-rose-600 dark:text-rose-400">
                    {h.ports.length} 开放
                  </span>
                </div>
                {expanded && (
                  <div className="px-6 py-1 space-y-0.5 bg-black/[0.02] dark:bg-white/[0.02]">
                    {h.ports.map((p, i) => (
                      <div key={i} className="flex items-center gap-2 text-[11px] py-0.5">
                        <span className="font-mono text-[var(--element-bg)] w-14">{p.port}</span>
                        <span className="text-neutral-400 w-10">{p.protocol}</span>
                        <span className="text-neutral-500 dark:text-stone-400 flex-1">{p.service || '未知'}</span>
                        {p.tls && <span className="text-[9px] px-1 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">TLS</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Payload 库 */}
      <div className="pt-2 border-t border-black/5 dark:border-stone-700/50">
        <button
          onClick={() => setShowPayloads((v) => !v)}
          className="text-xs text-violet-600 dark:text-violet-400 hover:underline"
        >
          {showPayloads ? '▼' : '▶'} Payload 库（{PAYLOAD_LIBRARY.reduce((s, c) => s + c.payloads.length, 0)} 条预设）
        </button>
        {showPayloads && (
          <div className="mt-2 space-y-2 max-h-[200px] overflow-y-auto">
            {PAYLOAD_LIBRARY.map((cat) => (
              <div key={cat.category}>
                <div className="text-[10px] font-semibold text-neutral-500 dark:text-stone-400 mb-1">{cat.category}</div>
                <div className="grid grid-cols-1 gap-0.5">
                  {cat.payloads.map((p, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 px-2 py-0.5 rounded text-[11px] hover:bg-black/[0.03] dark:hover:bg-white/[0.04] group"
                    >
                      <span className={`px-1 rounded text-[9px] ${
                        p.risk === 'high' ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
                        : p.risk === 'med' ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                        : 'bg-neutral-500/15 text-neutral-500 dark:text-stone-400'
                      }`}>{p.risk.toUpperCase()}</span>
                      <span className="text-neutral-500 dark:text-stone-400 w-20 truncate">{p.name}</span>
                      <code className="flex-1 font-mono text-[10px] text-[var(--element-bg)] truncate">{p.payload}</code>
                      <button
                        onClick={() => navigator.clipboard?.writeText(p.payload)}
                        className="opacity-0 group-hover:opacity-100 text-[10px] text-sky-500 hover:underline transition-opacity"
                      >
                        复制
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}

// ============================================================
// 3. GatewayStrategyHistory — 网关策略历史时间轴
// ============================================================
interface StrategyEvent {
  ts: number;
  generation: number;
  delta: {
    qps?: number | null;
    stealth_level?: number | null;
    phase?: string | null;
    tls_profile?: string | null;
    focus_url?: string | null;
    use_browser?: boolean | null;
    per_ip_concurrency?: number | null;
    proxy_pool_tag?: string | null;
  };
}

export function GatewayStrategyHistory() {
  // 订阅 strategy_committed 事件 + 拉取历史
  const [events, setEvents] = useState<StrategyEvent[]>([]);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    // 拉取历史
    (hostApi as { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> })
      .invoke<StrategyEvent[]>('gongfang_events_recent', { n: 200 })
      .then((hist) => {
        const filtered = (hist as StrategyEvent[]).filter((e) => (e as { kind?: string }).kind === 'strategy_committed');
        setEvents(filtered as StrategyEvent[]);
      })
      .catch(() => {});

    hostApi
      .listen<StrategyEvent & { kind: string }>('gongfang_event', (e) => {
        if (e.payload.kind !== 'strategy_committed') return;
        setEvents((prev) => {
          const next = [...prev, e.payload];
          if (next.length > 100) next.splice(0, next.length - 100);
          return next;
        });
      })
      .then((u) => (unsub = u))
      .catch(() => {});
    return () => {
      if (unsub) unsub();
    };
  }, []);

  return (
    <CollapsibleSection
      title="策略历史时间轴"
      storageKey="fw_gateway_strategy_history"
      defaultOpen={false}
      accent="defense"
      right={<span className="text-[10px] text-neutral-400">{events.length} 次热交换</span>}
    >
      {events.length === 0 ? (
        <p className="text-[11px] text-neutral-400">
          暂无策略变更记录。AI 控制面每 500ms 推理时若产生 delta 将触发 strategy_committed 事件。
        </p>
      ) : (
        <div className="max-h-[260px] overflow-y-auto space-y-1.5">
          {events
            .slice()
            .reverse()
            .map((e, i) => {
              const deltaParts: string[] = [];
              if (e.delta.qps != null) deltaParts.push(`qps=${e.delta.qps}`);
              if (e.delta.stealth_level != null) deltaParts.push(`stealth=${e.delta.stealth_level}`);
              if (e.delta.phase != null) deltaParts.push(`phase=${e.delta.phase}`);
              if (e.delta.tls_profile != null) deltaParts.push(`tls=${e.delta.tls_profile}`);
              if (e.delta.per_ip_concurrency != null) deltaParts.push(`conc=${e.delta.per_ip_concurrency}`);
              if (e.delta.proxy_pool_tag != null) deltaParts.push(`proxy=${e.delta.proxy_pool_tag}`);
              if (e.delta.use_browser != null) deltaParts.push(`browser=${e.delta.use_browser}`);
              if (e.delta.focus_url != null) deltaParts.push(`focus=${e.delta.focus_url || '∅'}`);
              return (
                <div
                  key={i}
                  className="flex items-start gap-2 px-2 py-1.5 rounded-lg bg-black/[0.02] dark:bg-white/[0.02] border-l-2 border-violet-500/50"
                >
                  <span className="text-[10px] text-neutral-400 tabular-nums shrink-0 mt-0.5">{fmtClock(e.ts)}</span>
                  <span className="text-[10px] px-1 py-0.5 rounded bg-violet-500/15 text-violet-600 dark:text-violet-400 font-mono shrink-0">
                    gen#{e.generation}
                  </span>
                  <span className="text-[11px] text-neutral-600 dark:text-stone-300 font-mono break-all">
                    {deltaParts.length > 0 ? deltaParts.join(' ') : '(无字段变更)'}
                  </span>
                </div>
              );
            })}
        </div>
      )}
    </CollapsibleSection>
  );
}

// ============================================================
// 4. AutomationTaskList — 自动化任务列表 + 模板对比卡片
// ============================================================
interface AutoTask {
  id: string;
  name: string;
  template: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  createdAt: number;
  finishedAt?: number;
}

export function AutomationTaskList({ fitness }: { fitness: { id: number; name: string; success: number; failure: number; success_rate: number; avg_divergence: number }[] }) {
  const [tasks, setTasks] = useState<AutoTask[]>([]);
  const [input, setInput] = useState({ name: '', template: '' });
  const idCounter = useRef(0);

  const handleAdd = () => {
    if (!input.name.trim()) return;
    setTasks((prev) => [
      ...prev,
      {
        id: `t_${idCounter.current++}`,
        name: input.name.trim(),
        template: input.template.trim() || '默认',
        status: 'pending',
        createdAt: Date.now(),
      },
    ]);
    setInput({ name: '', template: '' });
  };

  const handleStatus = (id: string, status: AutoTask['status']) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, status, finishedAt: status === 'success' || status === 'failed' ? Date.now() : undefined } : t)),
    );
  };

  const handleRemove = (id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  };

  const statusMeta: Record<AutoTask['status'], { label: string; cls: string; dot: string }> = {
    pending: { label: '待执行', cls: 'bg-neutral-500/15 text-neutral-500 dark:text-stone-400', dot: 'bg-neutral-400' },
    running: { label: '执行中', cls: 'bg-sky-500/15 text-sky-600 dark:text-sky-400', dot: 'bg-sky-500 animate-pulse' },
    success: { label: '成功', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400', dot: 'bg-emerald-500' },
    failed: { label: '失败', cls: 'bg-rose-500/15 text-rose-600 dark:text-rose-400', dot: 'bg-rose-500' },
  };

  // 模板对比卡片：找最优模板
  const bestTemplate = fitness.length > 0
    ? fitness.reduce((best, cur) => (cur.success_rate > best.success_rate ? cur : best))
    : null;

  return (
    <CollapsibleSection
      title="任务列表 + 模板对比"
      storageKey="fw_automation_task_list"
      defaultOpen={false}
      accent="info"
      right={<span className="text-[10px] text-neutral-400">{tasks.length} 任务</span>}
    >
      {/* 模板对比卡片（基于 fitness 数据） */}
      {fitness.length > 0 && bestTemplate && (
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg p-2 bg-emerald-500/10 border border-emerald-500/30">
            <div className="text-[10px] text-neutral-400">最优模板</div>
            <div className="text-xs font-mono text-emerald-600 dark:text-emerald-400 truncate">{bestTemplate.name}</div>
          </div>
          <div className="rounded-lg p-2 bg-black/[0.03] dark:bg-white/[0.03]">
            <div className="text-[10px] text-neutral-400">成功率</div>
            <div className="text-xs font-mono text-[var(--element-bg)]">{(bestTemplate.success_rate * 100).toFixed(1)}%</div>
          </div>
          <div className="rounded-lg p-2 bg-black/[0.03] dark:bg-white/[0.03]">
            <div className="text-[10px] text-neutral-400">平均偏离度</div>
            <div className="text-xs font-mono text-[var(--element-bg)]">{bestTemplate.avg_divergence.toFixed(3)}</div>
          </div>
        </div>
      )}

      {/* 添加任务表单 */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={input.name}
          onChange={(e) => setInput({ ...input, name: e.target.value })}
          placeholder="任务名称（如：滑块验证）"
          className="flex-1 px-2.5 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)] placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-[var(--element-bg)]"
        />
        <input
          type="text"
          value={input.template}
          onChange={(e) => setInput({ ...input, template: e.target.value })}
          placeholder="模板（可选）"
          className="w-32 px-2.5 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)] placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-[var(--element-bg)]"
        />
        <button
          onClick={handleAdd}
          disabled={!input.name.trim()}
          className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40"
        >
          添加
        </button>
      </div>

      {/* 任务列表 */}
      {tasks.length > 0 ? (
        <div className="space-y-1 max-h-[240px] overflow-y-auto">
          {tasks.map((t) => {
            const meta = statusMeta[t.status];
            return (
              <div
                key={t.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-black/[0.02] dark:bg-white/[0.02] group"
              >
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${meta.dot}`} />
                <span className="text-xs text-[var(--element-bg)] flex-1 truncate">{t.name}</span>
                <span className="text-[10px] text-neutral-400 font-mono">{t.template}</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] ${meta.cls}`}>{meta.label}</span>
                <span className="text-[10px] text-neutral-400 tabular-nums">{fmtRel(t.createdAt)}</span>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {t.status === 'pending' && (
                    <button onClick={() => handleStatus(t.id, 'running')} className="text-[10px] text-sky-500 hover:underline">运行</button>
                  )}
                  {t.status === 'running' && (
                    <>
                      <button onClick={() => handleStatus(t.id, 'success')} className="text-[10px] text-emerald-500 hover:underline">✓</button>
                      <button onClick={() => handleStatus(t.id, 'failed')} className="text-[10px] text-rose-500 hover:underline">✗</button>
                    </>
                  )}
                  <button onClick={() => handleRemove(t.id)} className="text-[10px] text-neutral-400 hover:underline">删</button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-[11px] text-neutral-400">暂无任务。可手动添加任务进行状态跟踪（前端状态，不入后端）。</p>
      )}
    </CollapsibleSection>
  );
}
