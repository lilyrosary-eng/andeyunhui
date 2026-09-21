// before-dev.mjs - beforeDevCommand 统一入口
//
// 背景：`pnpm run dev` 的 predev 会构建全部桌面插件（deploy-plugins × 16 个 vite），
// 而 Tauri android dev 的前端只需要 vite dev server（HMR）。插件加载对 Android 无意义，
// 白白耗时且不是安卓运行时需要的。
//
// Android dev（TAURI_ENV_PLATFORM=android，Tauri v2 在 beforeDevCommand 期间注入）：
//   只杀端口 + 直接起 vite（跳过 predev 的插件构建/外部依赖重建）。
// 桌面 dev：保持原 `pnpm run dev`（含 predev）行为不变。
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const isAndroid =
  process.env.TAURI_ENV_PLATFORM === 'android' ||
  process.env.TAURI_ANDROID === 'true' ||
  process.argv.some((a) => a.includes('android'));

if (isAndroid) {
  console.log('[before-dev] Android：跳过插件构建，直接启动 vite dev server');
  execSync('node scripts/kill-port.mjs', { cwd: root, stdio: 'inherit' });
  execSync('pnpm exec vite', { cwd: root, stdio: 'inherit', shell: true });
} else {
  console.log('[before-dev] 桌面：执行完整 dev 链（pnpm run dev + predev）');
  execSync('pnpm run dev', { cwd: root, stdio: 'inherit', shell: true });
}
