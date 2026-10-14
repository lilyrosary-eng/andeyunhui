/**
 * 媒体后端清单 + 路由表单测。
 * 重点验证「降级只针对未配置」这一与用户对齐的核心语义。
 */
import { describe, it, expect } from 'vitest';
import { createStorage, type Storage, type StorageBackend } from '@/core/storage';
import { isBackendReady, loadBackends, saveBackends, findBackend, BACKENDS_KEY, type MediaBackend } from './backends';
import { resolveBackend, routeFor, loadRoutes, saveRoutes, toMediaToolCfg, defaultRoutes, type MediaRoutes } from './routing';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  const backend: StorageBackend = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
  return createStorage(backend);
}

/** 造一个后端条目（只填关心的字段）。 */
function b(over: Partial<MediaBackend> & { id: string }): MediaBackend {
  return {
    name: over.id,
    kind: 'openai',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-x',
    caps: ['image'],
    extras: {},
    ...over,
  };
}

describe('isBackendReady —— 降级判定的唯一依据', () => {
  it('openai：需凭证 + 该能力的模型名，两者齐备才算就绪', () => {
    expect(isBackendReady(b({ id: 'a', extras: { models: { image: 'flux-1.1' } } }), 'image')).toBe(true);
    expect(isBackendReady(b({ id: 'a', extras: {} }), 'image')).toBe(false);
    expect(isBackendReady(b({ id: 'a', apiKey: '', extras: { models: { image: 'x' } } }), 'image')).toBe(false);
    // 引用档案可替代自填 apiKey
    expect(isBackendReady(b({ id: 'a', apiKey: '', extras: { models: { image: 'x' }, profileId: 'p1' } }), 'image')).toBe(true);
  })

  it('openai：模型名属于别的能力时不就绪（能力与模型要对上）', () => {
    const backend = b({ id: 'a', caps: ['image', 'speech'], extras: { models: { speech: 'tts-1' } } });
    expect(isBackendReady(backend, 'image')).toBe(false);
    expect(isBackendReady(backend, 'speech')).toBe(true);
  })

  it('caps 未声明该能力 → 不就绪（哪怕配了模型）', () => {
    const backend = b({ id: 'a', caps: ['speech'], extras: { models: { image: 'x', speech: 'y' } } });
    expect(isBackendReady(backend, 'image')).toBe(false);
  })

  it('comfyui：只看端点——端点通了即就绪（缺 ckpt 由 Rust 给明确错误，不静默跳过）', () => {
    const base = { id: 'c', kind: 'comfyui' as const, caps: ['image' as const], apiKey: '' };
    expect(isBackendReady(b({ ...base, extras: { ckpt: 'sd.safetensors' } }), 'image')).toBe(true);
    expect(isBackendReady(b({ ...base, extras: { workflowPath: 'D:/wf.json' } }), 'image')).toBe(true);
    // 端点通了但没填模型：用户意图明确（已配端点），应报错而非跳过
    expect(isBackendReady(b({ ...base, extras: {} }), 'image')).toBe(true);
    // 端点为空 → 完全无法连接 → 未配置
    expect(isBackendReady(b({ ...base, baseUrl: '', extras: {} }), 'image')).toBe(false);
    // ComfyUI 首期只做 image
    expect(isBackendReady(b({ ...base, caps: ['speech'], extras: {} }), 'speech')).toBe(false);
  })

  it('openai：有 profileId 即可（凭证从档案解析），端点为可选', () => {
    const noUrl = b({ id: 'a', baseUrl: '', apiKey: '', extras: { models: { image: 'x' }, profileId: 'p1' } });
    expect(isBackendReady(noUrl, 'image')).toBe(true);
    // 无 profileId 时需自填 apiKey + baseUrl
    const selfContained = b({ id: 'a', baseUrl: 'https://api.x/v1', apiKey: 'sk-y', extras: { models: { image: 'x' } } });
    expect(isBackendReady(selfContained, 'image')).toBe(true);
    // 无凭证来源
    expect(isBackendReady(b({ id: 'a', baseUrl: '', apiKey: '', extras: { models: { image: 'x' } } }), 'image')).toBe(false);
  })
})

