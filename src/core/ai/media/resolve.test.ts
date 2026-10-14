// resolve.ts 的 resolveOne 依赖 tauri invoke（蓝图工作流读取）与全局 storage，
// 不做完整单测；此处只覆盖「路由结果 → MediaToolCfg」的形状契约与「未配置不带键」语义，
// 这些是前端与 Rust 之间最容易静默错位的地方（字段名/大小写/缺键）。
import { describe, expect, it, vi } from 'vitest';

// 用内存 storage 替换全局 storage，避免污染真实 localStorage。
const mem = new Map<string, string>();
vi.mock('@/core/storage', () => ({
  storage: {
    getString: (k: string, d = '') => mem.get(k) ?? d,
    setString: (k: string, v: string) => void mem.set(k, v),
    getJSON: <T,>(k: string, d: T): T => {
      const raw = mem.get(k);
      if (!raw) return d;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return d;
      }
    },
    setJSON: (k: string, v: unknown) => void mem.set(k, JSON.stringify(v)),
    remove: (k: string) => void mem.delete(k),
  },
}));
// invoke 一律失败 → resolveOne 走「无 workflow 的 comfyui 档」/openai 档，不触网。
vi.mock('@tauri-apps/api/core', () => ({ invoke: () => Promise.reject(new Error('no tauri')) }));

import { BACKENDS_KEY, ROUTES_KEY } from './backends';
import type { MediaBackend } from './backends';
import { resolveMediaConfig } from './resolve';

function seed(backends: MediaBackend[], routes: Record<string, string[]>) {
  mem.clear();
  mem.set(BACKENDS_KEY, JSON.stringify(backends));
  mem.set(ROUTES_KEY, JSON.stringify(routes));
}

describe('resolveMediaConfig', () => {
  it('无清单无路由 → null（Rust 侧据此给未配置提示）', async () => {
    mem.clear();
    expect(await resolveMediaConfig()).toBeNull();
  });

  it('comfyui 后端 → image 键为 comfyui 档（含 baseUrl/ckpt）', async () => {
    seed(
      [
        {
          id: 'comfyui-local',
          name: '本地 ComfyUI',
          kind: 'comfyui',
          baseUrl: 'http://127.0.0.1:8188',
          apiKey: '',
          caps: ['image'],
          extras: { ckpt: 'sd_xl.safetensors', skillSlug: 'krea' },
        },
      ],
      { image: ['comfyui-local'] },
    );
    const m = await resolveMediaConfig();
    expect(m?.image?.backendKind).toBe('comfyui');
    expect(m?.image?.baseUrl).toBe('http://127.0.0.1:8188');
    expect(m?.image?.ckpt).toBe('sd_xl.safetensors');
    expect(m?.image?.skillSlug).toBe('krea');
    expect(m?.speech).toBeUndefined(); // 未配置的能力不带键
  });

  it('openai 后端 → speech 键带 model 与 profileId', async () => {
    seed(
      [
        {
          id: 'profile-p1',
          name: '云端媒体',
          kind: 'openai',
          baseUrl: '',
          apiKey: '',
          caps: ['speech'],
          extras: { models: { speech: 'tts-1' }, profileId: 'p1' },
        },
      ],
      { speech: ['profile-p1'] },
    );
    const m = await resolveMediaConfig();
    expect(m?.speech?.backendKind).toBe('openai');
    expect(m?.speech?.model).toBe('tts-1');
    expect(m?.speech?.profileId).toBe('p1');
    expect(m?.image).toBeUndefined();
  });

  it('链首未配置（comfyui 缺 url）→ 跳过取下一个就绪后端', async () => {
    seed(
      [
        {
          id: 'comfyui-broken',
          name: '坏 ComfyUI',
          kind: 'comfyui',
          baseUrl: '',
          apiKey: '',
          caps: ['image'],
          extras: {},
        },
        {
          id: 'profile-p1',
          name: '云端媒体',
          kind: 'openai',
          baseUrl: '',
          apiKey: '',
          caps: ['image'],
          extras: { models: { image: 'dall-e-3' }, profileId: 'p1' },
        },
      ],
      { image: ['comfyui-broken', 'profile-p1'] },
    );
    const m = await resolveMediaConfig();
    expect(m?.image?.backendKind).toBe('openai');
    expect(m?.image?.model).toBe('dall-e-3');
  });

  it('全部未配置 → null（不产生半成品键）', async () => {
    seed(
      [
        {
          id: 'comfyui-broken',
          name: '坏 ComfyUI',
          kind: 'comfyui',
          baseUrl: '',
          apiKey: '',
          caps: ['image'],
          extras: {},
        },
      ],
      { image: ['comfyui-broken'] },
    );
    expect(await resolveMediaConfig()).toBeNull();
  });
});
