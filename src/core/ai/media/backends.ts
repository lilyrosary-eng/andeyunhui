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
import { KEYS } from '@/core/storage/keys';

/** 后端清单的存储键（独立于 KEYS 表，避免为它加 Rust 侧无感的登记项）。 */
export const BACKENDS_KEY = 'andeyunhui.media.backends';
export const ROUTES_KEY = 'andeyunhui.media.routes';

/**
 * 媒体能力：一个后端可支持多种（如 fooocus 只支持 image）。
 *
 * `vision`（图片理解/识图）与 `image`（图片生成）是**两个方向**的能力，分开列：
 * 用户可能想用云端视觉模型看图、同时用本地 ComfyUI 出图，混成一个就没法分别配置。
 */
export type MediaKind = 'image' | 'vision' | 'speech' | 'video' | 'music' | 'embedding';

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
    /** 链里失败后的策略（缺省按 kind 推：comfyui→stop / openai→fallback）。 */
    onFail?: OnFail;
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
 * 某个后端**实际使用的端点** —— ComfyUI 统一取「本地生图」面板那一处。
 *
 * ## 为什么合并
 * 端点本来有两个存储位置：ComfyUI 面板的 `ai.comfyuiUrl`，与媒体后端条目自己的
 * `baseUrl`，二者**互不相通**。于是：
 *   - 在面板改了端点 → 手动生图/工作流库/蓝图跟着变，但 agent 的「画张图」仍走旧端点；
 *   - 要让 AI 生图走通，还得在媒体后端里**再填一遍**同一个端点。
 * 症状是「手动生图能用、让 AI 画却连不上」（或反过来），而且完全看不出原因。
 *
 * 自用是单机单实例（已与用户确认「就一台」），不需要两处各配一个，所以合并到面板。
 * 条目自己的 `baseUrl` 对 ComfyUI **不再生效**（字段保留以兼容旧数据，不读它）。
 */
/**
 * 某个后端**实际使用的 checkpoint** —— ComfyUI 统一取「本地生图」面板那一处。
 *
 * 与 `effectiveBaseUrl` 同一个理由、同一个病：checkpoint 原先也能两处配
 * （媒体后端条目的 `extras.ckpt` 与 ComfyUI 面板的 `ai.comfyuiCkpt`），
 * 改了其中一个另一个不跟着变 → 「面板里改了模型，让 AI 画却还是老模型」。
 * 端点已经统一过，这一处是漏掉的那半。
 *
 * 返回空串是**正常值**：语义是"自动挑一个"（见 Rust `resolve_checkpoint_choice`）。
 */
export function effectiveCkpt(b: MediaBackend, s: Storage = storage): string {
  if (b.kind === 'comfyui') {
    return s.getString(KEYS.ai.comfyuiCkpt.key, KEYS.ai.comfyuiCkpt.default).trim();
  }
  return (b.extras.ckpt ?? '').trim();
}

/**
 * 「生成后自动自检」是否开启（设置页那一处，默认开）。
 *
 * 挂在 `image` 档下发（见 `toMediaToolCfg`）：自检只发生在**出图之后**，
 * 两条出图路径读的都是 `ctx.media.image`。语义是"关掉 = 连那次视觉调用都不发"。
 */
export function effectiveSelfCheck(s: Storage = storage): boolean {
  return s.getString(KEYS.ai.autoSelfCheck.key, '1') === '1';
}

/** 内置流程可调参数的键（与 Rust `Txt2imgOptions` 的字段一一对应）。 */
const TXT2IMG_KEYS = ['sampler', 'scheduler', 'steps', 'cfg', 'width', 'height'] as const;

/**
 * ComfyUI 内置流程的采样参数（存在「本地生图」面板那一处）。非 comfyui 或没配 → undefined。
 *
 * 解析失败一律返回 undefined（= 用后端默认）：**坏 JSON 不该让整条生图链挂掉**。
 */
