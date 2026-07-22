// 插件部署脚本：构建插件并复制到 bundled-plugins/ 供 Tauri bundle.resources 打包使用
//
// 开发与打包统一路径：插件始终从 bundled-plugins/ 加载，external-deps 始终从 external-deps/ 加载
// 不再复制到 AppData，确保开发时与打包后的运行环境完全一致
//
// 目录结构：bundled-plugins/ 镜像 plugins/ 的目录结构（按模块归类）
//   - 顶级主模块：image/, music/, professional/, reading/, video/
//   - 茑萝子插件：茑萝/gongjuxiang/, 茑萝/huihua/, 茑萝/ide/, 茑萝/wps/
//   - 服务插件：  全局/screen-recorder/
//   - 空占位：    note/（.gitkeep）
// Rust 端 walk() / find_plugin_root() 递归扫描，天然支持嵌套目录结构。
//
// 自动发现：递归扫描 plugins/ 下所有含 manifest.json 的子目录（排除 _shared/_template）
// 嵌套目录（如 茑萝/gongjuxiang）保留层级部署到 bundled-plugins/茑萝/gongjuxiang/
//
// 增量更新策略：
//   - 不再全删重建 bundled-plugins/，仅按 relPath 更新有变化的插件
//   - 递归清理源码中已不存在的插件目录（按 relPath 比对，非 id）
//   - 占位文件夹（含 .gitkeep）不会被清理
//
// 新增插件只需在 plugins/ 下创建目录 + manifest.json，无需修改此脚本
//
// BUILD_CLEAN=1 环境变量：跳过所有插件构建和部署，只保留空模块文件夹 + .gitkeep。
// 用于 build_clean.bat 打包精简版安装包（不含插件代码，用户后续导入 .mufurong）。
import { execSync } from 'node:child_process';
import { mkdirSync, cpSync, readFileSync, existsSync, rmSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const pluginsDir = join(rootDir, 'plugins');

// vite 二进制路径：直接调用以绕过 pnpm exec 的 install 检查（pnpm 11 的 ERR_PNPM_IGNORED_BUILDS 会阻止构建）
const viteBin = join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js');

// 目标目录：bundled-plugins/ （开发时直接加载 + 生产打包嵌入资源）
const bundledDir = join(rootDir, 'bundled-plugins');

// BUILD_CLEAN=1 时跳过插件构建，只保留空目录占位
const BUILD_CLEAN = process.env.BUILD_CLEAN === '1';
if (BUILD_CLEAN) {
  console.log('[Deploy] BUILD_CLEAN=1：跳过所有插件构建，只保留空模块文件夹');
}

// 递归自动发现插件：扫描 plugins/ 下所有含 manifest.json 的目录（排除 _shared/_template），
// 支持子插件嵌套目录（如 茑萝/gongjuxiang），返回 {relPath, id, manifest} 对象数组
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

// 记录构建失败的插件；结束时若非空则以非零码退出，让 tauri build / dev 整体中止，
// 避免"某插件构建失败被静默跳过、继续打包旧包"这一极隐蔽的陷阱（曾多次踩坑）。
const failedPlugins = [];

console.log(`[Deploy] 发现 ${plugins.length} 个插件:`);
plugins.forEach(p => console.log(`  - id=${p.id}  src=${p.relPath}`));

// ===== 增量更新：递归清理已不存在的插件（按 relPath 比对） =====
// 对比源码 plugins/ 的 relPath 集合与部署目录，递归删除源码中已不存在的插件目录。
// 容器目录（如 茑萝/、全局/）本身保留——它们可能仍是其他有效插件的父目录。
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
      // 非插件目录：递归下钻（如 茑萝/ 容器目录）
      const subRemaining = walk(full, rel);
      if (subRemaining > 0) {
        remaining++;
      } else if (prefix !== '') {
        // 子容器已空且非顶层（顶层容器如 茑萝/、全局/ 保留以便用户手动放入插件）
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

  // BUILD_CLEAN=1：跳过插件构建和部署，只保留空模块文件夹
  if (BUILD_CLEAN) {
    console.log(`[Deploy] BUILD_CLEAN=1，跳过插件: ${id}`);
    continue;
  }

  const hasViteConfig = existsSync(join(pluginDir, 'vite.config.ts')) || existsSync(join(pluginDir, 'vite.config.js'));
  console.log(`\n[Deploy] ${hasViteConfig ? '构建' : '复制'}插件: ${id} (源: ${relPath})`);

  // 1. 构建（有 vite 配置）或跳过（预构建插件）
  //    直接通过 node 调用 vite 二进制（而非 pnpm exec / npx）：
  //    - pnpm 11 的 ERR_PNPM_IGNORED_BUILDS 会导致 pnpm exec 内部的 install 检查失败
  //    - npx 底层走 npm，不识别根 .npmrc 的 pnpm 专属键
  //    - vite 已通过 shamefully-hoist=true 提升到根 node_modules，直接调用最稳定
  if (hasViteConfig) {
    try {
      // 直接通过 node 调用 vite 二进制，绕过 pnpm exec（pnpm 11 的 ERR_PNPM_IGNORED_BUILDS 会导致 install 失败）
      // vite 已通过 shamefully-hoist=true 提升到根 node_modules，cwd 设为插件目录以找到 vite.config.ts
      execSync(`node "${viteBin}" build`, { cwd: pluginDir, stdio: 'inherit', timeout: 120_000 });
    } catch (e) {
      console.error(`[Deploy] ✗ 构建失败: ${id}`, e.message);
      failedPlugins.push(id);
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
  // 关键：保留 bundleTarget 目录节点本身，仅清空其内容，不要 rmSync(recursive) 删除目录。
  // 否则 dev 模式下 Rust 端对 bundled-plugins/ 的递归文件监听（ReadDirectoryChangesW）
  // 在子目录被删除后会失效，导致 plugin-fs-change 不再派发、运行中 app 始终使用
  // 旧的内存插件副本，部署改动不生效。清空内容后监听句柄保持有效，热重载可持续触发。
  if (existsSync(bundleTarget)) {
    for (const entry of readdirSync(bundleTarget)) {
      rmSync(join(bundleTarget, entry), { recursive: true, force: true });
    }
  } else {
    mkdirSync(bundleTarget, { recursive: true });
  }
  cpSync(manifestSrc, join(bundleTarget, 'manifest.json'));
  if (existsSync(distDir)) {
    cpSync(distDir, bundleTarget, { recursive: true });
  } else if (existsSync(entryFile)) {
    cpSync(entryFile, join(bundleTarget, 'index.js'));
  }
  console.log(`  ✓ -> bundled-plugins/${relPath}`);

  // 清理 AppData/user_plugins 下与本插件同 id/relPath 的陈旧影子副本。
  // dev 下以项目根 bundled-plugins/ 为权威源；若 user_plugins 残留旧副本，
  // find_plugin_root 优先查 user_plugins 会盖过最新代码，导致"部署成功但 app 跑旧插件"。
  // 每次部署顺手清掉影子，使 FS 监听触发的自动热重载能拿到新代码。
  clearUserPluginShadow(relPath, id);

  console.log(`[Deploy] ${id} 部署完成`);
}

// 清理 user_plugins 影子（见上方调用处注释）。仅 Windows（有 APPDATA）时生效。
function clearUserPluginShadow(relPath, id) {
  const appData = process.env.APPDATA;
  if (!appData) return;
  const userPlugins = join(appData, 'com.rosary.andengyuanhua', 'user_plugins');
  if (!existsSync(userPlugins)) return;
  for (const key of [relPath, id, `${relPath}.mufurong`, `${id}.mufurong`]) {
    const p = join(userPlugins, key);
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
      console.log(`  ✓ 清理陈旧影子: user_plugins/${key}`);
    }
  }
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
// 避免 NSIS 打包时丢弃空目录（占位模块如 鸢尾花/莲花 等无产物时仍保留目录）
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

// 关键：任一插件构建失败则整体失败退出，避免打包/开发环境静默使用旧包。
if (failedPlugins.length > 0) {
  console.error(`\n[Deploy] ✗ 以下插件构建失败，已中止：${failedPlugins.join(', ')}`);
  console.error('[Deploy] 请修复上述插件的构建错误后重试（打包已阻止以免装入旧包）。');
  process.exit(1);
}
