// 插件部署脚本：构建插件并复制到 Tauri app_data_dir/extensions/
// 同时复制到 bundled-plugins/ 供 Tauri bundle.resources 打包使用
//
// 自动发现：扫描 plugins/ 目录下所有含 manifest.json 的子目录（排除 _shared/_template）
// 新增插件只需在 plugins/ 下创建目录 + manifest.json，无需修改此脚本
import { execSync } from 'node:child_process';
import { mkdirSync, cpSync, copyFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const pluginsDir = join(rootDir, 'plugins');

// 目标目录1：app_data_dir/extensions/{plugin_id}/ （开发时使用）
// 从 tauri.conf.json 读取 identifier 避免与配置不同步
const tauriConf = JSON.parse(readFileSync(join(rootDir, 'src-tauri', 'tauri.conf.json'), 'utf-8'));
const appIdentifier = tauriConf.identifier || 'com.rosary.andengyuanhua';
const appDataDir = join(homedir(), 'AppData', 'Roaming', appIdentifier, 'extensions');
// 与 Rust 端 app.path().app_data_dir() 一致的根目录（不含 extensions），
// 用于放置 external-deps / transfer_station 等并列子目录
const appDataRoot = join(homedir(), 'AppData', 'Roaming', appIdentifier);
// 目标目录2：bundled-plugins/{plugin_id}/ （生产打包时嵌入资源）
const bundledDir = join(rootDir, 'bundled-plugins');

// 递归自动发现插件：扫描 plugins/ 下所有含 manifest.json 的目录（排除 _shared/_template），
// 支持子插件嵌套目录（如 niuluo/gongjuxiang），返回相对路径（以 "/" 分隔，如 "niuluo/gongjuxiang"）
const EXCLUDED = new Set(['_shared', '_template', 'global.d.ts']);

function discoverPlugins(dir, prefix, out) {
  for (const name of readdirSync(dir)) {
    if (EXCLUDED.has(name)) continue;
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    if (existsSync(join(full, 'manifest.json'))) {
      out.push(rel);
      continue; // 本目录已是插件根，不再下钻（与 Rust get_installed_plugins 行为一致）
    }
    discoverPlugins(full, rel, out);
  }
}

const plugins = [];
discoverPlugins(pluginsDir, '', plugins);

console.log(`[Deploy] 发现 ${plugins.length} 个插件: ${plugins.join(', ')}`);

// 清理并重建 bundled-plugins
if (existsSync(bundledDir)) {
  rmSync(bundledDir, { recursive: true });
}
mkdirSync(bundledDir, { recursive: true });

for (const pluginId of plugins) {
  const pluginDir = join(pluginsDir, pluginId);
  if (!existsSync(pluginDir)) continue;

  const hasViteConfig = existsSync(join(pluginDir, 'vite.config.ts')) || existsSync(join(pluginDir, 'vite.config.js'));
  console.log(`\n[Deploy] ${hasViteConfig ? '构建' : '复制'}插件: ${pluginId}`);

  // 1. 构建（有 vite 配置）或跳过（预构建插件）
  if (hasViteConfig) {
    try {
      execSync('pnpm exec vite build', { cwd: pluginDir, stdio: 'inherit', timeout: 120_000 });
    } catch (e) {
      console.error(`[Deploy] 构建失败: ${pluginId}`, e.message);
      continue;
    }
  }

  // 2. 复制到 app_data_dir（开发环境）
  const targetDir = join(appDataDir, pluginId);
  mkdirSync(targetDir, { recursive: true });

  // 复制 manifest.json
  const manifestSrc = join(pluginDir, 'manifest.json');
  if (existsSync(manifestSrc)) {
    cpSync(manifestSrc, join(targetDir, 'manifest.json'));
    console.log(`  ✓ manifest.json -> app_data`);
  }

  // 复制产物：优先 dist/（vite 构建），其次 index.js（预构建）
  const distDir = join(pluginDir, 'dist');
  const entryFile = join(pluginDir, 'index.js');
  if (existsSync(distDir)) {
    cpSync(distDir, targetDir, { recursive: true });
    console.log(`  ✓ dist/ -> app_data`);
  } else if (existsSync(entryFile)) {
    cpSync(entryFile, join(targetDir, 'index.js'));
    console.log(`  ✓ index.js -> app_data`);
  }

  // 3. 复制到 bundled-plugins（生产打包）
  const bundleTarget = join(bundledDir, pluginId);
  mkdirSync(bundleTarget, { recursive: true });
  if (existsSync(manifestSrc)) {
    cpSync(manifestSrc, join(bundleTarget, 'manifest.json'));
  }
  if (existsSync(distDir)) {
    cpSync(distDir, bundleTarget, { recursive: true });
  } else if (existsSync(entryFile)) {
    cpSync(entryFile, join(bundleTarget, 'index.js'));
  }
  console.log(`  ✓ -> bundled-plugins`);

  console.log(`[Deploy] ${pluginId} 部署完成`);
}

console.log('\n[Deploy] 所有插件部署完成');

// 确保 bundled-plugins/全局 存在（用户要求：存放全局插件的文件夹，空时补 .gitkeep）
const globalBundle = join(bundledDir, '全局');
mkdirSync(globalBundle, { recursive: true });
if (readdirSync(globalBundle).length === 0) {
  writeFileSync(join(globalBundle, '.gitkeep'), '');
  console.log('[Deploy] 空 bundled-plugins/全局 文件夹已保留');
}

// 确保每个插件（模块）在 bundled-plugins 下都有文件夹；空文件夹补 .gitkeep，
// 避免 NSIS 打包时丢弃空目录（用户要求：每个模块一个文件夹，无插件则为空白文件夹）
for (const name of readdirSync(pluginsDir)) {
  const dir = join(pluginsDir, name);
  if (!statSync(dir).isDirectory() || EXCLUDED.has(name)) continue;
  const bundleTarget = join(bundledDir, name);
  if (!existsSync(bundleTarget)) mkdirSync(bundleTarget, { recursive: true });
  if (readdirSync(bundleTarget).length === 0) {
    writeFileSync(join(bundleTarget, '.gitkeep'), '');
    console.log(`[Deploy] 空模块文件夹已保留: ${name}/`);
  }
}

// 确保 external-deps 目录存在（打包资源：外部依赖 / 重型插件，由用户决定放入），
// 空时补 .gitkeep 以免打包被忽略
const externalDir = join(rootDir, 'external-deps');
if (!existsSync(externalDir)) mkdirSync(externalDir, { recursive: true });
if (readdirSync(externalDir).length === 0) {
  writeFileSync(join(externalDir, '.gitkeep'), '');
  console.log('[Deploy] 空 external-deps 文件夹已保留');
}

// 确保 external-deps/全局 存在（用户要求：存放全局依赖的文件夹，空时补 .gitkeep）
const globalExternal = join(externalDir, '全局');
mkdirSync(globalExternal, { recursive: true });
if (readdirSync(globalExternal).length === 0) {
  writeFileSync(join(globalExternal, '.gitkeep'), '');
  console.log('[Deploy] 空 external-deps/全局 文件夹已保留');
}

// 同步 external-deps → app_data/external-deps（注意：与 Rust 端 app.path().app_data_dir() 同级，
// 即 app_data 根目录下，而非 extensions/ 之下；开发期每次 predev 都刷新，
// 避免新增外部依赖未随版本号变更而被 setup 跳过复制）
const wrongExternal = join(appDataDir, 'external-deps');
if (existsSync(wrongExternal)) rmSync(wrongExternal, { recursive: true });
if (existsSync(externalDir)) {
  cpSync(externalDir, join(appDataRoot, 'external-deps'), { recursive: true });
  console.log('[Deploy] external-deps 已同步到 app_data');
}

// 生成插件清单（路线 A：分发解耦方案使用）
try {
  await import('./gen-manifest.mjs');
  console.log('[Deploy] manifest.json 已生成');
  // 同步清单到 app_data/extensions/，供运行时 read_manifest 读取
  // 注意：appDataDir 已指向 .../extensions，无需再拼接 'extensions'
  const manifestSrc = join(bundledDir, 'manifest.json');
  if (existsSync(manifestSrc)) {
    copyFileSync(manifestSrc, join(appDataDir, 'manifest.json'));
    console.log('[Deploy] manifest.json 已同步到 app_data');
  }
} catch (e) {
  console.warn('[Deploy] manifest 生成失败（非致命）:', e.message);
}

console.log(`[Deploy] bundled-plugins / external-deps 已准备好用于 Tauri bundle.resources`);