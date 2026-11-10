import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { ensureOverlayWindow } from '@/core/overlayWindow';
import { EVENTS } from '@/core/events/schema';
import type { TranslateSettings, TranslateResult, DocTranslateOutcome } from './translateLanguages';

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
  requiredAssets?: string[];// 需要的外部依赖资源路径（如 "茑萝/ide/codemirror/index.js"）
  // 声明式权限：能力优先（permissions.capabilities）；commands 为旧式逐命令声明，
  // 保留兼容并在能力集合之上进一步收紧。
  // 与 Rust 端 PluginManifest.permissions 对应；沙箱按「能力规则 + 已授权能力」强制。
  permissions?: PluginPermissions;
  /** 来源："bundled"（随包出厂，能力自动批准）| "user"（第三方，需要用户授权） */
  origin?: 'bundled' | 'user' | string;
}

/** 插件声明式权限（manifest.json 的 `permissions` 段） */
export interface PluginPermissions {
  /** 推荐：能力清单（storage / fs.read / fs.write / fs.pick / media / net /
   *  clipboard.read / clipboard.write / window / system / ai / data / attack）。 */
  capabilities?: string[];
  /** 旧式：允许调用的 Tauri 命令名（存在时在能力集合上再收紧）。 */
  commands?: string[];
}

/** 命令 → 能力规则（Rust 端数据驱动下发） */
export interface CapabilityRules {
  exact: [string, string][];
  prefix: [string, string][];
  capabilities: string[];
}

/** 授权范围（目前用于写入校验；读范围预留） */
export interface GrantScopes {
  fsRead?: string[];
  fsWrite?: string[];
  net?: string[];
}

/** 插件授权账本条目 */
export interface PluginGrant {
  capabilities: string[];
  trustedDev?: boolean;
  manifestHash?: string;
  updatedAt?: number;
  scopes?: GrantScopes;
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

// 启动守卫状态（services/boot_guard.rs）
export interface BootGuardState {
  /** 连续未确认的启动次数 */
  attempts: number;
  /** 上次成功启动时间（秒） */
  lastOkAt: number;
  /** 上次成功启动时实际加载的插件 id */
  lastOkPlugins: string[];
  /** 上次自动回滚禁用的插件（提示用，用户手动恢复后移除） */
  lastRollback: string[];
  /** 是否需要跳过全部插件加载（命令行安全模式或强制安全模式） */
  safeMode: boolean;
  /** 回滚无效后的强制安全模式 */
  forceSafeMode: boolean;
}

// 安装基线变更集（services/changeset_service.rs）
// 只读对照：永远是「刚下载的版本 → 当前」，与 AI 编程自带的会话审阅互相独立。
export interface ChangesetFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface ChangesetSummary {
  pluginId: string;
  /** 当前 manifest 版本 */
  version: string;
  /** 基线建立时间（秒） */
  baselineAt: number;
  /** 应用升级后插件版本变了，但用户有本地改动，基线未自动滚动 */
  baselineStale: boolean;
  files: ChangesetFile[];
  additions: number;
  deletions: number;
}

// 高危文件草稿（services/draft_service.rs）
// AI 改插件清单 / 插件入口 / 宿主核心文件时先落草稿，用户确认后才写回磁盘。
export interface DraftMeta {
  id: string;
  /** 目标绝对路径 */
  path: string;
  /** 所属插件；宿主核心文件为 null */
  pluginId: string | null;
  kind: 'manifest' | 'entry' | 'host-core';
  source: 'ai' | 'user';
  sessionId: string;
  createdAt: number;
  size: number;
  targetExists: boolean;
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
  /** 来源：`local` = 本机（拖入/导入/截图/录屏），`external` = 外部下载 */
  origin: string;
}

// 通用存档快照（笔记 / 文件 / 图片）—— 设置页里它扮演的是**回收站**
export interface ArchiveEntry {
  id: string;
  kind: string; // note | file | image
  sourceId: string;
  name: string;
  ext: string;
  size: number;
  modified: string;
  /** 快照对应的原始绝对路径；还原时优先回到这里。旧数据可能没有。 */
  originPath?: string | null;
}

/** 回收站用量（设置页展示「占多少 / 上限多少」） */
export interface ArchiveUsage {
  count: number;
  totalBytes: number;
  limitBytes: number;
  limitEntries: number;
}

/**
 * 中转站条目。**这是一条索引，不是文件**。
 *
 * - `ownership: 'managed'` —— 文件在中转站的 dropzone 目录里，中转站拥有它；
 * - `ownership: 'referenced'` —— 文件在用户自己的目录里，中转站只是"记得"它。
 *
 * 所有权决定删除语义：managed 可以删（只是扔掉自己的副本，且会先进回收站），
 * referenced 千万别删文件 —— 那是用户唯一一份。
 *
 * 所有操作都用 `id`，**不要**把 `path` 传给后端（后端只认 id，路径由它自己查）。
 */
export interface StationEntry {
  id: string;
  name: string;
  path: string;
  size: number;
  extension: string;
  modifiedAt: string;
  addedAt: string;
  ownership: 'managed' | 'referenced';
  source: string;
  status: 'ok' | 'missing';
  isReadable: boolean;
  downloadId?: string;
}

export interface StationList {
  entries: StationEntry[];
  /** 降级提示（下载记录读取失败 / 索引写不进去 / 条目已丢失）。非空时必须展示。 */
  notices: string[];
}

export interface StationRemoveOutcome {
  deletedFile: boolean;
  archived: boolean;
  /** 非空表示这次操作用户必须知道的事（比如回收站没进去、删除不可撤销） */
  notice?: string | null;
}

export interface StationRelocateResult {
  path: string;
  notice?: string | null;
  /** 是否走了跨卷的流式复制（而不是瞬时改名）—— 据此决定要不要提示耗时。 */
  streamed: boolean;
}

/** 移动进度（`station-move-progress` 事件负载）。 */
export interface StationMoveProgress {
  id: string;
  done: number;
  total: number;
}

/** 拖入/导入一批路径的结果。 */
export interface StationIngestResult {
  entries: StationEntry[];
  /** 没有被收下的原因（不存在 / 已在站内 / 复制失败 / 非绝对路径）。必须显示。 */
  notices: string[];
}

/** 中转站存储概况（设置页展示 + 「打开文件夹」落点）。 */
export interface StationStorageInfo {
  root: string;
  dropzonePath: string;
  archivesPath: string;
  dropzoneBytes: number;
  dropzoneCount: number;
  archiveBytes: number;
  archiveCount: number;
  /** 文档解析抽取的图片（不属于"中转站文件"，单列是为了不误判） */
  mediaBytes: number;
  mediaCount: number;
  /** 笔记首次备份 */
  backupBytes: number;
  backupCount: number;
  totalBytes: number;
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

