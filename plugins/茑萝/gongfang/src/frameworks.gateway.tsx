/// <reference path="../../../global.d.ts" />
import React from 'react';
const { useCallback, useEffect, useState } = React;
import { AuditInput, GatewayStrategyHistory, CollapsibleSection, useKernelRunning } from './frameworksShared';
import { tauriInvoke, CapabilityGrid, TechStackChips, StatusCard } from './frameworksShared';
import type { GatewayNodeSummary, GatewayStatusResult, ReputationBreakdown, TrafficReport, RouteSimReport, StrategySimReport, ShapingAdvice, ObfuscateReport, EntropyReport, CurlReport, FrameworkMeta } from './frameworksShared';
// ============ 框架五：API 网关 ============
const gatewayMeta: FrameworkMeta = {
  title: 'API 网关框架',
  subtitle: '自适应流量整形器。节点信誉矩阵 + Poisson 间隔 + 头序随机化 + Payload 混淆 + 预测性故障转移；其中选路与间隔整形已进入爬虫抓取主链路，头序/熵/混淆当前经面板与命令使用（可导出 curl）。',
  posture: '攻防',
  capabilities: [
    '节点信誉矩阵（错误率 + EWMA RTT + 梯度惩罚）',
    'N+1 冗余池（备用节点 ≥ 活跃 50%）',
    '预测性故障转移（RTT 梯度递增 → 提前切换）',
    'Poisson 间隔生成器（突发-静默模式；已进抓取主链路）',
    'HTTP 头序随机化（按浏览器族模板重排 + Accept-Language/Encoding 位置扰动；已进抓取主链路，impersonate 通道除外）',
    'JSON Payload 混淆（冗余字段 + 字段顺序随机化；经面板导出，未进主链路——GET 抓取无请求体）',
    '请求熵监控器（已接爬虫真实请求模式；熵低时只告警，不自动注入假请求）',
    'OS 指纹加权随机（Win+Chrome 65% / macOS+Safari 15% / ...）',
    'arc-swap 策略热交换（@rotate/@throttle 亚毫秒级切换）',
    'JSON 快照恢复（灾难性故障 < 100ms 重建）',
  ],
  capabilitiesPlanned: [],
  techStack: [
    { name: 'arc-swap', license: 'MIT' },
    { name: 'parking_lot', license: 'Apache-2.0' },
    { name: 'reqwest', license: 'MIT' },
    { name: 'serde', license: 'MIT' },
    { name: 'xorshift64*', license: '内置' },
  ],
  status: '已交付',
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

  // 节点信誉评分器
  const [scoreErr, setScoreErr] = useState(0);    // 错误率 %
  const [scoreRtt, setScoreRtt] = useState(100);  // EWMA RTT ms
  const [scoreGrad, setScoreGrad] = useState(0);  // RTT 梯度 ms/sample
  const [scoreResult, setScoreResult] = useState<ReputationBreakdown | null>(null);
  const [scoreBusy, setScoreBusy] = useState(false);

  const handleScore = useCallback(async () => {
    setScoreBusy(true);
    try {
      const r = await tauriInvoke<ReputationBreakdown>('gongfang_gateway_score', { errorRate: scoreErr / 100, ewmaRtt: scoreRtt, rttGradient: scoreGrad });
      setScoreResult(r);
    } catch {
      setScoreResult(null);
    } finally {
      setScoreBusy(false);
    }
  }, [scoreErr, scoreRtt, scoreGrad]);

  // 网关仿真状态
  const [trafficLambda, setTrafficLambda] = useState(1);
  const [trafficCount, setTrafficCount] = useState(20);
  const [trafficResult, setTrafficResult] = useState<TrafficReport | null>(null);
  const [trafficBusy, setTrafficBusy] = useState(false);

  const ROUTE_SAMPLE = JSON.stringify([
    { url: 'http://node-a:7890', region: 'CN-Shanghai', error_rate: 0.02, ewma_rtt: 120, rtt_gradient: 2 },
    { url: 'http://node-b:7890', region: 'US-West', error_rate: 0.4, ewma_rtt: 400, rtt_gradient: 12 },
    { url: 'http://node-c:7890', region: 'EU-Frankfurt', error_rate: 0.0, ewma_rtt: 600, rtt_gradient: 20 },
  ], null, 2);
  const [routeJson, setRouteJson] = useState(ROUTE_SAMPLE);
  const [routeResult, setRouteResult] = useState<RouteSimReport | null>(null);
  const [routeBusy, setRouteBusy] = useState(false);

  const [stratRouting, setStratRouting] = useState('direct');
  const [stratRatio, setStratRatio] = useState(100);
  const [stratResult, setStratResult] = useState<StrategySimReport | null>(null);
  const [stratBusy, setStratBusy] = useState(false);

  const handleTraffic = useCallback(async () => {
    setTrafficBusy(true);
    try {
      const r = await tauriInvoke<TrafficReport>('gongfang_gateway_traffic', { lambda: trafficLambda, count: trafficCount });
      setTrafficResult(r);
    } catch { setTrafficResult(null); } finally { setTrafficBusy(false); }
  }, [trafficLambda, trafficCount]);

  const handleRoute = useCallback(async () => {
    setRouteBusy(true);
    try {
      const nodes = JSON.parse(routeJson || '[]');
      const r = await tauriInvoke<RouteSimReport>('gongfang_gateway_route_sim', { nodes });
      setRouteResult(r);
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      alert(`路由仿真 JSON 解析或执行失败：${msg}`);
    } finally { setRouteBusy(false); }
  }, [routeJson]);

  const handleStrategy = useCallback(async () => {
    setStratBusy(true);
    try {
      const r = await tauriInvoke<StrategySimReport>('gongfang_gateway_strategy_sim', { routing: stratRouting, ratio: stratRatio / 100 });
      setStratResult(r);
    } catch { setStratResult(null); } finally { setStratBusy(false); }
  }, [stratRouting, stratRatio]);

  // 隐身整形实验室
  const [shaping, setShaping] = useState<ShapingAdvice | null>(null);
  const [shapingBusy, setShapingBusy] = useState(false);
  const [obfRaw, setObfRaw] = useState(JSON.stringify({ query: 'select * from users', limit: 10 }, null, 2));
  const [obfResult, setObfResult] = useState<ObfuscateReport | null>(null);
  const [obfBusy, setObfBusy] = useState(false);
  const [entropyInput, setEntropyInput] = useState(['GET /api/users 200', 'GET /api/users 200', 'GET /api/users 200', 'GET /api/users 200', 'GET /api/users 200', 'GET /api/users 200', 'GET /api/users 200', 'GET /api/users 200'].join('\n'));
  const [entropyResult, setEntropyResult] = useState<EntropyReport | null>(null);
  const [entropyBusy, setEntropyBusy] = useState(false);

  const handleShaping = useCallback(async () => {
    setShapingBusy(true);
    try { setShaping(await tauriInvoke<ShapingAdvice>('gongfang_gateway_shaping_demo', {})); }
    catch { setShaping(null); } finally { setShapingBusy(false); }
  }, []);

  const handleObfuscate = useCallback(async () => {
    setObfBusy(true);
    try { setObfResult(await tauriInvoke<ObfuscateReport>('gongfang_gateway_obfuscate', { raw: obfRaw })); }
    catch { setObfResult(null); } finally { setObfBusy(false); }
  }, [obfRaw]);

  const handleEntropy = useCallback(async () => {
    setEntropyBusy(true);
    try {
      const patterns = entropyInput.split('\n').map((s) => s.trim()).filter(Boolean);
      setEntropyResult(await tauriInvoke<EntropyReport>('gongfang_gateway_entropy_demo', { patterns }));
    } catch { setEntropyResult(null); } finally { setEntropyBusy(false); }
  }, [entropyInput]);

  // 隐身请求生成 (curl)
  const [curlUrl, setCurlUrl] = useState('https://example.com');
  const [curlRaw, setCurlRaw] = useState('');
  const [curlMode, setCurlMode] = useState('stealth');
  const [curlResult, setCurlResult] = useState<CurlReport | null>(null);
  const [curlBusy, setCurlBusy] = useState(false);

  const handleCurl = useCallback(async () => {
    if (!curlUrl.trim()) return;
    setCurlBusy(true);
    try {
      setCurlResult(await tauriInvoke<CurlReport>('gongfang_gateway_curl', { url: curlUrl.trim(), raw: curlRaw.trim() || null, mode: curlMode }));
    } catch { setCurlResult(null); } finally { setCurlBusy(false); }
  }, [curlUrl, curlRaw, curlMode]);
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

  // 每 3 秒自动刷新状态：仅内核运行中才轮询（避免未启动/未启用 feature 时的空转拉取与报错风暴）
  const running = useKernelRunning();
  useEffect(() => {
    if (!running) return;
    const id = setInterval(fetchStatus, 3000);
    return () => clearInterval(id);
  }, [running, fetchStatus]);

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
          <TechStackChips items={gatewayMeta.techStack} />
        </CollapsibleSection>

        {/* 错误提示 */}
        {error && (
          <div className="px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-600 dark:text-rose-400">
            <span className="font-medium">网关错误：</span>{error}
            <span className="ml-2 text-[10px] text-rose-400/70">（若未启用 gongfang-gateway feature，所有命令将返回此错误）</span>
          </div>
        )}

        {/* 节点信誉评分器（离线仿真信誉/故障判定） */}
        <CollapsibleSection
          title="节点信誉评分器"
          storageKey="fw_gateway_score"
          defaultOpen={false}
          accent="defense"
        >
          <div className="grid grid-cols-3 gap-2">
            <div>
              <div className="text-[10px] text-neutral-400 mb-1">错误率 %</div>
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={scoreErr}
                onChange={(e) => setScoreErr(Number(e.target.value))}
                className="w-full px-2 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)]"
              />
            </div>
            <div>
              <div className="text-[10px] text-neutral-400 mb-1">EWMA RTT (ms)</div>
              <input
                type="number"
                min={0}
                step={10}
                value={scoreRtt}
                onChange={(e) => setScoreRtt(Number(e.target.value))}
                className="w-full px-2 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)]"
              />
            </div>
            <div>
              <div className="text-[10px] text-neutral-400 mb-1">RTT 梯度 (ms/sample)</div>
              <input
                type="number"
                min={-50}
                step={1}
                value={scoreGrad}
                onChange={(e) => setScoreGrad(Number(e.target.value))}
                className="w-full px-2 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)]"
              />
            </div>
          </div>
          <div className="mt-2">
            <button
              onClick={handleScore}
              disabled={scoreBusy}
              className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
            >
              {scoreBusy ? '计算中...' : '评分'}
            </button>
            <span className="ml-2 text-[10px] text-neutral-400">输入假想节点指标 → 看信誉分与故障判定，离线仿真。</span>
          </div>
          {scoreResult && (
            <div className="mt-2 space-y-1.5 rounded border border-black/10 dark:border-stone-700/50 p-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-[var(--element-bg)]">信誉</span>
                <span className={`text-xl font-mono font-semibold ${scoreResult.is_failing ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{scoreResult.reputation.toFixed(0)}</span>
                {scoreResult.is_failing
                  ? <span className="px-1.5 py-0.5 rounded text-[10px] bg-rose-500/15 text-rose-600 dark:text-rose-400">故障</span>
                  : <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">正常</span>}
              </div>
              <div className="grid grid-cols-3 gap-2 text-[10px]">
                <div className="bg-black/[0.03] dark:bg-white/[0.04] rounded p-1.5">
                  <div className="text-neutral-400">错误惩罚</div>
                  <div className="font-mono text-neutral-600 dark:text-stone-300">-{scoreResult.error_penalty.toFixed(1)}</div>
                </div>
                <div className="bg-black/[0.03] dark:bg-white/[0.04] rounded p-1.5">
                  <div className="text-neutral-400">RTT 惩罚</div>
                  <div className="font-mono text-neutral-600 dark:text-stone-300">-{scoreResult.rtt_penalty.toFixed(1)}</div>
                </div>
                <div className="bg-black/[0.03] dark:bg-white/[0.04] rounded p-1.5">
                  <div className="text-neutral-400">梯度惩罚</div>
                  <div className="font-mono text-neutral-600 dark:text-stone-300">-{scoreResult.gradient_penalty.toFixed(1)}</div>
                </div>
              </div>
              <p className="text-[10px] text-neutral-400 leading-relaxed">
                规则：错误率每% 罚 0.4 分 · RTT&gt;500ms 罚20 / &gt;200 罚10 · 梯度&gt;10 罚15；故障=错误率&gt;10% 或 梯度&gt;15。
              </p>
            </div>
          )}
        </CollapsibleSection>

        {/* 流量时序仿真（Poisson） */}
        <CollapsibleSection
          title="流量时序仿真 (Poisson)"
          storageKey="fw_gateway_traffic"
          defaultOpen={false}
          accent="defense"
        >
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-neutral-400">λ(次/秒)</span>
              <input
                type="number"
                min={0.1}
                step={0.5}
                value={trafficLambda}
                onChange={(e) => setTrafficLambda(Number(e.target.value))}
                className="w-20 px-2 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)]"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-neutral-400">样本数</span>
              <input
                type="number"
                min={1}
                max={100}
                value={trafficCount}
                onChange={(e) => setTrafficCount(Number(e.target.value))}
                className="w-20 px-2 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)]"
              />
            </div>
            <button
              onClick={handleTraffic}
              disabled={trafficBusy}
              className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40"
            >
              {trafficBusy ? '生成中...' : '仿真'}
            </button>
          </div>
          {trafficResult && (
            <div className="mt-2 space-y-1.5">
              <div className="grid grid-cols-3 gap-2 text-[10px]">
                <div className="bg-black/[0.03] dark:bg-white/[0.04] rounded p-1.5"><div className="text-neutral-400">期望间隔</div><div className="font-mono text-[var(--element-bg)]">{trafficResult.expected_interval_ms ?? '—'} ms</div></div>
                <div className="bg-black/[0.03] dark:bg-white/[0.04] rounded p-1.5"><div className="text-neutral-400">实际平均</div><div className="font-mono text-[var(--element-bg)]">{trafficResult.avg_ms} ms</div></div>
                <div className="bg-black/[0.03] dark:bg-white/[0.04] rounded p-1.5"><div className="text-neutral-400">min–max</div><div className="font-mono text-[var(--element-bg)]">{trafficResult.min_ms}–{trafficResult.max_ms}</div></div>
              </div>
              <div className="text-[10px] text-neutral-400">间隔序列（ms）：<span className="font-mono">{trafficResult.intervals_ms.join(', ')}</span></div>
            </div>
          )}
        </CollapsibleSection>

        {/* 路由决策仿真 */}
        <CollapsibleSection
          title="路由决策仿真"
          storageKey="fw_gateway_route_sim"
          defaultOpen={false}
          accent="defense"
        >
          <div className="space-y-2">
            <textarea
              value={routeJson}
              onChange={(e) => setRouteJson(e.target.value)}
              rows={4}
              className="w-full px-2.5 py-1.5 rounded-lg text-xs font-mono bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)] placeholder:text-neutral-400"
            />
            <div className="flex gap-2">
              <button
                onClick={handleRoute}
                disabled={routeBusy}
                className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40"
              >
                {routeBusy ? '仿真中...' : '仿真选路'}
              </button>
              <button
                onClick={() => { setRouteJson(ROUTE_SAMPLE); setRouteResult(null); }}
                className="btn-press px-2 py-1.5 rounded-lg text-xs text-neutral-500 dark:text-stone-400 border border-black/10 dark:border-stone-700/50"
              >
                载入示例
              </button>
            </div>
            {/* 说明文字必须包成字符串：直接写 {} 会被当成 JSX 表达式（逗号运算符 → 只渲染最后一项） */}
            <p className="text-[10px] text-neutral-400">{'JSON 数组：[{url, region, error_rate, ewma_rtt, rtt_gradient}]，按信誉选出非故障最高分节点。'}</p>
            {routeResult && (
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-[var(--element-bg)] font-medium">选中</span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">{routeResult.selected ?? '（无可用节点）'}</span>
                  <span className="ml-auto text-[10px] text-neutral-400">活跃 {routeResult.active} · 备用 {routeResult.standby} · 冗余 {(routeResult.redundancy_ratio * 100).toFixed(0)}%</span>
                </div>
                {routeResult.nodes.map((n, i) => (
                  <div key={i} className="flex items-center gap-2 text-[11px] rounded border border-black/5 dark:border-stone-700/40 p-1">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${n.url === routeResult.selected ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : n.is_failing ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400' : 'bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-stone-300'}`}>{n.reputation.toFixed(0)}</span>
                    <span className="font-mono text-[var(--element-bg)] truncate">{n.url}</span>
                    <span className="ml-auto text-[10px] text-neutral-400">err-{n.error_penalty.toFixed(1)} rtt-{n.rtt_penalty.toFixed(1)} g-{n.gradient_penalty.toFixed(1)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CollapsibleSection>

        {/* 策略仿真 @rotate/@throttle */}
        <CollapsibleSection
          title="策略仿真 @rotate/@throttle"
          storageKey="fw_gateway_strategy_sim"
          defaultOpen={false}
          accent="defense"
        >
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <select
                value={stratRouting}
                onChange={(e) => setStratRouting(e.target.value)}
                className="px-2 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)]"
              >
                <option value="direct">直连</option>
                <option value="proxy">代理</option>
                <option value="stealth">隐身</option>
              </select>
              <input
                type="range"
                min={5}
                max={100}
                step={5}
                value={stratRatio}
                onChange={(e) => setStratRatio(Number(e.target.value))}
                className="flex-1 h-1.5 bg-black/10 dark:bg-white/10 rounded-full appearance-none cursor-pointer accent-[var(--element-bg)]"
              />
              <span className="text-xs font-mono w-12 text-right">{stratRatio}%</span>
              <button
                onClick={handleStrategy}
                disabled={stratBusy}
                className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40"
              >
                {stratBusy ? '仿真中...' : '仿真'}
              </button>
            </div>
            {stratResult && (
              <div className="grid grid-cols-3 gap-2 text-[10px]">
                <div className="bg-black/[0.03] dark:bg-white/[0.04] rounded p-1.5"><div className="text-neutral-400">路由</div><div className="font-medium text-[var(--element-bg)]">{stratResult.routing_cn}</div></div>
                <div className="bg-black/[0.03] dark:bg-white/[0.04] rounded p-1.5"><div className="text-neutral-400">超时</div><div className="font-mono text-[var(--element-bg)]">{(stratResult.request_timeout_ms / 1000).toFixed(1)}s</div></div>
                <div className="bg-black/[0.03] dark:bg-white/[0.04] rounded p-1.5"><div className="text-neutral-400">并发</div><div className="font-mono text-[var(--element-bg)]">{stratResult.max_concurrent}</div></div>
                <div className="bg-black/[0.03] dark:bg-white/[0.04] rounded p-1.5"><div className="text-neutral-400">静默间隔</div><div className="font-mono text-[var(--element-bg)]">~{stratResult.est_interval_silent_ms} ms</div></div>
                <div className="bg-black/[0.03] dark:bg-white/[0.04] rounded p-1.5"><div className="text-neutral-400">突发间隔</div><div className="font-mono text-[var(--element-bg)]">~{stratResult.est_interval_burst_ms} ms</div></div>
                <div className="bg-black/[0.03] dark:bg-white/[0.04] rounded p-1.5"><div className="text-neutral-400">高优先豁免</div><div className="text-[var(--element-bg)]">{stratResult.high_priority_bypass ? '是' : '否'}</div></div>
              </div>
            )}
          </div>
        </CollapsibleSection>

        {/* 隐身请求整形演示 */}
        <CollapsibleSection
          title="隐身请求整形演示"
          storageKey="fw_gateway_shaping_demo"
          defaultOpen={false}
          accent="defense"
        >
          <div className="mb-2">
            <button
              onClick={handleShaping}
              disabled={shapingBusy}
              className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40"
            >
              {shapingBusy ? '生成中...' : '生成整形建议'}
            </button>
          </div>
          {shaping && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${shaping.in_burst ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400' : 'bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-stone-300'}`}>间隔 {shaping.interval_ms}ms</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] ${shaping.in_burst ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400' : 'bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-stone-300'}`}>{shaping.in_burst ? '突发' : '静默'}</span>
                <span className="px-1.5 py-0.5 rounded text-[10px] bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-stone-300">指纹 {shaping.fingerprint.os}</span>
                <span className="px-1.5 py-0.5 rounded text-[10px] bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-stone-300">熵 {shaping.current_entropy.toFixed(2)}</span>
                {shaping.needs_noise && <span className="px-1.5 py-0.5 rounded text-[10px] bg-rose-500/15 text-rose-600 dark:text-rose-400">需噪声 → {shaping.noise_path}</span>}
              </div>
              <div className="bg-black/[0.03] dark:bg-white/[0.04] rounded p-2">
                <div className="text-[10px] text-neutral-400 mb-0.5">头序（{shaping.header_order.length}）：</div>
                <div className="flex flex-wrap gap-1">
                  {shaping.header_order.map((h, i) => (
                    <span key={i} className="px-1 py-0.5 rounded text-[10px] font-mono bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-stone-300">{h}</span>
                  ))}
                </div>
              </div>
              <div className="bg-black/[0.03] dark:bg-white/[0.04] rounded p-2 text-[10px] text-neutral-500 dark:text-stone-400 break-all font-mono">{shaping.fingerprint.user_agent}</div>
            </div>
          )}
        </CollapsibleSection>

        {/* Payload 混淆 */}
        <CollapsibleSection
          title="Payload 混淆演示"
          storageKey="fw_gateway_obfuscate"
          defaultOpen={false}
          accent="defense"
        >
          <div className="space-y-2">
            <textarea
              value={obfRaw}
              onChange={(e) => setObfRaw(e.target.value)}
              rows={3}
              className="w-full px-2.5 py-1.5 rounded-lg text-xs font-mono bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)]"
            />
            <button
              onClick={handleObfuscate}
              disabled={obfBusy}
              className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40"
            >
              {obfBusy ? '混淆中...' : '混淆'}
            </button>
            <p className="text-[10px] text-neutral-400">注入 `_ts / _nonce / _comment` 冗余字段并随机字段顺序，字节流变化但语义不变（绕过哈希指纹检测）。</p>
            {obfResult && obfResult.obfuscated !== obfResult.original && (
              <div className="bg-black/[0.03] dark:bg-white/[0.04] rounded p-2">
                <div className="text-[10px] text-neutral-400 mb-1">混淆后：</div>
                <div className="text-[10px] font-mono text-[var(--element-bg)] break-all">{obfResult.obfuscated}</div>
              </div>
            )}
            {obfResult && obfResult.obfuscated === obfResult.original && (
              <p className="text-[10px] text-amber-600 dark:text-amber-400">输入不是可解析的 JSON 对象，混淆器原样返回。</p>
            )}
          </div>
        </CollapsibleSection>

        {/* 请求熵监控实验 */}
        <CollapsibleSection
          title="请求熵监控实验"
          storageKey="fw_gateway_entropy"
          defaultOpen={false}
          accent="defense"
        >
          <div className="space-y-2">
            <textarea
              value={entropyInput}
              onChange={(e) => setEntropyInput(e.target.value)}
              rows={4}
              className="w-full px-2.5 py-1.5 rounded-lg text-xs font-mono bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)] placeholder:text-neutral-400"
            />
            <div className="flex gap-2">
              <button
                onClick={handleEntropy}
                disabled={entropyBusy}
                className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40"
              >
                {entropyBusy ? '计算中...' : '计算熵'}
              </button>
              <button
                onClick={() => setEntropyInput(['GET /api/users 200', 'GET /api/posts 200', 'GET /api/profile 200', 'POST /api/login 201', 'GET /static/a.png 200', 'GET /api/users 200', 'GET /api/posts 200', 'GET /api/profile 200'].join('\n'))}
                className="btn-press px-2 py-1.5 rounded-lg text-xs text-neutral-500 dark:text-stone-400 border border-black/10 dark:border-stone-700/50"
              >
                多样化示例
              </button>
            </div>
            <p className="text-[10px] text-neutral-400">每行一条 `方法 路径 状态`。模式越单一熵越低，低于阈值 2.0 时建议注入假请求。</p>
            {entropyResult && (
              <div className="bg-black/[0.03] dark:bg-white/[0.04] rounded p-2 space-y-1">
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-[var(--element-bg)] font-medium">Shannon 熵</span>
                  <span className={`text-lg font-mono font-semibold ${entropyResult.entropy < entropyResult.threshold ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{entropyResult.entropy}</span>
                  <span className="text-[10px] text-neutral-400">(阈值 {entropyResult.threshold})</span>
                  {entropyResult.needs_noise
                    ? <span className="ml-auto px-1.5 py-0.5 rounded text-[10px] bg-amber-500/15 text-amber-600 dark:text-amber-400">建议注入 {entropyResult.noise_path}</span>
                    : <span className="ml-auto px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">多样化充分</span>}
                </div>
                <div className="text-[11px] text-neutral-500 dark:text-stone-400">{entropyResult.verdict}</div>
              </div>
            )}
          </div>
        </CollapsibleSection>

        {/* 隐身请求生成 (curl) */}
        <CollapsibleSection
          title="隐身请求生成 (curl)"
          storageKey="fw_gateway_curl"
          defaultOpen={false}
          accent="defense"
        >
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={curlUrl}
                onChange={(e) => setCurlUrl(e.target.value)}
                placeholder="https://example.com"
                className="flex-1 px-2.5 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)]"
              />
              <select
                value={curlMode}
                onChange={(e) => setCurlMode(e.target.value)}
                className="px-2 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)]"
              >
                <option value="direct">直连</option>
                <option value="proxy">代理</option>
                <option value="stealth">隐身</option>
              </select>
              <button
                onClick={handleCurl}
                disabled={curlBusy || !curlUrl.trim()}
                className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40"
              >
                {curlBusy ? '生成中...' : '生成'}
              </button>
            </div>
            <textarea
              value={curlRaw}
              onChange={(e) => setCurlRaw(e.target.value)}
              rows={2}
              placeholder="可选：JSON 请求体（会自动做 Payload 混淆）"
              className="w-full px-2.5 py-1.5 rounded-lg text-xs font-mono bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)] placeholder:text-neutral-400"
            />
            {curlResult && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-[10px] text-neutral-400">
                  <span>指纹 {curlResult.fingerprint}</span>
                  <span>间隔 {curlResult.interval_ms}ms</span>
                  <span>{curlResult.in_burst ? '突发' : '静默'}</span>
                  {curlResult.note && <span className="text-amber-600 dark:text-amber-400">{curlResult.note}</span>}
                </div>
                <pre className="whitespace-pre-wrap break-all rounded border border-black/10 dark:border-stone-700/50 bg-black/[0.03] dark:bg-white/[0.04] p-2 text-[10px] font-mono text-[var(--element-bg)] overflow-x-auto">{curlResult.command}</pre>
                <button
                  onClick={() => navigator.clipboard?.writeText(curlResult.command)}
                  className="btn-press px-2 py-1 rounded-lg text-[10px] text-neutral-500 dark:text-stone-400 border border-black/10 dark:border-stone-700/50"
                >
                  复制
                </button>
              </div>
            )}
          </div>
        </CollapsibleSection>

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

        {/* 核心能力清单（已交付 / 计划中 分栏） */}
        <CollapsibleSection title="核心能力" storageKey="fw_gateway_capabilities" defaultOpen={false} accent="defense">
          <CapabilityGrid meta={gatewayMeta} />
        </CollapsibleSection>
      </div>
    </div>
  );
}

export { GatewayPanel };
