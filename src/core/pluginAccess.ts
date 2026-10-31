// 插件能力模型（前端侧）
//
// - 规则来自 Rust（plugin_capability_rules）：命令 → 能力，新增命令族只需在 Rust 补一条规则；
// - 授权账本来自 Rust（plugin_grants.json）：内置插件自动批准，第三方/自研插件由用户在
//   设置 → 扩展 里确认；可勾选“开发信任”一次放行；
// - 沙箱只认能力集合，不再维护逐命令白名单。
import { api, type CapabilityRules, type PluginGrant, type PluginManifest } from '@/lib/api';

export const CAPABILITY_LABELS: Record<string, string> = {
  storage: '插件私有存储',
  'fs.read': '读取文件',
  'fs.write': '写入 / 删除 / 下载文件',
  'fs.pick': '弹出文件选择框',
  media: '图片 / 音视频 / 歌词处理',
  net: '访问外部网络',
  'clipboard.read': '读取剪贴板',
  'clipboard.write': '写入剪贴板',
  window: '浮窗 / 播放器状态 / 窗口',
  system: '进程 / 环境 / Git / Shell',
  ai: 'AI / 知识库 / MCP',
  data: '模块数据与配置（音乐库、会话等）',
  attack: '攻防工具集',
};

export const KNOWN_CAPABILITIES = Object.keys(CAPABILITY_LABELS);

export interface SandboxPolicy {
  rules: CapabilityRules;
  granted: Set<string>;
  /** 旧式 commands 声明（存在时用于收紧） */
  declaredCommands: Set<string> | null;
  trustedDev: boolean;
  hasGrant: boolean;
  /** 内置随包插件：辅助 API（创建浮窗 / 读媒体 blob）按可信处理 */
  bundled: boolean;
}

export interface AccessState {
  declared: string[];
  granted: string[];
  missing: string[];
  trustedDev: boolean;
  hasGrant: boolean;
  needsConsent: boolean;
  /** 官方内置（随包出厂）：默认信任，不参与逐项授权 */
  bundled: boolean;
}

let rulesCache: CapabilityRules | null = null;
let rulesPromise: Promise<CapabilityRules> | null = null;
let grantsCache: Record<string, PluginGrant> | null = null;
let grantsPromise: Promise<Record<string, PluginGrant>> | null = null;

export async function getCapabilityRules(): Promise<CapabilityRules> {
  if (rulesCache) return rulesCache;
  if (!rulesPromise) {
    rulesPromise = api
      .pluginCapabilityRules()
      .then((r) => {
        rulesCache = r;
        return r;
      })
      .finally(() => {
        rulesPromise = null;
      });
  }
  return rulesPromise;
}

export async function getPluginGrants(force = false): Promise<Record<string, PluginGrant>> {
  if (grantsCache && !force) return grantsCache;
  if (!grantsPromise) {
    grantsPromise = api
      .pluginGrantsAll()
      .then((g) => {
        grantsCache = g || {};
        return grantsCache;
      })
      .finally(() => {
        grantsPromise = null;
      });
  }
  return grantsPromise;
}

export function capabilityFor(rules: CapabilityRules, command: string): string | null {
  for (const [cmd, cap] of rules.exact) {
    if (cmd === command) return cap;
  }
  for (const [prefix, cap] of rules.prefix) {
    if (command.startsWith(prefix)) return cap;
  }
  return null;
}

function uniq(list: string[]): string[] {
  return [...new Set(list.filter(Boolean))];
}

/** 插件声明的能力：优先 capabilities；旧式 commands 自动推导。 */
export function declaredCapabilities(rules: CapabilityRules, manifest: PluginManifest): string[] {
  const explicit = manifest.permissions?.capabilities;
  if (Array.isArray(explicit)) return uniq(explicit.filter((c) => KNOWN_CAPABILITIES.includes(c)));
  const cmds = manifest.permissions?.commands;
  if (!Array.isArray(cmds)) return [];
  const caps: string[] = [];
  for (const c of cmds) {
    const cap = capabilityFor(rules, c);
    if (cap) caps.push(cap);
  }
  return uniq(caps);
}

