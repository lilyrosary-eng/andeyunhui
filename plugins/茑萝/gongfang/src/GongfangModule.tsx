/// <reference path="../../../global.d.ts" />
// 茑萝 · 攻防主容器
// 职责：首次进入风险确认 + 免责声明 / 防追踪状态栏 / 五框架 Tab / 操作审计日志
//       P0 通用信息层：左 TargetWorkspace + 底部 MetricsChart/AiReasoningPanel/EventStream
// 设计：攻防一体、专业合法、极致高效、稳定防追踪、信息台密集布局（专业级控制台）
const React = window.__HOST_REACT__;
const { useState, useCallback, useEffect } = React;

import { CrawlerPanel, ReversePanel, PentestPanel, AutomationPanel, GatewayPanel } from './frameworks';
import { useAuditLog, AuditLogDrawer, type AuditInput } from './audit';
import { RiskConfirm, isDisclaimerAccepted, revokeDisclaimer } from './RiskConfirm';
import { GongfangAiSidebar } from './GongfangAiSidebar';
import { EventStream, MetricsChart, AiReasoningPanel, TargetWorkspace, AiReasoningLab } from './infoPanels';
import { ExportButton } from './professionalExtras';
import { useHotkeys, SituationalBar, useKernelRunning } from './ui';

type TabKey = 'crawler' | 'reverse' | 'pentest' | 'automation' | 'gateway';

// ============ 图标（内联 SVG，避免引入新依赖） ============
const ShieldIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);
const CrawlerIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
);
const ReverseIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </svg>
);
const PentestIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m14 4 6 6-11 11H3v-6L14 4z" />
    <path d="m13 5 6 6" />
  </svg>
);
const AutoIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 8V4H8" />
    <rect x="4" y="8" width="16" height="12" rx="2" />
    <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
  </svg>
);
const GatewayIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12h4l3-9 4 18 3-9h4" />
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
function TabButton({ active, onClick, icon, label, badge, badgeTone, disabled, disabledReason }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; badge?: string; badgeTone?: 'ok' | 'warn' | 'neutral'; disabled?: boolean; disabledReason?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={disabledReason}
      className={`btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
        disabled
          ? 'cursor-not-allowed text-neutral-400 dark:text-stone-500 opacity-60'
          : active
          ? 'bg-[var(--element-muted)] text-[var(--element-bg)]'
          : 'text-neutral-500 dark:text-stone-400 hover:text-neutral-700 dark:hover:text-stone-200 hover:bg-black/5 dark:hover:bg-white/5'
      }`}
    >
      {icon}
      {label}
      {badge && (
        <span className={`ml-1 px-1.5 py-0.5 rounded text-[10px] ${
          badgeTone === 'ok'
            ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
            : badgeTone === 'warn'
            ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400'
            : 'bg-neutral-500/10 text-neutral-500 dark:text-stone-400'
        }`}>{badge}</span>
      )}
    </button>
  );
}

// ============ 防追踪状态指示灯 ============
function StatusDot({ label, tone }: { label: string; tone: 'ok' | 'warn' | 'idle' }) {
  const toneCls = tone === 'ok'
    ? 'bg-emerald-500'
    : tone === 'warn'
    ? 'bg-amber-500'
    : 'bg-neutral-400';
  const dotCls = tone === 'ok' ? 'shadow-[0_0_6px] shadow-emerald-500/60' : '';
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className={`inline-block w-2 h-2 rounded-full ${toneCls} ${dotCls}`} />
      <span className="text-neutral-500 dark:text-stone-400">{label}</span>
    </div>
  );
}

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
}

// TabKey → features 字段（用于按编译能力优雅降级）
const TAB_FEATURE: Record<TabKey, keyof Features> = {
  crawler: 'crawler',
  reverse: 'reverse',
  pentest: 'pentest',
  automation: 'automation',
  gateway: 'gateway',
};

