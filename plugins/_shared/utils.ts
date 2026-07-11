/// <reference path="../global.d.ts" />
// =============================================
// 插件共享工具 — formatTime
// 图标已迁移至 ./icons.ts，统一从此处导入
// =============================================

/** 将秒数格式化为 mm:ss 或 hh:mm:ss（超过1小时时） */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// 图标功能已迁移至 ./icons.ts，向后兼容重导出
export { ArrowLeftIcon, PlayIcon, PauseIcon, FolderIcon, SearchIcon } from './icons';
