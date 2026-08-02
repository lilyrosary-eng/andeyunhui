// 茑萝 · IDE Agent 权限规则引擎
// 从 index.tsx 抽出 + 增强：在原有四档 PermissionMode 基础上增加 alwaysAllow/alwaysAsk/alwaysDeny 逐工具规则。
// 对齐 claw-code-main permissions.rs + learn-coding-agent 权限系统设计。

// ===== 四档权限模式（对齐 permissions.rs::PermissionMode）=====
export type PermissionMode = 'read-only' | 'plan' | 'normal' | 'dangerous';

export const PERMISSION_MODES: PermissionMode[] = ['read-only', 'plan', 'normal', 'dangerous'];

export const PERMISSION_MODE_META: Record<PermissionMode, { label: string; chip: string; cls: string; desc: string }> = {
  'read-only': { label: '只读', chip: '🟢', cls: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10', desc: '仅允许读取/搜索，禁止任何写入/Shell/MCP 操作' },
  'plan': { label: '计划', chip: '🔵', cls: 'text-blue-600 dark:text-blue-400 bg-blue-500/10', desc: '仅允许读取与制定计划，禁止写入/Shell/MCP 执行' },
  'normal': { label: '正常', chip: '🟡', cls: 'text-amber-600 dark:text-amber-400 bg-amber-500/10', desc: '允许读取/写入/编辑/只读 Shell，破坏性操作需确认' },
  'dangerous': { label: '高危', chip: '🔴', cls: 'text-red-600 dark:text-red-400 bg-red-500/10', desc: '破坏性操作需 approval="token" 属性，token 一次性使用' },
};

// ===== 逐工具权限规则（新增：alwaysAllow / alwaysAsk / alwaysDeny）=====
// 用户可为特定工具设置独立规则，覆盖 PermissionMode 默认行为。
// 例：alwaysDeny bash → 即使 dangerous 模式也禁止 Shell；alwaysAllow file_read → 只读模式也放行（不适用，read-only 已放行）
export type PermissionRule = 'alwaysAllow' | 'alwaysAsk' | 'alwaysDeny';

// 工具名 → 规则（持久化到 localStorage）
const PERMISSION_OVERRIDES_KEY = 'ide-agent-permission-overrides';

export function loadPermissionOverrides(): Record<string, PermissionRule> {
  try {
    const raw = localStorage.getItem(PERMISSION_OVERRIDES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export function savePermissionOverrides(overrides: Record<string, PermissionRule>): void {
  try { localStorage.setItem(PERMISSION_OVERRIDES_KEY, JSON.stringify(overrides)); } catch { /* 忽略 */ }
}

export function setToolPermission(toolName: string, rule: PermissionRule | null): void {
  const overrides = loadPermissionOverrides();
  if (rule === null) delete overrides[toolName];
  else overrides[toolName] = rule;
  savePermissionOverrides(overrides);
}

// ===== 许可令牌（对齐 approval_tokens.rs::one-shot）=====
export function generateApprovalToken(): string {
  // 6 位可读字符（大小写字母+数字），对齐 approval_tokens.rs::generate_token
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let t = '';
  for (let i = 0; i < 6; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

// 从标签字符串中提取 approval 属性（支持双引号或单引号）
export function extractApprovalAttr(tagStr: string): string | null {
  const m = tagStr.match(/\bapproval=(?:"([^"]*)"|'([^']*)')/);
  return m ? (m[1] || m[2] || null) : null;
}

// ===== 权限检查 =====
// opKind: 操作类别
// approval: 指令上的 approval 属性值（null=未提供）
// mode: 当前权限模式
// activeToken: 当前生效的许可令牌（仅 dangerous 模式）
// toolName: 工具名（用于查逐工具规则）
// overrides: 逐工具规则（可选，不传则从 localStorage 读取）
export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
  /** 是否需要弹窗确认（alwaysAsk 触发） */
  needAsk?: boolean;
}

export function checkPermission(
  opKind: 'write' | 'edit' | 'shell-destructive' | 'shell-readonly' | 'mcp' | 'subagent',
  approval: string | null,
  mode: PermissionMode,
  activeToken: string | null,
  toolName?: string,
  overrides?: Record<string, PermissionRule>,
): PermissionCheckResult {
  // 1) 逐工具规则优先（覆盖 PermissionMode 默认行为）
  const rules = overrides ?? loadPermissionOverrides();
  if (toolName && rules[toolName]) {
    const rule = rules[toolName];
    if (rule === 'alwaysDeny') return { allowed: false, reason: `🚫 工具「${toolName}」已被设为始终禁止` };
    if (rule === 'alwaysAsk') return { allowed: false, reason: `工具「${toolName}」需要确认`, needAsk: true };
    if (rule === 'alwaysAllow') return { allowed: true };
  }

  // 2) read-only 模式：仅放行只读操作
  if (mode === 'read-only') {
    if (opKind === 'shell-readonly') return { allowed: true };
    return { allowed: false, reason: '🚫 只读模式：禁止写入/编辑/Shell/MCP 操作' };
  }

  // 3) plan 模式：仅放行只读操作（同 read-only，但语义上是「制定计划阶段」）
  if (mode === 'plan') {
    if (opKind === 'shell-readonly') return { allowed: true };
    return { allowed: false, reason: '🚫 计划模式：仅允许读取与搜索，禁止执行写入/Shell/MCP' };
  }

  // 4) normal 模式：放行非破坏性操作，破坏性操作需确认
  if (mode === 'normal') {
    if (opKind === 'shell-destructive') return { allowed: false, reason: '⚠ 正常模式：破坏性 Shell 需切到高危模式或设为 alwaysAsk', needAsk: true };
    return { allowed: true };
  }

  // 5) dangerous 模式：破坏性操作需 approval token 匹配
  if (mode === 'dangerous') {
    const isDestructive = opKind === 'write' || opKind === 'edit' || opKind === 'shell-destructive' || opKind === 'mcp' || opKind === 'subagent';
    if (!isDestructive) return { allowed: true };
    if (!activeToken) return { allowed: false, reason: '🚫 高危模式：令牌已消费或未生成，请点击 🔑 生成新令牌' };
    if (!approval || approval !== activeToken) {
      return { allowed: false, reason: `🚫 高危模式：approval 属性缺失或不匹配（期望 "${activeToken}"，收到 "${approval || ''}"）。请在指令上加 approval="${activeToken}" 属性` };
    }
    return { allowed: true };
  }

  return { allowed: false, reason: '未知权限模式' };
}
