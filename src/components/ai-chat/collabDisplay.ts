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
