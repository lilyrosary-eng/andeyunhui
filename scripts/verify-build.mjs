// verify-build.mjs - 验证打包产物完整性
// 用法: node scripts/verify-build.mjs
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
let pass = 0, fail = 0, warn = 0;

function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }
}
function warnCheck(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { warn++; console.log(`  ⚠️  ${label}${detail ? ' — ' + detail : ''}`); }
}

// ===== 1. dist/ 前端产物 =====
console.log('\n📦 dist/ 前端产物');
const htmlPages = ['index.html', 'screenshot-overlay.html', 'recorder-widget.html',
  'recorder-select.html', 'recording-border.html', 'deskpet.html'];
for (const h of htmlPages) {
  check(`dist/${h}`, existsSync(join(root, 'dist', h)));
}
const publicFiles = ['ocr-wasm/ort-wasm-simd-threaded.wasm', 'ocr-worker.js',
  'speedtest.js', 'speedtest_worker.js', 'waiting-page-dark.html', 'waiting-page-light.html'];
for (const f of publicFiles) {
  check(`dist/${f}`, existsSync(join(root, 'dist', f)));
}
const assets = existsSync(join(root, 'dist', 'assets')) ? readdirSync(join(root, 'dist', 'assets')).length : 0;
check(`dist/assets/ 文件数 ≥ 30`, assets >= 30, `实际 ${assets}`);

// ===== 2. bundled-plugins/ =====
console.log('\n📦 bundled-plugins/');
const bundledDir = join(root, 'bundled-plugins');
function scanPlugins(dir, prefix, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    if (existsSync(join(full, 'manifest.json'))) {
      out.push(rel);
    } else {
      scanPlugins(full, rel, out);
    }
  }
  return out;
}
const pluginManifests = scanPlugins(bundledDir, '');

// 期望插件数不写死：基准取「源码 plugins/ 下实际存在的插件」。
// 有意不分发的插件（把目录移出 plugins/ 即可）不应让校验报错；真正要拦的是
// 「源码有 N 个、产物里却不是 N 个」这种静默漏打。下限守卫：产物至少要有一个插件。
const srcPluginDirs = scanPlugins(join(root, 'plugins'), '')
  .filter((p) => !/(^|\/)(_shared|_template)$/.test(p));
check(
  `插件数量 = 源码插件数 (${srcPluginDirs.length})`,
  pluginManifests.length === srcPluginDirs.length,
  `产物 ${pluginManifests.length}`,
);
check('至少打包 1 个插件', pluginManifests.length > 0, `实际 ${pluginManifests.length}`);

// 每个插件必须有 index.js + manifest.json
let pluginFilesOk = true;
for (const p of pluginManifests) {
  const dir = join(bundledDir, p);
  const hasIndex = existsSync(join(dir, 'index.js'));
  const hasManifest = existsSync(join(dir, 'manifest.json'));
  if (!hasIndex || !hasManifest) {
    pluginFilesOk = false;
    check(`${p} 完整性`, false, `index.js=${hasIndex} manifest.json=${hasManifest}`);
  }
}
if (pluginFilesOk) check('所有插件含 index.js + manifest.json', true);

// ===== 3. bundled-dlc/ =====
console.log('\n📦 bundled-dlc/');
const dlcDir = join(root, 'bundled-dlc');
const mufurongs = [];
function scanMufurongs(dir, prefix) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      scanMufurongs(full, prefix ? `${prefix}/${name}` : name);
    } else if (name.endsWith('.mufurong')) {
      mufurongs.push(prefix ? `${prefix}/${name}` : name);
    }
  }
}
scanMufurongs(join(dlcDir, 'plugins'), '');
const mujins = [];
function scanMujins(dir, prefix) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      scanMujins(full, prefix ? `${prefix}/${name}` : name);
    } else if (name.endsWith('.mujin')) {
      mujins.push(prefix ? `${prefix}/${name}` : name);
    }
  }
}
scanMujins(join(dlcDir, 'external-deps'), '');

// .mufurong 期望数同样不写死（基准=源码插件数）：有意不分发的插件不报错，
// 但「打包产物数 ≠ 源码插件数」这种漏打仍会失败。
check(
  `.mufurong 插件数 = 源码插件数 (${srcPluginDirs.length})`,
  mufurongs.length === srcPluginDirs.length,
  `实际 ${mufurongs.length}`,
);
check(`.mujin 依赖数 = 6`, mujins.length === 6, `实际 ${mujins.length}`);

// 每个 .mufurong 非空
let mufurongSizeOk = true;
for (const m of mufurongs) {
  const size = statSync(join(dlcDir, 'plugins', m)).size;
  if (size === 0) { mufurongSizeOk = false; check(`${m} 非空`, false, '0 字节'); }
}
if (mufurongSizeOk) check('所有 .mufurong 非空', true);

// 关键 .mujin 大小校验
const criticalMujins = { '全局/ffmpeg.mujin': 50_000_000, 'deskpet-assets.mujin': 1_000_000 };
for (const [name, minSize] of Object.entries(criticalMujins)) {
  const p = join(dlcDir, 'external-deps', name);
  if (existsSync(p)) {
    check(`${name} ≥ ${Math.round(minSize / 1e6)}MB`, statSync(p).size >= minSize, `${(statSync(p).size / 1e6).toFixed(1)} MB`);
  } else {
    check(`${name} 存在`, false);
  }
}

// ===== 4. NSIS 安装包 =====
console.log('\n📦 NSIS 安装包');
const nsisDir = join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const setupExe = existsSync(nsisDir)
  ? readdirSync(nsisDir).filter(f => f.endsWith('-setup.exe')).sort().pop()
  : null;
if (setupExe) {
  const size = statSync(join(nsisDir, setupExe)).size;
  check(`安装包 ${setupExe} 存在`, true);
  check(`安装包大小 ≥ 80MB`, size >= 80_000_000, `${(size / 1e6).toFixed(1)} MB`);
} else {
  check('安装包 .exe 存在', false, '未找到 *-setup.exe');
}

// ===== 5. 交叉比对 =====
console.log('\n🔗 交叉比对');
check('源码插件数 = bundled-dlc .mufurong 数', pluginManifests.length === mufurongs.length,
  `src=${pluginManifests.length} dlc=${mufurongs.length}`);

// ===== 汇总 =====
console.log(`\n${'='.repeat(40)}`);
console.log(`✅ 通过: ${pass}  ❌ 失败: ${fail}  ⚠️  警告: ${warn}`);
if (fail === 0) {
  console.log('🎉 打包产物验证通过！\n');
  process.exit(0);
} else {
  console.log('💥 存在失败项，请检查上方 ❌ 标记。\n');
  process.exit(1);
}
