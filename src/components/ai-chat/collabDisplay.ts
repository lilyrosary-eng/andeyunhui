// AI 协作成员显示规则：成员名为主，harness 短名 + 模型为副标签。
//
// 「自有 / 外部」描述的是 harness 归属（native 是安得云荟自有，dsh / MCP / CLI / 信箱是外部），
// 但显示模型与否只看「本应用是否确实知道它」：native 与 dsh 的模型由本应用配置；
// MCP / 信箱 / CLI 的模型在对方侧，写出来就是假信息。
import type { CollabAgent } from '@/core/ai/aiCollab';

const HARNESS_LABEL: Record<string, string> = {
  echo: 'Echo',
  native: '安得云荟',
  dsh: 'DeepSeek',
  mcp: 'MCP',
  acp: 'ACP',
  'stream-json': 'CLI',
  mailbox: '.Talk 信箱',
};

export function harnessLabel(harnessId: string): string {
  return HARNESS_LABEL[harnessId] ?? harnessId;
}

export function agentMeta(agent: CollabAgent): string {
  const model = agent.model?.trim();
  return model ? `${harnessLabel(agent.harnessId)} · ${model}` : harnessLabel(agent.harnessId);
}

/** 耗时展示：1.2s / 2m5s；未知返回空串，由调用方决定是否隐藏。 */
export function formatDuration(ms?: number | null): string {
  if (ms == null || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

/** token 展示：1.2k；0/未知返回空串。 */
export function formatTokens(tokens?: number | null): string {
  if (!tokens) return '';
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}
