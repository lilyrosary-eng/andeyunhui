// before-build.mjs - beforeBuildCommand 统一入口
//
// 背景：Tauri 会把前端 dist/ 资源 embed 进 Rust 二进制（generate_context!）。
// 每次 `pnpm run build` 重新生成 dist，资源指纹变化 → 整个 lib crate 全量重编，
// 即使 Rust 代码没改（这就是 Android 打包"每次都慢"的根因）。
//
// Android 构建策略（自动判断，无需手动删 dist/）：
//   - 前端源码（src/、index.html、public/、tailwind.config.js、vite.config.*、
//     postcss.config.js 等）比 dist/ 产物更新 → 前端有改动 → 执行完整构建链，
//     重新 pnpm run build，新 dist 打进包。
//   - dist/ 已存在且不比源码旧 → 前端无改动 → 跳过前端重建，只跑
//     deploy-plugins / prepare-bundled-dlc（Android 下内部已跳过构建、建占位）。
//     dist 不变 → Rust 增量编译（秒级）。
//   - dist/ 不存在（首次）→ 完整构建链。
//
// 桌面构建（无 TAURI_ENV_PLATFORM）：始终走完整构建链，行为与旧命令完全一致。
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const isAndroid = process.env.TAURI_ENV_PLATFORM === 'android';

const FULL_CHAIN =
  'node scripts/gen-waiting-pages.mjs && ' +
  'node scripts/build-external-deps.mjs && ' +
  'node scripts/deploy-plugins.mjs && ' +
  'node scripts/copy-waiting.mjs && ' +
  'pnpm run build && ' +
  'node scripts/prepare-bundled-dlc.mjs';

// 递归取目录内最新 mtime（毫秒）
function latestMtime(dir) {
  if (!existsSync(dir)) return 0;
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, latestMtime(full));
    } else {
      try {
        latest = Math.max(latest, statSync(full).mtimeMs);
      } catch {
        /* 个别文件被占用/删除时忽略 */
      }
    }
  }
  return latest;
}

// 前端源码是否比 dist/ 产物更新（决定是否需要重建前端）
function frontendStale() {
  const distIndex = join(root, 'dist', 'index.html');
  if (!existsSync(distIndex)) return true; // dist 不存在，必须重建
  const srcLatest = Math.max(
    latestMtime(join(root, 'src')),
    latestMtime(join(root, 'public')),
    ...['index.html', 'tailwind.config.js', 'postcss.config.js', 'components.json', 'vite.config.ts', 'vite.config.js']
      .map((f) => join(root, f))
      .map((p) => (existsSync(p) ? statSync(p).mtimeMs : 0)),
  );
  const distLatest = latestMtime(join(root, 'dist'));
  return srcLatest > distLatest;
}

if (isAndroid) {
  if (frontendStale()) {
    console.log('[before-build] Android：检测到前端源码有更新，执行完整构建链');
    execSync(FULL_CHAIN, { cwd: root, stdio: 'inherit', shell: true });
  } else {
    console.log('[before-build] Android：前端无改动，复用 dist/ 产物（Rust 走增量编译）');
    execSync('node scripts/deploy-plugins.mjs', { cwd: root, stdio: 'inherit' });
    execSync('node scripts/prepare-bundled-dlc.mjs', { cwd: root, stdio: 'inherit' });
  }
} else {
  console.log('[before-build] 桌面：执行完整构建链');
  execSync(FULL_CHAIN, { cwd: root, stdio: 'inherit', shell: true });
}
