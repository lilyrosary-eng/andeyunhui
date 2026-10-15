/**
 * 前后端命令契约的防线：**前端 `invoke` 的每个命令，必须在对应端的注册表里**。
 *
 * 读文件的方式刻意用 **vite 的 `?raw` glob**，而不是 node 的 fs/path：
 * 本项目的 tsconfig 把 `types` 清成 `[]`（浏览器端不该有 node 全局），
 * 而三斜线 `/// <reference types="node" />` **不是文件级的** —— 它会把 node 类型
 * 加入整个编译上下文，于是 `LyricsWidget` 里 `setTimeout` 的返回类型被换成 node 的
 * `Timeout`，全项目多出一片无关报错。`?raw` 由 `vite/client` 提供类型，零污染。
 *
 * ## 血案（2026-10-15）
 * 能力探测落地时实现了 5 个 tauri 命令（`ai_probe_vision` / `ai_get_caps_probe_enabled` /
 * `ai_set_caps_probe_enabled` / `ai_media_usage` / `ai_media_cleanup`），
 * `ai_service/mod.rs` 里 `pub use` 也写了，**但忘了在 `main.rs` 的 `generate_handler!`
 * 里列一行**。于是：9 条单测全绿、`cargo test` 214/214、`tsc` 0 错 ——
 * 而前端一点就是 "command not found"。
 *
 * 整条链上**没有任何一环**能发现它：
 *   - Rust 单测打的是纯逻辑函数，不经过注册表；
 *   - `cargo check` 只查类型，`generate_handler!` 漏项不是类型错误；
 *   - `tsc` 不校验 `invoke()` 的字符串参数（它就是个 string）。
 * 这条测试补的就是那一环。
 *
 * ## 解析要点（踩过的坑）
 * **必须按方括号配平扫描**，不能用 `generate_handler!\s*\[(.*?)\]` 这类非贪婪正则 ——
 * 列表里有 `#[cfg(target_os = "linux")]`，其中的 `]` 会让非贪婪匹配**提前截断**，
 * 于是「它之后的所有命令」都被判成未注册，产出大量**假阳性**。
 * （我第一版就错在这：算出 24 个断链，实际只有 1 个。）
 */
import { describe, expect, it } from 'vitest';

