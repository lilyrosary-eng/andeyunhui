// .mujin 打包脚本：把 external-deps/ 下的每个依赖目录打包成专属格式 .mujin
//
// .mujin = ZIP 改后缀，与 .mufurong 同源机制，但用于外部依赖（external-deps）。
// 用户把 .mujin 放到 user_external_deps/ 目录，应用自动解压（Rust 端 zip crate）。
//
// 大型模块（茑萝/全局/阅读）保留母文件夹结构：
//   niaoluo/ide/codemirror.mujin, niaoluo/wps/tiptap.mujin, ...
//   全局/ffmpeg.mujin, 全局/basic-pitch.mujin
//
// 不可再分的依赖（tiptap 等即使内部有子文件夹）整体打包成单个 .mujin。
//
// 打包工具：PowerShell [System.IO.Compression.ZipFile]::CreateFromDirectory()
// （Windows 10+ 内置 .NET，无需额外依赖，MIT 协议）
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const externalDir = join(rootDir, 'external-deps');
const outputDir = join(rootDir, 'dist-dlc', 'external-deps');

// ========== 依赖白名单 ==========
// 每条声明一个要打包的依赖目录（src，相对于 external-deps/）及其输出路径（out，相对于输出根）。
//
// 打包规则：
//   - 茑萝子模块的依赖保留母文件夹结构（与 plugins 镜像）
//   - 不可再分的依赖（tiptap 等即使内部有 packages/、tests/ 等子文件夹）
//     也整体打包成单个 .mujin（CreateFromDirectory 会递归整个目录树）
//   - 新增依赖只需在此数组追加一条声明
const TARGETS = [
  // 茑萝子模块（niaoluo/ide/、niaoluo/wps/ 母文件夹结构）
  { src: 'niaoluo/ide/codemirror', out: 'niaoluo/ide/codemirror.mujin' },
  { src: 'niaoluo/wps/tiptap',     out: 'niaoluo/wps/tiptap.mujin' },
  // 全局模块（全局/ 母文件夹结构）
  { src: '全局/ffmpeg',            out: '全局/ffmpeg.mujin' },
  { src: '全局/basic-pitch',       out: '全局/basic-pitch.mujin' },
];

// 用 PowerShell .NET API 打包目录为 .mujin（ZIP 格式，不自动添加 .zip 后缀）
function packToMujin(srcDir, destFile) {
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

if (!existsSync(externalDir)) {
  console.error('[PackMujin] external-deps/ 目录不存在，请先准备好依赖源');
  process.exit(1);
}

console.log(`[PackMujin] 发现 ${TARGETS.length} 个依赖待打包`);

// 清理输出目录
if (existsSync(outputDir)) rmSync(outputDir, { recursive: true });
mkdirSync(outputDir, { recursive: true });

// 逐个打包
let packed = 0;
const packedList = [];
for (const { src, out } of TARGETS) {
  const srcDir = join(externalDir, src);
  const destFile = join(outputDir, out);
  if (!existsSync(srcDir)) {
    console.warn(`[PackMujin] ⚠ 跳过不存在的源: ${src}`);
    continue;
  }
  try {
    packToMujin(srcDir, destFile);
    packed++;
    packedList.push(out);
    console.log(`[PackMujin] ✓ ${src} -> ${relative(rootDir, destFile)}`);
  } catch (e) {
    console.error(`[PackMujin] ✗ ${src} 打包失败: ${e.message}`);
  }
}

// 生成使用说明（与 pack-mufurong 配套，单独一份依赖说明）
const readmePath = join(outputDir, '依赖安装说明.txt');
const readmeContent = `岸灯鸢花 · 外部依赖包（.mujin）
================================

本目录包含 ${packed} 个外部依赖（.mujin 格式）。

安装方式：
  把 .mujin 文件放到应用数据目录的 user_external_deps/ 文件夹下。
  - 母文件夹（如 niaoluo/ide/、niaoluo/wps/、全局/）需要手动创建
  - 例如：
      user_external_deps/niaoluo/ide/codemirror.mujin
      user_external_deps/niaoluo/wps/tiptap.mujin
  - 应用启动时自动解压，源文件 mtime 匹配时跳过（速度极快）
  - 用户安装的依赖可覆盖打包资源（external-deps/）的同名依赖

依赖列表：
${packedList.map(p => `  - ${p}`).join('\n')}

制作 .mujin 依赖：
  1. 把第三方依赖项目放到 external-deps/<模块>/<子模块>/<依赖名>/ 下
  2. 在 scripts/pack-mujin.mjs 的 TARGETS 数组追加一条声明
  3. 运行 node scripts/pack-mujin.mjs 打包
  4. .mujin 本质是 ZIP 改后缀，可用任何 ZIP 工具查看内容
`;
mkdirSync(outputDir, { recursive: true });
writeFileSync(readmePath, readmeContent, 'utf-8');

console.log(`\n[PackMujin] 依赖打包完成！`);
console.log(`[PackMujin] .mujin 依赖: ${packed} 个`);
console.log(`[PackMujin] 输出目录: ${outputDir}`);
