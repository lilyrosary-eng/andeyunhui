// 插件部署脚本：构建插件并复制到 bundled-plugins/ 供 Tauri bundle.resources 打包使用
//
// 开发与打包统一路径：插件始终从 bundled-plugins/ 加载，external-deps 始终从 external-deps/ 加载
// 不再复制到 AppData，确保开发时与打包后的运行环境完全一致
//
// 目录结构：bundled-plugins/ 镜像 plugins/ 的目录结构（按模块归类）
//   - 顶级主模块：image/, music/, professional/, reading/, video/
//   - 茑萝子插件：niaoluo/gongjuxiang/, niaoluo/huihua/, niaoluo/ide/, niaoluo/wps/
//   - 服务插件：  全局/markitdown/, 全局/screen-recorder/
//   - 空占位：    note/（.gitkeep）
// Rust 端 walk() / find_plugin_root() 递归扫描，天然支持嵌套目录结构。
//
// 自动发现：递归扫描 plugins/ 下所有含 manifest.json 的子目录（排除 _shared/_template）
// 嵌套目录（如 niaoluo/gongjuxiang）保留层级部署到 bundled-plugins/niaoluo/gongjuxiang/
//
// 增量更新策略：
//   - 不再全删重建 bundled-plugins/，仅按 relPath 更新有变化的插件
//   - 递归清理源码中已不存在的插件目录（按 relPath 比对，非 id）
//   - 占位文件夹（含 .gitkeep）不会被清理
//
// 新增插件只需在 plugins/ 下创建目录 + manifest.json，无需修改此脚本
import { execSync } from 'node:child_process';
import { mkdirSync, cpSync, readFileSync, existsSync, rmSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const pluginsDir = join(rootDir, 'plugins');

// 目标目录：bundled-plugins/ （开发时直接加载 + 生产打包嵌入资源）
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

// ===== 增量更新：递归清理已不存在的插件（按 relPath 比对） =====
// 对比源码 plugins/ 的 relPath 集合与部署目录，递归删除源码中已不存在的插件目录。
// 容器目录（如 niaoluo/、全局/）本身保留——它们可能仍是其他有效插件的父目录。
function cleanStalePlugins(targetDir, validRelPaths, label) {
  if (!existsSync(targetDir)) return;
  // 递归扫描：找到所有含 manifest.json 的目录，若其相对路径不在 validRelPaths 中则删除
  function walk(dir, prefix) {
    let remaining = 0; // 该层下剩余的有效条目数（用于判断是否需清理空容器）
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const stat = statSync(full);
      if (!stat.isDirectory()) {
        // 保留 .gitkeep 与 manifest.json（根清单）等非插件文件
        remaining++;
        continue;
      }
      const rel = prefix ? `${prefix}/${name}` : name;
      const manifestPath = join(full, 'manifest.json');
      if (existsSync(manifestPath)) {
        // 这是一个插件目录：按 relPath 判定是否保留
        if (validRelPaths.has(rel)) {
          remaining++;
        } else {
          console.log(`[Deploy] 清理已移除的 ${label}: ${rel}/`);
          rmSync(full, { recursive: true, force: true });
        }
        // 不再下钻（插件目录内部由部署阶段全量重建）
        continue;
      }
      // 非插件目录：递归下钻（如 niaoluo/ 容器目录）
      const subRemaining = walk(full, rel);
      if (subRemaining > 0) {
        remaining++;
      } else if (prefix !== '') {
        // 子容器已空且非顶层（顶层容器如 niaoluo/、全局/ 保留以便用户手动放入插件）
        // 这里仅记录，不自动删除——避免误删用户手动创建的占位目录
      }
    }
    return remaining;
  }
  walk(targetDir, '');
}

const validRelPaths = new Set(plugins.map(p => p.relPath));
cleanStalePlugins(bundledDir, validRelPaths, 'bundled-plugins');

// ===== 部署每个插件（保留源码相对路径，与 plugins/ 结构一致） =====
for (const { relPath, id, manifest } of plugins) {
  const pluginDir = join(pluginsDir, relPath);
  if (!existsSync(pluginDir)) continue;

  const hasViteConfig = existsSync(join(pluginDir, 'vite.config.ts')) || existsSync(join(pluginDir, 'vite.config.js'));
  console.log(`\n[Deploy] ${hasViteConfig ? '构建' : '复制'}插件: ${id} (源: ${relPath})`);

  // 1. 构建（有 vite 配置）或跳过（预构建插件）
  //    用 pnpm exec 而非 npx：项目本身是 pnpm 体系（根 .npmrc 含 pnpm 专属键），
  //    npx 底层走 npm 会不识别这些键并报 "Unknown project config" 警告。
  //    pnpm exec 只执行已存在的二进制、不触发 install（避免 node_modules 被占用时 EPERM），
  //    且能正确识别根 .npmrc 的 pnpm 配置，警告即消除。
  if (hasViteConfig) {
    try {
      execSync('pnpm exec vite build', { cwd: pluginDir, stdio: 'inherit', timeout: 120_000 });
    } catch (e) {
      console.error(`[Deploy] 构建失败: ${id}`, e.message);
      continue;
    }
  }

  // 复制产物：优先 dist/（vite 构建），其次 index.js（预构建）
  const distDir = join(pluginDir, 'dist');
  const entryFile = join(pluginDir, 'index.js');
  const manifestSrc = join(pluginDir, 'manifest.json');

  // 2. 复制到 bundled-plugins（保留源码相对路径，与 plugins/ 结构一致）
  //    Rust 端 walk() / find_plugin_root() 递归扫描，天然支持嵌套目录结构
  const bundleTarget = join(bundledDir, relPath);
  if (existsSync(bundleTarget)) rmSync(bundleTarget, { recursive: true, force: true });
  mkdirSync(bundleTarget, { recursive: true });
  cpSync(manifestSrc, join(bundleTarget, 'manifest.json'));
  if (existsSync(distDir)) {
    cpSync(distDir, bundleTarget, { recursive: true });
  } else if (existsSync(entryFile)) {
    cpSync(entryFile, join(bundleTarget, 'index.js'));
  }
  console.log(`  ✓ -> bundled-plugins/${relPath}`);

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

// 生成插件清单（路线 A：分发解耦方案使用）
try {
  await import('./gen-manifest.mjs');
  console.log('[Deploy] manifest.json 已生成');
} catch (e) {
  console.warn('[Deploy] manifest 生成失败（非致命）:', e.message);
}

console.log(`[Deploy] bundled-plugins / external-deps 已准备好用于 Tauri bundle.resources`);
