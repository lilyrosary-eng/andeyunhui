/// <reference path="../../../global.d.ts" />
// 茑萝 · 攻防 AI 指挥官（侧边栏）
// 职责：AI 对话控制枢纽，可调度五大框架，也支持纯人工快速指令
// 设计：复用全局 ai_chat 流式接口 + <cmd> 标签自动执行（ReAct 式 agent 循环）
// 布局：填充 ModuleSidebarShell 的 children 区（不破坏外壳的顶栏/底栏）
const React = window.__HOST_REACT__;
const { useState, useRef, useCallback, useEffect, useMemo } = React;

const hostApi = window.__HOST_API__;

// 攻防命令直接走 __TAURI_INTERNALS__.invoke（未加入插件沙箱白名单）
const tauriInvoke = <T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  const w = window as any & {
    __TAURI_INTERNALS__?: { invoke: <U = T>(c: string, a?: Record<string, unknown>) => Promise<U> };
  };
  if (!w.__TAURI_INTERNALS__?.invoke) {
    return Promise.reject(new Error('Tauri invoke 不可用'));
  }
  return w.__TAURI_INTERNALS__.invoke<T>(cmd, args);
};

// ============ 类型 ============
type ChatRole = 'user' | 'assistant' | 'tool';

interface ChatMsg {
  id: string;
  role: ChatRole;
  content: string;
  streaming?: boolean;
  error?: boolean;
}

interface AiProfile {
  id: string;
  name?: string;
  model?: string;
  base_url?: string;
  api_key?: string;
}

interface CmdDirective {
  action: string;
  attrs: Record<string, string>;
}

// ============ <cmd> 标签解析 ============
const CMD_REGEX = /<cmd\s+([^/]*?)\/>/g;

function parseCmds(text: string): { cmds: CmdDirective[]; cleaned: string } {
  const cmds: CmdDirective[] = [];
  const cleaned = text.replace(CMD_REGEX, (_match, raw: string) => {
    const attrs: Record<string, string> = {};
    const attrRegex = /(\w+)="([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = attrRegex.exec(raw)) !== null) {
      attrs[m[1]] = m[2];
    }
    if (attrs.action) {
      cmds.push({ action: attrs.action, attrs });
    }
    return '';
  }).trim();
  return { cmds, cleaned };
}