/** 构建期把需要的源文件读成字符串（vite `?raw`）。 */
const RAW = import.meta.glob('../../src-tauri/src/{main.rs,android/mod.rs}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** 前端源码（拆成两个 glob，便于区分是否在 src/mobile 下）。 */
const FRONTEND = import.meta.glob(['../**/*.{ts,tsx,js,jsx}', '!../**/*.test.*'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * 按后缀取源文件内容。
 * 不按精确键索引：`import.meta.glob` 的键是**相对本测试文件**的路径
 * （形如 `../../src-tauri/src/main.rs`），与"从项目根算"的写法不一致；
 * 用后缀匹配把这个形式差异隔离掉。
 */
function rawBySuffix(suffix: string): string {
  const key = Object.keys(RAW).find((k) => k.endsWith(suffix));
  if (!key) {
    throw new Error(
      `?raw glob 没抓到 *${suffix}。实际抓到的键：${JSON.stringify(Object.keys(RAW))}`,
    );
  }
  return RAW[key];
}

/** 按方括号配平解析 `generate_handler![...]`，返回命令名集合。 */
function handlerSet(relPath: string): Set<string> {
  const text = rawBySuffix(relPath.replace('src-tauri/src/', ''));
  const start = text.indexOf('generate_handler!');
  if (start < 0) throw new Error(`${relPath} 里找不到 generate_handler!`);
  const open = text.indexOf('[', start);

  let depth = 0;
  let k = open;
  for (; k < text.length; k++) {
    if (text[k] === '[') depth++;
    else if (text[k] === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw new Error(`${relPath} 的 generate_handler! 方括号不配平`);

  const out = new Set<string>();
  for (const rawLine of text.slice(open + 1, k).split('\n')) {
    // 去掉行内注释与尾逗号；跳过属性行（#[cfg(...)]）与空行
    const line = rawLine.split('//')[0].trim().replace(/,$/, '');
    if (!line || line.startsWith('#')) continue;
    out.add(line.split('::').pop()!);
  }
  return out;
}

/**
 * 收集前端源码里的 `invoke('name')` 命令名 → 出现位置。
 * `onlyMobile` 为真时只取 `src/mobile/` 下的（便于"桌面"这一侧排除移动端专用命令）。
 */
function invokedIn(onlyMobile: boolean): Map<string, string[]> {
  const found = new Map<string, string[]>();
  // 匹配 invoke 之后到第一个 ( 之间的任意内容 —— **不能**写成 (?:<[^>]*>)?：
    // 泛型可能嵌套（invoke<Record<string, unknown>>(...)），[^>]* 会在第一个 > 处失配，
    // 于是整条调用被漏掉、命令被误报成未调用。这个坑我踩过一次（2026-10-15）。
    const re = /invoke\s*[^(]*\(\s*'([A-Za-z0-9_]+)'/g;
  for (const [path, text] of Object.entries(FRONTEND)) {
    // glob 键是相对本测试文件的路径（形如 ../mobile/screens/x.tsx），
    // 所以不能按 '/src/mobile/' 判断。
    const isMobile = /(^|\/)mobile\//.test(path);
    if (onlyMobile !== isMobile) continue;
    for (const m of text.matchAll(re)) {
      const list = found.get(m[1]) ?? [];
      list.push(path);
      found.set(m[1], list);
    }
  }
  return found;
}

/**
 * 已知的、暂不修的前端调用（**显式列出并写明理由**，不允许悄悄放过）。
 * 加进来等于承认"这里有一条断链"，所以每一条都该有对应的待办。
 */
const KNOWN_BROKEN: Record<string, string> = {
  // 后端确实没有这个命令（只有 import_deskpet_asset 用于导入素材）。
  // 即「首次打开桌宠」这条路是坏的（Capsule.tsx:714）。属 Capsule 模块、非 AI 模块，
  // 修它要碰桌宠窗口的创建逻辑，已单独报告待用户决定。
  show_deskpet: 'Capsule 桌宠窗口：后端缺该命令，已单独报告（非 AI 模块）',
};

describe('前后端命令契约', () => {
  const desktop = handlerSet('src-tauri/src/main.rs');
  const android = handlerSet('src-tauri/src/android/mod.rs');

  it('桌面注册表非空且能正确解析（防空解析导致的假绿）', () => {
    // 配平解析若写错（比如正则版），会漏掉 #[cfg] 之后的一大段 —— 这里用数量下限兜住。
    expect(desktop.size).toBeGreaterThan(400);
    expect(android.size).toBeGreaterThan(30);
    // 抽查几个一定存在的命令，确保解析器抓的是真列表
    expect(desktop.has('ai_chat_agent')).toBe(true);
    expect(desktop.has('ai_get_config')).toBe(true);
  });

  it('桌面端：前端调用的命令都已注册', () => {
    const invoked = invokedIn(false);
    const missing: string[] = [];
    for (const [cmd, files] of invoked) {
      if (files.every((f) => f.startsWith('src/mobile/'))) continue; // 移动端另有注册表
      if (desktop.has(cmd)) continue;
      if (cmd in KNOWN_BROKEN) continue;
      missing.push(`${cmd}  <- ${files[0]}`);
    }
    expect(missing, `以下命令前端在调用、桌面端却没注册：\n${missing.join('\n')}`).toEqual([]);
  });

  // ⚠️ 移动端**暂不纳入**这条防线（用户 2026-10-15 明确「移动端不管」）。
  //
  // 但已核实存在的问题仍然记在这里，避免日后重蹈：
  //   `ai_vision_ocr` 被 `src/mobile/hooks/useAiStream.ts` 调用，而
  //   `android/mod.rs` 的注册表里没有它 ⇒ 移动端发图在真机上会 "command not found"。
  //   之所以特别值得记：`android/mod.rs` **只在 `target_os = "android"` 下编译**，
  //   桌面的 `cargo check` 检查不到它 —— 这类漏项在开发机上永远不会自己暴露。
  it.skip('移动端：src/mobile 调用的命令都已注册（用户明确移动端暂不管）', () => {
    const invoked = invokedIn(true);
    const missing: string[] = [];
    for (const [cmd, files] of invoked) {
      if (android.has(cmd)) continue;
      if (cmd in KNOWN_BROKEN) continue;
      missing.push(`${cmd}  <- ${files[0]}`);
    }
    expect(missing, `以下命令 src/mobile 在调用、移动端却没注册：\n${missing.join('\n')}`).toEqual([]);
  });

  it('注册表里没有重复项（Tauri 对重复注册会直接 panic）', () => {
    for (const [label, path] of [
      ['桌面', 'main.rs'],
      ['移动端', 'mod.rs'],
    ] as const) {
      const text = rawBySuffix(path);
      const start = text.indexOf('generate_handler!');
      const open = text.indexOf('[', start);
      let depth = 0;
      let k = open;
      for (; k < text.length; k++) {
        if (text[k] === '[') depth++;
        else if (text[k] === ']') {
          depth--;
          if (depth === 0) break;
        }
      }
      const names: string[] = [];
      for (const rawLine of text.slice(open + 1, k).split('\n')) {
        const line = rawLine.split('//')[0].trim().replace(/,$/, '');
        if (!line || line.startsWith('#')) continue;
        names.push(line.split('::').pop()!);
      }
      const dup = names.filter((n, i) => names.indexOf(n) !== i);
      expect(dup, `${label}注册表里有重复命令：${dup.join(', ')}`).toEqual([]);
    }
  });
});
