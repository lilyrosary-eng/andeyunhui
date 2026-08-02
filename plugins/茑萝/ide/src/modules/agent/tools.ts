// 茑萝 · IDE Agent 工具系统
// 形式化现有 XML 标签工具：每个工具有元数据（名称/描述/只读/破坏性）+ XML 标签模式。
// 新增：spawn_subagent 子代理工具（为子任务起独立 messages[]，仅只读工具，返回摘要）。
// 对齐 learn-coding-agent 工具接口设计 + claw-code tool.rs Trait 概念。

import { getRole } from './subagentRoles';

const hostApi = window.__HOST_API__;

// ===== 工具元数据接口 =====
export interface ToolDef {
  /** 工具名（唯一标识） */
  name: string;
  /** XML 标签名（如 'read', 'write', 'shell'） */
  xmlTag: string;
  /** 人类可读描述（注入 system prompt，告诉 LLM 用法） */
  description: string;
  /** 用法示例（注入 system prompt） */
  usage: string;
  /** 是否只读（不修改文件系统/不执行命令） */
  isReadOnly: boolean;
  /** 是否破坏性（可能造成不可逆更改） */
  isDestructive: boolean;
}

// ===== 内置工具注册表 =====
export const BUILTIN_TOOLS: ToolDef[] = [
  {
    name: 'file_read',
    xmlTag: 'read',
    description: '读取文件内容。路径为项目根的相对路径或绝对路径。',
    usage: '<read path="src/main.ts"/>',
    isReadOnly: true,
    isDestructive: false,
  },
  {
    name: 'file_write',
    xmlTag: 'write',
    description: '写入文件（覆盖整个文件内容）。路径不存在则创建。',
    usage: '<write path="src/new.ts">文件内容…</write>',
    isReadOnly: false,
    isDestructive: true,
  },
  {
    name: 'file_edit',
    xmlTag: 'edit',
    description: '编辑文件：将文件中的 old 文本替换为 new 文本（精确匹配）。',
    usage: '<edit path="src/main.ts"><old>旧代码</old><new>新代码</new></edit>',
    isReadOnly: false,
    isDestructive: true,
  },
  {
    name: 'file_delete',
    xmlTag: 'delete',
    description: '删除文件。',
    usage: '<delete path="src/old.ts"/>',
    isReadOnly: false,
    isDestructive: true,
  },
  {
    name: 'shell',
    xmlTag: 'shell',
    description: '执行 Shell 命令。只读命令（ls/cat/grep/git status 等）在 normal 模式放行；破坏性命令需高危模式。',
    usage: '<shell command="npm run build"/>',
    isReadOnly: false,
    isDestructive: true,
  },
  {
    name: 'grep',
    xmlTag: 'search',
    description: '在项目根下递归搜索文件内容（gitignore 感知）。返回匹配的文件路径、行号、行内容。',
    usage: '<search query="function parseConfig"/>',
    isReadOnly: true,
    isDestructive: false,
  },
  {
    name: 'glob',
    xmlTag: 'glob',
    description: '按文件名模式搜索文件。支持 * 通配符。',
    usage: '<glob pattern="**/*.ts"/>',
    isReadOnly: true,
    isDestructive: false,
  },
  {
    name: 'ast',
    xmlTag: 'ast',
    description: '获取文件的 AST 结构（用于理解代码结构，不做全文读取）。',
    usage: '<ast path="src/main.ts"/>',
    isReadOnly: true,
    isDestructive: false,
  },
  {
    name: 'mcp',
    xmlTag: 'mcp',
    description: '调用 MCP（Model Context Protocol）工具。tool 格式为 "server_id:tool_name"。',
    usage: '<mcp tool="server:tool_name">{\"arg\":\"value\"}</mcp>',
    isReadOnly: false,
    isDestructive: true,
  },
  {
    name: 'rag',
    xmlTag: 'rag',
    description: '对本地知识库做 RAG 语义检索。',
    usage: '<rag query="如何配置数据库连接"/>',
    isReadOnly: true,
    isDestructive: false,
  },
  {
    name: 'plan',
    xmlTag: 'plan',
    description: '制定/更新执行计划。列出步骤，用户确认后逐步执行。',
    usage: '<plan><step>1. 读取配置文件</step><step>2. 修改数据库连接</step><step>3. 运行测试</step></plan>',
    isReadOnly: true,
    isDestructive: false,
  },
  {
    name: 'subagent',
    xmlTag: 'subagent',
    description: '为子任务启动子代理。子代理拥有独立上下文，仅可用只读工具，完成后返回摘要。可选 role 属性加载预设角色（code-reviewer/security-auditor/test-engineer/web-performance-auditor），加载后子代理按角色方法论与输出格式工作。',
    usage: '<subagent task="审查 src/index.tsx 最近改动" role="code-reviewer"/>',
    isReadOnly: true,
    isDestructive: false,
  },
  {
    name: 'done',
    xmlTag: 'done',
    description: '标记任务完成。Agent 循环在遇到 <done/> 后退出。',
    usage: '<done/>',
    isReadOnly: true,
    isDestructive: false,
  },
  {
    name: 'skill',
    xmlTag: 'skill',
    description: '加载指定技能的完整指南到上下文（渐进式披露）。先用系统提示词里的技能索引找到 name，再调用本工具加载全文，按指南执行；不要在未加载全文时臆测技能内容。',
    usage: '<skill name="code-simplification"/>',
    isReadOnly: true,
    isDestructive: false,
  },
];