describe('resolveBackend —— 降级只跳过「未配置」', () => {
  const comfyReady = b({ id: 'comfy', kind: 'comfyui', apiKey: '', caps: ['image'], extras: { ckpt: 'sd.safetensors' } });
  const cloudReady = b({ id: 'cloud', caps: ['image'], extras: { models: { image: 'flux' } } });
  // 「未配置」= 端点为空（完全连不上）；缺模型不算未配置（应报错）
  const comfyUnset = b({ id: 'comfy', kind: 'comfyui', apiKey: '', baseUrl: '', caps: ['image'], extras: {} });

  it('首个后端就绪 → 选它，不继续往后看', () => {
    const r = resolveBackend('image', [comfyReady, cloudReady], { image: ['comfy', 'cloud'] });
    expect(r?.backend.id).toBe('comfy');
  })

  it('首个后端未配置（端点为空）→ 跳过，落到下一个', () => {
    const r = resolveBackend('image', [comfyUnset, cloudReady], { image: ['comfy', 'cloud'] });
    expect(r?.backend.id).toBe('cloud');
  })

  it('全部未配置 → null（调用方给出可自纠的错误）', () => {
    const r = resolveBackend('image', [comfyUnset], { image: ['comfy'] });
    expect(r).toBeNull();
  })

  it('路由表里引用了不存在的 id → 跳过而非崩溃', () => {
    const r = resolveBackend('image', [cloudReady], { image: ['ghost', 'cloud'] });
    expect(r?.backend.id).toBe('cloud');
  })

  it('能力无路由 → null', () => {
    expect(resolveBackend('speech', [cloudReady], { image: ['cloud'] })).toBeNull();
  })

  it('路由顺序即优先级（把云端放前面就先用云端）', () => {
    const r = resolveBackend('image', [comfyReady, cloudReady], { image: ['cloud', 'comfy'] });
    expect(r?.backend.id).toBe('cloud');
  })
})

describe('toMediaToolCfg —— 传给 Rust 的最小配置', () => {
  it('只带本次需要的字段，不含无关能力', () => {
    const r = resolveBackend(
      'image',
      [b({ id: 'cloud', extras: { models: { image: 'flux', speech: 'tts' }, profileId: 'p1' } })],
      { image: ['cloud'] },
    )!;
    const cfg = toMediaToolCfg(r);
    expect(cfg).toEqual({
      kind: 'image',
      backendKind: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-x',
      model: 'flux',
      profileId: 'p1',
    });
    expect('speech' in cfg).toBe(false);
  })

  it('comfyui 档带 ckpt/工作流/slug', () => {
    const r = resolveBackend(
      'image',
      [b({ id: 'c', kind: 'comfyui', apiKey: '', extras: { workflowPath: 'D:/w.json', skillSlug: 'krea' } })],
      { image: ['c'] },
    )!;
    const cfg = toMediaToolCfg(r);
    expect(cfg.backendKind).toBe('comfyui');
    expect(cfg.workflowPath).toBe('D:/w.json');
    expect(cfg.skillSlug).toBe('krea');
    expect(cfg.ckpt).toBeUndefined();
  })
})

describe('存取与默认路由', () => {
  it('后端清单读写往返', () => {
    const s = memoryStorage();
    saveBackends([b({ id: 'a' })], s);
    expect(loadBackends(s).map((x) => x.id)).toEqual(['a']);
    expect(findBackend('a', s)?.id).toBe('a');
    expect(findBackend('nope', s)).toBeUndefined();
  })

  it('路由表读写往返；空/损坏回退为空对象', () => {
    const s = memoryStorage();
    saveRoutes({ image: ['a'] }, s);
    expect(loadRoutes(s)).toEqual({ image: ['a'] });
    const bad = memoryStorage();
    bad.setString('andeyunhui.media.routes', '[]');
    expect(loadRoutes(bad)).toEqual({});
  })

  it('routeFor：未配置的能力返回空数组', () => {
    expect(routeFor('image', {})).toEqual([]);
    expect(routeFor('image', { image: ['a'] })).toEqual(['a']);
  })

  it('defaultRoutes：按各后端声明的 caps 拼单链', () => {
    const routes: MediaRoutes = defaultRoutes([
      b({ id: 'comfy', kind: 'comfyui', apiKey: '', caps: ['image'], extras: { ckpt: 'x' } }),
      b({ id: 'cloud', caps: ['image', 'speech'], extras: {} }),
    ]);
    expect(routes.image).toEqual(['comfy', 'cloud']);
    expect(routes.speech).toEqual(['cloud']);
    expect(routes.video).toBeUndefined();
  })

  it('存储键独立于 KEYS 表', () => {
    expect(BACKENDS_KEY).toBe('andeyunhui.media.backends');
  })
})

