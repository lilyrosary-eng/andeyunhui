/// <reference path="../global.d.ts" />
// 统一的「以安得云荟打开 / 拖入主窗口」处理中枢。
//
// 设计：右键「以安得云荟打开」与拖入主窗口（处于对应媒体模块时）共用同一流程：
//   1. 把文件导入固定临时目录 <app_data>/openwith/<module>/（复制，常驻库文件夹）
//   2. 各媒体模块消费后将该目录注册为库根目录并打开目标文件
// 这样两者行为天然一致。
//
// 因为插件以 IIFE 形式加载、无法使用 @tauri-apps 包，这里统一走 window.__HOST_API__。

export type OpenWithItem =
  | { path: string; name?: string }
  | { name: string; bytes: number[] };

const hostApi = window.__HOST_API__ as {
  invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
};

// 关键：主应用与每个插件是各自独立打包的 IIFE 包，会各自内联一份本模块。
// 若用模块级变量保存 listeners/pending，主应用与插件将持有互不连通的两份状态，
// 导致 dispatchOpenWith 派发不到插件的监听器（拖入媒体模块「毫无反应」）。
// 故把中枢状态挂到真实 window 全局，所有包共享同一份 Set / Map。
// 沙箱 proxy 的 get 会回退到真实 window，因此只要主应用（先于插件加载）初始化一次，
// 插件读取到的就是同一实例。
interface OpenWithHub {
  listeners: Set<(module: string, files: OpenWithItem[]) => void>;
  pendingByModule: Record<string, OpenWithItem[]>;
}
const HUB_KEY = '__ANDY_OPEN_WITH_HUB__';
const g = window as unknown as Record<string, unknown>;
let hub = g[HUB_KEY] as OpenWithHub | undefined;
if (!hub) {
  hub = { listeners: new Set(), pendingByModule: {} };
  g[HUB_KEY] = hub;
}
const { listeners, pendingByModule } = hub;

/** 模块挂载时注册消费者；返回取消函数。 */
export function registerOpenWithListener(
  cb: (module: string, files: OpenWithItem[]) => void,
): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 取走当前模块待处理的一次性文件（模块挂载时调用，避免事件早于监听器到达的竞态）。 */
export function getPendingOpenWith(module: string): OpenWithItem[] | null {
  const p = pendingByModule[module];
  if (p) {
    delete pendingByModule[module];
    return p;
  }
  return null;
}

/**
 * 派发「以安得云荟打开」请求。
 * - 若已有对应模块挂载（监听器已就绪），立即投递；
 * - 否则暂存为 pending，待该模块挂载后由 getPendingOpenWith 取走。
 */
export function dispatchOpenWith(module: string, files: OpenWithItem[]): void {
  if (!files || files.length === 0) return;
  if (listeners.size > 0) {
    listeners.forEach((l) => l(module, files));
  } else {
    pendingByModule[module] = files;
  }
}

/** 将文件导入固定临时目录，返回目录路径与最终落地文件绝对路径列表。 */
export async function importToOpenWithDir(
  module: string,
  files: OpenWithItem[],
): Promise<{ dir: string; paths: string[] }> {
  const payload = files.map((f) =>
    'path' in f
      ? { kind: 'path', path: f.path, name: f.name ?? null }
      : { kind: 'bytes', name: f.name, bytes: f.bytes },
  );
  return hostApi.invoke<{ dir: string; paths: string[] }>('import_to_openwith_dir', {
    module,
    files: payload,
  });
}
