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
  if (caps.vision) {
    // 视觉位带来源后缀。只有 `provider`（供应商权威上报 / 实测探测确证）才是
    // 「对话模型原生看图」这条分支的依据；`inferred`（名称推断）只是猜测。
    // 不加区分的话，用户看到「视觉」会以为一定能直发 —— 而实际会被路由到
    // analyze_image 工具那条老路径，现象上就是「它明明标了视觉却好像没看图」。
    //
    // 来源不明（''，改造前的老数据）**不加后缀**：宁可不标，也不要给它编一个
    // 来源 —— 那正是我们花力气区分来源要避免的事。
    const suffix =
      caps.vision_source === 'provider'
        ? t('modelSettings.caps.sourceProvider')
        : caps.vision_source === 'inferred'
          ? t('modelSettings.caps.sourceInferred')
          : caps.vision_source === 'manual'
            ? t('modelSettings.caps.sourceManual')
            : '';
    out.push(suffix ? `${t('modelSettings.caps.vision')}·${suffix}` : t('modelSettings.caps.vision'));
  }
  if (caps.reasoning) out.push(t('modelSettings.caps.reasoning'));
  if (caps.tools) out.push(t('modelSettings.caps.tools'));
  return out;
}
