// prepare-bundled-dlc.mjs - 为 Tauri 打包准备 bundled-dlc/ 资源目录
//
// 在 beforeBuildCommand 末尾运行（vite build 之后），把所有插件/依赖打包成
// .mufurong/.mujin 私有格式，统一放入 bundled-dlc/，由 tauri.conf.json
// bundle.resources 嵌入安装包。安装后 Rust 端 extract_bundled_dlc 自动
// 复制到 user_plugins/ 与 user_external_deps/，再由既有的
// extract_mufurong_plugins / extract_mujin_deps 自动解压。
//
// 产物结构：
//   bundled-dlc/
//     plugins/         *.mufurong（含母文件夹 茑萝/、全局/）
//     external-deps/   *.mujin（含母文件夹 茑萝/ide/、全局/）
//
// BUILD_CLEAN=1（精简打包）：跳过打包，只创建空 bundled-dlc/ + .gitkeep，
// 安装包不含任何插件/依赖，用户后续可下载 .mufurong/.mujin 自行导入。
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, cpSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const bundledDlcDir = join(rootDir, 'bundled-dlc');
const distDlcDir = join(rootDir, 'dist-dlc');

const BUILD_CLEAN = process.env.BUILD_CLEAN === '1';

// 1. 清理旧 bundled-dlc/（避免遗留过期 .mufurong/.mujin）
if (existsSync(bundledDlcDir)) {
  rmSync(bundledDlcDir, { recursive: true });
}
mkdirSync(bundledDlcDir, { recursive: true });

if (BUILD_CLEAN) {
  // 精简模式：只放 .gitkeep 占位，让 tauri bundle 能找到非空目录
  writeFileSync(join(bundledDlcDir, '.gitkeep'), '');
  console.log('[PrepareDLC] BUILD_CLEAN=1：已创建空 bundled-dlc/ 占位');
  process.exit(0);
}

// 2. 调用 pack-mufurong.mjs 生成 dist-dlc/（内部自动调用 pack-mujin.mjs）
//    - dist-dlc/plugins/         *.mufurong
//    - dist-dlc/external-deps/   *.mujin
console.log('[PrepareDLC] 调用 pack-mufurong.mjs 生成 .mufurong + .mujin ...');
try {
  execSync('node scripts/pack-mufurong.mjs', { cwd: rootDir, stdio: 'inherit' });
} catch (e) {
  console.error(`[PrepareDLC] ✗ pack-mufurong.mjs 失败: ${e.message}`);
  console.error('[PrepareDLC] 继续生成空 bundled-dlc/ 占位，安装包将不含插件');
  writeFileSync(join(bundledDlcDir, '.gitkeep'), '');
  process.exit(0);
}

// 3. 把 dist-dlc/ 整体复制到 bundled-dlc/
if (!existsSync(distDlcDir)) {
  console.error('[PrepareDLC] ✗ dist-dlc/ 未生成，回退到空占位');
  writeFileSync(join(bundledDlcDir, '.gitkeep'), '');
  process.exit(0);
}

console.log('[PrepareDLC] 复制 dist-dlc/ -> bundled-dlc/ ...');
cpSync(distDlcDir, bundledDlcDir, { recursive: true });

// 4. 统计结果
function countFiles(dir, ext) {
  let n = 0;
  if (!existsSync(dir)) return 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      n += countFiles(join(dir, entry.name), ext);
    } else if (entry.name.endsWith('.' + ext)) {
      n++;
    }
  }
  return n;
}
const mufurongCount = countFiles(join(bundledDlcDir, 'plugins'), 'mufurong');
const mujinCount = countFiles(join(bundledDlcDir, 'external-deps'), 'mujin');

console.log('');
console.log('[PrepareDLC] ========================================');
console.log(`[PrepareDLC] [OK] bundled-dlc/ 准备完成`);
console.log(`[PrepareDLC]   - .mufurong 插件: ${mufurongCount} 个`);
console.log(`[PrepareDLC]   - .mujin    依赖: ${mujinCount} 个`);
console.log(`[PrepareDLC]   目录: ${relative(rootDir, bundledDlcDir)}`);
console.log('[PrepareDLC] ========================================');
