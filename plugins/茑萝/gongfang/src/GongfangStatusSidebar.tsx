/// <reference path="../../../global.d.ts" />
// 茑萝 · 攻防 · 状态侧栏（2026-10-19 新增）
//
// ## 为什么有它
// 原来的攻防侧栏是 AI 对话框（GongfangAiSidebar，已删除，AI 迁到黄金棋盘浮岛）。
// 侧栏位置空出来之后，正好放**功能块/状态显示**：内核状态、事件流、时序指标、目标工作区。
// 分工因此变得清晰：
//   · 浮岛「AI 攻防」= 只有对话（自然语言下指令）
//   · 这个侧栏 = 只读状态 + 少量直接操作（启停），不产生对话
//
// ## 为什么复用 infoPanels 里的组件
// EventStream / MetricsChart / TargetWorkspace 本来就在攻防主区域底部渲染，
// 有自己的轮询与图表实例；这里直接复用（传 height 收窄），既保证视觉与主区域一致，
// 又不重复实现轮询/图表逻辑。
import { EventStream, MetricsChart, TargetWorkspace } from './infoPanels';

// 与插件里其它文件一致：React 取自宿主注入的 __HOST_REACT__，
// 不 import 'react' —— 避免主包里出现第二份 React 实例（hooks 会直接崩）
const React = window.__HOST_REACT__;
const { useState, useEffect, useCallback } = React;

const tauriInvoke = <T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  (window.__HOST_API__ as { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> }).invoke(cmd, args) as Promise<T>;

interface KernelStatus {
  running?: boolean;
  reward?: number;
  error_rate?: number;
  strategy?: unknown;
}

/** 策略对象可能很大，侧栏只取前几个标量做摘要。 */
function strategySummary(v: unknown): string {
  if (!v || typeof v !== 'object') return '';
  const o = v as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of ['profile', 'level', 'mode', 'concurrency', 'delay_ms']) {
    const x = o[k];
    if (typeof x === 'string' || typeof x === 'number') parts.push(`${k}=${x}`);
  }
  return parts.join(' · ');
}

export function GongfangStatusSidebar() {
  const [st, setSt] = useState<KernelStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await tauriInvoke<KernelStatus>('gongfang_status');
      setSt(s);
      setErr(null);
    } catch (e) {
      // 内核未编译 / 未启动时状态命令可能失败：显示一行提示即可，不要弹窗打断
      setErr(String(e));
      setSt(null);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = () => { if (alive) void refresh(); };
    tick();
    const iv = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(iv); };
  }, [refresh]);

  const toggle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (st?.running) {
        await tauriInvoke('gongfang_stop');
      } else {
        await tauriInvoke('gongfang_start', { profileId: null });
      }
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, st?.running, refresh]);

  const running = !!st?.running;
  const reward = typeof st?.reward === 'number' ? st.reward : null;
  const errRate = typeof st?.error_rate === 'number' ? st.error_rate : null;
  const strat = strategySummary(st?.strategy);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 10px 16px', height: '100%', overflowY: 'auto' }}>
      {/* 状态卡 */}
      <div style={{ border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, padding: 10, background: 'rgba(255,255,255,0.03)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: 4, background: running ? '#5fd08a' : 'rgba(255,255,255,0.3)', boxShadow: running ? '0 0 8px #5fd08a' : 'none' }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(244,244,246,0.9)' }}>{running ? '内核运行中' : '内核未启动'}</span>
          <span style={{ flex: 1 }} />
          <button
            onClick={() => void toggle()}
            disabled={busy}
            title={running ? '停止双轨制内核' : '启动双轨制内核'}
            style={{
              fontSize: 11, padding: '3px 10px', borderRadius: 999, cursor: busy ? 'default' : 'pointer',
              color: running ? '#f0a3a3' : '#1c1c1e',
              background: running ? 'rgba(240,120,120,0.14)' : '#e6c35c',
              border: running ? '1px solid rgba(240,120,120,0.4)' : 'none',
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? '…' : running ? '停止' : '启动'}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Stat label="累计奖励" value={reward === null ? '—' : String(reward)} />
          <Stat label="错误率" value={errRate === null ? '—' : `${(errRate * 100).toFixed(1)}%`} />
        </div>
        {strat && (
          <div style={{ marginTop: 6, fontSize: 10.5, color: 'rgba(244,244,246,0.55)', lineHeight: 1.5, wordBreak: 'break-all' }}>
            策略 {strat}
          </div>
        )}
        {err && (
          <div style={{ marginTop: 6, fontSize: 10.5, color: '#f0a3a3', lineHeight: 1.5 }}>
            {err.slice(0, 120)}
          </div>
        )}
      </div>

      {/* 事件流（复用主区域组件） */}
      <Section title="最近事件">
        <EventStream height={190} />
      </Section>

      {/* 时序指标 */}
      <Section title="指标曲线">
        <MetricsChart height={170} />
      </Section>

      {/* 目标工作区 */}
      <Section title="目标工作区">
        <TargetWorkspace />
      </Section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ flex: 1, minWidth: 0, background: 'rgba(0,0,0,0.22)', borderRadius: 8, padding: '6px 8px' }}>
      <div style={{ fontSize: 10, color: 'rgba(244,244,246,0.5)' }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: '#e6c35c', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'rgba(244,244,246,0.55)', marginBottom: 4, letterSpacing: 0.3 }}>{title}</div>
      {children}
    </div>
  );
}
