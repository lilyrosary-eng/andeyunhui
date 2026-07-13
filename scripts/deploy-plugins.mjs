// 插件部署脚本：构建插件并复制到 Tauri app_data_dir/extensions/{id}/
// 同时复制到 bundled-plugins/{id}/ 供 Tauri bundle.resources 打包使用
//
// 自动发现：递归扫描 plugins/ 下所有含 manifest.json 的子目录（排除 _shared/_template）
// 嵌套目录（如 niaoluo/gongjuxiang）也支持，但部署时按 manifest.id 平铺到根目录，
// 不再保留嵌套层级（避免路径耦合，Rust 端 find_plugin_root 按 id 递归匹配即可定位）
//
// 增量更新策略：
//   - 不再全删重建 bundled-plugins/，仅按 id 更新有变化的插件
//   - 清理源码中已不存在的插件目录（cleanStalePlugins）
//   - 占位文件夹（含 .gitkeep）不会被清理
//
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
// 支持子插件嵌套目录（如 niaoluo/gongjuxiang），返回 {relPath, id, manifest} 对象数组
const EXCLUDED = new Set(['_shared', '_template', 'global.d.ts']);

function discoverPlugins(dir, prefix, out) {
  for (const name of readdirSync(dir)) {
    if (EXCLUDED.has(name)) continue;
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    const manifestPath = join(full, 'manifest.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        if (!manifest.id) {
          console.warn(`[Deploy] ⚠ ${rel}/manifest.json 缺少 id 字段，跳过`);
          continue;
        }
        out.push({ relPath: rel, id: manifest.id, manifest });
      } catch (e) {
        console.warn(`[Deploy] ⚠ ${rel}/manifest.json 解析失败: ${e.message}`);
      }
      continue; // 本目录已是插件根，不再下钻（与 Rust get_installed_plugins 行为一致）
    }
    discoverPlugins(full, rel, out);
  }
}

const plugins = [];
discoverPlugins(pluginsDir, '', plugins);

console.log(`[Deploy] 发现 ${plugins.length} 个插件:`);
plugins.forEach(p => console.log(`  - id=${p.id}  src=${p.relPath}`));

// ===== 增量更新：清理已不存在的插件 =====
// 对比源码 plugins/ 的 id 列表与部署目录，删除源码中已不存在的插件目录
// 全局/ 目录本身保留（占位），但其下的插件子目录会被清理（避免与按 id 平铺的副本冲突，
// 导致 Rust 端 find_plugin_root 递归查找时命中不确定的副本）
function cleanStalePlugins(targetDir, validIds, label) {
  if (!existsSync(targetDir)) return;
  const keepPlaceholders = new Set(['全局', 'global', '.gitkeep', 'manifest.json']);
  for (const name of readdirSync(targetDir)) {
    const full = join(targetDir, name);
    if (!statSync(full).isDirectory()) continue;
    // 跨平台兼容：中文名 "全局" 与英文名 "global" 都视为非插件目录
    if (name === '全局' || name === 'global') {
      cleanGlobalSubplugins(full, validIds, `${label}/${name}`);
      continue;
    }
    if (keepPlaceholders.has(name)) continue;
    if (!validIds.has(name)) {
      console.log(`[Deploy] 清理已移除的 ${label}: ${name}/`);
      rmSync(full, { recursive: true, force: true });
    }
  }
}

// 清理 全局 目录下的插件子目录（新逻辑下所有插件按 id 平铺到根目录，全局/ 只存放非插件资源）
function cleanGlobalSubplugins(globalDir, validIds, label) {
  for (const name of readdirSync(globalDir)) {
    if (name === '.gitkeep') continue;
    const full = join(globalDir, name);
    if (!statSync(full).isDirectory()) continue;
    // 子目录含 manifest.json 即视为插件副本，删除（无论 id 是否有效，平铺副本已存在于根目录）
    if (existsSync(join(full, 'manifest.json'))) {
      console.log(`[Deploy] 清理 ${label}/ 下的冗余插件副本: ${name}/`);
      rmSync(full, { recursive: true, force: true });
    }
  }
}

const validIds = new Set(plugins.map(p => p.id));
cleanStalePlugins(bundledDir, validIds, 'bundled-plugins');
cleanStalePlugins(appDataDir, validIds, 'app_data/extensions');

// ===== 部署每个插件（按 id 平铺到根目录） =====
for (const { relPath, id, manifest } of plugins) {
  const pluginDir = join(pluginsDir, relPath);
  if (!existsSync(pluginDir)) continue;

  const hasViteConfig = existsSync(join(pluginDir, 'vite.config.ts')) || existsSync(join(pluginDir, 'vite.config.js'));
  console.log(`\n[Deploy] ${hasViteConfig ? '构建' : '复制'}插件: ${id} (源: ${relPath})`);

  // 1. 构建（有 vite 配置）或跳过（预构建插件）
  if (hasViteConfig) {
    try {
      execSync('pnpm exec vite build', { cwd: pluginDir, stdio: 'inherit', timeout: 120_000 });
    } catch (e) {
      console.error(`[Deploy] 构建失败: ${id}`, e.message);
      continue;
    }
  }

  // 2. 复制到 app_data_dir（开发环境）—— 按 id 平铺
  const targetDir = join(appDataDir, id);
  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });

  // 复制 manifest.json
  const manifestSrc = join(pluginDir, 'manifest.json');
  cpSync(manifestSrc, join(targetDir, 'manifest.json'));
  console.log(`  ✓ manifest.json -> app_data/extensions/${id}`);

  // 复制产物：优先 dist/（vite 构建），其次 index.js（预构建）
  const distDir = join(pluginDir, 'dist');
  const entryFile = join(pluginDir, 'index.js');
  if (existsSync(distDir)) {
    cpSync(distDir, targetDir, { recursive: true });
    console.log(`  ✓ dist/ -> app_data/extensions/${id}`);
  } else if (existsSync(entryFile)) {
    cpSync(entryFile, join(targetDir, 'index.js'));
    console.log(`  ✓ index.js -> app_data/extensions/${id}`);
  }

  // 3. 复制到 bundled-plugins（生产打包）—— 按 id 平铺
  const bundleTarget = join(bundledDir, id);
  if (existsSync(bundleTarget)) rmSync(bundleTarget, { recursive: true, force: true });
  mkdirSync(bundleTarget, { recursive: true });
  cpSync(manifestSrc, join(bundleTarget, 'manifest.json'));
  if (existsSync(distDir)) {
    cpSync(distDir, bundleTarget, { recursive: true });
  } else if (existsSync(entryFile)) {
    cpSync(entryFile, join(bundleTarget, 'index.js'));
  }
  console.log(`  ✓ -> bundled-plugins/${id}`);

  console.log(`[Deploy] ${id} 部署完成`);
}

console.log('\n[Deploy] 所有插件部署完成');

// 确保 bundled-plugins/全局 存在（用户要求：存放全局插件的文件夹，空时补 .gitkeep）
const globalBundle = join(bundledDir, '全局');
mkdirSync(globalBundle, { recursive: true });
if (readdirSync(globalBundle).length === 0) {
  writeFileSync(join(globalBundle, '.gitkeep'), '');
  console.log('[Deploy] 空 bundled-plugins/全局 文件夹已保留');
}

// 确保每个模块在 bundled-plugins 下都有文件夹；空文件夹补 .gitkeep，
// 避免 NSIS 打包时丢弃空目录（占位模块如 note/image 等无产物时仍保留目录）
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
if (existsSync(wrongExternal)) rmSync(wrongExternal, { recursive: true, force: true });
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
