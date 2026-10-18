// .mujin 打包脚本：把 external-deps/ 下的每个依赖目录打包成专属格式 .mujin
//
// .mujin = ZIP 改后缀，与 .mufurong 同源机制，但用于外部依赖（external-deps）。
// 用户把 .mujin 放到 user_external_deps/ 目录，应用自动解压（Rust 端 zip crate）。
//
// 大型模块（茑萝/全局/阅读）保留母文件夹结构：
//   茑萝/ide/codemirror.mujin, 茑萝/wps/tiptap.mujin, ...
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
import { zipDir } from './lib/zip.mjs';

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
//
// heavy: true —— 重型依赖（ffmpeg/OCR/桌面宠物资源等）。
//   BUILD_LITE=1 时跳过这些依赖，用于 Android 等轻量构建（手机系统自带媒体播放/截图，
//   无需 ffmpeg；OCR/桌面宠物非移动端核心功能）。桌面构建不设 BUILD_LITE，全量打包。
//   未来移动端需要某依赖时，从该条移除 heavy 标记即可。
//
// excludeWin / excludeOther —— 平台专属排除（glob，按 basename 或相对路径匹配）。
//   背景：external-deps/全局/ffmpeg/ 同时放着两套二进制——
//     · Windows：ffmpeg.exe + avcodec-62/avformat-62/avutil-60/swresample-6 四个共享 DLL
//     · Linux：  fetch-ffmpeg-linux.mjs 落的**无扩展名**静态 ffmpeg（见
//               services/recording_service_linux.rs:147 的 get_ffmpeg_path）
//   原实现只在非 Windows 侧排除 *.exe/*.dll，Windows 侧一个字节都不排，
//   于是 76MB 的 Linux 静态 ffmpeg 被打进每个 Windows 安装包（安装包 101.6MB，
//   约 25~30MB 是它）。现在两侧对称：各排掉对方平台的那一套。
//   注意：Windows 侧的排除早先**静默失效**——zipDir 的 exclude 在 Windows 分支被丢掉
//   （CreateFromDirectory 不支持过滤），已修，见 scripts/lib/zip.mjs。
const TARGETS = [
  // 茑萝子模块（茑萝/ide/、茑萝/wps/ 母文件夹结构）
  { src: '茑萝/ide/codemirror', out: '茑萝/ide/codemirror.mujin' },
  { src: '茑萝/wps/tiptap',     out: '茑萝/wps/tiptap.mujin' },
  // 全局模块（全局/ 母文件夹结构）
  {
    src: '全局/ffmpeg',
    out: '全局/ffmpeg.mujin',
    heavy: true,
    // Windows 包只留 ffmpeg.exe + 四个共享 DLL；Linux 包只留无扩展名的 ffmpeg
    excludeWin: ['ffmpeg'],
    excludeOther: ['*.exe', '*.dll'],
  },
  { src: '全局/basic-pitch',       out: '全局/basic-pitch.mujin', heavy: true },
  // 本地 OCR 依赖包（引擎 + ONNX 模型 + 字符表，用户自行下载放入「依赖」目录）
  { src: '全局/paddleocr',         out: '全局/paddleocr.mujin', heavy: true },
  { src: 'deskpet-assets',         out: 'deskpet-assets.mujin', heavy: true },
  // 攻防模块真实 TLS 指纹通道（curl-impersonate，MIT，Windows x86_64 预编译二进制）。
  // heavy：移动端无此需求（且该二进制为 Windows 专属），Android/BUILD_LITE 构建应跳过。
  // excludeOther：Linux/macOS 包排除 curl-impersonate.exe（Windows x86_64 二进制，跑了也没用）。
  {
    src: '全局/curl-impersonate',
    out: '全局/curl-impersonate.mujin',
    heavy: true,
    excludeOther: ['*.exe', '*.dll'],
  },
];

// 轻量构建模式：跳过 heavy 依赖。
//   - Android 构建自动启用（TAURI_ENV_PLATFORM=android）：手机系统自带媒体播放/截图能力，
//     无需 ffmpeg/OCR/桌面宠物等重型依赖；移动端只保留核心功能依赖，APK 从 ~184MB 降到 ~15MB。
//     Tauri v2 在 beforeBuildCommand 期间注入 TAURI_ENV_PLATFORM（见官方环境变量文档）。
//   - 桌面构建默认全量打包；如需在桌面测试轻量包，显式设置 BUILD_LITE=1。
//   - 显式 BUILD_LITE=1 始终生效（覆盖自动判定），便于调试。
const IS_ANDROID = process.env.TAURI_ENV_PLATFORM === 'android';
const BUILD_LITE = process.env.BUILD_LITE === '1' || IS_ANDROID;