// ============ 命令执行 ============
async function executeCmd(cmd: CmdDirective): Promise<string> {
  const { action, attrs } = cmd;
  const label = actionLabel(action, attrs);
  dispatchAudit('AI 指令', label, 'info');
  try {
    let result: string;
    switch (action) {
      case 'status': {
        const r = await tauriInvoke('gongfang_status');
        result = JSON.stringify(r, null, 2);
        break;
      }
      case 'start': {
        await tauriInvoke('gongfang_start', { profileId: attrs.profile || null });
        result = '内核已启动';
        break;
      }
      case 'stop': {
        await tauriInvoke('gongfang_stop');
        result = '内核已停止';
        break;
      }
      case 'inject': {
        await tauriInvoke('gongfang_inject', { cmd: attrs.cmd || 'Focus' });
        result = `已注入指令: ${attrs.cmd || 'Focus'}`;
        break;
      }
      case 'scan': {
        const ports = attrs.ports
          ? attrs.ports.split(',').map((p) => parseInt(p.trim(), 10)).filter((n) => !isNaN(n) && n > 0)
          : null;
        const r = await tauriInvoke('gongfang_scan', { host: attrs.host, ports });
        const openCount = (r as any)?.open_ports?.length ?? 0;
        result = `扫描完成: ${openCount} 个开放端口\n${JSON.stringify(r, null, 2)}`;
        break;
      }
      case 'waf': {
        const r = await tauriInvoke('gongfang_waf_detect', { url: attrs.url });
        result = JSON.stringify(r, null, 2);
        break;
      }
      case 'crypto': {
        const r = await tauriInvoke('gongfang_crypto_identify', { hexData: attrs.hex });
        result = JSON.stringify(r, null, 2);
        break;
      }
      case 'symbols': {
        const r = await tauriInvoke('gongfang_symbols', { url: attrs.url || null });
        result = `共 ${(r as any[])?.length ?? 0} 个符号\n${JSON.stringify(r, null, 2)}`;
        break;
      }
      case 'humanize': {
        const r = await tauriInvoke<string>('gongfang_humanize', { level: parseInt(attrs.level || '5', 10) });
        result = `已设置拟人化等级 ${attrs.level}，当前模板: ${r}`;
        break;
      }
      case 'fitness': {
        const r = await tauriInvoke('gongfang_fitness');
        result = JSON.stringify(r, null, 2);
        break;
      }
      case 'migrate': {
        const r = await tauriInvoke<string>('gongfang_fitness_migrate');
        result = r;
        break;
      }
      case 'reset': {
        await tauriInvoke('gongfang_fitness_reset');
        result = '适应度统计已重置';
        break;
      }
      case 'rotate': {
        const r = await tauriInvoke<string>('gongfang_gateway_rotate', { mode: attrs.mode || 'direct' });
        result = r;
        break;
      }
      case 'throttle': {
        const r = await tauriInvoke<string>('gongfang_gateway_throttle', { percent: parseInt(attrs.percent || '100', 10) });
        result = r;
        break;
      }
      case 'gateway_status': {
        const r = await tauriInvoke('gongfang_gateway_status');
        result = JSON.stringify(r, null, 2);
        break;
      }
      case 'gateway_pool': {
        const r = await tauriInvoke('gongfang_gateway_pool');
        result = JSON.stringify(r, null, 2);
        break;
      }
      default:
        result = `未知命令: ${action}`;
    }
    dispatchAudit('AI 指令', label, 'success', result.slice(0, 120));
    return result;
  } catch (e) {
    const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
    dispatchAudit('AI 指令', label, 'error', msg.slice(0, 120));
    return `执行失败: ${msg}`;
  }
}

function actionLabel(action: string, attrs: Record<string, string>): string {
  switch (action) {
    case 'scan': return `扫描 ${attrs.host || '?'}`;
    case 'waf': return `WAF 检测 ${attrs.url || '?'}`;
    case 'crypto': return `加密识别 (${attrs.hex?.length || 0} 字符)`;
    case 'humanize': return `拟人化 L${attrs.level || '5'}`;
    case 'inject': return `注入 ${attrs.cmd || 'Focus'}`;
    case 'rotate': return `切换出口 ${attrs.mode || 'direct'}`;
    case 'throttle': return `限速 ${attrs.percent || '100'}%`;
    default: return action;
  }
}

// ============ 审计日志分发（通过全局事件发送给 GongfangModule） ============
function dispatchAudit(action: string, target: string, status: 'info' | 'success' | 'warn' | 'error', detail?: string) {
  window.dispatchEvent(new CustomEvent('gongfang-audit', { detail: { action, target, status, detail } }));
}

