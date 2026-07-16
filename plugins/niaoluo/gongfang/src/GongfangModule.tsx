/// <reference path="../../../global.d.ts" />
// 茑萝 · 攻防主容器
// 职责：首次进入风险确认 + 免责声明 / 防追踪状态栏 / 四框架 Tab / 操作审计日志
// 设计：攻防一体、专业合法、极致高效、稳定防追踪
// 当前为 UI 骨架占位，框架能力后续逐步填充。
const React = window.__HOST_REACT__;
const { useState, useCallback } = React;

import { CrawlerPanel, ReversePanel, PentestPanel, AutomationPanel } from './frameworks';
import { useAuditLog, AuditLogDrawer } from './audit';
import { RiskConfirm, isDisclaimerAccepted, revokeDisclaimer } from './RiskConfirm';

type TabKey = 'crawler' | 'reverse' | 'pentest' | 'automation';

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
const LogIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="9" y1="13" x2="15" y2="13" />
    <line x1="9" y1="17" x2="15" y2="17" />
  </svg>
);

// ============ Tab 按钮 ============
function TabButton({ active, onClick, icon, label, badge }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; badge?: string }) {
  return (
    <button
      onClick={onClick}
      className={`btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
        active
          ? 'bg-[var(--element-muted)] text-[var(--element-bg)]'
          : 'text-neutral-500 dark:text-stone-400 hover:text-neutral-700 dark:hover:text-stone-200 hover:bg-black/5 dark:hover:bg-white/5'
      }`}
    >
      {icon}
      {label}
      {badge && <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-600 dark:text-amber-400">{badge}</span>}
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
function GongfangModule() {
  const [accepted, setAccepted] = useState<boolean>(() => isDisclaimerAccepted());
  const [tab, setTab] = useState<TabKey>('crawler');
  const [showLog, setShowLog] = useState(false);
  const { logs, addLog, clearLog } = useAuditLog();

  // 包裹 setTab：切换 Tab 时记录审计
  const switchTab = useCallback((next: TabKey) => {
    const labels: Record<TabKey, string> = { crawler: '网络爬虫', reverse: '逆向工程', pentest: '渗透测试', automation: '自动化测试' };
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
      {/* 顶部：标题 + 防追踪状态栏 + 审计入口 */}
      <div className="flex items-center justify-between gap-3 px-5 py-2.5 border-b border-white/80 dark:border-stone-700/50">
        <div className="flex items-center gap-1.5">
          <span className="text-[var(--element-bg)]">{ShieldIcon}</span>
          <span className="text-sm font-semibold text-[var(--element-bg)]">攻防套件</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-600 dark:text-rose-400">仅限授权测试</span>
        </div>

        {/* 防追踪状态栏：占位指示，后续接入真实状态 */}
        <div className="flex items-center gap-4">
          <StatusDot label="代理通道" tone="idle" />
          <StatusDot label="指纹轮换" tone="idle" />
          <StatusDot label="痕迹清理" tone="idle" />
          <button
            onClick={reopenDisclaimer}
            className="btn-press px-2 py-1 rounded-lg text-[11px] text-neutral-400 hover:text-neutral-600 dark:hover:text-stone-300 hover:bg-black/5 dark:hover:bg-white/5"
            title="重新阅读免责声明"
          >
            声明
          </button>
          <button
            onClick={() => { addLog({ action: '查看审计日志', target: '审计抽屉', status: 'info' }); setShowLog(true); }}
            className="btn-press flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5"
            title="操作审计日志"
          >
            {LogIcon}
            <span>{logs.length}</span>
          </button>
        </div>
      </div>

      {/* 四大框架 Tab */}
      <div className="flex items-center gap-1 px-5 py-2 border-b border-white/60 dark:border-stone-700/30">
        <TabButton active={tab === 'crawler'} onClick={() => switchTab('crawler')} icon={CrawlerIcon} label="网络爬虫" badge="就绪" />
        <TabButton active={tab === 'reverse'} onClick={() => switchTab('reverse')} icon={ReverseIcon} label="逆向工程" badge="骨架" />
        <TabButton active={tab === 'pentest'} onClick={() => switchTab('pentest')} icon={PentestIcon} label="渗透测试" badge="骨架" />
        <TabButton active={tab === 'automation'} onClick={() => switchTab('automation')} icon={AutoIcon} label="自动化测试" badge="骨架" />
      </div>

      {/* 框架内容区 */}
      <div className="flex-1 h-full overflow-hidden">
        {tab === 'crawler' && <CrawlerPanel addLog={addLog} />}
        {tab === 'reverse' && <ReversePanel addLog={addLog} />}
        {tab === 'pentest' && <PentestPanel addLog={addLog} />}
        {tab === 'automation' && <AutomationPanel addLog={addLog} />}
      </div>

      {/* 审计日志抽屉 */}
      <AuditLogDrawer open={showLog} onClose={() => setShowLog(false)} logs={logs} onClear={clearLog} />
    </div>
  );
}

// ============ 侧边栏（茑萝母目录下展示，复用宿主 ModuleSidebarShell 渲染） ============
function GongfangSidebar() {
  return (
    <div className="p-4 text-sm text-neutral-500 dark:text-stone-400">
      <div className="flex items-center gap-2 mb-3 text-[var(--element-bg)]">
        {ShieldIcon}
        <span className="font-medium">攻防套件</span>
      </div>
      <ul className="space-y-1.5 text-xs">
        <li>· 网络爬虫（反检测/反封锁）</li>
        <li>· 逆向工程（协议/加解密）</li>
        <li>· 渗透测试（扫描/WAF绕过）</li>
        <li>· 自动化测试（验证码/行为）</li>
      </ul>
    </div>
  );
}

export { GongfangModule, GongfangSidebar };