describe('多云端条目 —— 一个能力可挂多条，按链序生效', () => {
  it('两条云端后端都能进链，首个就绪者胜出', () => {
    const a = b({ id: 'cloud-a', baseUrl: 'https://a.example/v1', extras: { models: { image: 'dall-e-3' } } });
    const c = b({ id: 'cloud-b', baseUrl: 'https://b.example/v1', extras: { models: { image: 'flux' } } });
    expect(resolveBackend('image', [a, c], { image: ['cloud-a', 'cloud-b'] })?.backend.id).toBe('cloud-a');
  })

  it('首个未配置（无凭证来源）时落到第二个云端条目', () => {
    const broken = b({ id: 'cloud-a', baseUrl: '', apiKey: '', extras: { models: { image: 'dall-e-3' } } });
    const ok = b({ id: 'cloud-b', baseUrl: 'https://b.example/v1', extras: { models: { image: 'flux' } } });
    expect(resolveBackend('image', [broken, ok], { image: ['cloud-a', 'cloud-b'] })?.backend.id).toBe('cloud-b');
  })

  it('不同能力可各自挂不同云端条目', () => {
    const visionOnly = b({ id: 'v', caps: ['vision'], extras: { models: { vision: 'gpt-4o' } } });
    const imgOnly = b({ id: 'i', caps: ['image'], extras: { models: { image: 'dall-e-3' } } });
    const routes: MediaRoutes = { vision: ['v'], image: ['i'] };
    expect(resolveBackend('vision', [visionOnly, imgOnly], routes)?.backend.id).toBe('v');
    expect(resolveBackend('image', [visionOnly, imgOnly], routes)?.backend.id).toBe('i');
  })

  it('defaultRoutes 把多个云端条目都拼进同一条链', () => {
    const a = b({ id: 'a', caps: ['image'], extras: { models: { image: 'x' } } });
    const c = b({ id: 'c', caps: ['image'], extras: { models: { image: 'y' } } });
    expect(defaultRoutes([a, c]).image).toEqual(['a', 'c']);
  })
})

describe('vision 能力位 —— 与 image 是两个方向', () => {
  it('openai 后端：需凭证 + 视觉模型名', () => {
    expect(isBackendReady(b({ id: 'a', caps: ['vision'], extras: { models: { vision: 'gpt-4o' } } }), 'vision')).toBe(true);
    expect(isBackendReady(b({ id: 'a', caps: ['vision'], extras: {} }), 'vision')).toBe(false);
  })

  it('comfyui 是生图后端，vision 恒不就绪', () => {
    const comfy = b({
      id: 'c', kind: 'comfyui', apiKey: '', baseUrl: 'http://127.0.0.1:8188',
      caps: ['image', 'vision'], extras: { ckpt: 'sd.safetensors' },
    });
    expect(isBackendReady(comfy, 'image')).toBe(true);
    expect(isBackendReady(comfy, 'vision')).toBe(false);
  })

  it('vision 与 image 不可互替', () => {
    const imgOnly = b({ id: 'a', caps: ['image'], extras: { models: { image: 'dall-e-3' } } });
    expect(isBackendReady(imgOnly, 'vision')).toBe(false);
    const visionOnly = b({ id: 'b', caps: ['vision'], extras: { models: { vision: 'gpt-4o' } } });
    expect(isBackendReady(visionOnly, 'image')).toBe(false);
  })
})