// ============ 系统提示词 ============
function buildSystemPrompt(): string {
  return [
    '你是攻防套件的 AI 指挥官，运行在「茑萝」平台的「攻防」模块侧边栏中。',
    '你可以根据用户的自然语言指令，调度五大框架（网络爬虫/逆向工程/渗透测试/自动化测试/API网关）。',
    '',
    '可用命令（通过 <cmd> 标签输出，前端自动执行并回填结果）：',
    '1. <cmd action="status" /> — 查询内核运行状态',
    '2. <cmd action="start" profile="可选" /> — 启动双轨制内核',
    '3. <cmd action="stop" /> — 停止内核',
    '4. <cmd action="inject" cmd="Focus|Bypass|Pause|Resume" /> — 注入控制指令（P0/P1/P2 优先级）',
    '5. <cmd action="scan" host="目标主机" ports="80,443,8080" /> — 端口扫描（ports 可选，不填用 Top-100）',
    '6. <cmd action="waf" url="https://目标URL" /> — WAF 检测',
    '7. <cmd action="crypto" hex="6e3a5f2c..." /> — 加密算法识别（卡方检验 + 特征向量库）',
    '8. <cmd action="symbols" url="可选目标URL" /> — 符号库查询',
    '9. <cmd action="humanize" level="5" /> — 设置拟人化等级（0机械-10疲劳）',
    '10. <cmd action="fitness" /> — 查询模板适应度报告',
    '11. <cmd action="migrate" /> — 触发热迁移（切换到最优模板）',
    '12. <cmd action="reset" /> — 重置适应度统计',
    '13. <cmd action="rotate" mode="direct|proxy|stealth" /> — 切换出口流量模式',
    '14. <cmd action="throttle" percent="50" /> — 调整全局带宽上限',
    '15. <cmd action="gateway_status" /> — 查询网关状态',
    '16. <cmd action="gateway_pool" /> — 查询代理节点池',
    '',
    '规则：',
    '- 每次回复可以包含多个 <cmd> 标签，也可以混合自然语言说明',
    '- 命令执行结果会以 tool 角色自动回填，你可以根据结果继续分析或执行下一步',
    '- 完成所有操作后输出 <done/> 并附上简短中文总结',
    '- 仅限授权测试场景，拒绝任何非法操作',
    '- 保持简洁，只在必要时输出说明性文字',
    '- 不要在对话中贴大段代码，用 <cmd> 标签让前端执行',
    '- 如果用户意图不明确，先简短询问再执行',
  ].join('\n');
}

// ============ 快捷指令（纯人工，无需 AI） ============
interface QuickAction {
  label: string;
  cmd: () => Promise<string>;
}

