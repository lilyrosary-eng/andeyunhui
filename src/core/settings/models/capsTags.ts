/**
 * 能力标签的**唯一**渲染口径（模型行与发现弹窗共用，避免两处各写一套导致不一致）。
 *
 * 语义：文本/视觉/思考/工具是彼此**独立**的能力，可同时成立——旧实现用 `else if`
 * 只出一项，导致「视觉+思考+文本+工具」的模型只显示「文本」。向量模型是另一类
 * （不作为对话模型），单独短路。
 *
 * ## 为什么要带来源后缀（2026-10-22 扩展）
 * 名字启发式会给**所有**文本模型标上「工具」——这正是用户看到的"所有模型都是
 * 文本+工具两个标签"。标签本身并不算错（多数 OpenAI 兼容对话模型确实支持 function
 * calling），错在**没有区分"猜的"和"测过的"**。现在：
 *   - `provider` = 端点上报 / 探测确证 →「工具·实测」
 *   - `inferred` = 名字猜的 →「工具·推断」
 *   - `manual`   = 用户手改 →「工具·手填」
 *   - `''`       = 来源不明（改造前老数据）→ **不加后缀**（宁可不标，也不编来源）
 * 用户据此知道哪些标签值得信、哪些点一下「探测能力」就能确证。
 */
import type { CapsUi, CapsSourceUi } from '../aiConfigCodec';

type TFunc = (k: string, vars?: Record<string, string | number>) => string;

/** 单个能力位的标签（带来源后缀）。 */
function tag(labelKey: string, source: CapsSourceUi | '', t: TFunc): string {
  const suffix =
    source === 'provider'
      ? t('modelSettings.caps.sourceProvider')
      : source === 'inferred'
        ? t('modelSettings.caps.sourceInferred')
        : source === 'manual'
          ? t('modelSettings.caps.sourceManual')
          : '';
  return suffix ? `${t(labelKey)}·${suffix}` : t(labelKey);
}

export function capTags(caps: CapsUi, t: TFunc): string[] {
  // 向量模型不是对话模型，单独短路（它没有视觉/工具/文本可谈）
  if (caps.embedding) return [tag('modelSettings.caps.embedding', caps.embedding_source, t)];
  const out: string[] = [];
  if (caps.text) out.push(t('modelSettings.caps.text'));
  // 视觉位带来源后缀：只有 provider（上报/实测）才是「原生看图」的依据，
  // inferred 只是猜测 —— 不加区分会让用户以为它一定能直发图片。
  if (caps.vision) out.push(tag('modelSettings.caps.vision', caps.vision_source, t));
  if (caps.reasoning) out.push(t('modelSettings.caps.reasoning'));
  if (caps.tools) out.push(tag('modelSettings.caps.tools', caps.tools_source, t));
  return out;
}
