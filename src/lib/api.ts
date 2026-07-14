import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emit } from '@tauri-apps/api/event';

// 定义笔记的数据类型（与 Rust 端保持一致）
export interface NoteInfo {
  id: string;
  title: string;
  date: string;
  pinned?: boolean;
}

// 插件 Manifest 结构（与 Rust 端 PluginManifest 对应，camelCase 序列化）
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  kind: 'module' | 'service';
  visible: boolean;
  entry: string;
  iconName: string;
  hostApiVersion: number;
  deps?: string[];
  parent?: string;          // 子插件归属的父模块 id
  path?: string;            // 相对 bundled-plugins/ 的路径（嵌套子插件用）
  minAppVersion?: string;   // 要求的最低应用版本
  codename?: string;        // 模块代号（如 "铃兰"、"莲花"），空表示无代号
  requiredAssets?: string[];// 需要的外部依赖资源路径（如 "niaoluo/ide/codemirror/index.js"）
  capabilities?: string[];  // 插件能力声明（如 "file-system"、"network"）
}

// 扫描结果（A.1 改造后）
export interface PluginScanResult {
  valid: PluginManifest[];
  rejected: RejectedPlugin[];
}

export interface RejectedPlugin {
  folderName: string;
  reason: string;
}

// 中转站文件信息
export interface TransferStationFile {
  fileId: string;
  fileName: string;
  size: number;
  modified: string;
  isBackup: boolean;
}

// 中转站暂存文件（文件系统扫描，含拖入文件与解析抽取的图片）
export interface ImportedFile {
  fileId: string;
  originalName: string;
  extension: string;
  size: number;
  storedPath: string;
  absolutePath: string;
  importedAt: string;
  isReadable: boolean;
}

// 通用存档快照（笔记 / 文件 / 图片）
export interface ArchiveEntry {
  id: string;
  kind: string; // note | file | image
  sourceId: string;
  name: string;
  ext: string;
  size: number;
  modified: string;
}

