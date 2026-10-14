/**
 * 媒体后端配置迁移（一次性）——把散落的旧配置聚成「后端清单 + 路由表」。
 *
 * 迁移来源：
 *   ① 前端 localStorage 的 ComfyUI 三键（ai.comfyuiUrl / comfyuiCkpt / comfyuiBlueprintWf / ...Slug）
 *      → 一条 comfyui 后端条目（caps: ['image']）；
 *   ② Rust 侧各供应商档案的 image_model / tts_model（经 ai_get_profiles 读取）
 *      → 每个**有值**的档案生成一条 openai 后端条目（引用该档案取凭证）。
 *
 * 安全性（重要）：`ai_config.json` 刚经历过一次数据丢失，故本迁移**只读档案、绝不写回**；
 * 旧字段 image_model / tts_model 保留不动（改为「保留但不读」）。迁移产物只落 localStorage。
 *
 * 幂等：以 MIGRATED_KEY 标记，跑过就不再跑；清单非空时也跳过（用户已自己配过）。
 */
import { invoke } from '@tauri-apps/api/core';
import { storage, type Storage } from '@/core/storage';
import { KEYS } from '@/core/storage/keys';
import { BACKENDS_KEY, ROUTES_KEY, loadBackends, saveBackends, type MediaBackend } from './backends';
import { defaultRoutes, saveRoutes } from './routing';

/** 迁移完成标记（存在即不再迁移）。 */
export const MIGRATED_KEY = 'andeyunhui.media.migrated';

/** ai_get_profiles 返回的档案形状（只关心迁移需要的字段）。 */
interface RawProfile {
  id?: string;
  name?: string;
  model?: string;
  image_model?: string | null;
  tts_model?: string | null;
}

/**
 * 由旧配置构造后端清单（纯函数，便于测试）。
 * comfyui 档仅在 url 非空时生成；openai 档每个「有 image_model 或 tts_model」的档案生成一条。
 */
export function buildBackendsFromLegacy(
  legacy: { comfyuiUrl: string; comfyuiCkpt: string; blueprintWf: string; blueprintSlug: string },
  profiles: RawProfile[],
): MediaBackend[] {
  const out: MediaBackend[] = [];
  const url = legacy.comfyuiUrl.trim();
  if (url) {
    const ckpt = legacy.comfyuiCkpt.trim();
    const wf = legacy.blueprintWf.trim();
    const slug = legacy.blueprintSlug.trim();
    out.push({
      id: 'comfyui-local',
      name: '本地 ComfyUI',
      kind: 'comfyui',
      baseUrl: url,
      apiKey: '',
      caps: ['image'],
      extras: {
        ...(ckpt ? { ckpt } : {}),
        ...(wf ? { workflowPath: wf } : {}),
        ...(slug ? { skillSlug: slug } : {}),
      },
    });
  }
  for (const p of profiles) {
    const img = (p.image_model ?? '').trim();
    const tts = (p.tts_model ?? '').trim();
    if (!img && !tts) continue;
    const id = p.id?.trim() || `profile-${out.length}`;
    const caps: MediaBackend['caps'] = [];
    if (img) caps.push('image');
    if (tts) caps.push('speech');
    out.push({
      id: `profile-${id}`,
      name: p.name?.trim() || p.model?.trim() || '云端媒体',
      kind: 'openai',
      baseUrl: '',
      apiKey: '',
      caps,
      extras: {
        models: { ...(img ? { image: img } : {}), ...(tts ? { speech: tts } : {}) },
        profileId: id,
      },
    });
  }
  return out;
}

/**
 * 执行迁移（幂等）。返回是否发生了迁移。
 * tauri invoke 不可用时（如纯浏览器预览）静默跳过，不阻塞启动。
 */
export async function migrateMediaBackends(s: Storage = storage): Promise<boolean> {
  if (s.getString(MIGRATED_KEY, '') === '1') return false;
  if (loadBackends(s).length > 0) {
    // 用户已配过清单 → 只打标记，不覆盖
    s.setString(MIGRATED_KEY, '1');
    return false;
  }
  let profiles: RawProfile[];
  try {
    const res = await invoke<{ profiles?: RawProfile[] }>('ai_get_profiles');
    profiles = Array.isArray(res?.profiles) ? res.profiles : [];
  } catch {
    // Rust 侧不可用（预览环境）：仅迁移前端可读的 ComfyUI 三键
    profiles = [];
  }
  const backends = buildBackendsFromLegacy(
    {
      comfyuiUrl: s.getString(KEYS.ai.comfyuiUrl.key, ''),
      comfyuiCkpt: s.getString(KEYS.ai.comfyuiCkpt.key, ''),
      blueprintWf: s.getString(KEYS.ai.comfyuiBlueprintWf.key, ''),
      blueprintSlug: s.getString(KEYS.ai.comfyuiBlueprintWfSlug.key, ''),
    },
    profiles,
  );
  saveBackends(backends, s);
  saveRoutes(defaultRoutes(backends), s);
  s.setString(MIGRATED_KEY, '1');
  return true;
}

/** 清空迁移标记与产物（设置面板「重置」用）。 */
export function resetMediaConfig(s: Storage = storage): void {
  s.remove(BACKENDS_KEY);
  s.remove(ROUTES_KEY);
  s.remove(MIGRATED_KEY);
}
