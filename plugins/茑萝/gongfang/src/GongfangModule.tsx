/// <reference path="../../../global.d.ts" />
// 茑萝 · 攻防主容器
// 职责：首次进入风险确认 + 免责声明 / 防追踪状态栏 / 五框架 Tab / 操作审计日志
//       P0 通用信息层：左 TargetWorkspace + 底部 MetricsChart/AiReasoningPanel/EventStream
// 设计：攻防一体、专业合法、极致高效、稳定防追踪、信息台密集布局（专业级控制台）
const React = window.__HOST_REACT__;
const { useState, useCallback, useEffect, useRef } = React;

// ============ Tauri invoke 封装 ============
// 统一走沙箱 hostApi.invoke（已加入 pluginSandbox 白名单）。
// 必须自带泛型：宿主声明的 invoke 返回 Promise<unknown>，内联转型后再写 invoke<T> 会报 TS2558，
// 且返回值会被推断成 unknown，取字段时连锁报错。
const tauriInvoke = <T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  (window.__HOST_API__ as { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> }).invoke(cmd, args) as Promise<T>;

import { CrawlerPanel, ReversePanel, PentestPanel, AutomationPanel, GatewayPanel } from './frameworks';
import { useAuditLog, AuditLogDrawer, type AuditInput } from './audit';
import { RiskConfirm, isDisclaimerAccepted, revokeDisclaimer } from './RiskConfirm';
import { EventStream, MetricsChart, AiReasoningPanel, TargetWorkspace, AiReasoningLab } from './infoPanels';
import { ExportButton } from './professionalExtras';
import { useHotkeys, SituationalBar, useKernelRunning } from './ui';
import { FRAMEWORK_LABELS, getNav, setNav, subscribeNav, useNav, type TabKey } from './navStore';

// ============ 图标（内联 SVG，避免引入新依赖） ============
const ShieldIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);
const LogIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="9" y1="13" x2="15" y2="13" />
    <line x1="9" y1="17" x2="15" y2="17" />
  </svg>
);

// ============ Tab 按钮 ============

// ============ 主模块 ============
// 顶部态势感知条用的轻量 status 类型（仅取展示字段）
interface TopSituation {
  running: boolean;
  phase?: string;
  reward?: number;
  errorRate?: number;
  qps?: number;
  generation?: number;
}

// gongfang_status.features：标注各子框架是否随内核编译（未编译的前端置灰，不做假可用）
interface Features {
  crawler: boolean;
  reverse: boolean;
  pentest: boolean;
  automation: boolean;
  gateway: boolean;
  /** 真实 TLS/JA3-JA4 指纹伪装通道是否可用（当前未实现，恒为 false） */
  tls_impersonate: boolean;
}

