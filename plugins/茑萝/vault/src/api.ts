/// <reference path="../../../global.d.ts" />
// 密码托管 · 后端契约（与 src-tauri/src/services/vault_service.rs 的 serde 字段一一对应）
// 所有调用都走宿主沙箱的 __HOST_API__.invoke；命令名已在 manifest.permissions.commands 声明。

export type ItemKind = 'login' | 'apiKey' | 'secureNote' | 'sshKey';

export interface CustomField {
  name: string;
  value: string;
  hidden: boolean;
}

export interface ItemVersion {
  atMs: number;
  title: string;
  username: string;
  password: string;
}

export interface VaultItem {
  id: string;
  kind: ItemKind;
  title: string;
  username: string;
  password: string;
  urls: string[];
  fields: CustomField[];
  notes: string;
  totpSecret: string;
  tags: string[];
  favorite: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  lastUsedAtMs: number;
  deletedAtMs: number | null;
  history: ItemVersion[];
}

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
  itemCount: number;
  trashedCount: number;
  hasDeviceSlot: boolean;
  recoverySlots: number;
  autoLockMin: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface AuditEntry {
  atMs: number;
  action: string;
  detail: string;
}

export interface CreateOutcome {
  recoveryCodes: string[];
  status: VaultStatus;
}

export interface RedeemOutcome {
  remainingRecoveryCodes: number;
  status: VaultStatus;
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return window.__HOST_API__.invoke<T>(cmd, args);
}

export const vaultApi = {
  status: () => invoke<VaultStatus>('vault_status'),
  create: (password: string, enableDeviceUnlock: boolean, autoLockMin?: number) =>
    invoke<CreateOutcome>('vault_create', { password, enableDeviceUnlock, autoLockMin }),
  unlock: (password: string) => invoke<VaultStatus>('vault_unlock', { password }),
  unlockDevice: () => invoke<VaultStatus>('vault_unlock_device'),
  lock: () => invoke<VaultStatus>('vault_lock'),
  changePassword: (currentPassword: string, newPassword: string) =>
    invoke<VaultStatus>('vault_change_password', { currentPassword, newPassword }),
  rotateRecoveryCodes: () => invoke<string[]>('vault_rotate_recovery_codes'),
  redeemRecovery: (code: string, newPassword: string) =>
    invoke<RedeemOutcome>('vault_redeem_recovery', { code, newPassword }),
  list: () => invoke<VaultItem[]>('vault_list'),
  getItem: (id: string) => invoke<VaultItem>('vault_get_item', { id }),
  saveItem: (item: VaultItem) => invoke<VaultItem>('vault_save_item', { item }),
  deleteItem: (id: string, hard = false) => invoke<void>('vault_delete_item', { id, hard }),
  restoreItem: (id: string) => invoke<void>('vault_restore_item', { id }),
  emptyTrash: () => invoke<number>('vault_empty_trash'),
  markUsed: (id: string) => invoke<void>('vault_mark_used', { id }),
  setAutoLock: (minutes: number) => invoke<VaultStatus>('vault_set_auto_lock', { minutes }),
  auditLog: (limit = 50) => invoke<AuditEntry[]>('vault_audit_log', { limit }),
  exportJson: () => invoke<string>('vault_export_json'),
  importItems: (items: VaultItem[], mode: 'merge' | 'replace' = 'merge') =>
    invoke<number>('vault_import_items', { items, mode }),
};

export function blankItem(kind: ItemKind = 'login'): VaultItem {
  return {
    id: '',
    kind,
    title: '',
    username: '',
    password: '',
    urls: [],
    fields: [],
    notes: '',
    totpSecret: '',
    tags: [],
    favorite: false,
    createdAtMs: 0,
    updatedAtMs: 0,
    lastUsedAtMs: 0,
    deletedAtMs: null,
    history: [],
  };
}

export const KIND_LABEL: Record<ItemKind, string> = {
  login: '网站账号',
  apiKey: 'API Key',
  secureNote: '安全笔记',
  sshKey: 'SSH 私钥',
};

/** 常用站点：新建时给域名匹配做提示，不参与任何网络请求。 */
export const COMMON_SITES = [
  'github.com',
  'gitlab.com',
  'mail.google.com',
  'accounts.google.com',
  'microsoft.com',
  'apple.com',
  'bilibili.com',
  'music.163.com',
  'aliyun.com',
  'cloudflare.com',
];
