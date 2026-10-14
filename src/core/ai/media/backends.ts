/**
 * 媒体后端清单（multi-backend）——把「生图/语音/视频/音乐」的后端从供应商档案里独立出来。
 *
 * 背景：原先 image_model / tts_model 挂在供应商档案上，ComfyUI 端点又单独存一处，
 * 「本地后端」始终是特例；再扩到 sd-webui / fooocus / 视频 / 音乐会越来越别扭。
 * 现在统一为「后端条目」清单：每条描述一个后端（kind + 端点 + 凭证 + 支持的能力），
 * 由路由表（routing.ts）按能力挑用。
 *
 * 存 localStorage（与既有 ComfyUI 配置同处），不经 Rust —— Rust 读不到前端存储，
 * 故每次 agent 请求把解析结果经 ai_chat_agent 的 media 参数传入（沿用 comfyui 参数通道的思路）。
 */
import { storage, type Storage } from '@/core/storage';

/** 后端清单的存储键（独立于 KEYS 表，避免为它加 Rust 侧无感的登记项）。 */
export const BACKENDS_KEY = 'andeyunhui.media.backends';
export const ROUTES_KEY = 'andeyunhui.media.routes';

/**
 * 媒体能力：一个后端可支持多种（如 fooocus 只支持 image）。
 *
 * `vision`（图片理解/识图）与 `image`（图片生成）是**两个方向**的能力，分开列：
 * 用户可能想用云端视觉模型看图、同时用本地 ComfyUI 出图，混成一个就没法分别配置。
 */
export type MediaKind = 'image' | 'vision' | 'speech' | 'video' | 'music';

/** 首期只启用 image/vision/speech；video/music 枚举留位（后端可声明，路由表暂不配）。 */
export const ENABLED_KINDS: MediaKind[] = ['image', 'vision', 'speech'];
export const ALL_KINDS: MediaKind[] = ['image', 'vision', 'speech', 'video', 'music'];

/** 后端种类：决定用哪套调用协议。 */
export type BackendKind = 'comfyui' | 'openai';

/** 一个媒体后端条目。 */
export interface MediaBackend {
  /** 唯一 id（内部引用用，路由表按 id 指）。 */
  id: string;
  /** 显示名（如「本地 ComfyUI」「云端图片模型」）。 */
  name: string;
  /** 调用协议种类。 */
  kind: BackendKind;
  /** 端点基址。 */
  baseUrl: string;
  /** API Key（本地后端留空）。 */
  apiKey: string;
  /** 支持的能力（可多选）。 */
  caps: MediaKind[];
  /** 各 kind 专属配置。 */
  extras: {
    /** comfyui：checkpoint 模型文件名。 */
    ckpt?: string;
    /** comfyui：蓝图指定工作流文件路径。 */
    workflowPath?: string;
    /** comfyui：该工作流的技能包 slug（失败写回用）。 */
    skillSlug?: string;
    /** openai：各能力对应的模型名。 */
    models?: Partial<Record<MediaKind, string>>;
    /** openai：该后端引用哪个供应商档案取凭证（不填则用自填 baseUrl/apiKey）。 */
    profileId?: string;
  };
}

/**
 * 一条后端是否「配置完整」（可用于该能力）。
 * 这是**降级判定的唯一依据**：路由只跳过「未配置」的后端，不因执行失败而转下一个
 * （用户显式配了本地后端就是想用本地——可能为隐私或额度，静默转云端属越权且可能花钱）。
 */
export function isBackendReady(b: MediaBackend, kind: MediaKind): boolean {
  if (!b.caps.includes(kind)) return false;
  if (b.kind === 'comfyui') {
    // ComfyUI 是**生图**后端，只做 image，不理解图片（vision 恒不就绪）。
    // 端点为空也算未配置：连不上就谈不上能力。
    return kind === 'image' && b.baseUrl.trim() !== '';
  }
  // openai 兼容：需能取到凭证与模型名。端点为可选（凭证经 profileId 从档案解析，
  // 或后端自带 apiKey + baseUrl）。
  const hasCred =
    (b.extras.profileId?.trim() ?? '') !== '' || (b.apiKey.trim() !== '' && b.baseUrl.trim() !== '');
  const hasModel = !!(b.extras.models?.[kind]?.trim());
  // 视觉档特例：挂了档案（profileId）时模型名可留空——Rust 侧 vision_ask 会回落到
  // 该档案的 vision_model（见 ai_ocr.rs），面板提示写的正是这条。
  // ⚠️ 生图/语音**不放开**：它们的云端分支最终读的是档案里的 image_model / tts_model
  //    （multimodal_service.rs:29-33 / 91-95），**不读**本清单里的模型名，
  //    所以模型名在这里只是就绪判据，留空会让路由提前跳过。
  if (kind === 'vision' && (b.extras.profileId?.trim() ?? '') !== '') return hasCred;
  return hasCred && hasModel;
}

function loadList(s: Storage): MediaBackend[] {
  const v = s.getJSON<MediaBackend[]>(BACKENDS_KEY, []);
  return Array.isArray(v) ? v : [];
}

/** 读后端清单（空数组=未配置）。 */
export function loadBackends(s: Storage = storage): MediaBackend[] {
  return loadList(s);
}

/** 写后端清单。 */
export function saveBackends(list: MediaBackend[], s: Storage = storage): void {
  s.setJSON(BACKENDS_KEY, list);
}

/** 按 id 找一个后端。 */
export function findBackend(id: string, s: Storage = storage): MediaBackend | undefined {
  return loadList(s).find((b) => b.id === id);
}
