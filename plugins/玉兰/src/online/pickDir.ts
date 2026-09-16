/// <reference path="../../../global.d.ts" />
// 下载目录选择：统一走宿主命令 pick_directory（与音乐模块 / pluginRuntime 一致）。
//
// ⚠️ 历史缺陷：本模块曾调用 'open_download_dir_dialog'，该命令在 Rust 侧根本不存在，
// 于是每次都抛错并退化为 window.prompt() 手输路径，导致下载目录基本设不上。
// 现在统一改用 pick_directory（main.rs 已注册）。
export async function pickDownloadDir(): Promise<string | null> {
  try {
    const r = await (window as any).__HOST_API__?.invoke?.('pick_directory');
    if (r) return String(r);
  } catch {
    /* 用户取消或命令失败，返回 null 由调用方提示 */
  }
  return null;
}
