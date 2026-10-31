import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CapabilityRules, PluginGrant, PluginManifest } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    pluginCapabilityRules: vi.fn(),
    pluginGrantsAll: vi.fn(),
    pluginGrantSet: vi.fn(),
    pluginGrantClear: vi.fn(),
  },
}));
import { api } from '@/lib/api';
import {
  declaredCapabilities,
  evaluateAccess,
  invalidateAccessCache,
  policyAllows,
  preparePluginAccess,
  type SandboxPolicy,
} from './pluginAccess';

const RULES: CapabilityRules = {
  exact: [
    ['plugin_storage_get', 'storage'],
    ['netease_http_post', 'net'],
  ],
  prefix: [
    ['read_', 'fs.read'],
    ['write_', 'fs.write'],
  ],
  capabilities: ['storage', 'fs.read', 'fs.write', 'net', 'window'],
};

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    kind: 'module',
    visible: true,
    entry: 'index.js',
    iconName: 'Package',
    hostApiVersion: 1,
    ...overrides,
  };
}

function policy(
  granted: string[],
  opts: { commands?: string[]; trustedDev?: boolean; bundled?: boolean } = {},
): SandboxPolicy {
  return {
    rules: RULES,
    granted: new Set(granted),
    declaredCommands: opts.commands ? new Set(opts.commands) : null,
    trustedDev: !!opts.trustedDev,
    hasGrant: true,
    bundled: !!opts.bundled,
  };
}

describe('pluginAccess · 能力推导', () => {
  it('旧式 commands 自动推导能力', () => {
    const m = manifest({ permissions: { commands: ['plugin_storage_get', 'read_text_file'] } });
    expect(declaredCapabilities(RULES, m).sort()).toEqual(['fs.read', 'storage']);
  });

  it('新式 capabilities 优先且过滤未知能力', () => {
    const m = manifest({ permissions: { capabilities: ['net', 'no.such.capability'] } });
    expect(declaredCapabilities(RULES, m)).toEqual(['net']);
  });

  it('未声明权限 = 零能力', () => {
    expect(declaredCapabilities(RULES, manifest())).toEqual([]);
  });
});

describe('pluginAccess · 授权判定', () => {
  const declaredManifest = manifest({ permissions: { capabilities: ['fs.read'] } });

  it('内置插件缺授权也不阻塞，且视为全部声明能力已信任', () => {
    const state = evaluateAccess({ ...declaredManifest, origin: 'bundled' }, RULES, undefined);
    expect(state.needsConsent).toBe(false);
    expect(state.bundled).toBe(true);
    expect(state.missing).toEqual([]);
    expect(state.granted).toEqual(['fs.read']);
  });

  it('第三方插件缺能力 → 需要授权', () => {
    const state = evaluateAccess({ ...declaredManifest, origin: 'user' }, RULES, undefined);
    expect(state.needsConsent).toBe(true);
    expect(state.missing).toEqual(['fs.read']);
  });

  it('第三方插件已授全 → 不需授权', () => {
    const grant: PluginGrant = { capabilities: ['fs.read'] };
    const state = evaluateAccess({ ...declaredManifest, origin: 'user' }, RULES, grant);
    expect(state.needsConsent).toBe(false);
  });

  it('授权不能比 manifest 声明更宽', () => {
    const grant: PluginGrant = { capabilities: ['fs.read', 'net', 'fs.write'] };
    const state = evaluateAccess({ ...declaredManifest, origin: 'user' }, RULES, grant);
    expect(state.granted).toEqual(['fs.read']);
  });
});

describe('pluginAccess · 放行判断', () => {
  it('能力命中才放行', () => {
    expect(policyAllows(policy(['fs.read']), 'read_text_file')).toBe(true);
    expect(policyAllows(policy(['fs.read']), 'write_text_file')).toBe(false);
  });

  it('未归类的命令一律拒绝', () => {
    expect(policyAllows(policy(['fs.read', 'net'], { trustedDev: true }), 'delete_all_notes')).toBe(false);
  });

  it('旧式 commands 在能力之上收紧', () => {
    const p = policy(['fs.read'], { commands: ['read_text_file'] });
    expect(policyAllows(p, 'read_text_file')).toBe(true);
    expect(policyAllows(p, 'read_file_base64')).toBe(false);
  });

  it('开发信任跳过能力与命令收紧（仍要求命令已归类）', () => {
    const p = policy([], { trustedDev: true, commands: ['read_text_file'] });
    expect(policyAllows(p, 'write_text_file')).toBe(true);
    expect(policyAllows(p, 'delete_all_notes')).toBe(false);
  });
});


describe('pluginAccess · preparePluginAccess（内置自动批准 / 第三方待授权）', () => {
  const grantsStore: Record<string, PluginGrant> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    invalidateAccessCache();
    for (const k of Object.keys(grantsStore)) delete grantsStore[k];
    vi.mocked(api.pluginCapabilityRules).mockResolvedValue(RULES);
    vi.mocked(api.pluginGrantsAll).mockImplementation(async () => ({ ...grantsStore }));
    vi.mocked(api.pluginGrantSet).mockImplementation(async (args) => {
      const grant: PluginGrant = {
        capabilities: args.capabilities,
        trustedDev: args.trustedDev,
        manifestHash: args.manifestHash,
      };
      grantsStore[args.pluginId] = grant;
      return grant;
    });
  });

  it('内置插件：默认信任、不写授权账本，且可调用未声明的已归类命令', async () => {
    const m = manifest({ id: 'builtin', origin: 'bundled', permissions: { capabilities: ['fs.read'] } });
    const { state, policy } = await preparePluginAccess(m);
    expect(state.needsConsent).toBe(false);
    expect(state.bundled).toBe(true);
    expect(api.pluginGrantSet).not.toHaveBeenCalled();
    // 内置默认信任：manifest 没列出的 cancel_scan 也放行（命令已归类）
    expect(policyAllows(policy, 'netease_http_post')).toBe(true);
  });

  it('第三方插件：缺授权 → needsConsent，且不会自动写授权', async () => {
    const m = manifest({ id: 'third', origin: 'user', permissions: { capabilities: ['net'] } });
    const { state } = await preparePluginAccess(m);
    expect(state.needsConsent).toBe(true);
    expect(api.pluginGrantSet).not.toHaveBeenCalled();
  });

  it('第三方插件：已有完整授权 → 放行', async () => {
    grantsStore.third = { capabilities: ['net'] };
    const m = manifest({ id: 'third', origin: 'user', permissions: { capabilities: ['net'] } });
    const { state, policy } = await preparePluginAccess(m);
    expect(state.needsConsent).toBe(false);
    expect(policy.granted.has('net')).toBe(true);
  });

  it('第三方插件：manifest 新增能力 → 重新需要授权', async () => {
    grantsStore.third = { capabilities: ['net'] };
    const m = manifest({ id: 'third', origin: 'user', permissions: { capabilities: ['net', 'fs.write'] } });
    const { state } = await preparePluginAccess(m);
    expect(state.needsConsent).toBe(true);
    expect(state.missing).toEqual(['fs.write']);
  });
});
