// 模型档案表单编解码：Rust 侧 AiProfile 载荷 ↔ 前端编辑态 ProfileUi。
// 原嵌于 ModelSettings.tsx（组件文件），抽出后纯函数可单测。

export interface ProfileUi {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  vision_model: string;
  temperature: number;
  max_tokens: string;
  top_p: string;
  system_prompt: string;
  thinking: boolean;
  persona_call_me_as: string;
  persona_preset: string;
  persona_style: string;
}

export function fromPayload(p: any): ProfileUi {
  return {
    id: p.id || 'p_' + Math.random().toString(36).slice(2, 8),
    name: p.name || '',
    base_url: p.base_url || '',
    api_key: p.api_key || '',
    model: p.model || '',
    vision_model: p.vision_model || '',
    temperature: typeof p.temperature === 'number' ? p.temperature : 0.3,
    max_tokens: p.max_tokens != null ? String(p.max_tokens) : '',
    top_p: p.top_p != null ? String(p.top_p) : '',
    system_prompt: p.system_prompt || '',
    thinking: p.thinking === true,
    persona_call_me_as: p.persona_call_me_as || '',
    persona_preset: p.persona_preset || '',
    persona_style: p.persona_style || '',
  };
}

export function toPayload(p: ProfileUi) {
  return {
    id: p.id,
    name: p.name,
    base_url: p.base_url,
    api_key: p.api_key,
    model: p.model,
    vision_model: p.vision_model.trim() ? p.vision_model.trim() : null,
    temperature: p.temperature,
    max_tokens: p.max_tokens.trim() ? Math.max(1, parseInt(p.max_tokens, 10) || 0) : null,
    top_p: p.top_p.trim() ? Math.min(1, Math.max(0, parseFloat(p.top_p) || 0)) : null,
    system_prompt: p.system_prompt.trim() ? p.system_prompt.trim() : null,
    thinking: p.thinking === true ? true : null,
    persona_call_me_as: p.persona_call_me_as.trim() ? p.persona_call_me_as.trim() : null,
    persona_preset: p.persona_preset.trim() ? p.persona_preset.trim() : null,
    persona_style: p.persona_style.trim() ? p.persona_style.trim() : null,
  };
}