// 封装 API 调用
export const api = {
  // 获取所有笔记
  getAllNotes: () => invoke<NoteInfo[]>('get_all_notes'),
  
  // 获取单篇笔记内容
  getNoteContent: (noteId: string) => invoke<{ title: string, content: string }>('get_note_content', { noteId }),
  
  // 保存笔记
  saveNote: (noteId: string, title: string, content: string) => 
    invoke<void>('save_note', { noteId, title, content }),
  
  // 删除笔记
  deleteNote: (noteId: string) => invoke<void>('delete_note', { noteId }),
  
  // 复制笔记
  duplicateNote: (noteId: string) => invoke<string>('duplicate_note', { noteId }),
  
  // 置顶笔记
  togglePinNote: (noteId: string) => invoke<void>('toggle_pin_note', { noteId }),

  // 批量搜索笔记内容（Rust 端一次性扫描，返回匹配的 noteId 列表）
  searchNotesContent: (query: string) => invoke<string[]>('search_notes_content', { query }),

  // 创建浮窗笔记子窗口
  // 改用前端 WebviewWindow API 建窗：规避 Windows 上在命令里用
  // run_on_main_thread 同步 WebviewWindowBuilder::build() 导致的 WebView2
  // 主线程「重入死锁」（build 等待的创建完成回调需要被同一消息循环派发，而
  // 该闭包正占用着消息循环）→ 整个应用卡死。Tauri 官方运行时建窗路径由
  // 框架内部正确在主线程创建窗口，不会重入死锁。
  createFloatingNoteWindow: async (noteId: string, title: string, x: number, y: number) => {
    const label = `floating-note-${noteId}`;
    // getByLabel 返回 Promise<WebviewWindow | null>，必须 await
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      existing.show().catch(() => {});
      existing.setFocus().catch(() => {});
      return;
    }
    const win = new WebviewWindow(label, {
      url: `index.html?floating=true&noteId=${encodeURIComponent(noteId)}`,
      title,
      width: 480,
      height: 420,
      minWidth: 300,
      minHeight: 200,
      decorations: false,
      resizable: true,
      transparent: true, // 浮窗 30% 透明效果：窗口本身必须透明，CSS 背景透明才有意义
      x,
      y,
    });
    win.once('tauri://created', () => {
      emit('floating-note-opened', noteId).catch(() => {});
    });
    win.once('tauri://error', (e: unknown) => {
      console.error('[api] 创建浮窗窗口失败:', e);
    });
  },

  // 标签系统
  getNoteTags: (noteId: string) => invoke<string[]>('get_note_tags', { noteId }),
  setNoteTags: (noteId: string, tags: string[]) => invoke<void>('set_note_tags', { noteId, tags }),
  getAllTags: () => invoke<string[]>('get_all_tags'),
  getAllNoteTagsMap: () => invoke<Record<string, string[]>>('get_all_note_tags_map'),
  
  // 获取已安装插件列表（返回校验过的 valid + rejected）
  getInstalledPlugins: () => invoke<PluginScanResult>('get_installed_plugins'),
  // 强制刷新插件扫描缓存（用于手动检测新插件）
  refreshPlugins: () => invoke<PluginScanResult>('refresh_plugins'),
  
  // 读取插件文件内容
  readPluginFile: (pluginId: string, fileName: string) => 
    invoke<string>('read_plugin_file', { pluginId, fileName }),

  // 设置插件可见性（启用/禁用，重启后生效）
  setPluginVisibility: (pluginId: string, visible: boolean) =>
    invoke<void>('set_plugin_visibility', { pluginId, visible }),

  // 列出中转站文件
  listTransferStationFiles: () => invoke<TransferStationFile[]>('list_transfer_station_files'),

  // 中转站交互：还原 / 删除 / 清空
  restoreTransferStationFile: (fileName: string, isBackup: boolean) =>
    invoke<void>('restore_transfer_station_file', { fileName, isBackup }),
  deleteTransferStationFile: (fileName: string, isBackup: boolean) =>
    invoke<void>('delete_transfer_station_file', { fileName, isBackup }),
  clearTransferStation: () => invoke<number>('clear_transfer_station'),

  // 列出中转站暂存文件（文件系统扫描，含解析抽取的图片）
  listDropzoneFiles: () => invoke<ImportedFile[]>('list_dropzone_files'),
  // 以 base64 data URL 读取中转站文件（备用）
  readDropzoneBase64: (storedPath: string) =>
    invoke<string>('read_dropzone_base64', { storedPath }),
  // 为「拖出到系统」准备带原始文件名的导出副本，返回绝对路径（前端以 file:// 拖出真实文件）
  prepareDropExport: (storedPath: string, originalName: string) =>
    invoke<string>('prepare_drop_export', { storedPath, originalName }),
  // 导入图片到图标栏中转站（复制进 dropzone），返回指向该副本的 localimg:// 引用
  addImageToDropzone: (sourcePath: string, originalName: string) =>
    invoke<string>('add_image_to_dropzone', { sourcePath, originalName }),
  // 同上，但接收前端 File 的 base64（HTML5 拖入/粘贴，无本地路径）
  addImageBytesToDropzone: (base64: string, originalName: string) =>
    invoke<string>('add_image_bytes_to_dropzone', { base64, originalName }),
  // 导入任意文件字节到图标栏中转站（HTML5 拖入场景，无本地路径），返回 ImportedFile 元信息
  addBytesToDropzone: (base64: string, originalName: string) =>
    invoke<ImportedFile>('add_bytes_to_dropzone', { base64, originalName }),
  // 「保存到…」：把中转站文件导出到用户选择的任意路径
  exportDropzoneFile: (storedPath: string, destPath: string) =>
    invoke<void>('export_dropzone_file', { storedPath, destPath }),

  // ===== 通用存档（快照）=====
  archiveSnapshot: (
    kind: string,
    sourceId: string,
    name: string,
    contentBase64: string,
    ext: string,
  ) => invoke<void>('archive_snapshot', { kind, sourceId, name, contentBase64, ext }),
  listArchives: () => invoke<ArchiveEntry[]>('list_archives'),
  restoreArchive: (id: string) => invoke<void>('restore_archive', { id }),
  deleteArchive: (id: string) => invoke<void>('delete_archive', { id }),
  clearArchives: () => invoke<number>('clear_archives'),

  // 托盘模式：切换/获取
  toggleTrayMode: (enabled: boolean) => invoke<void>('toggle_tray_mode', { enabled }),
  getTrayMode: () => invoke<boolean>('get_tray_mode'),
};