export function manifestHash(manifest: PluginManifest): string {
  const raw = JSON.stringify({
    id: manifest.id,
    version: manifest.version,
    permissions: manifest.permissions ?? null,
  });
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export function evaluateAccess(
  manifest: PluginManifest,
  rules: CapabilityRules,
  grant: PluginGrant | undefined,
): AccessState {
  const declared = declaredCapabilities(rules, manifest);
  // 授权不能比当前声明更宽：manifest 删掉的能力立即失效（重新加回需要再确认）。
  const granted = uniq(grant?.capabilities ?? []).filter((c) => declared.includes(c));
  const bundled = manifest.origin === 'bundled';
  // 官方内置插件随包出厂、随应用签名发布：默认完全信任，不走逐项授权。
  const missing = bundled ? [] : declared.filter((c) => !granted.includes(c));
  const trustedDev = !!grant?.trustedDev;
  const needsConsent = !bundled && !trustedDev && missing.length > 0;
  return {
    declared,
    // 内置插件展示“全部声明能力已信任”，便于 UI 说明
    granted: bundled ? declared : granted,
    missing,
    trustedDev,
    hasGrant: !!grant,
    needsConsent,
    bundled,
  };
}

export interface PreparedAccess {
  state: AccessState;
  policy: SandboxPolicy;
}

/**
 * 载入/启用插件前的准备：
 * - 内置插件自动把声明能力写进账本（首次运行即可用）；
 * - 第三方插件缺少授权时返回 needsConsent（调用方不要执行脚本）。
 */
export async function preparePluginAccess(manifest: PluginManifest): Promise<PreparedAccess> {
  const rules = await getCapabilityRules();
  let grants = await getPluginGrants();
  let grant: PluginGrant | undefined = grants[manifest.id];
  const bundled = manifest.origin === 'bundled';

  // 内置插件不再写授权账本（默认信任）；顺手清掉历史遗留的内置 entries。
  if (bundled && grant) {
    try {
      await api.pluginGrantClear(manifest.id);
    } catch { /* 清理失败不影响默认信任 */ }
    if (grantsCache) {
      const next = { ...grantsCache };
      delete next[manifest.id];
      grantsCache = next;
    }
    grant = undefined;
  }

  const state = evaluateAccess(manifest, rules, grant);
  const policy: SandboxPolicy = {
    rules,
    granted: new Set(state.granted),
    declaredCommands: Array.isArray(manifest.permissions?.commands)
      ? new Set(manifest.permissions!.commands!)
      : null,
    trustedDev: state.trustedDev,
    hasGrant: state.hasGrant,
    bundled,
  };
  return { state, policy };
}

/** 用户在扩展页确认授权（可选“开发信任”）。 */
export async function approvePluginAccess(
  manifest: PluginManifest,
  trustedDev: boolean,
): Promise<void> {
  const rules = await getCapabilityRules();
  const declared = declaredCapabilities(rules, manifest);
  const grant = await api.pluginGrantSet({
    pluginId: manifest.id,
    capabilities: declared,
    trustedDev,
    manifestHash: manifestHash(manifest),
  });
  grantsCache = { ...(grantsCache ?? {}), [manifest.id]: grant };
  window.dispatchEvent(new CustomEvent('plugin-access-changed', { detail: { id: manifest.id } }));
}

export async function revokePluginAccess(pluginId: string): Promise<void> {
  await api.pluginGrantClear(pluginId);
  if (grantsCache) {
    const next = { ...grantsCache };
    delete next[pluginId];
    grantsCache = next;
  }
  window.dispatchEvent(new CustomEvent('plugin-access-changed', { detail: { id: pluginId } }));
}

export function invalidateAccessCache(): void {
  grantsCache = null;
  grantsPromise = null;
  rulesCache = null;
  rulesPromise = null;
}


/** 沙箱放行判断（唯一入口） */
export function policyAllows(policy: SandboxPolicy, command: string): boolean {
  const cap = capabilityFor(policy.rules, command);
  if (!cap) return false;
  // 官方内置 / 显式开发信任：跳过能力集合与旧式 commands 收紧（命令仍须已归类）
  if (policy.bundled || policy.trustedDev) return true;
  if (!policy.granted.has(cap)) return false;
  if (policy.declaredCommands && !policy.declaredCommands.has(command)) return false;
  return true;
}

/** 拒绝原因（给插件开发者可执行的修复提示） */
export function policyDenyReason(policy: SandboxPolicy, command: string): string {
  const cap = capabilityFor(policy.rules, command);
  if (!cap) {
    return `宿主尚未给命令 "${command}" 归类能力 —— 需要宿主在 plugin_access.rs 里补一条命令→能力规则`;
  }
  if (!policy.granted.has(cap)) {
    return `插件缺少能力 "${cap}" —— 请在 设置 → 扩展 → 该插件 中授权，或在 manifest.permissions.capabilities 声明 "${cap}"`;
  }
  return `manifest.permissions.commands 未列出 "${command}"（旧式逐命令声明只允许列出更少的命令）`;
}

/** 没有授权上下文时的默认策略：全部拒绝 */
export function denyAllPolicy(): SandboxPolicy {
  return {
    rules: { exact: [], prefix: [], capabilities: [] },
    granted: new Set(),
    declaredCommands: null,
    trustedDev: false,
    hasGrant: false,
    bundled: false,
  };
}
