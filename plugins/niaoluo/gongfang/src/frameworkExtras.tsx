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

import { CollapsibleSection } from './ui';

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
// 1. CrawlerUrlQueue — 爬虫 URL 队列（事件累积 + 手动添加）
// ============================================================
interface UrlItem {
  id: string;
  url: string;
  addedAt: number;
  status: 'pending' | 'running' | 'done' | 'failed';
  note?: string;
}

export function CrawlerUrlQueue() {
  const [items, setItems] = useState<UrlItem[]>([]);
  const [input, setInput] = useState('');
  const idCounter = useRef(0);

  // 订阅 PhaseExecuted 事件，自动将 focus_url 加入队列
  useEffect(() => {
    let unsub: (() => void) | null = null;
    hostApi
      .listen<{ kind: string; ts: number; focus_url?: string | null; phase?: string }>('gongfang_event', (e) => {
        if (e.payload.kind !== 'phase_executed') return;
        const url = e.payload.focus_url;
        if (!url) return;
        setItems((prev) => {
          if (prev.some((i) => i.url === url)) {
            // 已存在则更新状态
            return prev.map((i) =>
              i.url === url
                ? {
                    ...i,
                    status: e.payload.phase === 'Clean' ? 'done' : 'running',
                  }
                : i,
            );
          }
          return [
            ...prev,
            {
              id: `ev_${idCounter.current++}`,
              url,
              addedAt: e.payload.ts,
              status: 'running',
            },
          ];
        });
      })
      .then((u) => (unsub = u))
      .catch(() => {});
    return () => {
      if (unsub) unsub();
    };
  }, []);

  const handleAdd = () => {
    const url = input.trim();
    if (!url) return;
    if (items.some((i) => i.url === url)) return;
    setItems((prev) => [
      ...prev,
      { id: `m_${idCounter.current++}`, url, addedAt: Date.now(), status: 'pending' },
    ]);
    setInput('');
  };

  const handleStatus = (id: string, status: UrlItem['status']) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, status } : i)));
  };

  const handleRemove = (id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  const statusMeta: Record<UrlItem['status'], { label: string; cls: string }> = {
    pending: { label: '待抓取', cls: 'bg-neutral-500/15 text-neutral-500 dark:text-stone-400' },
    running: { label: '抓取中', cls: 'bg-sky-500/15 text-sky-600 dark:text-sky-400' },
    done: { label: '完成', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
    failed: { label: '失败', cls: 'bg-rose-500/15 text-rose-600 dark:text-rose-400' },
  };

  return (
    <CollapsibleSection
      title="URL 队列"
      storageKey="fw_crawler_url_queue"
      defaultOpen={false}
      accent="attack"
      right={
        <span className="text-[10px] text-neutral-400">
          {items.length} 条 · 自动捕获 focus_url + 手动添加
        </span>
      }
    >
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          placeholder="https://目标URL（回车添加）"
          className="flex-1 px-2.5 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)] placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-[var(--element-bg)]"
        />
        <button
          onClick={handleAdd}
          disabled={!input.trim()}
          className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40"
        >
          添加
        </button>
        <button
          onClick={() => setItems([])}
          className="btn-press px-2 py-1.5 rounded-lg text-xs text-neutral-500 dark:text-stone-400 border border-black/10 dark:border-stone-700/50 hover:bg-black/5 dark:hover:bg-white/5"
        >
          清空
        </button>
      </div>
      {items.length > 0 ? (
        <div className="overflow-x-auto max-h-[280px] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-white/80 dark:bg-stone-900/80 backdrop-blur">
              <tr className="text-left text-neutral-400 border-b border-black/5 dark:border-stone-700/50">
                <th className="py-1.5 pr-3">URL</th>
                <th className="py-1.5 pr-3">添加</th>
                <th className="py-1.5 pr-3">状态</th>
                <th className="py-1.5">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const meta = statusMeta[item.status];
                return (
                  <tr key={item.id} className="border-b border-black/[0.03] dark:border-stone-700/30 group">
                    <td className="py-1.5 pr-3 font-mono text-[var(--element-bg)] max-w-[280px] truncate" title={item.url}>
                      {item.url}
                    </td>
                    <td className="py-1.5 pr-3 text-neutral-400 tabular-nums">{fmtRel(item.addedAt)}</td>
                    <td className="py-1.5 pr-3">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${meta.cls}`}>{meta.label}</span>
                    </td>
                    <td className="py-1.5">
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => handleStatus(item.id, 'done')} className="text-[10px] text-emerald-500 hover:underline" title="标记完成">✓</button>
                        <button onClick={() => handleStatus(item.id, 'failed')} className="text-[10px] text-rose-500 hover:underline" title="标记失败">✗</button>
                        <button onClick={() => handleRemove(item.id)} className="text-[10px] text-neutral-400 hover:underline" title="移除">删</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-[11px] text-neutral-400">
          暂无 URL。运行内核后，注入 Focus 指令的目标 URL 会自动入队；也可手动添加待抓取 URL。
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
    const w = window as unknown as {
      __TAURI_INTERNALS__?: { invoke: <U>(c: string, a?: Record<string, unknown>) => Promise<U> };
    };
    w.__TAURI_INTERNALS__
      ?.invoke<StrategyEvent[]>('gongfang_events_recent', { n: 200 })
      .then((hist) => {
        const filtered = hist.filter((e) => (e as { kind?: string }).kind === 'strategy_committed');
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
