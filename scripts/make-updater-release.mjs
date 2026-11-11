/**
 * 生成 Windows 应用内更新发布物：
 *   1. 用本项目的 minisign 私钥签 NSIS 安装包（不依赖全局 TAURI_SIGNING_* 环境）；
 *   2. 输出 latest.json（Tauri updater 格式）与可上传的安装包/签名副本。
 *
 * 用法：
 *   node scripts/make-updater-release.mjs [--notes "更新说明"] [--notes-file path] [--base-url https://...]
 *
 * 私钥默认：%USERPROFILE%\.tauri\andeyunhui-updater.key
 * 可用 ANDEYUNHUI_UPDATER_KEY 覆盖；如需密码，用 ANDEYUNHUI_UPDATER_KEY_PASSWORD。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const confPath = path.join(root, 'src-tauri', 'tauri.conf.json');
const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
const version = conf.version;

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** 读取 repeated --mirror-url 与逗号分隔的 --mirrors。 */
function mirrorUrls() {
  const urls = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === '--mirror-url' && process.argv[index + 1]) {
      urls.push(process.argv[index + 1]);
      index += 1;
    }
  }
  const list = argValue('--mirrors');
  if (list) {
    urls.push(...list.split(',').map((item) => item.trim()).filter(Boolean));
  }
  return [...new Set(urls)];
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

const bundleDir = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const explicitSetup = argValue('--setup');

let setupPath;
if (explicitSetup) {
  setupPath = path.resolve(root, explicitSetup);
  if (!fs.existsSync(setupPath)) {
    console.error(`[updater] 指定的安装包不存在：${setupPath}`);
    process.exit(1);
  }
} else {
  if (!fs.existsSync(bundleDir)) {
    console.error(`[updater] 找不到 NSIS 输出目录：${bundleDir}\n请先运行 pnpm tauri build 或 build.bat`);
    process.exit(1);
  }

  const setups = fs
    .readdirSync(bundleDir)
    .filter((name) => name.endsWith('-setup.exe'))
    .map((name) => path.join(bundleDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (setups.length === 0) {
    console.error('[updater] 没有找到 *-setup.exe');
    process.exit(1);
  }
  const versioned = setups.filter((file) => path.basename(file).includes(`_${version}_`));
  setupPath =
    versioned.find((file) => path.basename(file).startsWith('andeyunhui_')) ||
    versioned[0] ||
    setups[0];
}
const setupName = path.basename(setupPath);
if (!setupName.includes(`_${version}_`)) {
  console.warn(`[updater] 警告：安装包名 ${setupName} 不包含当前版本 ${version}`);
}

const keyPath =
  process.env.ANDEYUNHUI_UPDATER_KEY ||
  path.join(os.homedir(), '.tauri', 'andeyunhui-updater.key');
if (!fs.existsSync(keyPath)) {
  console.error(`[updater] 找不到更新签名私钥：${keyPath}\n请先运行 pnpm tauri signer generate -w <path>，再生成 latest.json`);
  process.exit(1);
}
const keyContent = fs.readFileSync(keyPath, 'utf8').trim();

const tauriCli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
if (!fs.existsSync(tauriCli)) {
  console.error(`[updater] 找不到 Tauri CLI：${tauriCli}`);
  process.exit(1);
}
const childEnv = { ...process.env };
// pnpm 的 .bin/tauri.cmd 会补 NODE_PATH；这里直接跑 tauri.js，需要自己补上平台包解析路径。
try {
  const pnpmDir = path.join(root, 'node_modules', '.pnpm');
  const cliPkg = fs
    .readdirSync(pnpmDir)
    .find((name) => name.startsWith('@tauri-apps+cli@'));
  if (cliPkg) {
    const nodePaths = [
      path.join(pnpmDir, cliPkg, 'node_modules'),
      path.join(pnpmDir, 'node_modules'),
      childEnv.NODE_PATH,
    ].filter(Boolean);
    childEnv.NODE_PATH = nodePaths.join(path.delimiter);
  }
} catch {
  // 保留原有 NODE_PATH 即可
}
// 清掉本机其他项目设置的签名环境，避免签成别人的 key。
delete childEnv.TAURI_SIGNING_PRIVATE_KEY_PATH;
childEnv.TAURI_SIGNING_PRIVATE_KEY = keyContent;
childEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD =
  process.env.ANDEYUNHUI_UPDATER_KEY_PASSWORD || '';

console.log(`[updater] 签名安装包：${setupPath}`);
const signed = spawnSync(process.execPath, [tauriCli, 'signer', 'sign', setupPath], {
  cwd: root,
  env: childEnv,
  stdio: 'inherit',
});
if (signed.status !== 0) {
  console.error('[updater] 签名失败');
  process.exit(signed.status || 1);
}

const sigPath = `${setupPath}.sig`;
if (!fs.existsSync(sigPath)) {
  console.error(`[updater] 签名完成但找不到 ${sigPath}`);
  process.exit(1);
}
const signature = fs.readFileSync(sigPath, 'utf8').trim();
const sha256 = await sha256File(setupPath);
const mirrors = mirrorUrls();

// GitHub Release 会把含中文的资产名规范化（实测会变成 "_2.4.4_..."），
// 与 latest.json 里的 URL 对不上。发布资产统一用 ASCII 文件名，内容/签名不变。
const assetName = `andeyunhui_${version}_x64-setup.exe`;

let notes = argValue('--notes');
const notesFile = argValue('--notes-file');
if (!notes && notesFile) {
  notes = fs.readFileSync(path.resolve(root, notesFile), 'utf8').trim();
}
if (!notes) notes = `安得云荟 v${version} 更新`;

const baseUrl =
  argValue('--base-url') ||
  process.env.ANDEYUNHUI_UPDATE_BASE_URL ||
  `https://github.com/lilyrosary-eng/andeyunhui/releases/download/v${version}/`;
const url = baseUrl.replace(/\/?$/, '/') + encodeURIComponent(assetName);

const platform = {
  signature,
  url,
  sha256,
  size: fs.statSync(setupPath).size,
};
if (mirrors.length > 0) {
  platform.mirrors = mirrors;
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64-nsis': platform,
    'windows-x86_64': platform,
  },
};

const outDir = path.resolve(root, argValue('--out-dir') || 'dist-updater');
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(setupPath, path.join(outDir, assetName));
fs.copyFileSync(sigPath, path.join(outDir, `${assetName}.sig`));
fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log('\n[updater] 发布物已生成：');
console.log(`  安装包: ${path.join(outDir, assetName)}`);
console.log(`  签名:   ${path.join(outDir, `${assetName}.sig`)}`);
console.log(`  清单:   ${path.join(outDir, 'latest.json')}`);
console.log(`  版本:   ${version}`);
console.log(`  下载:   ${url}`);
if (mirrors.length > 0) {
  console.log(`  镜像:   ${mirrors.join(' , ')}`);
}
console.log(`  SHA-256: ${sha256}`);
console.log('\n上传提醒：把安装包、.sig、latest.json 传到 GitHub Release 的 v' + version + '；');
console.log('确保该 Release 是 latest（非预发布），客户端会请求：');
console.log('  https://github.com/lilyrosary-eng/andeyunhui/releases/latest/download/latest.json');
