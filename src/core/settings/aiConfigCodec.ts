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

/** 一个推理档位（与 Rust reasoning::EffortOption 对齐）。 */
export interface EffortOptionUi {
  id: string;
  name: string;
}

/**
 * 模型可用的推理档位集合（与 Rust reasoning::ReasoningSpec 对齐）。
 * 取值**只来自**供应商上报或内置保守表——不在此处臆造，发错值会被端点 400。
 */
export interface ReasoningSpecUi {
  efforts: EffortOptionUi[];
  /** 默认档位（可能为空）。 */
  default: string | null;
  /** true = 供应商上报；false = 内置兜底（UI 据此提示来源）。 */
  from_provider: boolean;
}

/** 空档位集合（工厂而非共享常量，避免被下游误改）。 */
export function emptyReasoning(): ReasoningSpecUi {
  return { efforts: [], default: null, from_provider: false };
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
  /** 旧的布尔思考开关。保留：它是 reasoning_effort 缺省时的回落依据（true→high）。 */
  thinking: boolean;
  /** 当前推理档位（'' = 未显式设置，按 thinking / 规范默认推导）。 */
  reasoning_effort: string;
  /** 可选档位集合与来源。 */
  reasoning: ReasoningSpecUi;
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

/** 解析档位集合；形状不对时返回空集合（UI 会退化成旧的布尔开关）。 */
function reasoningFrom(raw: any): ReasoningSpecUi {
  const efforts = Array.isArray(raw?.efforts)
    ? raw.efforts
        .filter((e: any) => typeof e?.id === 'string' && e.id.trim() !== '')
        .map((e: any) => ({ id: String(e.id).trim(), name: (s(e.name) || String(e.id).trim()) }))
    : [];
  return {
    efforts,
    default: typeof raw?.default === 'string' && raw.default.trim() !== '' ? raw.default.trim() : null,
    from_provider: raw?.fromProvider === true,
  };
}

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
    reasoning_effort: s(o.reasoning_effort),
    reasoning: reasoningFrom(raw?.reasoning),
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

/**
 * 生效的推理档位——与后端 `ResolvedTarget::effort()` **同口径**，保证所见即所得。
 *
 *   显式档位 > 旧开关（true→high）> 档位集合的默认 > off
 *
 * 并且：显式档位**不在集合内**时收敛到集合默认（配置里可能留着「在别的模型上设过的档位」，
 * 直接发出去会被端点 400）。
 */
export function effectiveEffort(m: Pick<ModelUi, 'reasoning_effort' | 'thinking' | 'reasoning'>): string {
  const spec = m.reasoning;
  const has = (id: string) => spec.efforts.some((e) => e.id.toLowerCase() === id);
  const fallback = spec.efforts.length ? (spec.default ?? spec.efforts[0].id) : 'off';
  const explicit = m.reasoning_effort.trim().toLowerCase();
  if (explicit) return !spec.efforts.length || has(explicit) ? explicit : fallback;
  if (m.thinking) return !spec.efforts.length || has('high') ? 'high' : fallback;
  return fallback;
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
    // 空集合不必落盘（null 更省空间，语义也明确）
    reasoning: m.reasoning.efforts.length > 0 ? m.reasoning : null,
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
