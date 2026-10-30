// 消息高度估算：虚拟列表里未渲染项只能估算，估算越准，导轨跳转越不容易“先跳到远处再修正”。
// 只用于未测量项；已渲染项的高度由 measureElement 实测覆盖。

export interface EstimateMessage {
  role: string;
  content?: string;
  reasoning?: string;
  images?: unknown[];
  attachments?: unknown[];
  agentSteps?: unknown[];
}

export function estimateMessageHeight(m: EstimateMessage | undefined): number {
  if (!m) return 160;
  const chars = (m.content?.length ?? 0) + Math.round((m.reasoning?.length ?? 0) * 0.5);
  const isUser = m.role === 'user';
  // 中文 12~14px、容器宽度 700~900px 时，一行约 28~36 字，行高约 21px ⇒ 0.6~0.8px/字。
  // 用户气泡更窄（78%），同样字数更高。
  let h = isUser ? 40 + chars * 0.82 : 90 + chars * 0.6;
  if (m.images?.length) h += Math.min(420, 170 * m.images.length);
  if (m.attachments?.length) h += 30;
  if (m.agentSteps?.length) h += 36;
  return Math.max(isUser ? 48 : 96, Math.min(2400, h));
}