// ============ 主组件 ============
export function GongfangAiSidebar() {
  const [conv, setConv] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  // 模型选择
  const [profiles, setProfiles] = useState<AiProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);

  // 流式状态
  const historyRef = useRef<{ role: string; content: string }[]>([]);
  const bufRef = useRef('');
  const assistantIdRef = useRef<string | null>(null);
  const reqRef = useRef<string | null>(null);
  const cancelRef = useRef(false);
  const resolveRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const SYSTEM_PROMPT = useMemo(() => buildSystemPrompt(), []);

  const configuredProfiles = profiles.filter((p) => p.api_key && p.api_key.trim());
  const activeProfile = configuredProfiles.find((p) => p.id === activeProfileId) || null;

  // 加载全局模型档案
  useEffect(() => {
    hostApi.invoke<{ profiles: AiProfile[]; active?: string }>('ai_get_profiles')
      .then((data) => {
        setProfiles(data.profiles || []);
        // 自动选中 active 或第一个已配置的
        const configured = (data.profiles || []).filter((p) => p.api_key && p.api_key.trim());
        if (data.active && configured.find((p) => p.id === data.active)) {
          setActiveProfileId(data.active);
        } else if (configured.length > 0) {
          setActiveProfileId(configured[0].id);
        }
      })
      .catch(() => {});
  }, []);

  // 流式事件监听（按 requestId 路由）
  useEffect(() => {
    let cancelled = false;
    const unlistens: Array<() => void> = [];
    const append = () => {
      const id = assistantIdRef.current;
      if (id) {
        const { cleaned } = parseCmds(bufRef.current);
        setConv((prev) => prev.map((m) => (m.id === id ? { ...m, content: cleaned } : m)));
      }
    };
    const finish = (err?: string) => {
      reqRef.current = null;
      const id = assistantIdRef.current;
      if (id) {
        if (err) {
          setConv((prev) => prev.map((m) => (m.id === id ? { ...m, content: (m.content ? m.content + '\n' : '') + '⚠ ' + err, error: true, streaming: false } : m)));
        } else {
          setConv((prev) => prev.map((m) => (m.id === id ? { ...m, streaming: false } : m)));
        }
      }
      if (resolveRef.current) {
        const r = resolveRef.current;
        resolveRef.current = null;
        r();
      }
    };
    (async () => {
      const u1 = await hostApi.listen<{ requestId: string; delta: string }>('ai-delta', (e) => {
        if (e.payload.requestId === reqRef.current) { bufRef.current += e.payload.delta; append(); }
      });
      const u2 = await hostApi.listen<{ requestId: string }>('ai-done', (e) => {
        if (e.payload.requestId === reqRef.current) finish();
      });
      const u3 = await hostApi.listen<{ requestId: string; error: string }>('ai-error', (e) => {
        if (e.payload.requestId === reqRef.current) finish(e.payload.error);
      });
      if (cancelled) { u1(); u2(); u3(); return; }
      unlistens.push(u1, u2, u3);
    })();
    return () => { cancelled = true; unlistens.forEach((u) => u()); };
  }, []);

  // 自动滚动
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conv]);

  // 输入框自适应高度
  const autoResize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const cs = getComputedStyle(el);
    const lh = parseInt(cs.lineHeight) || 18;
    const pad = parseInt(cs.paddingTop) + parseInt(cs.paddingBottom);
    const maxH = lh * 4 + pad;
    el.style.height = Math.min(el.scrollHeight, maxH) + 'px';
    el.style.overflowY = el.scrollHeight > maxH ? 'auto' : 'hidden';
  }, []);
  useEffect(() => { autoResize(); }, [input, autoResize]);

  // 调用 AI（流式），返回时 AI 已完成输出
  const callChat = useCallback((messages: { role: string; content: string }[]) => {
    return new Promise<void>((resolve) => {
      const reqId = 'gf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      reqRef.current = reqId;
      resolveRef.current = resolve;
      bufRef.current = '';
      hostApi.invoke('ai_chat', { requestId: reqId, messages, profileId: activeProfileId })
        .catch((e: any) => {
          bufRef.current += '\n⚠ ' + String(e);
          reqRef.current = null;
          resolveRef.current = null;
          resolve();
        });
    });
  }, [activeProfileId]);

  // 取消当前运行
  const cancelRun = useCallback(() => {
    cancelRef.current = true;
    reqRef.current = null;
    resolveRef.current?.();
    resolveRef.current = null;
    setBusy(false);
    setConv((prev) => [...prev, { id: 'c_' + Date.now().toString(36), role: 'assistant', content: '⛔ 已取消' }]);
  }, []);

  // 发送消息 + agent 循环
  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (!activeProfileId) {
      setConv((prev) => [...prev, { id: 'h_' + Date.now().toString(36), role: 'assistant', content: '⚠ 尚未配置可用模型，请到「全局设置 → 模型」添加并填写 API Key。', error: true }]);
      return;
    }

    cancelRef.current = false;
    setBusy(true);
    setInput('');

    const uid = 'u_' + Date.now().toString(36);
    setConv((prev) => [...prev, { id: uid, role: 'user', content: text }]);
    historyRef.current.push({ role: 'user', content: text });

    dispatchAudit('AI 对话', text.slice(0, 60), 'info');

    // agent 循环：AI 输出 → 解析 <cmd> → 执行 → 回填结果 → 继续
    let loopGuard = 0;
    while (loopGuard < 8 && !cancelRef.current) {
      loopGuard++;
      const aid = 'a_' + Date.now().toString(36) + loopGuard;
      assistantIdRef.current = aid;
      bufRef.current = '';
      setConv((prev) => [...prev, { id: aid, role: 'assistant', content: '', streaming: true }]);

      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...historyRef.current,
      ];
      await callChat(messages);

      if (cancelRef.current) break;

      const rawOutput = bufRef.current;
      const { cmds, cleaned } = parseCmds(rawOutput);

      // 更新显示（去掉 cmd 标签后的纯文本）
      setConv((prev) => prev.map((m) => (m.id === aid ? { ...m, content: cleaned || '（执行指令中...）', streaming: false } : m)));
      historyRef.current.push({ role: 'assistant', content: rawOutput });

      // 无命令 → 检查 <done/>
      if (cmds.length === 0) {
        break;
      }

      // 执行所有命令，收集结果
      for (const cmd of cmds) {
        if (cancelRef.current) break;
        const result = await executeCmd(cmd);
        const tid = 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
        setConv((prev) => [...prev, { id: tid, role: 'tool', content: `[${actionLabel(cmd.action, cmd.attrs)}]\n${result}` }]);
        historyRef.current.push({ role: 'tool', content: `命令 ${cmd.action} 执行结果:\n${result}` });
      }
    }

    setBusy(false);
    assistantIdRef.current = null;
  }, [input, busy, activeProfileId, SYSTEM_PROMPT, callChat]);

  // 快捷指令（纯人工，直接执行，不走 AI）
  const runQuickAction = useCallback(async (label: string, fn: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    const uid = 'q_' + Date.now().toString(36);
    setConv((prev) => [...prev, { id: uid, role: 'user', content: `[快捷] ${label}` }]);
    dispatchAudit('快捷指令', label, 'info');
    try {
      const result = await fn();
      const tid = 'qt_' + Date.now().toString(36);
      setConv((prev) => [...prev, { id: tid, role: 'tool', content: result }]);
      dispatchAudit('快捷指令', label, 'success', result.slice(0, 120));
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      const tid = 'qe_' + Date.now().toString(36);
      setConv((prev) => [...prev, { id: tid, role: 'tool', content: `⚠ ${msg}`, error: true }]);
      dispatchAudit('快捷指令', label, 'error', msg.slice(0, 120));
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const clearChat = useCallback(() => {
    setConv([]);
    historyRef.current = [];
  }, []);

  // 快捷指令定义
  const quickActions: QuickAction[] = useMemo(() => [
    {
      label: '状态',
      fn: async () => {
        const r = await tauriInvoke('gongfang_status');
        return JSON.stringify(r, null, 2);
      },
    },
    {
      label: '扫描',
      fn: async () => {
        const host = prompt('输入扫描目标主机（如 127.0.0.1）');
        if (!host) return '已取消';
        const r = await tauriInvoke('gongfang_scan', { host });
        const openCount = (r as any)?.open_ports?.length ?? 0;
        return `扫描 ${host}: ${openCount} 个开放端口\n${JSON.stringify(r, null, 2)}`;
      },
    },
    {
      label: 'WAF',
      fn: async () => {
        const url = prompt('输入目标 URL（如 https://example.com）');
        if (!url) return '已取消';
        const r = await tauriInvoke('gongfang_waf_detect', { url });
        return JSON.stringify(r, null, 2);
      },
    },
    {
      label: '适应度',
      fn: async () => {
        const r = await tauriInvoke('gongfang_fitness');
        return JSON.stringify(r, null, 2);
      },
    },
    {
      label: '网关',
      fn: async () => {
        const r = await tauriInvoke('gongfang_gateway_status');
        return JSON.stringify(r, null, 2);
      },
    },
  ], []);

  return (
    <div className="flex-1 flex flex-col min-h-0 -mx-4 -mb-2">
      {/* 头部：标题 + 模型选择 */}
      <div className="shrink-0 flex items-center gap-1.5 px-3 py-2 border-b border-black/5 dark:border-stone-700/50">
        <span className="text-xs font-semibold text-[var(--element-bg)] shrink-0">AI 指挥官</span>
        <span className="flex-1" />
        {configuredProfiles.length === 0 ? (
          <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-600 dark:text-amber-400 truncate max-w-[100px]" title="尚未配置可用模型">未配置模型</span>
        ) : modelOpen ? (
          <div className="absolute z-30 mt-1 right-2 top-8 w-52 rounded-lg border border-black/10 dark:border-stone-700/50 bg-white dark:bg-stone-800 shadow-lg max-h-48 overflow-auto py-1">
            {configuredProfiles.map((p) => (
              <button
                key={p.id}
                onClick={() => { setActiveProfileId(p.id); setModelOpen(false); }}
                className={`block w-full text-left px-2.5 py-1.5 text-[11px] hover:bg-black/5 dark:hover:bg-white/5 ${p.id === activeProfileId ? 'text-[var(--element-bg)] font-medium' : 'text-neutral-600 dark:text-stone-300'}`}
              >
                {p.name || p.model || '未命名'} · {p.model || p.base_url}
              </button>
            ))}
          </div>
        ) : (
          <button
            onClick={() => setModelOpen(true)}
            title="选择模型"
            className="btn-press text-[10px] text-neutral-500 dark:text-stone-400 hover:text-neutral-700 dark:hover:text-stone-200 truncate max-w-[100px]"
          >
            {activeProfile ? (activeProfile.name || activeProfile.model) : '选择模型'} ▾
          </button>
        )}
        <button
          onClick={clearChat}
          title="清空对话"
          className="btn-press w-6 h-6 flex items-center justify-center rounded text-neutral-400 hover:text-neutral-600 dark:hover:text-stone-300 hover:bg-black/5 dark:hover:bg-white/5 shrink-0"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
        </button>
      </div>

      {/* 快捷指令行 */}
      <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 border-b border-black/5 dark:border-stone-700/50 overflow-x-auto">
        {quickActions.map((qa) => (
          <button
            key={qa.label}
            onClick={() => runQuickAction(qa.label, qa.fn)}
            disabled={busy}
            className="btn-press shrink-0 px-2 py-0.5 rounded text-[10px] bg-black/[0.04] dark:bg-white/[0.05] text-neutral-600 dark:text-stone-300 border border-black/5 dark:border-stone-700/50 hover:bg-black/[0.08] dark:hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {qa.label}
          </button>
        ))}
      </div>

      {/* 消息列表 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 px-3 py-2 space-y-2">
        {conv.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center text-neutral-400 dark:text-stone-500 gap-1.5 px-2">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-50">
              <path d="M12 2a10 10 0 0 0-10 10 10 10 0 0 0 10 10 10 10 0 0 0 10-10 10 10 0 0 0-10-10z"/>
              <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
              <line x1="9" y1="9" x2="9.01" y2="9"/>
              <line x1="15" y1="9" x2="15.01" y2="9"/>
            </svg>
            <div className="text-[11px] font-medium">AI 指挥官</div>
            <div className="text-[10px] max-w-[180px] leading-relaxed">用自然语言指挥五大框架，或点击上方快捷指令直接操作</div>
          </div>
        ) : conv.map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div className={`max-w-[95%] rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed ${
              m.role === 'user'
                ? 'element-primary text-white'
                : m.role === 'tool'
                ? 'bg-neutral-200/60 dark:bg-stone-700/60 text-neutral-500 dark:text-stone-400 font-mono text-[10px] max-h-32 overflow-y-auto'
                : m.error
                ? 'bg-red-500/10 text-red-500 dark:text-red-400'
                : 'bg-white dark:bg-stone-800 border border-black/5 dark:border-stone-700/50 text-[var(--element-bg)]'
            }`}>
              {m.streaming && <span className="inline-block w-1 h-3 ml-0.5 align-middle bg-[var(--element-bg)] animate-pulse" />}
              <span className="whitespace-pre-wrap break-words">{m.content}</span>
            </div>
          </div>
        ))}
      </div>

      {/* 输入区 */}
      <div className="shrink-0 px-2 py-1.5 border-t border-black/5 dark:border-stone-700/50">
        <div className="flex items-end gap-1.5">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="输入指令，如「扫描 127.0.0.1」..."
            className="flex-1 resize-none px-2 py-1.5 rounded-lg text-[11px] bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)] placeholder:text-neutral-400 outline-none focus:ring-1 focus:ring-[var(--element-bg)] leading-relaxed"
          />
          <button
            onClick={busy ? cancelRun : sendMessage}
            disabled={busy ? false : !input.trim()}
            className={`btn-press shrink-0 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              busy
                ? 'bg-red-500/90 text-white hover:bg-red-500'
                : 'element-primary text-white hover:bg-[var(--element-hover)]'
            }`}
          >
            {busy ? '⛔' : '发送'}
          </button>
        </div>
      </div>
    </div>
  );
}
