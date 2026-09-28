// prepare-bundled-dlc.mjs - 为 Tauri 打包准备 bundled-dlc/ 资源目录
//
// 在 beforeBuildCommand 末尾运行（vite build 之后），把所有插件/依赖打包成
// .mufurong/.mujin 私有格式，统一放入 bundled-dlc/，由 tauri.conf.json
// bundle.resources 嵌入安装包。安装后 Rust 端 extract_bundled_dlc 自动
// 复制到 user_plugins/ 与 user_external_deps/，再由既有的
// extract_mufurong_plugins / extract_mujin_deps 自动解压。
//
// 产物结构：
//   bundled-dlc/
//     plugins/         *.mufurong（含母文件夹 茑萝/、全局/）
//     external-deps/   *.mujin（含母文件夹 茑萝/ide/、全局/）
//
// BUILD_CLEAN=1（精简打包）：跳过打包，只创建空 bundled-dlc/ + .gitkeep，
// 安装包不含任何插件/依赖，用户后续可下载 .mufurong/.mujin 自行导入。
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, cpSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const bundledDlcDir = join(rootDir, 'bundled-dlc');
const distDlcDir = join(rootDir, 'dist-dlc');

const BUILD_CLEAN = process.env.BUILD_CLEAN === '1';
// Android 构建：移动端不加载插件/依赖，跳过 DLC 打包。pack-mufurong 内部会
// 强制重建全部 16 个插件（第二遍 vite 构建），跳过可省下大量时间与 APK 体积。
const IS_ANDROID = process.env.TAURI_ENV_PLATFORM === 'android';

// 1. 清理旧 bundled-dlc/（避免遗留过期 .mufurong/.mujin）
if (existsSync(bundledDlcDir)) {
  rmSync(bundledDlcDir, { recursive: true });
}
mkdirSync(bundledDlcDir, { recursive: true });

if (BUILD_CLEAN || IS_ANDROID) {
  // 精简/Android 模式：只放 .gitkeep 占位，让 tauri bundle 能找到非空目录
  writeFileSync(join(bundledDlcDir, '.gitkeep'), '');
  console.log(`[PrepareDLC] ${IS_ANDROID ? 'Android 构建：跳过 DLC 打包（移动端不加载插件/依赖）' : 'BUILD_CLEAN=1'}：已创建空 bundled-dlc/ 占位`);
  process.exit(0);
}

// ========== 1b. ffmpeg 依赖集完整性校验（缺失即中止构建） ==========
//
// 踩过的坑：external-deps/全局/ffmpeg/ 曾被换上「只有 avcodec-62.dll + avfilter-11.dll
// + 630 KB 的 shared 版 ffmpeg.exe」的残缺集 —— 79.7 MB 的依赖打进了安装包却完全用不了：
//   · 进程内编码器（services/recording_service/ffi.rs）要 avutil-60 / swresample-6 /
//     avcodec-62 / avformat-62 四个共享 DLL，按「叶子先加载」的顺序 LoadLibrary；
//   · CLI 功能（分段拼接 / HLS 转封装 / 录屏回退 / 诊断自检）要一个**自包含**的
//     ffmpeg.exe（gyan.dev 的 essentials_build 或 full_build，非 *_shared）。
// 这里在打包前做硬校验，避免再把「装得上但用不了」的包发出去。
function checkFfmpegSet() {
  const dir = join(rootDir, 'external-deps', '全局', 'ffmpeg');
  const problems = [];
  if (!existsSync(dir)) {
    return [`目录不存在: ${relative(rootDir, dir)}`];
  }
  const files = readdirSync(dir);
  // ① 自包含 ffmpeg.exe：直接跑 -version，能跑通才算自包含
  //    （shared 版 CLI 换到别处会因缺 avformat/avutil 等 DLL 直接失败——这正是当初的故障形态）
  const exe = join(dir, 'ffmpeg.exe');
  if (!existsSync(exe)) {
    problems.push('缺少 ffmpeg.exe（CLI：分段拼接 / HLS 转封装 / 录屏回退 / 诊断自检）');
  } else {
    try {
      execSync(`"${exe}" -hide_banner -version`, { stdio: 'pipe', timeout: 20000 });
    } catch {
      problems.push(
        'ffmpeg.exe 无法独立运行（退出码非 0）。请换用 gyan.dev 的 essentials_build / full_build ' +
          '自包含版本（非 *_shared）；shared 版 CLI 会把 avfilter/avdevice 等 DLL 也拖进安装包，体积反而更大',
      );
    }
  }
  // ② 进程内编码器的四个共享 DLL（用通配匹配，容忍 ffmpeg 小版本升级）
  for (const [label, re] of [
    ['avutil-*.dll', /^avutil-\d+\.dll$/i],
    ['swresample-*.dll', /^swresample-\d+\.dll$/i],
    ['avcodec-*.dll', /^avcodec-\d+\.dll$/i],
    ['avformat-*.dll', /^avformat-\d+\.dll$/i],
  ]) {
    if (!files.some((f) => re.test(f))) {
      problems.push(`缺少 ${label}（进程内 libavcodec 编码器，见 ffi.rs 的 load 顺序）`);
    }
  }
  return problems;
}

const ffmpegProblems = checkFfmpegSet();
if (ffmpegProblems.length > 0) {
  console.error('[PrepareDLC] ✗ ffmpeg 依赖集不完整，已中止构建：');
  for (const p of ffmpegProblems) console.error(`            - ${p}`);
  console.error('[PrepareDLC]   期望文件：ffmpeg.exe（自包含）+ avutil-*/swresample-*/avcodec-*/avformat-*.dll');
  console.error('[PrepareDLC]   ⚠ 不要放入 avfilter/avdevice/ffplay/ffprobe：avfilter 单个约 118 MiB，');
  console.error('[PrepareDLC]     只有 shared 版 CLI 才需要，白占安装包约 29 MiB。');
  process.exit(1);
}
console.log('[PrepareDLC] [OK] ffmpeg 依赖集校验通过（自包含 ffmpeg.exe + 进程内 4 个共享 DLL）');

