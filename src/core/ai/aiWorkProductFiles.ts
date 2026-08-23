// AIWork 产物「落盘到文件」：目录配置（保存主目录 / 收藏 / 待决）+ 写 / 删 / 移封装。
// 产物产出即导出为 {name}.md 到保存主目录（未配置时仅保留记录不落盘）；
// 右键「收藏」「待决」把文件移到对应目录；「删除」移除记录并删除本地文件。
import { invoke } from '@tauri-apps/api/core';
import { storage } from '@/core/storage';

export interface AiWorkDirs {
  /** 产物产出即自动导出的主目录 */
  saveDir: string;
  /** 右键「收藏」移到的目录 */
  favDir: string;
  /** 右键「待决」移到的目录 */
  pendingDir: string;
}

const DIRS_KEY = 'andeyunhui.aiwork.productDirs';
const DEFAULT_DIRS: AiWorkDirs = { saveDir: '', favDir: '', pendingDir: '' };

export function loadProductDirs(): AiWorkDirs {
  const got = storage.getJSON<Partial<AiWorkDirs>>(DIRS_KEY, {});
  return {
    saveDir: typeof got?.saveDir === 'string' ? got.saveDir : '',
    favDir: typeof got?.favDir === 'string' ? got.favDir : '',
    pendingDir: typeof got?.pendingDir === 'string' ? got.pendingDir : '',
  };
}

export function setProductDirs(dirs: AiWorkDirs): void {
  storage.setJSON(DIRS_KEY, dirs);
}

/** 把产出导出为 {name}.md 到主目录，返回绝对路径；未配置保存目录时返回 ''（不落盘）。 */
export async function exportProductToFile(content: string, name: string): Promise<string> {
  const dir = loadProductDirs().saveDir;
  if (!dir) return '';
  try {
    return await invoke<string>('ai_work_save_product_file', { dir, name, content });
  } catch (e) {
    console.warn('[aiwork] 产物落盘失败', e);
    return '';
  }
}

/** 删除某个产物的本地文件（path 为空则跳过）。 */
export async function deleteProductFile(path: string): Promise<void> {
  if (!path) return;
  try {
    await invoke('ai_work_delete_product_file', { path });
  } catch (e) {
    console.warn('[aiwork] 删除产物文件失败', e);
  }
}

/** 把产物文件移动到指定目录，返回新绝对路径；无 path / 目录未配置时返回 ''。 */
export async function moveProductFile(path: string, toDir: string): Promise<string> {
  if (!path || !toDir) return '';
  try {
    return await invoke<string>('ai_work_move_product_file', { from: path, toDir });
  } catch (e) {
    console.warn('[aiwork] 移动产物文件失败', e);
    return '';
  }
}