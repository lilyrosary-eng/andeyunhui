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
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { invoke: <U = unknown>(c: string, a?: Record<string, unknown>) => Promise<U> };
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
        // 支持 <cmd action="inject" cmd="Focus" url="https://..." />
        //       <cmd action="inject" cmd="Bypass" challenge="captcha" />
        //       <cmd action="inject" cmd="Pause" /> / <cmd action="inject" cmd="Resume" />
        let cmdObj: unknown;
        const cmdName = attrs.cmd || 'Focus';
        if (cmdName === 'Focus' && attrs.url) {
          cmdObj = { Focus: { url: attrs.url } };
        } else if (cmdName === 'Bypass' && attrs.challenge) {
          cmdObj = { Bypass: { challenge: attrs.challenge } };
        } else {
          cmdObj = cmdName;
        }
        await tauriInvoke('gongfang_inject', { cmd: cmdObj });
        result = `已注入指令: ${cmdName}${attrs.url ? ` (url=${attrs.url})` : ''}${attrs.challenge ? ` (challenge=${attrs.challenge})` : ''}`;
        break;
      }
      case 'fetch': {
        // <cmd action="fetch" url="https://..." /> — 实际爬取 URL，返回页面内容+标题+链接
        const r = await tauriInvoke<any>('gongfang_fetch', { url: attrs.url });
        if (r.error) {
          result = `爬取失败: ${r.error}`;
        } else {
          const linksList = (r.links || []).slice(0, 10).join('\n  ');
          result = [
            `✅ 爬取成功: ${r.url}`,
            `- 状态码: ${r.status}`,
            `- 内容类型: ${r.content_type || '未知'}`,
            `- 内容长度: ${r.content_length} 字节`,
            `- 页面标题: ${r.title || '无'}`,
            `- 耗时: ${r.duration_ms}ms`,
            `- 发现链接 (${r.links?.length ?? 0} 个):`,
            `  ${linksList}${r.links?.length > 10 ? '\n  ...' : ''}`,
          ].join('\n');
        }
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
      case 'wait': {
        // <cmd action="wait" seconds="3" /> — 等待 N 秒（让爬虫运行后再查状态）
        const sec = Math.min(Math.max(parseInt(attrs.seconds || '2', 10), 1), 15);
        await new Promise((r) => setTimeout(r, sec * 1000));
        result = `已等待 ${sec} 秒`;
        break;
      }
      case 'targets': {
        const r = await tauriInvoke('gongfang_target_list');
        result = `共 ${(r as any[])?.length ?? 0} 个目标\n${JSON.stringify(r, null, 2)}`;
        break;
      }
      case 'metrics': {
        const r = await tauriInvoke('gongfang_metrics_history');
        const arr = (r as any[]) ?? [];
        const last = arr[arr.length - 1];
        result = `共 ${arr.length} 个指标点${last ? `\n最新: reward=${last.reward} err=${(last.error_rate * 100).toFixed(1)}% qps=${last.qps} phase=${last.phase}` : ''}`;
        break;
      }
      case 'events': {
        const r = await tauriInvoke('gongfang_events_recent');
        const arr = (r as any[]) ?? [];
        result = `共 ${arr.length} 条事件\n${arr.slice(-10).map((e: any) => `[${e.kind}] ${JSON.stringify(e).slice(0, 120)}`).join('\n')}`;
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
    case 'fetch': return `爬取 ${attrs.url || '?'}`;
    case 'waf': return `WAF 检测 ${attrs.url || '?'}`;
    case 'crypto': return `加密识别 (${attrs.hex?.length || 0} 字符)`;
    case 'humanize': return `拟人化 L${attrs.level || '5'}`;
    case 'inject': return `注入 ${attrs.cmd || 'Focus'}`;
    case 'rotate': return `切换出口 ${attrs.mode || 'direct'}`;
    case 'throttle': return `限速 ${attrs.percent || '100'}%`;
    case 'wait': return `等待 ${attrs.seconds || '2'}s`;
    case 'targets': return '查询目标列表';
    case 'metrics': return '查询指标';
    case 'events': return '查询事件流';
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
    '你的核心能力是「对话即攻防」——用户只需用自然语言描述意图，你自动完成全部操作链路。',
    '',
    '## 标准操作流程（SOP）',
    '1. 感知状态：每轮 system 消息末尾自动注入当前内核状态，你无需手动调 status',
    '2. 判断意图：识别用户要做什么（爬取/扫描/检测/逆向/调度）',
    '3. 自动启动：如内核未运行且任务需要内核 → 先 <cmd action="start" />',
    '4. 聚焦目标：如用户给了 URL → <cmd action="inject" cmd="Focus" url="..." />',
    '5. 执行任务：输出对应的 <cmd> 标签',
    '6. 监控反馈：如需观察运行效果 → <cmd action="wait" seconds="3" /> 再看状态',
    '7. 总结收尾：输出 <done/> 并附简短中文总结',
    '',
    '## 可用命令（通过 <cmd> 标签输出，前端自动执行并回填结果）',
    '',
    '### 内核控制',
    '| 命令 | 格式 | 说明 |',
    '|------|------|------|',
    '| 启动 | `<cmd action="start" />` | 启动双轨制内核（爬取前必须先启动） |',
    '| 停止 | `<cmd action="stop" />` | 停止内核 |',
    '| 聚焦 | `<cmd action="inject" cmd="Focus" url="https://目标URL" />` | 让爬虫聚焦某个 URL |',
    '| 绕过 | `<cmd action="inject" cmd="Bypass" challenge="验证码类型" />` | 绕过反爬挑战 |',
    '| 暂停 | `<cmd action="inject" cmd="Pause" />` | 暂停内核 |',
    '| 恢复 | `<cmd action="inject" cmd="Resume" />` | 恢复内核 |',
    '',
    '### 侦察扫描',
    '| 命令 | 格式 | 说明 |',
    '|------|------|------|',
    '| 实际爬取 | `<cmd action="fetch" url="https://目标URL" />` | 发 HTTP GET，返回页面内容+标题+链接 |',
    '| 端口扫描 | `<cmd action="scan" host="127.0.0.1" ports="80,443" />` | ports 可选 |',
    '| WAF 检测 | `<cmd action="waf" url="https://目标URL" />` | 检测目标 WAF |',
    '',
    '### 逆向分析',
    '| 命令 | 格式 | 说明 |',
    '|------|------|------|',
    '| 加密识别 | `<cmd action="crypto" hex="6e3a5f2c..." />` | 识别加密算法 |',
    '| 符号查询 | `<cmd action="symbols" url="可选" />` | 查询已学习符号 |',
    '',
    '### 监控反馈',
    '| 命令 | 格式 | 说明 |',
    '|------|------|------|',
    '| 等待 | `<cmd action="wait" seconds="3" />` | 等待 N 秒（1-15s，让爬虫运行后再看状态） |',
    '| 指标 | `<cmd action="metrics" />` | 查询最近时序指标 |',
    '| 事件 | `<cmd action="events" />` | 查询最近事件流 |',
    '| 目标列表 | `<cmd action="targets" />` | 查询目标工作区 |',
    '',
    '### 自动化与网关',
    '| 命令 | 格式 | 说明 |',
    '|------|------|------|',
    '| 拟人化 | `<cmd action="humanize" level="5" />` | 0机械-10疲劳 |',
    '| 适应度 | `<cmd action="fitness" />` | 查询模板适应度 |',
    '| 热迁移 | `<cmd action="migrate" />` | 切换到最优模板 |',
    '| 重置 | `<cmd action="reset" />` | 重置适应度 |',
    '| 切换出口 | `<cmd action="rotate" mode="direct\|proxy\|stealth" />` | 切换流量模式 |',
    '| 限速 | `<cmd action="throttle" percent="50" />` | 调整带宽上限 |',
    '| 网关状态 | `<cmd action="gateway_status" />` | 查询网关状态 |',
    '| 节点池 | `<cmd action="gateway_pool" />` | 查询代理节点池 |',
    '',
    '## 执行规则',
    '- 每次回复可包含多个 <cmd> 标签，混合自然语言说明',
    '- 命令执行结果会以 tool 角色自动回填，你根据结果继续分析或执行下一步',
    '- 完成所有操作后输出 <done/> 并附简短中文总结',
    '- 如果用户意图不明确（如没给 URL），先简短询问再执行',
    '- 仅限授权测试场景，拒绝非法操作',
    '- 保持简洁，不要贴大段代码',
    '- 优先自动完成全链路，不要让用户手动操作',
    '',
    '## 示例（few-shot）',
    '',
    '### 示例 1：爬取网站（全链路自动 + 实际数据）',
    '用户：爬取 https://example.com 的页面资源',
    '助手：好的，我先实际爬取页面看看内容，再启动内核持续跟踪。',
    '<cmd action="fetch" url="https://example.com" />',
    '（工具结果回填：状态=200, 标题=Example Domain, 5个链接, 1256字节）',
    '助手：页面爬取成功！标题: Example Domain，发现 5 个链接。现在启动内核持续跟踪。',
    '<cmd action="start" />',
    '<cmd action="inject" cmd="Focus" url="https://example.com" />',
    '（工具结果回填：内核已启动 + 已聚焦）',
    '助手：内核已启动并聚焦到 https://example.com。',
    '<done/>',
    '',
    '### 示例 2：扫描目标',
    '用户：帮我扫描 192.168.1.1 开了哪些端口',
    '助手：<cmd action="scan" host="192.168.1.1" />',
    '（工具结果回填后）',
    '助手：扫描完成，发现 N 个开放端口。建议进一步检测 WAF。',
    '<done/>',
    '',
    '### 示例 3：意图不明确',
    '用户：爬取我的网站',
    '助手：请提供您的网站 URL，例如 `https://example.com`，我好启动爬虫聚焦目标。',
    '',
    '### 示例 4：复合任务',
    '用户：扫描 10.0.0.1 然后检测 WAF',
    '助手：<cmd action="scan" host="10.0.0.1" />',
    '（工具结果回填后）',
    '助手：扫描完成。现在检测 WAF。',
    '<cmd action="waf" url="http://10.0.0.1" />',
    '（工具结果回填后）',
    '助手：WAF 检测完成。以下是汇总结果。',
    '<done/>',
    '',
    '### 示例 5：监控运行',
    '用户：爬虫跑得怎么样了？',
    '助手：（看到状态注入：running=true, reward=42, err=5%）',
    '内核运行正常，累计奖励 42，错误率 5%。让我查看最近指标。',
    '<cmd action="metrics" />',
    '（工具结果回填后）',
    '助手：最近 5 分钟指标平稳，无异常。',
    '<done/>',
    '',
    '### 示例 6：渗透测试全流程',
    '用户：对 10.0.0.5 做一次渗透侦察',
    '助手：好的，我来做端口扫描 + WAF 检测。',
    '<cmd action="scan" host="10.0.0.5" />',
    '（工具结果回填：发现 22/80/443 开放）',
    '助手：扫描到 3 个开放端口。现在检测 80 端口的 WAF。',
    '<cmd action="waf" url="http://10.0.0.5" />',
    '（工具结果回填：无 WAF）',
    '助手：渗透侦察完成：',
    '- 开放端口：22(SSH)、80(HTTP)、443(HTTPS)',
    '- WAF：未检测到',
    '- 建议：80 端口可直接测试，443 需 TLS 指纹伪装',
    '<done/>',
    '',
    '### 示例 7：逆向分析',
    '用户：帮我识别这段加密数据 6e3a5f2c8b1e4a7f',
    '助手：<cmd action="crypto" hex="6e3a5f2c8b1e4a7f" />',
    '（工具结果回填：block_size=16, entropy=3.2, matched=AES-ECB）',
    '助手：加密分析完成：',
    '- 分块大小：16 字节（AES 分组）',
    '- 熵值：3.2（偏低，可能 ECB 模式）',
    '- 匹配算法：AES-ECB（置信度 85%）',
    '- 建议：ECB 模式有模式泄露，可利用分组重放',
    '<done/>',
    '',
    '### 示例 8：自动化模板优化',
    '用户：优化一下爬虫模板',
    '助手：好的，我来查看当前适应度并优化。',
    '<cmd action="fitness" />',
    '（工具结果回填：模板A成功率80%，模板B成功率65%）',
    '助手：当前模板A成功率最高（80%）。执行热迁移切换到最优模板。',
    '<cmd action="migrate" />',
    '（工具结果回填：已迁移到模板A）',
    '助手：已切换到最优模板。设置拟人化等级为 5（中等疲劳模拟）。',
    '<cmd action="humanize" level="5" />',
    '（工具结果回填：已设置）',
    '助手：模板优化完成：已迁移到成功率最高的模板 + 拟人化等级 5。',
    '<done/>',
    '',
    '### 示例 9：网关流量调度',
    '用户：切换到隐身模式，限速 30%',
    '助手：<cmd action="rotate" mode="stealth" />',
    '（工具结果回填：已切换到隐身模式）',
    '助手：<cmd action="throttle" percent="30" />',
    '（工具结果回填：已限速 30%）',
    '助手：已切换到隐身模式 + 限速 30%。让我确认网关状态。',
    '<cmd action="gateway_status" />',
    '（工具结果回填：routing=stealth, bandwidth=0.3）',
    '助手：网关调度完成：隐身模式 + 30% 带宽，请求熵已提升。',
    '<done/>',
    '',
    '### 示例 10：停止内核',
    '用户：停下来吧',
    '助手：（看到状态注入：running=true）',
    '<cmd action="stop" />',
    '（工具结果回填：内核已停止）',
    '助手：内核已停止，所有任务已终止。',
    '<done/>',
  ].join('\n');
}

