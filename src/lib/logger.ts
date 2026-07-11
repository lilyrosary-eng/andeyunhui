// 开发环境日志工具：生产环境打包时自动被 tree-shaking 移除
// 运行时覆盖：生产环境排障时在 DevTools 执行 localStorage.setItem('log_level', 'debug') 即可开启调试日志
const isDev = import.meta.env.DEV || (typeof localStorage !== 'undefined' && localStorage.getItem('log_level') === 'debug');

export const logger = {
  log: (...args: unknown[]) => {
    if (isDev) console.log(...args);
  },

  /** DEBUG 级别日志：用于详细调试信息（如文件变动、状态同步等） */
  debug: (...args: unknown[]) => {
    if (isDev) console.debug(...args);
  },

  /** WARN 级别日志：生产环境也输出，用于捕获可恢复的异常 */
  warn: (...args: unknown[]) => {
    console.warn(...args);
  },

  /** ERROR 级别日志：生产环境也输出，用于捕获不可恢复的异常 */
  error: (...args: unknown[]) => {
    console.error(...args);
  },

  // ========== 笔记模块 ==========
  notes: {
    init: () => {
      if (isDev) console.log('[Notes] 初始化：加载笔记列表');
    },
    listLoaded: (count: number) => {
      if (isDev) console.log(`[Notes] 笔记列表加载完成，共 ${count} 篇`);
    },
    autoLoadFirst: (id: string) => {
      if (isDev) console.log('[Notes] 自动加载第一篇笔记:', id);
    },
    skipLoad: (id: string) => {
      if (isDev) console.log('[Notes] loadNoteContent 跳过：笔记已加载', id);
    },
    switchNote: (id: string) => {
      if (isDev) console.log('[Notes] loadNoteContent 切换笔记:', id);
    },
    contentLoaded: (id: string, title: string) => {
      if (isDev) console.log('[Notes] 笔记内容加载完成:', id, '标题:', title);
    },
    autoSaveTrigger: (id: string, title: string) => {
      if (isDev) console.log('[Notes] 自动保存触发:', id, '标题:', title);
    },
    render: (length: number) => {
      if (isDev) console.log('[Notes] Markdown 渲染，内容长度:', length);
    },
    create: (id: string) => {
      if (isDev) console.log('[Notes] 创建新笔记:', id);
    },
    refreshList: (count: number) => {
      if (isDev) console.log('[Notes] 刷新列表，笔记数:', count);
    },
    loadError: (operation: string, err: unknown) => {
      if (isDev) console.error(`[Notes] ${operation}失败`, err);
    },
    clearCurrent: () => {
      if (isDev) console.log('[Notes] 清空当前笔记');
    },
    toggleSettings: (show: boolean) => {
      if (isDev) console.log('[Notes] 切换笔记设置面板:', show);
    },
    floatingSnapBack: (id: string) => {
      if (isDev) console.log('[Notes] 浮窗吸附回列表:', id);
    },
    floatingCreated: (id: string) => {
      if (isDev) console.log('[Notes] 创建浮窗:', id);
    },
    floatingClosed: (id: string) => {
      if (isDev) console.log('[Notes] 关闭浮窗:', id);
    },
    floatingCopied: (id: string) => {
      if (isDev) console.log('[Notes] 复制浮窗内容:', id);
    },
    floatingDragged: (id: string) => {
      if (isDev) console.log('[Notes] 拖拽笔记成浮窗:', id);
    },
  },

  // ========== 侧边栏模块 ==========
  sidebar: {
    groupedRecalc: (noteCount: number, groupCount: number) => {
      if (isDev) console.log(`[Sidebar] groupedNotes 重新计算，笔记数: ${noteCount}, 分组数: ${groupCount}`);
    },
    search: (query: string) => {
      if (isDev) console.log('[Sidebar] 搜索输入:', query);
    },
    selectNote: (id: string, title: string) => {
      if (isDev) console.log('[Sidebar] 点击笔记:', id, title);
    },
    dragStart: (id: string, title: string) => {
      if (isDev) console.log('[Sidebar] 拖拽笔记:', id, title);
    },
    duplicate: (id: string) => {
      if (isDev) console.log('[Sidebar] 复制笔记:', id);
    },
    duplicateDone: () => {
      if (isDev) console.log('[Sidebar] 复制完成，刷新列表');
    },
    togglePin: (id: string) => {
      if (isDev) console.log('[Sidebar] 置顶笔记:', id);
    },
    deleteConfirm: (id: string) => {
      if (isDev) console.log('[Sidebar] 删除笔记确认:', id);
    },
    deleteConfirmed: (id: string) => {
      if (isDev) console.log('[Sidebar] 用户确认删除:', id);
    },
    deleteCurrent: () => {
      if (isDev) console.log('[Sidebar] 删除的是当前笔记，清空编辑区');
    },
  },

  // ========== 插件系统模块 ==========
  plugins: {
    pipelineStart: () => {
      if (isDev) console.log('[Plugins] ====== 插件加载流水线启动 ======');
    },
    stage0Done: (valid: number, rejected: number) => {
      if (isDev) console.log(`[Plugins] 阶段0 完成：有效 ${valid}, 拒绝 ${rejected}`);
    },
    stage0Failed: (err: unknown) => {
      if (isDev) console.error('[Plugins] 阶段0 失败：获取扫描结果出错', err);
    },
    scanRejected: (folder: string, reason: string) => {
      if (isDev) console.warn(`[Plugins] 扫描拒绝: ${folder} — ${reason}`);
    },
    noPlugins: () => {
      if (isDev) console.log('[Plugins] 无已安装插件，跳过后续阶段');
    },
    stage1Done: (compatible: number, total: number) => {
      if (isDev) console.log(`[Plugins] 阶段1 完成：兼容插件数 ${compatible}/${total}`);
    },
    versionRejected: (reason: string, id: string) => {
      if (isDev) console.warn(`[Plugins] ${reason}，跳过: ${id}`);
    },
    stage2Start: (count: number) => {
      if (isDev) console.log(`[Plugins] 阶段2：并行加载 ${count} 个插件`);
    },
    stage2Failed: (reason: string) => {
      if (isDev) console.error('[Plugins] 阶段2 加载失败:', reason);
    },
    stage3Fail: (id: string, reason: string) => {
      if (isDev) console.warn(`[Plugins] 阶段3 校验失败: ${id} — ${reason}`);
    },
    stage3FailCleanup: (id: string, reason: string) => {
      if (isDev) console.warn(`[Plugins] 阶段3 校验失败: ${id} — ${reason}，已清理`);
    },
    stage3Pass: (id: string, kind: string, visible: boolean) => {
      if (isDev) console.log(`[Plugins] 阶段3 通过: ${id} kind=${kind} visible=${visible}`);
    },
    pipelineDone: (success: number, total: number) => {
      if (isDev) console.log(`[Plugins] ====== 插件加载流水线完成: ${success}/${total} ======`);
    },
    perfReport: (report: Record<string, { avg: number; min: number; max: number }>) => {
      if (isDev) {
        console.log('[Plugins] 性能报告:');
        for (const [key, data] of Object.entries(report)) {
          console.log(`  ${key}: 平均 ${data.avg.toFixed(1)}ms, 最快 ${data.min.toFixed(1)}ms, 最慢 ${data.max.toFixed(1)}ms`);
        }
      }
    },
    errorBoundary: (id: string, msg: string) => {
      if (isDev) console.error('[Plugins] 插件崩溃:', id, msg);
    },
    disablePlugin: (id: string) => {
      if (isDev) console.log('[Plugins] 用户禁用插件:', id);
    },
    importSuccess: (id: string) => {
      if (isDev) console.log('[Plugins] 插件通过动态 import 加载成功:', id);
    },
    importSuccessDefault: (id: string) => {
      if (isDev) console.log('[Plugins] 插件通过动态 import(default) 加载成功:', id);
    },
    importFallback: (id: string, err: unknown) => {
      if (isDev) console.log('[Plugins] 动态 import 失败，回退沙箱:', id, err);
    },
    registryDuplicate: (id: string) => {
      if (isDev) console.warn(`[Plugins] 重复注册插件 id '${id}'，已跳过`);
    },
    perfWarn: (id: string, op: string, duration: number) => {
      if (isDev) console.warn(`[Plugins] ${id} ${op} 耗时过长: ${duration.toFixed(1)}ms`);
    },
    visibilityUpdated: (id: string, visible: boolean) => {
      if (isDev) console.log(`[Plugins] 插件可见性已更新: ${id}, visible=${visible} (重启后生效)`);
    },
    visibilityFailed: (id: string, err: unknown) => {
      if (isDev) console.error(`[Plugins] 插件可见性更新失败: ${id}`, err);
    },
    newPluginLoaded: (id: string) => {
      if (isDev) console.log('[Plugins] 新插件已加载:', id);
    },
    newPluginFailed: (id: string, err: unknown) => {
      if (isDev) console.error('[Plugins] 新插件加载失败:', id, err);
    },
  },

  // ========== 应用模块切换 ==========
  app: {
    switchModule: (id: string) => {
      if (isDev) console.log('[App] 切换模块:', id);
    },
    switchMainPlugin: (id: string, registryExists: boolean) => {
      if (isDev) console.log('[App] 切换到主模块插件:', id, 'registry存在:', registryExists);
    },
    mainPluginDef: (id: string, found: boolean) => {
      if (isDev) console.log('[App] 主模块插件定义:', id, found ? '找到' : 'NOT FOUND');
    },
    mainPluginRenderStart: (id: string, regReady: boolean) => {
      if (isDev) console.log('[App] 主模块插件渲染开始:', id, 'registry已就绪:', regReady);
    },
    mainPluginMissing: (id: string, registered: string[]) => {
      if (isDev) console.log('[App] 主模块插件未找到定义:', id, '已注册:', registered);
    },
    mainPluginNoComponent: (id: string, keys: string[]) => {
      if (isDev) console.log('[App] 主模块插件缺少组件:', id, 'def keys:', keys);
    },
    mainPluginRendering: (id: string, type: string, name: string) => {
      if (isDev) console.log('[App] 主模块插件渲染:', id, '组件类型:', type, 'name:', name);
    },
    fallbackModule: (id: string) => {
      if (isDev) console.log('[App] 阶段5 兜底：activeModule 无效，回退到 notes', id);
    },
  },

  // ========== 快捷键模块 ==========
  shortcuts: {
    editStart: (label: string) => {
      if (isDev) console.log(`[Shortcuts] 开始编辑快捷键: ${label}`);
    },
    editConfirm: (label: string, keys: string) => {
      if (isDev) console.log(`[Shortcuts] 快捷键已更新: ${label} -> ${keys}`);
    },
    editCancel: (label: string) => {
      if (isDev) console.log(`[Shortcuts] 取消编辑: ${label}`);
    },
    configLoaded: (count: number) => {
      if (isDev) console.log(`[Shortcuts] 配置已加载: ${count} 个快捷键`);
    },
    reset: () => {
      if (isDev) console.log('[Shortcuts] 恢复默认快捷键');
    },
  },

  // ========== 导出备份模块 ==========
  export: {
    failed: (err: unknown) => {
      if (isDev) console.error('[Export] 导出失败:', err);
    },
  },

  // ========== 自动保存模块 ==========
  autoSave: {
    configLoaded: (enabled: boolean, interval: number) => {
      if (isDev) console.debug('[AutoSave] 配置已加载:', { enabled, intervalSecs: interval });
    },
    configUpdated: (enabled: boolean, interval: number) => {
      if (isDev) console.debug('[AutoSave] 配置已更新:', { enabled, intervalSecs: interval });
    },
    configLoadFailed: (err: unknown) => {
      if (isDev) console.warn('[AutoSave] 配置加载失败（首次启动正常）:', err);
    },
    syncFailed: (err: unknown) => {
      if (isDev) console.error('[AutoSave] 同步配置到后端失败:', err);
    },
  },

  // ========== 中转站模块 ==========
  transferStation: {
    listLoaded: (currentCount: number, backupCount: number) => {
      if (isDev) console.log(`[TransferStation] 文件列表加载完成: 当前 ${currentCount} 个, 备份 ${backupCount} 个`);
    },
    listFailed: (err: unknown) => {
      if (isDev) console.error('[TransferStation] 文件列表加载失败:', err);
    },
    restore: (fileName: string, isBackup: boolean) => {
      if (isDev) console.log(`[TransferStation] 还原文件: ${fileName} (来源: ${isBackup ? '备份' : '当前暂存'})`);
    },
    restoreSuccess: (fileName: string) => {
      if (isDev) console.log('[TransferStation] 还原成功:', fileName);
    },
    restoreFailed: (fileName: string, err: unknown) => {
      if (isDev) console.error(`[TransferStation] 还原失败: ${fileName}`, err);
    },
    delete: (fileName: string) => {
      if (isDev) console.log('[TransferStation] 删除文件:', fileName);
    },
    deleteSuccess: (fileName: string) => {
      if (isDev) console.log('[TransferStation] 删除成功:', fileName);
    },
    deleteFailed: (fileName: string, err: unknown) => {
      if (isDev) console.error(`[TransferStation] 删除失败: ${fileName}`, err);
    },
    clear: () => {
      if (isDev) console.log('[TransferStation] 清空中转站（当前暂存分组）');
    },
    clearSuccess: (count: number) => {
      if (isDev) console.log(`[TransferStation] 清空完成: 已删除 ${count} 个文件`);
    },
    clearFailed: (err: unknown) => {
      if (isDev) console.error('[TransferStation] 清空失败:', err);
    },
  },

  // ========== 拖放导入 (Dropzone) 模块 ==========
  dropzone: {
    dragDropEvent: (type: string, pathCount: number) => {
      if (isDev) console.log(`[Dropzone] 拖放事件触发: type=${type}, 文件数=${pathCount}`);
    },
    importStart: (filePath: string) => {
      if (isDev) console.log(`[Dropzone] 开始导入文件: ${filePath}`);
    },
    importSuccess: (fileName: string, isReadable: boolean) => {
      if (isDev) console.log(`[Dropzone] 导入成功: ${fileName}, 可读=${isReadable}`);
    },
    importFailed: (filePath: string, err: unknown) => {
      if (isDev) console.error(`[Dropzone] 导入失败: ${filePath}`, err);
    },
    readCheck: (fileName: string, isReadable: boolean, activeModule: string) => {
      if (isDev) console.log(`[Dropzone] 读取检查: ${fileName}, 可读=${isReadable}, 当前模块=${activeModule}`);
    },
    readSkip: (reason: string) => {
      if (isDev) console.log(`[Dropzone] 跳过读取: ${reason}`);
    },
    readStart: (storedPath: string) => {
      if (isDev) console.log(`[Dropzone] 开始读取文件内容: ${storedPath}`);
    },
    readSuccess: (fileName: string, contentLength: number) => {
      if (isDev) console.log(`[Dropzone] 读取成功: ${fileName}, 内容长度=${contentLength}`);
    },
    readFailed: (storedPath: string, err: unknown) => {
      if (isDev) console.error(`[Dropzone] 读取失败: ${storedPath}`, err);
    },
    openInEditor: (fileName: string) => {
      if (isDev) console.log(`[Dropzone] 在编辑器中打开: ${fileName}`);
    },
  },
};