// 用跨平台助手打包目录为 .mujin（ZIP 格式，不自动添加 .zip 后缀）
// Windows 走 PowerShell .NET；其它平台走 Info-ZIP（见 scripts/lib/zip.mjs）。
//
// 平台排除按 target 逐个声明（excludeWin / excludeOther），兜底再用
// PLATFORM_DEFAULT_EXCLUDE 补一条全局默认——早先「只在非 Windows 排 *.exe/*.dll」
// 是单向的，导致 Windows 安装包打进 76MB 的 Linux 静态 ffmpeg（见 TARGETS 注释）。
const IS_WIN = process.platform === 'win32';
const PLATFORM_DEFAULT_EXCLUDE = IS_WIN ? [] : ['*.exe', '*.dll'];

/** 取该 target 在当前平台下的排除模式（声明值 + 全局默认，去重） */
function excludeFor(target) {
  const declared = IS_WIN ? (target.excludeWin ?? []) : (target.excludeOther ?? []);
  return [...new Set([...declared, ...PLATFORM_DEFAULT_EXCLUDE])];
}

function packToMujin(srcDir, destFile, exclude) {
  zipDir(srcDir, destFile, { exclude });
}

// ========== 主流程 ==========

if (!existsSync(externalDir)) {
  console.error('[PackMujin] external-deps/ 目录不存在，请先准备好依赖源');
  process.exit(1);
}

const liteReason = process.env.BUILD_LITE === '1' ? 'BUILD_LITE=1' : (IS_ANDROID ? 'TAURI_ENV_PLATFORM=android' : '');
console.log(`[PackMujin] 发现 ${TARGETS.length} 个依赖待打包${BUILD_LITE ? `（轻量模式 · ${liteReason}，跳过 heavy）` : '（全量模式）'}`);

// 清理输出目录
if (existsSync(outputDir)) rmSync(outputDir, { recursive: true });
mkdirSync(outputDir, { recursive: true });

// 逐个打包
let packed = 0;
const packedList = [];
const failedDeps = [];
for (const target of TARGETS) {
  const { src, out } = target;
  // 轻量模式跳过重型依赖
  if (BUILD_LITE && target.heavy) {
    console.log(`[PackMujin] ⊘ 跳过重型依赖（BUILD_LITE=1）: ${src}`);
    continue;
  }
  const srcDir = join(externalDir, src);
  const destFile = join(outputDir, out);
  if (!existsSync(srcDir)) {
    console.warn(`[PackMujin] ⚠ 跳过不存在的源: ${src}`);
    continue;
  }
  try {
    const exclude = excludeFor(target);
    packToMujin(srcDir, destFile, exclude);
    packed++;
    packedList.push(out);
    const exNote = exclude.length ? `（排除 ${exclude.join(' ')}）` : '';
    console.log(`[PackMujin] ✓ ${src} -> ${relative(rootDir, destFile)}${exNote}`);
  } catch (e) {
    console.error(`[PackMujin] ✗ ${src} 打包失败: ${e.message}`);
    failedDeps.push(src);
  }
}

// 生成使用说明（与 pack-mufurong 配套，单独一份依赖说明）
const readmePath = join(outputDir, '依赖安装说明.txt');
const readmeContent = `安得云荟 · 外部依赖包（.mujin）
================================

本目录包含 ${packed} 个外部依赖（.mujin 格式）。

安装方式：
  把 .mujin 文件放到应用数据目录的 user_external_deps/ 文件夹下。
  - 母文件夹（如 茑萝/ide/、茑萝/wps/、全局/）需要手动创建
  - 例如：
      user_external_deps/茑萝/ide/codemirror.mujin
      user_external_deps/茑萝/wps/tiptap.mujin
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

// 关键：任一依赖打包失败则整体失败退出，避免静默生成残缺安装包。
if (failedDeps.length > 0) {
  console.error(`\n[PackMujin] ✗ 以下依赖打包失败，已中止：${failedDeps.join(', ')}`);
  console.error('[PackMujin] 请修复上述依赖的打包错误后重试。');
  process.exit(1);
}
