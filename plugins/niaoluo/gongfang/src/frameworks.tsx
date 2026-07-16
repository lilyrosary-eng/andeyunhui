/// <reference path="../../../global.d.ts" />
// 攻防模块 · 四大框架面板
// 爬虫框架：内核已就绪，接入实际 Tauri 命令（启动/停止/状态/指令注入）。
// 逆向/渗透/自动化：仍为 UI 骨架阶段，使用 FrameworkPlaceholder 占位模板。
const React = window.__HOST_REACT__;
const { useState, useEffect, useCallback } = React;

import type { AuditInput } from './audit';

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
        <section className="bg-white/60 dark:bg-white/[0.03] rounded-xl border border-black/5 dark:border-stone-700/50 p-4">
          <h3 className="text-sm font-medium text-[var(--element-bg)] mb-3">核心能力规划</h3>
          <div className="grid grid-cols-2 gap-2">
            {meta.capabilities.map((cap) => (
              <div key={cap} className="flex items-center gap-2 text-[13px] text-neutral-600 dark:text-stone-300">
                <span className="inline-block w-1 h-1 rounded-full bg-neutral-400" />
                {cap}
              </div>
            ))}
          </div>
        </section>

        {/* 技术选型 */}
        <section className="bg-white/60 dark:bg-white/[0.03] rounded-xl border border-black/5 dark:border-stone-700/50 p-4">
          <h3 className="text-sm font-medium text-[var(--element-bg)] mb-3">技术选型（优先 MIT/Apache 协议）</h3>
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
        </section>

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
        <section className="bg-white/60 dark:bg-white/[0.03] rounded-xl border border-black/5 dark:border-stone-700/50 p-4">
          <h3 className="text-sm font-medium text-[var(--element-bg)] mb-3">核心能力规划</h3>
          <div className="grid grid-cols-2 gap-2">
            {crawlerMeta.capabilities.map((cap) => (
              <div key={cap} className="flex items-center gap-2 text-[13px] text-neutral-600 dark:text-stone-300">
                <span className="inline-block w-1 h-1 rounded-full bg-neutral-400" />
                {cap}
              </div>
            ))}
          </div>
        </section>

        {/* 技术选型 */}
        <section className="bg-white/60 dark:bg-white/[0.03] rounded-xl border border-black/5 dark:border-stone-700/50 p-4">
          <h3 className="text-sm font-medium text-[var(--element-bg)] mb-3">技术选型（优先 MIT/Apache 协议）</h3>
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
        </section>

        {/* 内核控制面板 */}
        <section className="bg-white/60 dark:bg-white/[0.03] rounded-xl border border-black/5 dark:border-stone-700/50 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-[var(--element-bg)]">内核控制</h3>
            {status && !status.features.crawler && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400">
                后端未启用 crawler feature
              </span>
            )}
          </div>

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
        </section>
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
    { name: 'wasmparser', license: 'Apache-2.0' },
    { name: 'frida-gum', license: 'wxWindows' },
    { name: 'gimli', license: 'Apache-2.0' },
    { name: 'object', license: 'MIT' },
  ],
  status: '骨架',
};

function ReversePanel({ addLog }: { addLog: (i: AuditInput) => void }) {
  return <FrameworkPlaceholder meta={reverseMeta} addLog={addLog} />;
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
    { name: 'nuclei', license: 'MIT' },
    { name: 'sqlmap', license: 'GPL-2.0' },
    { name: 'nmap', license: 'NPSL' },
    { name: 'tokio::process', license: 'MIT' },
  ],
  status: '骨架',
};

function PentestPanel({ addLog }: { addLog: (i: AuditInput) => void }) {
  return <FrameworkPlaceholder meta={pentestMeta} addLog={addLog} />;
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
    { name: 'ort (ONNX Runtime)', license: 'MIT' },
    { name: 'imageproc', license: 'MIT' },
    { name: 'tesseract-rs', license: 'MIT' },
    { name: 'whisper.cpp', license: 'MIT' },
  ],
  status: '骨架',
};

function AutomationPanel({ addLog }: { addLog: (i: AuditInput) => void }) {
  return <FrameworkPlaceholder meta={automationMeta} addLog={addLog} />;
}

export { CrawlerPanel, ReversePanel, PentestPanel, AutomationPanel };
