// before-build.mjs - beforeBuildCommand 统一入口
//
// 背景：Tauri 会把前端 dist/ 资源 embed 进 Rust 二进制（generate_context!）。
// 每次 `pnpm run build` 重新生成 dist，资源指纹变化 → 整个 lib crate 全量重编，
// 即使 Rust 代码没改（这就是 Android 打包"每次都慢"的根因）。
//
// Android 构建策略：
//   - dist/ 已存在（前端产物可用）→ 跳过 pnpm run build 等前端重建，只跑
//     deploy-plugins / prepare-bundled-dlc（两者在 Android 下已内部跳过、建占位）。
//     这样 dist 不变 → Rust 增量编译（秒级）。
//   - dist/ 不存在（首次/前端资源缺失）→ 走完整全量构建链。
//
// 桌面构建（无 TAURI_ENV_PLATFORM）：始终走完整构建链，行为与旧命令完全一致。
//
// 注意：Android 下如果改了前端代码，需删除 dist/（或手动跑一次 pnpm run build）
// 才会重新打包前端。
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const isAndroid = process.env.TAURI_ENV_PLATFORM === 'android';
const distReady = existsSync(join(root, 'dist', 'index.html'));

const FULL_CHAIN =
  'node scripts/gen-waiting-pages.mjs && ' +
  'node scripts/build-external-deps.mjs && ' +
  'node scripts/deploy-plugins.mjs && ' +
  'node scripts/copy-waiting.mjs && ' +
  'pnpm run build && ' +
  'node scripts/prepare-bundled-dlc.mjs';

if (isAndroid && distReady) {
  console.log('[before-build] Android + dist 已存在：跳过前端重建（复用产物，避免触发 Rust 全量重编）');
  // Android 下这两个脚本内部已跳过插件构建 / DLC 打包，只确保占位目录存在
  execSync('node scripts/deploy-plugins.mjs', { cwd: root, stdio: 'inherit' });
  execSync('node scripts/prepare-bundled-dlc.mjs', { cwd: root, stdio: 'inherit' });
} else {
  console.log(`[before-build] ${isAndroid ? 'Android + dist 缺失' : '桌面'}：执行完整构建链`);
  execSync(FULL_CHAIN, { cwd: root, stdio: 'inherit', shell: true });
}
