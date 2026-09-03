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
import { execSync, spawn } from 'node:child_process';
import { mkdirSync, cpSync, readFileSync, existsSync, rmSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';

// 关闭 IDE safe-delete 拦截：否则 Vite emptyDir 批量删除 dist/ 被拦（SAFE_DELETE_BULK_CONFIRM_REQUIRED），构建失败。
// 官方开关：shim 仅在 SAFE_DELETE_ENABLED !== '0' 时启用。
process.env.SAFE_DELETE_ENABLED = '0';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const pluginsDir = join(rootDir, 'plugins');

// 关闭 IDE safe-delete 拦截（否则 Vite emptyDir 批量删除 dist/ 被拦，构建失败）。
// 该开关官方支持：shim 仅在 SAFE_DELETE_ENABLED !== '0' 时启用。
process.env.SAFE_DELETE_ENABLED = '0';

// vite 二进制路径：直接调用以绕过 pnpm exec 的 install 检查（pnpm 11 的 ERR_PNPM_IGNORED_BUILDS 会阻止构建）
const viteBin = join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js');

// 目标目录：bundled-plugins/ （开发时直接加载 + 生产打包嵌入资源）
const bundledDir = join(rootDir, 'bundled-plugins');

// BUILD_CLEAN=1 时跳过插件构建，只保留空目录占位
// Android 构建（TAURI_ENV_PLATFORM=android）：移动端不加载任何桌面插件（浮窗/IDE/WPS/桌宠等），
// 跳过全部插件构建 —— 16 个插件 × 独立 vite 是 Android 打包最大的时间黑洞，跳过可省一大半构建时间。
const BUILD_CLEAN = process.env.BUILD_CLEAN === '1';
const IS_ANDROID = process.env.TAURI_ENV_PLATFORM === 'android';
if (BUILD_CLEAN) {
  console.log('[Deploy] BUILD_CLEAN=1：跳过所有插件构建，只保留空模块文件夹');
} else if (IS_ANDROID) {
  console.log('[Deploy] Android 构建：跳过插件构建（移动端不加载桌面插件），只保留空模块文件夹');
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

// ===== 预生成 Tailwind CSS =====
// 插件构建需要 Tailwind 工具类（flex、h-full、overflow-hidden 等），
// 但 Vite lib 模式下 Tailwind JIT 扫描不触发。
// 解决方案：在并行构建前一次性预生成 Tailwind CSS，写入 .vite-temp/_tailwind-plugins.css，
// 后续每个插件构建只需读取该文件，避免并发竞争。
if (!BUILD_CLEAN && !IS_ANDROID) {
  console.log('[Deploy] 预生成 Tailwind CSS...');
  try {
    const genScript = join(rootDir, '.vite-temp', '_gen-tw.cjs');
    const outPath = join(rootDir, '.vite-temp', '_tailwind-plugins.css');
    mkdirSync(join(rootDir, '.vite-temp'), { recursive: true });

    const configPath = join(rootDir, 'tailwind.config.js').replace(/\\/g, '\\\\');
    const cssOutPath = outPath.replace(/\\/g, '\\\\');
    writeFileSync(genScript, `
      const postcss = require('postcss');
      const tailwindcss = require('tailwindcss');
      const autoprefixer = require('autoprefixer');
      const fs = require('fs');
      const css = '@tailwind base; @tailwind components; @tailwind utilities;';
      postcss([tailwindcss({ config: '${configPath}' }), autoprefixer()])
        .process(css, { from: undefined })
        .then(r => { fs.writeFileSync('${cssOutPath}', r.css); process.exit(0); })
        .catch(e => { console.error(e); process.exit(1); });
    `);
    execSync(`node "${genScript}"`, { cwd: rootDir, stdio: 'pipe' });
    const sizeKB = (statSync(outPath).size / 1024).toFixed(0);
    console.log(`  ✓ Tailwind CSS 已预生成 (${sizeKB} KB)`);
  } catch (e) {
    console.warn(`[Deploy] ⚠ Tailwind CSS 预生成失败: ${e.message}`);
  }
}

// ===== 并行构建插件 =====
// 将构建（慢）与复制（快）分离：构建阶段并行执行，复制阶段串行执行。
// 并发上限 MAX_CONCURRENT：避免同时启动过多 Vite 进程导致内存不足或 CPU 争抢。
// 12900HX 24 线程，4-6 个并行 Vite 构建是甜区——既吃满 CPU 又不 OOM。
const MAX_CONCURRENT = Math.min(4, cpus().length);

/** 异步构建单个插件（有 vite.config.ts/js 的才需要构建） */
function buildPluginAsync(plugin) {
  return new Promise((resolve) => {
    const { relPath, id } = plugin;
    const pluginDir = join(pluginsDir, relPath);
    const hasViteConfig = existsSync(join(pluginDir, 'vite.config.ts')) || existsSync(join(pluginDir, 'vite.config.js'));
    if (!hasViteConfig) { resolve({ plugin, ok: true, skipped: true }); return; }

    console.log(`[Deploy] ▶ 构建: ${id} (源: ${relPath})`);
    const child = spawn('node', [`"${viteBin}"`, 'build'], {
      cwd: pluginDir,
      stdio: 'pipe',
      shell: true,
      timeout: 120_000,
    });
    let stderr = '';
    child.stderr?.on('data', d => { stderr += d; });
    child.on('close', code => {
      if (code === 0) {
        console.log(`[Deploy] ✓ 构建完成: ${id}`);
        resolve({ plugin, ok: true });
      } else {
        console.error(`[Deploy] ✗ 构建失败: ${id} (exit ${code})`);
        if (stderr) console.error(`  ${stderr}`);
        resolve({ plugin, ok: false });
      }
    });
    child.on('error', e => {
      console.error(`[Deploy] ✗ 构建异常: ${id}`, e.message);
      resolve({ plugin, ok: false });
    });
  });
}

/** 并发限制执行器：同时最多 maxConcurrency 个 Promise 在跑 */
async function parallelLimit(tasks, maxConcurrency) {
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = task().then(r => { executing.delete(p); return r; });
    executing.add(p);
    results.push(p);
    if (executing.size >= maxConcurrency) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

// ===== 部署阶段1：并行构建所有插件 =====
if (!BUILD_CLEAN && !IS_ANDROID) {
  const buildTasks = plugins.map(p => () => buildPluginAsync(p));
  console.log(`[Deploy] 并行构建 ${plugins.length} 个插件（并发: ${MAX_CONCURRENT}）...`);
  const buildResults = await parallelLimit(buildTasks, MAX_CONCURRENT);

  // 收集失败的插件
  for (const { plugin, ok } of buildResults) {
    if (!ok) failedPlugins.push(plugin.id);
  }
}

// ===== 部署阶段2：串行复制产物到 bundled-plugins/ =====
for (const { relPath, id, manifest } of plugins) {
  const pluginDir = join(pluginsDir, relPath);
  if (!existsSync(pluginDir)) continue;
  // 构建阶段失败的插件：跳过部署，避免把旧包/残留 dist 打进安装包（修复原"装入旧包"隐患）
  if (failedPlugins.includes(id)) {
    console.warn(`[Deploy] ⚠ 跳过部署失败插件（避免装入旧包）: ${id}`);
    continue;
  }

  // BUILD_CLEAN=1 / Android：跳过插件构建和部署，只保留空模块文件夹
  if (BUILD_CLEAN || IS_ANDROID) {
    console.log(`[Deploy] ${BUILD_CLEAN ? 'BUILD_CLEAN=1' : 'Android'}，跳过插件: ${id}`);
    continue;
  }

  // 复制产物：优先 dist/（vite 构建），其次 index.js（预构建）
  const distDir = join(pluginDir, 'dist');
  const entryFile = join(pluginDir, 'index.js');
  const manifestSrc = join(pluginDir, 'manifest.json');

  const bundleTarget = join(bundledDir, relPath);
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

  clearUserPluginShadow(relPath, id);
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
