/**
 * 能力标签的**唯一**渲染口径（模型行与发现弹窗共用，避免两处各写一套导致不一致）。
 *
 * 语义：文本/视觉/思考/工具是彼此**独立**的能力，可同时成立——旧实现用 `else if`
 * 只出一项，导致「视觉+思考+文本+工具」的模型只显示「文本」。向量模型是另一类
 * （不作为对话模型），单独短路。
 */
import type { CapsUi } from '../aiConfigCodec';

type TFunc = (k: string, vars?: Record<string, string | number>) => string;

export function capTags(caps: CapsUi, t: TFunc): string[] {
  if (caps.embedding) return [t('modelSettings.caps.embedding')];
  const out: string[] = [];
  if (caps.text) out.push(t('modelSettings.caps.text'));
  if (caps.vision) out.push(t('modelSettings.caps.vision'));
  if (caps.reasoning) out.push(t('modelSettings.caps.reasoning'));
  if (caps.tools) out.push(t('modelSettings.caps.tools'));
  return out;
}
