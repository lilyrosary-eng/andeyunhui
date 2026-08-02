// IDE 子插件跨模块共享状态
// IdeEditor（component）与 FileExplorer（sidebar）由宿主独立渲染，
// 靠此共享对象 + 'ide-project-changed' 事件通信（保持原 index.tsx 模块级 let 语义，最低风险拆分）。
export const ideShared = {
  // 当前项目根目录（FileExplorer 设置，IdeEditor/IdeAgent 读取）
  projectRoot: null as string | null,
  // 打开文件到编辑器标签页的命令式句柄（IdeEditor 注册，FileExplorer/CommandPalette 调用）
  addFileTab: null as ((path: string, content: string) => void) | null,
  // 当前已打开的文件路径列表（IdeEditor 维护，CommandPalette 用于 MRU 排序）
  recentFiles: null as (() => string[]) | null,
};

// 平台检测：用于 shell 命令跨平台适配（目录删除/重命名走 run_shell_command 取巧）
export const isWindows =
  typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
