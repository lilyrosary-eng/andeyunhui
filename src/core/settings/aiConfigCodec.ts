// v2 配置与前端编辑态的编解码。抽成纯函数是为了能单测——
// ModelSettings 里内联编解码时，测试只能整个组件挂载，太重。

export interface CapsUi {
  text: boolean;
  vision: boolean;
  reasoning: boolean;
  embedding: boolean;
  /** 工具/函数调用能力。纯展示维度，不参与路由决策。 */
  tools: boolean;
}

export interface ModelUi {
  id: string;
  model: string;
  label: string;
  caps: CapsUi;
  /** 上下文窗口（输入侧），字符串便于输入。来源：端点自报 / 兜底表 / 用户手填 */
  context_tokens: string;
  /**
   * 模型的**单次最大输出**（能力上限）。与下面的 `max_tokens`（**请求参数**：本次要它产多长）
   * 语义不同，勿混用。同样是 端点自报 / 兜底表 / 用户手填 三者之一。
   */
  max_output_tokens: string;
  temperature: string;
  max_tokens: string;
  top_p: string;
  system_prompt: string;
  thinking: boolean;
  persona_call_me_as: string;
  persona_preset: string;
  persona_style: string;
}

export interface ProviderUi {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  vision_model: string;
  image_model: string;
  tts_model: string;
  last_scanned_at: number | null;
  models: ModelUi[];
}

export interface ConfigUi {
  providers: ProviderUi[];
  selected_provider_id: string | null;
  selected_model_id: string | null;
}

const DEFAULT_TEMPERATURE = 0.3;

const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

function capsFrom(raw: any): CapsUi {
  const c = raw || {};
  return {
    text: c.text !== false,
    vision: c.vision === true,
    reasoning: c.reasoning === true,
    embedding: c.embedding === true,
    tools: c.tools === true,
  };
}

/** 数值字段 → 输入框字符串（空/无效 → ''）。 */
const numStr = (v: unknown): string => {
  const n = numOrNull(v);
  return n === null ? '' : String(n);
};

function modelFrom(raw: any): ModelUi {
  const o = raw?.overrides || {};
  return {
    id: s(raw?.id),
    model: s(raw?.model),
    label: s(raw?.label),
    caps: capsFrom(raw?.caps),
    context_tokens: numStr(raw?.context_tokens),
    max_output_tokens: numStr(raw?.max_output_tokens),
    temperature: numStr(o.temperature),
    max_tokens: numStr(o.max_tokens),
    top_p: numStr(o.top_p),
    system_prompt: s(o.system_prompt),
    thinking: o.thinking === true,
    persona_call_me_as: s(o.persona_call_me_as),
    persona_preset: s(o.persona_preset),
    persona_style: s(o.persona_style),
  };
}

function providerFrom(raw: any): ProviderUi {
  return {
    id: s(raw?.id),
    name: s(raw?.name),
    base_url: s(raw?.base_url),
    api_key: typeof raw?.api_key === 'string' ? raw.api_key : '',
    vision_model: s(raw?.vision_model),
    image_model: s(raw?.image_model),
    tts_model: s(raw?.tts_model),
    last_scanned_at: numOrNull(raw?.last_scanned_at),
    models: Array.isArray(raw?.models) ? raw.models.map(modelFrom) : [],
  };
}

export function fromConfig(payload: any): ConfigUi {
  return {
    providers: Array.isArray(payload?.providers) ? payload.providers.map(providerFrom) : [],
    selected_provider_id: payload?.selection?.provider_id ?? null,
    selected_model_id: payload?.selection?.model_id ?? null,
  };
}

function toModel(m: ModelUi) {
  const t = numOrNull(m.temperature);
  const mt = numOrNull(m.max_tokens);
  const tp = numOrNull(m.top_p);
  const ctx = numOrNull(m.context_tokens);
  const mot = numOrNull(m.max_output_tokens);
  return {
    id: m.id,
    model: m.model,
    label: s(m.label) || null,
    caps: m.caps,
    context_tokens: ctx === null ? null : Math.trunc(ctx),
    max_output_tokens: mot === null ? null : Math.max(1, Math.trunc(mot)),
    overrides: {
      // 空温度回落 0.3：后端 resolve_target 也这么做，前端保持一致以便所见即所得
      temperature: t === null ? DEFAULT_TEMPERATURE : t,
      // 0 或负数的 max_tokens 会被后端当成"不限制"还是"0 输出"？不明确，
      // 统一归一到 1，避免用户输入 0 时请求被拒
      max_tokens: mt === null ? null : Math.max(1, Math.trunc(mt)),
      top_p: tp === null ? null : Math.min(1, Math.max(0, tp)),
      system_prompt: s(m.system_prompt) || null,
      thinking: m.thinking ? true : null,
      persona_call_me_as: s(m.persona_call_me_as) || null,
      persona_preset: s(m.persona_preset) || null,
      persona_style: s(m.persona_style) || null,
      max_context_tokens: null,
    },
  };
}

export function toConfig(ui: ConfigUi): any {
  return {
    providers: ui.providers.map((p) => ({
      id: p.id,
      name: s(p.name),
      base_url: s(p.base_url),
      api_key: p.api_key,
      vision_model: s(p.vision_model) || null,
      image_model: s(p.image_model) || null,
      tts_model: s(p.tts_model) || null,
      last_scanned_at: p.last_scanned_at,
      models: p.models.map(toModel),
    })),
    selection: {
      provider_id: ui.selected_provider_id,
      model_id: ui.selected_model_id,
    },
  };
}