function GongfangModule() {
  const [accepted, setAccepted] = useState<boolean>(() => isDisclaimerAccepted());
  const [tab, setTab] = useState<TabKey>('crawler');
  const [showLog, setShowLog] = useState(false);
  // P0 信息台开关：左侧目标工作区 + 底部信息台（时序图/事件流/AI 推理）
  const [showTargets, setShowTargets] = useState(true);
  const [showInfo, setShowInfo] = useState(true);
  // 顶部态势感知条：轻量拉取 gongfang_status（2s 轮询，仅 accepted 后）
  const [situation, setSituation] = useState<TopSituation | null>(null);
  const { logs, addLog, clearLog } = useAuditLog();
  // 编译能力（features）+ 拉取失败标志：feature 未编译的框架前端置灰
  const [features, setFeatures] = useState<Features | null>(null);
  const [featureWarn, setFeatureWarn] = useState(false);

  // Tauri invoke 封装（顶部态势感知条用，统一走沙箱 hostApi，已加入白名单）
  const fetchSituation = useCallback(async () => {
    try {
      const s = await (window.__HOST_API__ as { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> }).invoke<{
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
      if (s.features) setFeatures(s.features);
      setFeatureWarn(false);
    } catch {
      setFeatureWarn(true);
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
    { key: '1', handler: () => setTab('crawler'), description: '切换到网络爬虫' },
    { key: '2', handler: () => setTab('reverse'), description: '切换到逆向工程' },
    { key: '3', handler: () => setTab('pentest'), description: '切换到渗透测试' },
    { key: '4', handler: () => setTab('automation'), description: '切换到自动化测试' },
    { key: '5', handler: () => setTab('gateway'), description: '切换到 API 网关' },
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

  // 包裹 setTab：切换 Tab 时记录审计
  const switchTab = useCallback((next: TabKey) => {
    const labels: Record<TabKey, string> = { crawler: '网络爬虫', reverse: '逆向工程', pentest: '渗透测试', automation: '自动化测试', gateway: 'API 网关' };
    addLog({ action: '切换框架', target: labels[next], status: 'info' });
    setTab(next);
  }, [addLog]);

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

      {/* 五大框架 Tab + 信息台切换 */}
      <div className="flex items-center gap-1 px-5 py-2 border-b border-white/60 dark:border-stone-700/30">
        {featureWarn && <span className="text-[10px] text-amber-600 dark:text-amber-400 mr-2" title="gongfang_status 拉取失败，无法确认各框架编译能力">状态不可用</span>}
        {([
          { key: 'crawler' as TabKey, icon: CrawlerIcon, label: '网络爬虫' },
          { key: 'reverse' as TabKey, icon: ReverseIcon, label: '逆向工程' },
          { key: 'pentest' as TabKey, icon: PentestIcon, label: '渗透测试' },
          { key: 'automation' as TabKey, icon: AutoIcon, label: '自动化测试' },
          { key: 'gateway' as TabKey, icon: GatewayIcon, label: 'API 网关' },
        ]).map((t) => {
          const enabled = features ? features[TAB_FEATURE[t.key]] : true; // 未取到前不拦截
          return (
            <TabButton
              key={t.key}
              active={tab === t.key}
              onClick={() => switchTab(t.key)}
              icon={t.icon}
              label={t.label}
              disabled={!enabled}
              disabledReason="该框架未随当前内核编译，请用 --features 构建后再使用"
              badge={features === null ? undefined : enabled ? '就绪' : '未编译'}
              badgeTone={enabled ? 'ok' : 'warn'}
            />
          );
        })}
        <div className="flex-1" />
        {/* 快捷键提示 */}
        <span className="text-[10px] text-neutral-400 mr-1 hidden md:inline">快捷键 1-5 切框架 · I 信息台 · T 目标 · L 审计</span>
        {/* P0 信息台开关 */}
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
            {features && !features[TAB_FEATURE[tab]] ? (
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
const GongfangSidebar = GongfangAiSidebar;

export { GongfangModule, GongfangSidebar };
