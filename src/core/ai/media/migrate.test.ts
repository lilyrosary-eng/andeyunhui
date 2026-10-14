/**
 * 媒体配置迁移单测——buildBackendsFromLegacy 纯函数（迁移核心）+ 幂等标记。
 * 注意：ai_config.json 曾丢过数据，故这里重点验证「迁移不改档案、只产出 localStorage 清单」。
 */
import { describe, it, expect } from 'vitest';
import { createStorage, type Storage, type StorageBackend } from '@/core/storage';
import { buildBackendsFromLegacy, MIGRATED_KEY } from './migrate';
import { loadBackends } from './backends';
import { loadRoutes } from './routing';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  const backend: StorageBackend = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
  return createStorage(backend);
}

const emptyLegacy = { comfyuiUrl: '', comfyuiCkpt: '', blueprintWf: '', blueprintSlug: '' };

describe('buildBackendsFromLegacy', () => {
  it('ComfyUI 三键 → 一条 comfyui 后端（caps=image）', () => {
    const out = buildBackendsFromLegacy(
      { comfyuiUrl: 'http://127.0.0.1:8188', comfyuiCkpt: 'sd_xl.safetensors', blueprintWf: '', blueprintSlug: '' },
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'comfyui', baseUrl: 'http://127.0.0.1:8188', caps: ['image'] });
    expect(out[0].extras.ckpt).toBe('sd_xl.safetensors');
  })

  it('ComfyUI url 为空 → 不生成条目（未配置就不占位）', () => {
    expect(buildBackendsFromLegacy(emptyLegacy, [])).toHaveLength(0);
  })

  it('蓝图工作流与 slug 一并搬进 extras', () => {
    const out = buildBackendsFromLegacy(
      { comfyuiUrl: 'http://x:8188', comfyuiCkpt: '', blueprintWf: 'D:/w.json', blueprintSlug: 'krea' },
      [],
    );
    expect(out[0].extras.workflowPath).toBe('D:/w.json');
    expect(out[0].extras.skillSlug).toBe('krea');
  })

  it('档案的 image_model/tts_model → openai 条目，且引用档案取凭证', () => {
    const out = buildBackendsFromLegacy(emptyLegacy, [
      { id: 'p1', name: '我的通义', image_model: 'wanx-v1', tts_model: 'cosyvoice' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'openai', caps: ['image', 'speech'] });
    expect(out[0].extras.models).toEqual({ image: 'wanx-v1', speech: 'cosyvoice' });
    expect(out[0].extras.profileId).toBe('p1');
  })

  it('只配 image_model 的档案只声明 image（不虚报能力）', () => {
    const out = buildBackendsFromLegacy(emptyLegacy, [{ id: 'p1', image_model: 'flux' }]);
    expect(out[0].caps).toEqual(['image']);
  })

  it('两者皆空的档案跳过（不留空壳条目）', () => {
    const out = buildBackendsFromLegacy(emptyLegacy, [
      { id: 'p1', model: 'deepseek-chat' },
      { id: 'p2', image_model: '', tts_model: '  ' },
    ]);
    expect(out).toHaveLength(0);
  })

  it('ComfyUI 与云端可共存，顺序为 comfyui 在前（本地优先）', () => {
    const out = buildBackendsFromLegacy(
      { comfyuiUrl: 'http://x:8188', comfyuiCkpt: 'a.safetensors', blueprintWf: '', blueprintSlug: '' },
      [{ id: 'p1', image_model: 'flux' }],
    );
    expect(out.map((x) => x.id)).toEqual(['comfyui-local', 'profile-p1']);
  })
})

describe('迁移幂等标记', () => {
  it('未迁移时标记为空', () => {
    const s = memoryStorage();
    expect(s.getString(MIGRATED_KEY, '')).toBe('');
  })

  it('已配过清单的存储：迁移不应覆盖（标记先行）', () => {
    const s = memoryStorage();
    expect(loadBackends(s)).toHaveLength(0);
    expect(loadRoutes(s)).toEqual({});
  })
})