export function effectiveTxt2img(
  b: MediaBackend,
  s: Storage = storage,
): Record<string, string | number> | undefined {
  if (b.kind !== 'comfyui') return undefined;
  const raw = s.getString(KEYS.ai.comfyuiBuiltinParams.key, '').trim();
  if (!raw) return undefined;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string | number> = {};
    for (const k of TXT2IMG_KEYS) {
      const v = o?.[k];
      // 只带"真的填了值"的键；留空 = 后端用默认（与面板上留空的语义一致）
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      else if (typeof v === 'string' && v.trim()) out[k] = v.trim();
    }
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 端点是否是**本机**地址。
 *
 * 为什么需要它：`BackendKind` 只有 `comfyui | openai` 两种，而面板把 `openai` 一律标成
 * 「云端」—— 但 **LM Studio 就是本地的 OpenAI 兼容服务**（`http://127.0.0.1:1234/v1`）。
 * 于是"本地服务"被标成"云端"，用户会以为花的钱在云上。
 *
 * 判据刻意保守：**认不出的按远程**（宁可把本地误标成远程，也别把远程误标成本地 ——
 * 后者会让人以为没出网）。只认回环地址的这几种写法。
 */
export function isLocalEndpoint(url: string): boolean {
  const raw = url.trim().toLowerCase();
  if (!raw) return false;
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/:?#]+)/.exec(raw);
  const host = m?.[1] ?? '';
  return host === 'localhost' || host === '127.0.0.1' || host.startsWith('127.') || host === '::1' || host === '[::1]';
}

/** 这条后端在链里失败后怎么办。`stop` 立刻报错；`fallback` 转下一站。 */
export type OnFail = 'stop' | 'fallback';

/**
 * 某后端的**失败策略**（显式配置优先）。
 *
 * 默认值就是"用户几乎一定想要的"那个：
 *   - `comfyui` → **stop**（本地后端，静默转云端等于越权，还可能花钱）
 *   - `openai`  → **fallback**（云端偶发 429/503 太常见，不转就整次失败）
 * ⚠️ LM Studio 这种"本地但走 openai 协议"的会落到 fallback 默认 —— 所以面板上
 * **必须把这个值显示出来**（带一句"如果这是本地服务建议改成停"），让人一眼能改。
 */
export function effectiveOnFail(b: MediaBackend): OnFail {
  const v = b.extras.onFail;
  if (v === 'stop' || v === 'fallback') return v;
  return b.kind === 'comfyui' ? 'stop' : 'fallback';
}

export function effectiveBaseUrl(b: MediaBackend, s: Storage = storage): string {
  if (b.kind === 'comfyui') {
    return s.getString(KEYS.ai.comfyuiUrl.key, KEYS.ai.comfyuiUrl.default).trim();
  }
  return b.baseUrl.trim();
}

/**
 * 一条后端是否「配置完整」（可用于该能力）。**跳过"未配置"的依据就是它。**
 *
 * ⚠️ 别把它和"执行失败之后怎么办"混为一谈 —— 那是两件事：
 *   - **未配置** → 路由直接跳过（本函数）
 *   - **执行失败** → 看该站的 `onFail`（2026-10-17 起）：comfyui 默认 `stop`、
 *     openai 默认 `fallback`，且**兜底一定显式提示**。
 *
 * 早期版本是"一律不转"，理由是"用户配了本地就是想用本地（隐私/额度），静默转云端属越权"。
 * 那条理由**现在由 `onFail: 'stop'` 这个默认值承载**，而不是写死 —— 需要兜底的场合
 * （云端偶发 429/503）不该跟着一起殉葬。
 */
export function isBackendReady(b: MediaBackend, kind: MediaKind, s: Storage = storage): boolean {
  if (!b.caps.includes(kind)) return false;
  if (b.kind === 'comfyui') {
    // ComfyUI 能做两件：**出图** 与 **语音合成**（跑用户的 TTS 工作流）。
    //
    // ⚠️ **视觉仍然不做**，这是刻意的：ComfyUI 是"生成"侧，它没有"看图并回答"的能力。
    // 想要本地视觉请用**本地的 OpenAI 兼容**视觉模型（LM Studio 之类）——
    // 那条路已经通了，不需要绕 ComfyUI。
    const comfyKinds: MediaKind[] = ['image', 'speech'];
    if (!comfyKinds.includes(kind)) return false;
    //
    // 端点判据**仍然保留**（端点为空 = 连不上 = 未配置），只是端点的**来源**换成了
    // 「本地生图」面板那一处（见 effectiveBaseUrl）—— 条目自己的 baseUrl 不再生效。
    // 那一处带默认值（127.0.0.1:8188），所以加了条目通常就直接就绪；
    // 用户把面板端点清空时，这里仍能如实判为「未配置」。
    // ㊟ 刻意不简化成恒 true：那会连带失去「跳过未配置后端」这个语义的载体。
    return effectiveBaseUrl(b, s) !== '';
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
