// 桥接模块：App.tsx 的 Tauri onDragDropEvent 捕获系统拖放文件路径后，
// 派发给当前笔记编辑器在光标处内联插入。

type DropHandler = (paths: string[]) => void;

let handler: DropHandler | null = null;

export function registerDropHandler(fn: DropHandler): void {
  handler = fn;
}

export function unregisterDropHandler(): void {
  handler = null;
}

export function dispatchDroppedPaths(paths: string[]): void {
  handler?.(paths);
}
