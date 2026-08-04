// 移动端 AI 对话共享类型（T07）。
//
// 复用桌面 capsule 的事件契约（ai-delta / ai-reasoning-delta / ai-done / ai-error），
// 但消息结构在桌面 ChatMsg 基础上扩展「来源溯源」（§6.3.2 支点 2）与时间线分隔项，
// 以支持 §4.1.1 降级卡片与 §4.1.2 来源切换分隔的行内插入。

import type { ComputeKind } from '../components/ComputeChip';

/** 算力来源描述（assistant 消息溯源 + ComputeChip 状态共用） */
export interface ComputeSource {
  kind: ComputeKind;
  /** 显示名（如「书房台式机」「OpenAI」），来自 profile.name */
  label: string;
  /** 副文案（如「qwen2.5:14b」「局域网直连」） */
  description?: string;
  /** 关联的 AI profile id（ai_chat 的 profileId 参数） */
  profileId?: string;
}

/** 对话消息（扩展自桌面 ChatMsg，增加来源溯源 + 多模态） */
export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** 思考模式下的思维链（可折叠遮罩展示） */
  reasoning?: string;
  error?: boolean;
  /** assistant 消息的算力来源（§6.3.2 每条回复溯源） */
  source?: ComputeSource;
  /** 用户消息携带的图片（data URL 数组，阶段 5 多模态） */
  images?: string[];
  /** assistant 消息的语音（data URL，阶段 5 TTS） */
  audioUrl?: string;
}

/**
 * 时间线项 —— MessageList 的虚拟滚动单元。
 *
 * 将「消息 / 来源分隔 / 降级卡片」统一为扁平数组，便于 @tanstack/react-virtual
 * 按下标虚拟化。divider / degrade 不进入 ai_chat 的 messages 载荷（仅 UI 层）。
 */
export type TimelineItem =
  | { type: 'message'; id: string; msg: ChatMsg }
  | { type: 'divider'; id: string; source: ComputeSource }
  | { type: 'degrade'; id: string; reason: string; failedMsgId: string };

/** 桌面 ai_get_profiles 返回的 profile 字段（与 Rust AiProfile 对齐） */
export interface AiProfile {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  vision_model?: string | null;
  temperature?: number;
  max_tokens?: number | null;
  top_p?: number | null;
  system_prompt?: string | null;
  thinking?: boolean | null;
  /** 人设：怎么称呼你 */
  persona_call_me_as?: string | null;
  /** 人设：风格预设 key（sharp/gentle/rigorous/humorous/pro/concise/mentor/custom） */
  persona_preset?: string | null;
  /** 人设：自定义风格描述 */
  persona_style?: string | null;
  /** 图片生成模型（多模态·阶段 5，可选） */
  image_model?: string | null;
  /** 语音合成模型（多模态·阶段 5，可选） */
  tts_model?: string | null;
}

/** 依据 base_url 判定算力来源类型（local = 本机/局域网；cloud = 公网） */
export function classifyProfile(profile: AiProfile): ComputeKind {
  const url = (profile.base_url || '').toLowerCase();
  // 127.0.0.1 / localhost / 192.168.* / 10.* / 172.16-31.* 视为本地或局域网
  if (
    url.includes('127.0.0.1') ||
    url.includes('localhost') ||
    url.includes('0.0.0.0') ||
    /^https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url)
  ) {
    return 'local';
  }
  return 'cloud';
}