  // 常用笔记
  toggleFavoriteNote: (noteId: string) => invoke<boolean>('toggle_favorite_note', { noteId }),
  getAllFavorites: () => invoke<string[]>('get_all_favorites'),
  getNextFavorite: () => invoke<string | null>('get_next_favorite'),

  // 创建浮窗笔记子窗口
  // 改用前端 WebviewWindow API 建窗：规避 Windows 上在命令里用
  // run_on_main_thread 同步 WebviewWindowBuilder::build() 导致的 WebView2
  // 主线程「重入死锁」（build 等待的创建完成回调需要被同一消息循环派发，而
  // 该闭包正占用着消息循环）→ 整个应用卡死。Tauri 官方运行时建窗路径由
  // 框架内部正确在主线程创建窗口，不会重入死锁。
  // 注意：_title 保留在签名里只为兼容既有调用方（拖拽创建浮窗时一直带着标题）。
  // 当前 URL 不带标题——浮窗标题由 FloatingNoteView 自己按 noteId 加载后设置；
  // 若将来要把标题预填进窗口，直接把这个参数用起来即可。
  createFloatingNoteWindow: async (noteId: string, _title: string, x: number, y: number) => {
    const label = `floating-note-${noteId}`;
    // 把主窗口当前生效字体作为 URL 参数带给浮窗：浮窗 webview 的 localStorage 可能与主窗隔离，
    // 单靠事件只覆盖"设置变更"时刻；创建时直接带过去可保证浮窗打开即用应用内统一字体。
    let fontParam = '';
    try {
      const applied = document.body.style.fontFamily || '';
      const m = applied.match(/^"([^"]+)"/);
      if (m) fontParam = m[1];
    } catch { /* ignore */ }
    // 统一走 window_manager 引擎：主线程安全创建 + 重试 + 坏窗自愈；复用（已存在）由引擎内部处理
    const win = await ensureOverlayWindow(label, `index.html?floating=true&noteId=${encodeURIComponent(noteId)}${fontParam ? `&fontFamily=${encodeURIComponent(fontParam)}` : ''}`, {
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
    if (win) {
      await win.show().catch(() => {});
      await win.setFocus().catch(() => {});
      emit(EVENTS.notes.opened, noteId).catch(() => {});
    }
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

  // 启动守卫状态：安全模式 / 上次连续启动失败后被自动禁用的插件
  getBootGuardState: () => invoke<BootGuardState>('boot_guard_state'),
  // 首屏渲染成功后确认「能启动」；传 pluginIds 时更新自动回滚的成功基线
  bootGuardOk: (pluginIds?: string[] | null) =>
    invoke<void>('boot_guard_ok', { pluginIds: pluginIds ?? null }),
  // 用户手动恢复某个被自动禁用的插件后，从提示名单里移除
  bootGuardClearRollback: (pluginId: string) =>
    invoke<void>('boot_guard_clear_rollback', { pluginId }),
  // 退出强制安全模式（清除标记与回滚提示），随后 reload 让插件重新加载
  bootGuardExitSafeMode: () => invoke<void>('boot_guard_exit_safe_mode'),

  // ===== 安装基线变更集（额外的一层只读对照，不影响 AI 编程的会话审阅） =====
  changesetSummary: (pluginId: string) =>
    invoke<ChangesetSummary>('changeset_summary', { pluginId }),
  changesetDiff: (pluginId: string, path: string) =>
    invoke<string>('changeset_diff', { pluginId, path }),
  changesetRestoreFile: (pluginId: string, path: string) =>
    invoke<boolean>('changeset_restore_file', { pluginId, path }),
  changesetRestoreAll: (pluginId: string) =>
    invoke<{ restored: number; removed: number }>('changeset_restore_all', { pluginId }),
  changesetResetBaseline: (pluginId: string) =>
    invoke<void>('changeset_reset_baseline', { pluginId }),
  changesetExportPatch: (pluginId: string) =>
    invoke<string>('changeset_export_patch', { pluginId }),
  changesetPackPlugin: (pluginId: string) =>
    invoke<string>('changeset_pack_plugin', { pluginId }),
  changesetRevealFile: (path: string) =>
    invoke<void>('changeset_reveal_file', { path }),

  // ===== 高危文件草稿区（AI 写入先暂存，用户确认才生效） =====
  draftList: (pluginId?: string | null) =>
    invoke<DraftMeta[]>('draft_list', { pluginId: pluginId ?? null }),
  draftRead: (id: string) => invoke<string>('draft_read', { id }),
  draftDiff: (id: string) => invoke<string>('draft_diff', { id }),
  draftApply: (id: string) => invoke<DraftMeta>('draft_apply', { id }),
  draftDiscard: (id: string) => invoke<void>('draft_discard', { id }),

  // 彻底删除插件（连同文件 + .mufurong 包 + 可见性记录）
  deletePlugin: (pluginId: string) =>
    invoke<void>('delete_plugin', { pluginId }),

  // 在系统文件管理器中打开插件所在目录
  openPluginFolder: (pluginId: string) =>
    invoke<void>('open_plugin_folder', { pluginId }),

  // 插件能力规则（数据驱动，前端不再维护命令白名单）
  pluginCapabilityRules: () => invoke<CapabilityRules>('plugin_capability_rules'),
  // 全部插件授权账本
  pluginGrantsAll: () => invoke<Record<string, PluginGrant>>('plugin_grants_all'),
  // 写入/更新单个插件授权；返回落盘后的 grant
  pluginGrantSet: (args: {
    pluginId: string;
    capabilities: string[];
    trustedDev: boolean;
    manifestHash: string;
    scopes?: GrantScopes;
  }) => invoke<PluginGrant>('plugin_grant_set', args),
  // 撤销授权（删除插件时后端也会自动清）
  pluginGrantClear: (pluginId: string) => invoke<void>('plugin_grant_clear', { pluginId }),

  // AI 视觉 OCR：传入图片 base64（不含 data: 前缀）+ mime + 可选 prompt，返回识别文本
  // 失败时抛错（含 HTTP 状态码 + 响应体片段），调用方需 try/catch 并展示降级提示
  aiVisionOcr: (imageBase64: string, imageMime: string, prompt?: string, profileId?: string) =>
    invoke<string>('ai_vision_ocr', { imageBase64, imageMime, prompt, profileId }),

  // 多节点翻译：免费节点（Bing / MyMemory）、AI、百度、有道、DeepL、LibreTranslate…
  // 返回**结构化结果**（译文 + 实际节点 + 源语言识别 + 所有显式提示 + 诊断）。
  // settings 里带节点/凭证/链顺序/术语表；不传也能用（落默认链，无需任何 key）。
  translateText: (text: string, targetLang?: string, sourceLang?: string, settings?: TranslateSettings) =>
    invoke<TranslateResult>('translate_text', { text, targetLang, sourceLang, settings }),

  // 文档「格式保留」翻译：docx / pptx **原地回填**。
  // 样式、表格、图片、页眉页脚都不动，只替换文字；**原文件一个字节都不改**，
  // 默认另存为 `<原名>.<目标语言>.<扩展名>`。返回结构化结果（含所有提示，不截断）。
  // PDF 暂不支持：它没有 OOXML 的「文本节点 + 样式」结构，硬做只会毁版面。
  translateDocument: (
    path: string,
    targetLang?: string,
    sourceLang?: string,
    settings?: TranslateSettings,
    outPath?: string,
  ) =>
    invoke<DocTranslateOutcome>('translate_document', {
      path,
      targetLang,
      sourceLang,
      settings,
      outPath,
    }),

  // PDF 翻译：提取文本 → 翻译 → 输出 docx（装了 LibreOffice 时可再转回 PDF）。
  // ⚠️ 只做尝试：**不保留原版面**，输出是重排后的新文档；原 PDF 不会被修改。
  translatePdf: (
    path: string,
    targetLang?: string,
    sourceLang?: string,
    settings?: TranslateSettings,
    outPath?: string,
    toPdf?: boolean,
  ) =>
    invoke<DocTranslateOutcome>('translate_pdf', {
      path,
      targetLang,
      sourceLang,
      settings,
      outPath,
      toPdf,
    }),

  // OCR 文本校对 / 整理：将 OCR 原文交给文本模型纠错整理（用于 DeepSeek 等不支持识图的模型）
  aiOcrEnhance: (text: string, profileId?: string) =>
    invoke<string>('ai_ocr_enhance', { text, profileId }),
  // 将 OCR 源图导出为保留原始版面的 PDF（图像保真，布局 100% 不变）
  ocrExportPdf: (path: string, imageBase64: string, mime: string) =>
    invoke<void>('ocr_export_pdf', { path, imageBase64, mime }),

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

  // ===== 中转站索引（只收 id，不收路径）=====
  /** 列出中转站全部条目：托管文件 + 已完成的下载。 */
  stationList: () => invoke<StationList>('station_list'),
  /**
   * 把一批**真实路径**收进中转站（拖入 / 导入的统一入口）。
   *
   * 直接传路径，**不经过 base64**：旧链路要前端先把整个文件读成 data URL 再传回，
   * 1 GB 的文件必然失败（字符串体积 1.37×，V8 单字符串有上限），中间还白落两次盘。
   *
   * `copyThreshold`：≤ 它则复制进中转站（自包含），> 它则只登记位置。缺省 100 MiB。
   */
  stationIngestPaths: (paths: string[], copyThreshold?: number) =>
    invoke<StationIngestResult>('station_ingest_paths', { paths, copyThreshold }),
  /** 中转站存储概况：根目录与各分项占用。 */
  stationStorageInfo: () => invoke<StationStorageInfo>('station_storage_info'),
  /**
   * 移除一条记录。**默认动作，不删用户的文件。**
   * 托管条目会先进回收站；引用条目只忘掉记录，磁盘文件一动不动。
   */
  stationRemoveRecord: (id: string) =>
    invoke<StationRemoveOutcome>('station_remove_record', { id }),
  /** 显式删除真实文件（第二动作，不可逆，UI 必须二次确认）。 */
  stationDeleteFile: (id: string) => invoke<void>('station_delete_file', { id }),
  /** 改名/移动。`newPath` 必须是绝对路径，返回实际落点。 */
  stationRelocate: (id: string, newPath: string) =>
    invoke<StationRelocateResult>('station_relocate', { id, newPath }),
  /**
   * 取消正在进行的移动（只有跨卷搬大文件才需要）。
   * 返回 true 表示确实中止了一个进行中的移动。
   */
  stationMoveCancel: () => invoke<boolean>('station_move_cancel'),

  // ===== 通用存档（快照）=====
  archiveSnapshot: (
    kind: string,
    sourceId: string,
    name: string,
    contentBase64: string,
    ext: string,
  ) => invoke<void>('archive_snapshot', { kind, sourceId, name, contentBase64, ext }),
  listArchives: () => invoke<ArchiveEntry[]>('list_archives'),
  archivesUsage: () => invoke<ArchiveUsage>('archives_usage'),
  /** 还原到原路径（原目录不可用时回退到中转站），返回实际写入的绝对路径。 */
  restoreArchive: (id: string) => invoke<string>('restore_archive', { id }),
  deleteArchive: (id: string) => invoke<void>('delete_archive', { id }),
  clearArchives: () => invoke<number>('clear_archives'),

  // 托盘模式：切换/获取
  toggleTrayMode: (enabled: boolean) => invoke<void>('toggle_tray_mode', { enabled }),
  getTrayMode: () => invoke<boolean>('get_tray_mode'),
};