// 宿主侧密码库桥：自动填充只需要「状态 + 条目摘要 + 标记取用」三件事。
// 与插件里的 vault 插件共用同一批 Rust 命令，但宿主不受插件能力白名单限制。
import { invoke } from '@tauri-apps/api/core';

export type ItemKind = 'login' | 'apiKey' | 'secureNote' | 'sshKey';

export interface VaultItemSummary {
  id: string;
  kind: ItemKind;
  title: string;
  username: string;
  password: string;
  urls: string[];
  tags: string[];
  favorite: boolean;
  lastUsedAtMs: number;
  updatedAtMs: number;
  deletedAtMs: number | null;
}

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
  itemCount: number;
  hasDeviceSlot: boolean;
  recoverySlots: number;
  autoLockMin: number;
}

export async function getVaultStatus(): Promise<VaultStatus | null> {
  try {
    return await invoke<VaultStatus>('vault_status');
  } catch {
    return null;
  }
}

export async function listVaultItems(): Promise<VaultItemSummary[]> {
  try {
    const items = await invoke<VaultItemSummary[]>('vault_list');
    return items.filter((i) => !i.deletedAtMs);
  } catch {
    return [];
  }
}

export async function markVaultItemUsed(id: string): Promise<void> {
  try {
    await invoke('vault_mark_used', { id });
  } catch {
    // 时间戳写入失败不影响已完成的填充
  }
}
