// .mufurong 打包脚本：把 bundled-plugins/ 下的每个插件打包成专属格式 .mufurong
//
// .mufurong = ZIP 改后缀。内部结构：manifest.json + index.js（+可选资源）
// 用户把 .mufurong 放到 user_plugins/ 目录，应用自动解压（Rust 端 zip crate）
//
// 大型模块（茑萝/全局/阅读）保留母文件夹结构：
//   niaoluo/ai.mufurong, niaoluo/gongjuxiang.mufurong, ...
//   全局/screen-recorder.mufurong
//
// 打包工具：PowerShell [System.IO.Compression.ZipFile]::CreateFromDirectory()
// （Windows 10+ 内置 .NET，无需额外依赖，MIT 协议）
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const bundledDir = join(rootDir, 'bundled-plugins');
const externalDir = join(rootDir, 'external-deps');
const outputDir = join(rootDir, 'dist-dlc');

// 递归扫描插件：找所有含 manifest.json 的目录
function scanPlugins(dir, prefix, out) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    if (existsSync(join(full, 'manifest.json'))) {
      out.push({ relPath: rel, dir: full });
    } else {
      scanPlugins(full, rel, out);
    }
  }
}

// 用 PowerShell .NET API 打包目录为 .mufurong（ZIP 格式，不自动添加 .zip 后缀）
function packToMufurong(srcDir, destFile) {
  mkdirSync(dirname(destFile), { recursive: true });
  if (existsSync(destFile)) rmSync(destFile);

  // 用 EncodedCommand 传递脚本，避免引号转义问题
  // 单引号字符串中的单引号用两个单引号转义
  const src = srcDir.replace(/'/g, "''");
  const dst = destFile.replace(/'/g, "''");
  const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${src}', '${dst}', [System.IO.Compression.CompressionLevel]::Optimal, $false)`;
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, { stdio: 'pipe' });
}

// ========== 主流程 ==========

// 1. 先确保 bundled-plugins/ 已构建（运行 deploy-plugins.mjs）
if (!existsSync(bundledDir) || readdirSync(bundledDir).length === 0) {
  console.log('[Pack] bundled-plugins/ 不存在或为空，先运行 deploy-plugins.mjs...');
  execSync('node scripts/deploy-plugins.mjs', { cwd: rootDir, stdio: 'inherit' });
}

// 2. 扫描所有插件
const plugins = [];
scanPlugins(bundledDir, '', plugins);
console.log(`[Pack] 发现 ${plugins.length} 个插件`);

// 3. 清理输出目录
if (existsSync(outputDir)) rmSync(outputDir, { recursive: true });
mkdirSync(outputDir, { recursive: true });

// 4. 打包每个插件为 .mufurong
let packed = 0;
for (const { relPath, dir } of plugins) {
  const outFile = join(outputDir, 'plugins', relPath + '.mufurong');
  try {
    packToMufurong(dir, outFile);
    packed++;
    console.log(`[Pack] ✓ ${relPath} -> ${relative(rootDir, outFile)}`);
  } catch (e) {
    console.error(`[Pack] ✗ ${relPath} 打包失败: ${e.message}`);
  }
}

// 5. 调用 pack-mujin.mjs 把 external-deps/ 打包成 .mujin（与 .mufurong 同源机制）
// .mujin 输出到 dist-dlc/external-deps/ 下，保留母文件夹结构（niaoluo/ide/、全局/ 等）
if (existsSync(externalDir)) {
  console.log('[Pack] 调用 pack-mujin.mjs 打包 .mujin 依赖 ...');
  try {
    execSync('node scripts/pack-mujin.mjs', { cwd: rootDir, stdio: 'inherit' });
  } catch (e) {
    console.warn(`[Pack] ⚠ .mujin 依赖打包失败（非致命）: ${e.message}`);
  }
}

// 6. 生成使用说明
const readmePath = join(outputDir, '使用说明.txt');
const readmeContent = `安得云荟 · DLC 插件与依赖包
==============================

本目录包含 ${packed} 个 .mufurong 插件与若干 .mujin 外部依赖。

安装方式：
1. 插件（.mufurong 文件）：
   把 .mufurong 文件放到应用数据目录的 user_plugins/ 文件夹下。
   - 母文件夹（如 niaoluo/、全局/）需要手动创建
   - 例如：user_plugins/niaoluo/ai.mufurong
   - 应用启动时自动解压，版本匹配时跳过（速度极快）

2. 外部依赖（.mujin 文件）：
   把 .mujin 文件放到应用数据目录的 user_external_deps/ 文件夹下。
   - 母文件夹（如 niaoluo/ide/、niaoluo/wps/、全局/）需要手动创建
   - 例如：user_external_deps/niaoluo/ide/codemirror.mujin
   - 应用启动时自动解压，源文件 mtime 匹配时跳过（速度极快）
   - 用户安装的 .mujin 优先于打包资源 external-deps/，可覆盖同名依赖

插件列表：
${plugins.map(p => `  - ${p.relPath}`).join('\n')}

制作 .mufurong 插件：
  1. 在 plugins/ 下创建插件目录（参考 _template/）
  2. 编写 manifest.json + src/index.tsx
  3. 运行 node scripts/pack-mufurong.mjs 打包（同时会调用 pack-mujin.mjs）
  4. .mufurong 本质是 ZIP 改后缀，可用任何 ZIP 工具查看内容

制作 .mujin 依赖：
  1. 把第三方依赖项目放到 external-deps/<模块>/<子模块>/<依赖名>/ 下
  2. 在 scripts/pack-mujin.mjs 的 TARGETS 数组追加一条声明
  3. 运行 node scripts/pack-mujin.mjs 打包（或通过 pack-mufurong.mjs 自动调用）
  4. .mujin 本质是 ZIP 改后缀，可用任何 ZIP 工具查看内容
`;
mkdirSync(outputDir, { recursive: true });
writeFileSync(readmePath, readmeContent, 'utf-8');

console.log(`\n[Pack] DLC 打包完成！`);
console.log(`[Pack] 插件 .mufurong: ${packed} 个`);
console.log(`[Pack] 输出目录: ${outputDir}`);