// 2. 调用 pack-mufurong.mjs 生成 dist-dlc/（内部自动调用 pack-mujin.mjs）
//    - dist-dlc/plugins/         *.mufurong
//    - dist-dlc/external-deps/   *.mujin
console.log('[PrepareDLC] 调用 pack-mufurong.mjs 生成 .mufurong + .mujin ...');
try {
  execSync('node scripts/pack-mufurong.mjs', { cwd: rootDir, stdio: 'inherit' });
} catch (e) {
  // 🔴 不再静默降级：pack-mufurong 失败意味着插件/依赖打包异常，
  //    应中止构建而非生成空壳安装包（否则用户拿到「能装但没有插件」的残缺包）。
  console.error(`[PrepareDLC] ✗ pack-mufurong.mjs 失败: ${e.message}`);
  console.error('[PrepareDLC] 已中止，安装包未生成（请修复插件打包错误后重试）');
  process.exit(1);
}

// 3. 把 dist-dlc/ 整体复制到 bundled-dlc/
if (!existsSync(distDlcDir)) {
  // pack-mufurong.mjs 成功退出但未生成 dist-dlc/，属脚本内部 bug，中止构建
  console.error('[PrepareDLC] ✗ dist-dlc/ 未生成（pack-mufurong.mjs 内部异常），已中止');
  process.exit(1);
}

console.log('[PrepareDLC] 复制 dist-dlc/ -> bundled-dlc/ ...');
cpSync(distDlcDir, bundledDlcDir, { recursive: true });

// 3b. 安装包内的 .mujin 改存 store（不压缩），把压缩让给 NSIS 的 LZMA
//
// 为什么：.mujin 本身就是 ZIP（deflate），NSIS 拿到已压缩的数据几乎压不动，
// 等于白白浪费一次「更好的压缩」机会。实测 ffmpeg 依赖集：
//     deflate(ZIP) = 79.7 MiB   →   交给 NSIS LZMA = 57.6 MiB（省 22 MiB）
// dist-dlc/ 对外分发的那份仍保持 deflate（用户手动下载 .mujin 时体积更小），
// 故这里只重写 bundled-dlc/ 里的副本。解压端用 zip crate 的 by_index + io::copy，
// Stored / Deflate 都能读，换存储方式对运行时零影响。
function zipToStore(zipPath) {
  const tmp = `${zipPath}.store`;
  const s = zipPath.replace(/'/g, "''");
  const t = tmp.replace(/'/g, "''");
  const ps =
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
    `$src=[System.IO.Compression.ZipFile]::OpenRead('${s}'); ` +
    `$dst=[System.IO.Compression.ZipFile]::Open('${t}','Create'); ` +
    `foreach($e in $src.Entries){ ` +
    `$ne=$dst.CreateEntry($e.FullName,[System.IO.Compression.CompressionLevel]::NoCompression); ` +
    `$is=$e.Open(); $os=$ne.Open(); $is.CopyTo($os); $os.Dispose(); $is.Dispose() }; ` +
    `$dst.Dispose(); $src.Dispose()`;
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, { stdio: 'pipe' });
  rmSync(zipPath);
  renameSync(tmp, zipPath);
}

function collectMujins(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectMujins(p));
    else if (entry.name.endsWith('.mujin')) out.push(p);
  }
  return out;
}

const mujins = collectMujins(join(bundledDlcDir, 'external-deps'));
let storeConverted = 0;
let storeSaved = 0;
for (const m of mujins) {
  if (statSync(m).size === 0) continue;
  const before = statSync(m).size;
  try {
    zipToStore(m);
    storeConverted++;
    storeSaved += before - statSync(m).size;
  } catch (e) {
    console.error(`[PrepareDLC] ✗ 转 store 失败: ${relative(rootDir, m)} — ${e.message}`);
    process.exit(1);
  }
}
// 转 store 后 .mujin 会「变大」（原本 deflate 压过），这是预期：省下的体积体现在
// 安装包（NSIS LZMA）上，而不是这个中间产物上。故这里只报数量，不报「变大了」。
console.log(
  `[PrepareDLC] .mujin 转 store: ${storeConverted} 个 ` +
    `（预期解压后体积 +${(storeSaved / 1024 / 1024).toFixed(1)} MiB，由 NSIS LZMA 在安装包里压回并额外省下约 20%）`,
);

// 4. 统计结果
function countFiles(dir, ext) {
  let n = 0;
  if (!existsSync(dir)) return 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      n += countFiles(join(dir, entry.name), ext);
    } else if (entry.name.endsWith('.' + ext)) {
      n++;
    }
  }
  return n;
}
const mufurongCount = countFiles(join(bundledDlcDir, 'plugins'), 'mufurong');
const mujinCount = countFiles(join(bundledDlcDir, 'external-deps'), 'mujin');

console.log('');
console.log('[PrepareDLC] ========================================');
console.log(`[PrepareDLC] [OK] bundled-dlc/ 准备完成`);
console.log(`[PrepareDLC]   - .mufurong 插件: ${mufurongCount} 个`);
console.log(`[PrepareDLC]   - .mujin    依赖: ${mujinCount} 个`);
console.log(`[PrepareDLC]   目录: ${relative(rootDir, bundledDlcDir)}`);
console.log('[PrepareDLC] ========================================');
