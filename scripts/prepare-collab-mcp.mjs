// prepare-collab-mcp.mjs —— 为 Tauri 打包准备 ai-collab-mcp sidecar
//
// 背景：`crates/ai-collab-kit/src/bin/ai-collab-mcp.rs` 是给 Trae / WorkBuddy 等外部
// harness 用的 stdio MCP 进程。它不属于主应用二进制，历史上只存在于 target/ 下，
// 打出来的安装包里根本没有 —— 用户装完应用后找不到这个 exe。
//
// Tauri 2 的 sidecar 约定：`bundle.externalBin: ["binaries/ai-collab-mcp"]` 会自动按
// 「文件名 + target triple」去 src-tauri/binaries/ 找实体文件。所以这里在打包前：
//   1) 用 release profile 编译 ai-collab-mcp；
//   2) 复制成 binaries/ai-collab-mcp[.exe]（作为 bundle.resources 的一部分随安装包分发）。
//
// 为什么用 resources 而不是 externalBin：externalBin 会在 `cargo check` 阶段就校验文件
// 是否存在，等于每台开发机都必须先跑一次 release 编译才能 cargo check。resources 只要求
// 目录存在（仓库里留 .gitkeep），日常开发不受影响，打包时再由本脚本填上产物。
//
// 只在打包链（before-build）里跑，dev 不跑：浮岛/对话都用不到这个进程，
// 每次 dev 重新编译它只会拖慢启动。源码没变时直接复用已有产物。
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const srcTauri = join(root, 'src-tauri');

// Android 不跑任何桌面 sidecar（与 deploy-plugins 跳过插件同一理由）
if (process.env.TAURI_ENV_PLATFORM === 'android') {
  console.log('[collab-mcp] Android 构建：跳过 sidecar');
  process.exit(0);
}

/** 递归取目录内最新 mtime（毫秒） */
function latestMtime(dir) {
  if (!existsSync(dir)) return 0;
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    try {
      latest = Math.max(latest, entry.isDirectory() ? latestMtime(full) : statSync(full).mtimeMs);
    } catch {
      /* 被占用/删除的文件忽略，不值得中断打包 */
    }
  }
  return latest;
}

const isWin = process.platform === 'win32';
const builtExe = join(srcTauri, 'target', 'release', isWin ? 'ai-collab-mcp.exe' : 'ai-collab-mcp');
const outDir = join(srcTauri, 'binaries');
const outExe = join(outDir, isWin ? 'ai-collab-mcp.exe' : 'ai-collab-mcp');

// 源码比产物新才重编；否则直接复用（打包链路高频调用也不拖慢）
const srcLatest = latestMtime(join(root, 'crates', 'ai-collab-kit', 'src'));
const needsBuild = !existsSync(builtExe) || srcLatest > statSync(builtExe).mtimeMs;

if (needsBuild) {
  console.log('[collab-mcp] 编译 ai-collab-mcp（release）…');
  execSync('cargo build --release --bin ai-collab-mcp -p ai-collab-kit', {
    cwd: srcTauri,
    stdio: 'inherit',
    shell: true,
  });
} else {
  console.log('[collab-mcp] 产物已是最新，跳过编译');
}

if (!existsSync(builtExe)) {
  console.error(`[collab-mcp] 编译后仍找不到产物：${builtExe}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
copyFileSync(builtExe, outExe);
// 顺带清掉旧的带 triple 命名产物（历史脚本版本留下的，避免安装包里出现两个 exe）
for (const name of readdirSync(outDir)) {
  if (/^ai-collab-mcp-/.test(name)) {
    try { rmSync(join(outDir, name), { force: true }); } catch { /* 占用时忽略 */ }
  }
}
const sizeMB = (statSync(outExe).size / 1024 / 1024).toFixed(1);
console.log(`[collab-mcp] ✓ sidecar 就绪：binaries/${outExe.split(/[/\\]/).pop()}（${sizeMB} MB）`);