// ===== 系统提示词生成：工具说明 =====
export function generateToolSystemPrompt(opts?: {
  mcpTools?: { serverId: string; toolName: string; description?: string }[];
  permissionMode?: string;
}): string {
  const lines: string[] = [
    '## 可用工具（通过 XML 标签调用）',
    '',
    '你可以在回复中嵌入以下 XML 标签来调用工具。每个标签会立即执行，结果在下一轮返回。',
    '',
  ];

  for (const t of BUILTIN_TOOLS) {
    const flags = [t.isReadOnly ? '只读' : '写入', t.isDestructive ? '破坏性' : '安全'].join(' / ');
    lines.push(`### <${t.xmlTag}>`);
    lines.push(`${t.description} [${flags}]`);
    lines.push(`用法：${t.usage}`);
    lines.push('');
  }

  // MCP 工具列表
  if (opts?.mcpTools && opts.mcpTools.length > 0) {
    lines.push('### MCP 工具（通过 <mcp tool="server:tool">调用）');
    for (const m of opts.mcpTools) {
      lines.push(`- ${m.serverId}:${m.toolName}${m.description ? ' — ' + m.description : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ===== 子代理运行器 =====
// 为子任务起独立 messages[]，仅只读工具（read/search/glob/ast），返回摘要文本。
// 对齐 learn-coding-agent s04 子代理设计：独立上下文、受限工具集、返回摘要。

export interface SubAgentOptions {
  task: string;
  projectRoot?: string | null;
  profileId?: string | null;
  /** 最大轮次（默认 5） */
  maxRounds?: number;
  /** 父上下文摘要（注入子代理 system prompt，提供任务背景） */
  parentContext?: string;
  /** 预设角色名（code-reviewer / security-auditor / test-engineer / web-performance-auditor）。
   *  命中则把角色 systemPrompt 拼接到基础约束之前，让子代理按角色方法论与输出格式工作。 */
  role?: string | null;
}

export interface SubAgentResult {
  /** 子代理最终输出文本 */
  summary: string;
  /** 执行的轮次 */
  rounds: number;
  /** 是否因轮次上限退出 */
  truncated: boolean;
}

const SUBAGENT_SYSTEM_PROMPT = `你是 IDE 编程助手的子代理，负责独立完成一个子任务并返回摘要。

## 约束
- 你只能使用只读工具：<read path="..."/>、<search query="..."/>、<ast path="..."/>
- 禁止任何写入/编辑/Shell/MCP 操作
- 最多 5 轮交互，务必高效
- 完成后输出 <done/> 并给出简洁摘要

## 输出格式
完成探索后，直接给出任务结论的摘要文本（不需要 XML 标签），然后加 <done/>。`;

export async function runSubAgent(opts: SubAgentOptions): Promise<SubAgentResult> {
  const { task, projectRoot, profileId, maxRounds = 5, parentContext, role } = opts;
  // 角色预设：命中则把角色 systemPrompt 拼接到基础约束之前（角色方法论 + 基础只读约束）
  const rolePrompt = role ? (getRole(role)?.systemPrompt ?? '') : '';
  const systemContent = (rolePrompt ? rolePrompt + '\n\n---\n\n' : '') + SUBAGENT_SYSTEM_PROMPT + (parentContext ? '\n\n## 父任务背景\n' + parentContext : '') + (projectRoot ? '\n\n## 项目根目录\n' + projectRoot : '');
  const messages: { role: string; content: string }[] = [
    { role: 'system', content: systemContent },
    { role: 'user', content: task },
  ];

  for (let round = 0; round < maxRounds; round++) {
    // 调用 ai_chat（流式，收集完整文本）
    const reqId = 'sub_' + Date.now().toString(36) + '_' + round;
    const fullText = await callChatSync(reqId, messages, profileId);
    messages.push({ role: 'assistant', content: fullText });

    // 检查是否完成
    if (/<done\s*\/>/.test(fullText)) {
      return {
        summary: fullText.replace(/<done\s*\/>/g, '').trim(),
        rounds: round + 1,
        truncated: false,
      };
    }

    // 解析只读工具指令并执行
    const reads = parseReadTags(fullText);
    const searches = parseSearchTags(fullText);
    const toolResults: string[] = [];

    for (const path of reads) {
      try {
        const content = await hostApi.invoke<string>('read_text_file', { path });
        const truncated = content.length > 8000 ? content.slice(0, 8000) + '\n…（已截断）' : content;
        toolResults.push(`[read ${path}]\n${truncated}`);
      } catch (e) {
        toolResults.push(`[read ${path}] 错误：${String(e)}`);
      }
    }

    for (const query of searches) {
      try {
        const hits = await hostApi.invoke<{ path: string; line: number; text: string }[]>('search_content', {
          root: projectRoot || '.',
          pattern: query,
          max_results: 20,
        });
        const formatted = hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n');
        toolResults.push(`[search "${query}"]\n${formatted || '无匹配'}`);
      } catch (e) {
        toolResults.push(`[search "${query}"] 错误：${String(e)}`);
      }
    }

    if (toolResults.length === 0) {
      // 没有工具调用也没有 done → 视为完成
      return { summary: fullText.trim(), rounds: round + 1, truncated: false };
    }

    messages.push({ role: 'user', content: '工具结果：\n\n' + toolResults.join('\n\n---\n\n') });
  }

  // 达到轮次上限
  const lastMsg = messages[messages.length - 1];
  return {
    summary: (lastMsg?.content || '').replace(/<[^>]+>/g, '').trim().slice(0, 2000),
    rounds: maxRounds,
    truncated: true,
  };
}

// ===== 辅助：同步调用 ai_chat（收集流式响应）=====
async function callChatSync(
  requestId: string,
  messages: { role: string; content: string }[],
  profileId?: string | null,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    let resolved = false;

    const unlistenDelta = hostApi.listen?.(`ai-delta`, (e: any) => {
      if (e?.payload?.requestId === requestId && e?.payload?.delta) {
        buf += e.payload.delta;
      }
    });

    const unlistenDone = hostApi.listen?.(`ai-done`, (e: any) => {
      if (e?.payload?.requestId === requestId) {
        if (!resolved) { resolved = true; cleanup(); resolve(buf); }
      }
    });

    const unlistenError = hostApi.listen?.(`ai-error`, (e: any) => {
      if (e?.payload?.requestId === requestId) {
        if (!resolved) { resolved = true; cleanup(); reject(new Error(e?.payload?.error || 'AI 调用失败')); }
      }
    });

    function cleanup() {
      try { unlistenDelta?.then?.((u: any) => u?.()); } catch { /* 忽略 */ }
      try { unlistenDone?.then?.((u: any) => u?.()); } catch { /* 忽略 */ }
      try { unlistenError?.then?.((u: any) => u?.()); } catch { /* 忽略 */ }
    }

    // 超时保护（60s）
    const timeout = setTimeout(() => {
      if (!resolved) { resolved = true; cleanup(); resolve(buf || '(超时无响应)'); }
    }, 60_000);

    hostApi.invoke('ai_chat', { requestId, messages, profileId }).catch((e: any) => {
      if (!resolved) { resolved = true; cleanup(); clearTimeout(timeout); reject(e); }
    });
  });
}

// ===== 辅助：解析只读工具标签 =====
function parseReadTags(raw: string): string[] {
  const re = /<read\b[^>]*\bpath=(?:"([^"]*)"|'([^']*)')[^>]*\/?>/g;
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) paths.push(m[1] || m[2] || '');
  return paths;
}

function parseSearchTags(raw: string): string[] {
  const re = /<(?:search|rag)\b[^>]*\bquery=(?:"([^"]*)"|'([^']*)')[^>]*\/?>/g;
  const queries: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) queries.push(m[1] || m[2] || '');
  return queries;
}