// ============ 快捷指令（纯人工，无需 AI） ============
interface QuickAction {
  label: string;
  fn: () => Promise<string>;
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
    // 最多 8 轮（支持 wait + 多步任务），单次 AI 调用 60s 超时，连续 2 轮无命令自动终止
    let loopGuard = 0;
    let noCmdRounds = 0;
    while (loopGuard < 8 && !cancelRef.current) {
      loopGuard++;
      const aid = 'a_' + Date.now().toString(36) + loopGuard;
      assistantIdRef.current = aid;
      bufRef.current = '';
      setConv((prev) => [...prev, { id: aid, role: 'assistant', content: '', streaming: true }]);

      // 自动状态注入：每轮查询内核状态并注入到 system 消息（AI 无需手动调 status 即可感知当前状态）
      let statusSnapshot = '';
      try {
        const s = await tauriInvoke<any>('gongfang_status');
        const strat = s.strategy;
        statusSnapshot = [
          '',
          '## 当前内核状态（每轮自动注入，无需手动查询）',
          `- 运行状态: ${s.running ? '✅ 运行中' : '⏹ 未启动'}`,
          `- 阶段: ${strat?.phase ?? 'Idle'}`,
          `- QPS: ${strat?.qps ?? 0}`,
          `- 聚焦目标: ${strat?.focus_url ?? '未设置'}`,
          `- 累计奖励: ${s.reward}`,
          `- 错误率: ${((s.error_rate ?? 0) * 100).toFixed(1)}%`,
          `- 策略代次: #${strat?.generation ?? 0}`,
          s.running ? '' : '⚠ 内核未启动，如需爬取/扫描请先 <cmd action="start" />',
        ].join('\n');
      } catch {
        statusSnapshot = '\n## 当前内核状态\n内核查询失败（可能未启动）';
      }

      const messages = [
        { role: 'system', content: SYSTEM_PROMPT + statusSnapshot },
        ...historyRef.current,
      ];

      // 单次 AI 调用 60s 超时保护（防止本地模型卡死整个循环）
      await Promise.race([
        callChat(messages),
        new Promise<void>((resolve) => setTimeout(() => {
          if (reqRef.current) {
            cancelRef.current = true;
            setConv((prev) => prev.map((m) => (m.id === aid ? { ...m, content: (m.content ? m.content + '\n' : '') + '⚠ AI 响应超时（60s），已自动终止', error: true, streaming: false } : m)));
          }
          resolve();
        }, 60000)),
      ]);

      if (cancelRef.current) break;

      const rawOutput = bufRef.current;
      const { cmds, cleaned } = parseCmds(rawOutput);

      // 更新显示（去掉 cmd 标签后的纯文本）
      setConv((prev) => prev.map((m) => (m.id === aid ? { ...m, content: cleaned || '（执行指令中...）', streaming: false } : m)));
      historyRef.current.push({ role: 'assistant', content: rawOutput });

      // 无命令 → 检查是否连续无命令
      if (cmds.length === 0) {
        noCmdRounds++;
        if (noCmdRounds >= 2) break; // 连续 2 轮无命令，终止
        break; // 无命令说明 AI 在等用户输入或已输出 <done/>
      }
      noCmdRounds = 0;

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
      label: '启动',
      fn: async () => {
        await tauriInvoke('gongfang_start', { profileId: null });
        return '内核已启动（双轨制：控制面 AI 推理 + 数据面 Tick 执行）';
      },
    },
    {
      label: '爬取',
      fn: async () => {
        const url = prompt('输入要爬取的目标 URL（如 https://example.com）');
        if (!url) return '已取消';
        await tauriInvoke('gongfang_start', { profileId: null }).catch(() => {});
        await tauriInvoke('gongfang_inject', { cmd: { Focus: { url } } });
        return `已启动内核并聚焦到 ${url}\n爬虫将以此 URL 为目标开始采集（可在主面板查看实时指标）`;
      },
    },
    {
      label: '停止',
      fn: async () => {
        await tauriInvoke('gongfang_stop');
        return '内核已停止';
      },
    },
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
            placeholder="自然语言指挥，如「爬取 https://example.com」或「扫描 127.0.0.1」..."
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