function GongfangModule() {
  const [accepted, setAccepted] = useState<boolean>(() => isDisclaimerAccepted());
  // 选中功能块与各框架编译能力都放在 navStore：侧栏（宿主另一处渲染）要读同一份，
  // 否则会出现「侧栏高亮 A、主区域显示 B」以及两套各自轮询 status 的浪费。
  const { tab, features, featureWarn } = useNav();
  const [showLog, setShowLog] = useState(false);
  // P0 信息台开关：左侧目标工作区 + 底部信息台（时序图/事件流/AI 推理）
  const [showTargets, setShowTargets] = useState(true);
  const [showInfo, setShowInfo] = useState(true);
  // 顶部态势感知条：轻量拉取 gongfang_status（2s 轮询，仅 accepted 后）
  const [situation, setSituation] = useState<TopSituation | null>(null);
  const { logs, addLog, clearLog } = useAuditLog();

  // Tauri invoke 封装（顶部态势感知条用，统一走沙箱 hostApi，已加入白名单）
  const fetchSituation = useCallback(async () => {
    try {
      const s = await tauriInvoke<{
        running: boolean;
        strategy: { phase: string; qps: number; generation: number };
        reward: number;
        error_rate: number;
        features: Features;
      }>('gongfang_status');
      setSituation({
        running: s.running,
        phase: s.strategy?.phase,
        reward: s.reward,
        errorRate: s.error_rate,
        qps: s.strategy?.qps,
        generation: s.strategy?.generation,
      });
      // features 逐字段比较在 setNav 里做：轮询每次都是新对象，不比较会白刷侧栏
      setNav({ features: s.features ?? null, featureWarn: false });
    } catch (e) {
      console.warn('[gongfang] gongfang_status 拉取失败（无法确认框架编译能力）:', e);
      setNav({ featureWarn: true });
    }
  }, []);

  // 内核是否运行（事件驱动），据此控制态势条轮询开关
  const running = useKernelRunning();

  // 进入模块（同意声明后）拉取一次初始态势
  useEffect(() => {
    if (!accepted) return;
    fetchSituation();
  }, [accepted, fetchSituation]);

  // 态势条轮询：仅内核运行中才轮询（避免未启动时的空转拉取）；停止后自动停表
  useEffect(() => {
    if (!accepted || !running) return;
    const id = setInterval(fetchSituation, 2000);
    return () => clearInterval(id);
  }, [accepted, running, fetchSituation]);

  // 全局快捷键：1-5 切 Tab / I 切信息台 / T 切目标 / L 审计
  useHotkeys([
    { key: '1', handler: () => setNav({ tab: 'crawler' }), description: '切换到网络爬虫' },
    { key: '2', handler: () => setNav({ tab: 'reverse' }), description: '切换到逆向工程' },
    { key: '3', handler: () => setNav({ tab: 'pentest' }), description: '切换到渗透测试' },
    { key: '4', handler: () => setNav({ tab: 'automation' }), description: '切换到自动化测试' },
    { key: '5', handler: () => setNav({ tab: 'gateway' }), description: '切换到 API 网关' },
    { key: 'i', handler: () => setShowInfo((v) => !v), description: '切换信息台' },
    { key: 't', handler: () => setShowTargets((v) => !v), description: '切换目标工作区' },
    { key: 'l', handler: () => setShowLog((v) => !v), description: '切换审计日志' },
  ]);

  // 监听来自 AI 侧边栏的审计事件（侧边栏组件无 props，通过全局事件通信）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<AuditInput>).detail;
      if (detail) addLog(detail);
    };
    window.addEventListener('gongfang-audit', handler as EventListener);
    return () => window.removeEventListener('gongfang-audit', handler as EventListener);
  }, [addLog]);

  // 切换审计：侧栏点击与快捷键 1-5 都写同一个 navStore，这里订阅变化后统一落一条审计，
  // 避免「侧栏切的不记、快捷键切的记」这种半套行为。
  const lastLoggedTab = useRef<TabKey>(getNav().tab);
  useEffect(() => subscribeNav(() => {
    const next = getNav().tab;
    if (next === lastLoggedTab.current) return;
    lastLoggedTab.current = next;
    addLog({ action: '切换框架', target: FRAMEWORK_LABELS[next], status: 'info' });
  }), [addLog]);

  // 重新阅读免责声明
  const reopenDisclaimer = useCallback(() => {
    revokeDisclaimer();
    addLog({ action: '重新阅读声明', target: '免责声明', status: 'info' });
    setAccepted(false);
  }, [addLog]);

  // 未同意免责声明：全屏覆盖，不渲染任何攻防功能
  if (!accepted) {
    return <RiskConfirm onAgree={() => { setAccepted(true); addLog({ action: '同意免责声明', target: '攻防模块', status: 'success' }); }} />;
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-[#f5f5f0] dark:bg-[#1c1917]">
      {/* 顶部：标题 + 内核态势感知条 + 审计入口 */}
      <div className="flex items-center justify-between gap-3 px-5 py-2.5 border-b border-white/80 dark:border-stone-700/50">
        <div className="flex items-center gap-2">
          <span className="text-[var(--element-bg)]">{ShieldIcon}</span>
          <span className="text-sm font-semibold text-[var(--element-bg)]">攻防套件</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-600 dark:text-rose-400">仅限授权测试</span>
        </div>

        {/* 内核态势感知条（phase/reward/err/qps/gen 实时一行） */}
        <div className="flex-1 flex justify-center min-w-0">
          <SituationalBar situation={situation ?? { running: false }} />
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={reopenDisclaimer}
            className="btn-press px-2 py-1 rounded-lg text-[11px] text-neutral-400 hover:text-neutral-600 dark:hover:text-stone-300 hover:bg-black/5 dark:hover:bg-white/5"
            title="重新阅读免责声明"
          >
            声明
          </button>
          <ExportButton
            label="导出报告"
            getData={() => ({ active_tab: tab, logs })}
            extraData={{ disclaimer_accepted: accepted }}
          />
          <button
            onClick={() => { addLog({ action: '查看审计日志', target: '审计抽屉', status: 'info' }); setShowLog(true); }}
            className="btn-press flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5"
            title="操作审计日志 (L)"
          >
            {LogIcon}
            <span>{logs.length}</span>
          </button>
        </div>
      </div>

      {/* 视图开关条（导航已搬到侧栏：同一批入口不再出现在两处） */}
      <div className="flex items-center gap-1.5 px-5 py-1.5 border-b border-white/60 dark:border-stone-700/30">
        <span className="text-[11px] text-neutral-400 dark:text-stone-500 mr-1">{FRAMEWORK_LABELS[tab]}</span>
        {featureWarn && <span className="text-[10px] text-amber-600 dark:text-amber-400 mr-2" title="gongfang_status 拉取失败，无法确认各框架编译能力">状态不可用</span>}
        <div className="flex-1" />
        <span className="text-[10px] text-neutral-400 mr-1 hidden md:inline">快捷键 1-5 切功能块 · I 信息台 · T 目标 · L 审计</span>
        <button
          onClick={() => setShowTargets((v) => !v)}
          className={`btn-press px-2 py-1 rounded-lg text-[11px] border ${
            showTargets
              ? 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400'
              : 'border-black/10 dark:border-stone-700/50 text-neutral-400 hover:bg-black/5 dark:hover:bg-white/5'
          }`}
          title="切换目标工作区"
        >
          目标
        </button>
        <button
          onClick={() => setShowInfo((v) => !v)}
          className={`btn-press px-2 py-1 rounded-lg text-[11px] border ${
            showInfo
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : 'border-black/10 dark:border-stone-700/50 text-neutral-400 hover:bg-black/5 dark:hover:bg-white/5'
          }`}
          title="切换信息台"
        >
          信息台
        </button>
      </div>

      {/* 主内容区：左 TargetWorkspace + 右（框架内容 + 底部信息台） */}
      <div className="flex-1 flex h-full overflow-hidden">
        {/* 左侧目标工作区（可折叠） */}
        {showTargets && (
          <div className="w-[220px] shrink-0 p-2 border-r border-black/5 dark:border-stone-700/30">
            <TargetWorkspace onActivate={(t) => addLog({ action: '激活目标', target: t.name, status: 'info' })} />
          </div>
        )}

        {/* 右侧：框架内容 + 底部信息台（上下分割） */}
        <div className="flex-1 flex flex-col h-full overflow-hidden">
          {/* 框架内容区 */}
          <div className={`overflow-hidden ${showInfo ? 'flex-1 min-h-0' : 'flex-1'}`}>
            {features && features[tab] === false ? (
              <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-6">
                <p className="text-sm font-medium text-neutral-500 dark:text-stone-400">该框架未随当前内核编译</p>
                <p className="text-xs text-neutral-400 max-w-sm">当前二进制未启用对应 feature，命令不可用。请用 <code className="px-1 py-0.5 rounded bg-black/5 dark:bg-white/10 font-mono text-[10px]">--features gongfang-...</code> 重新构建后再使用。</p>
              </div>
            ) : (
              <>
                {tab === 'crawler' && <CrawlerPanel addLog={addLog} />}
                {tab === 'reverse' && <ReversePanel addLog={addLog} />}
                {tab === 'pentest' && <PentestPanel addLog={addLog} />}
                {tab === 'automation' && <AutomationPanel addLog={addLog} />}
                {tab === 'gateway' && <GatewayPanel addLog={addLog} />}
              </>
            )}
          </div>

          {/* 底部信息台：三栏可独立折叠（时序图 + 事件流 + AI 推理日志）
              items-start 让每栏高度独立自适应：折叠时只占标题栏，展开时撑开
              max-h 限制最高 340px，超出可滚动 */}
          {showInfo && (
            <div className="max-h-[340px] overflow-y-auto shrink-0 grid grid-cols-3 gap-2 p-2 border-t border-black/5 dark:border-stone-700/30 bg-black/[0.01] dark:bg-black/20 items-start">
              <MetricsChart height={200} />
              <EventStream height={200} />
              <AiReasoningPanel height={200} />
            </div>
          )}

          {/* AI 推理层实验室：知识库(RAG) + 路由仿真 + 推理统计 */}
          <AiReasoningLab />
        </div>
      </div>

      {/* 审计日志抽屉 */}
      <AuditLogDrawer open={showLog} onClose={() => setShowLog(false)} logs={logs} onClear={clearLog} />
    </div>
  );
}

// ============ 侧边栏（AI 指挥官控制枢纽，复用宿主 ModuleSidebarShell 渲染） ============
// 侧边栏组件无 props（宿主以 <PluginContent /> 渲染），通过全局事件与主模块通信

export { GongfangModule };
