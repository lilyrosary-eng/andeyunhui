// fetch-ffmpeg-linux.mjs —— 为 Linux 构建准备「随包分发」的 ffmpeg 二进制。
//
// 背景：Windows 侧 external-deps/全局/ffmpeg/ 放的是 ffmpeg.exe + *.dll；Linux 要放同目录下的
// `ffmpeg`（无扩展名），由 Rust 端 get_ffmpeg_path 优先命中（见 services/recording_service_linux.rs）。
// 打包链路把该目录压成 全局/ffmpeg.mujin 随包分发（与 Windows 同机制）。
//
// 取源优先级：
//   1) 环境变量 FFMPEG_LINUX_SRC=/path/to/static/ffmpeg  —— 指定静态版（推荐，跨发行版可用）
//   2) 下载 FFMPEG_LINUX_URL（默认 johnvansickle 静态构建）并解出 ffmpeg
//   3) 回退：复制系统 ffmpeg（**动态链接，仅适合与构建机同源的发行版**，会告警）
// 目标：external-deps/全局/ffmpeg/ffmpeg（已存在且非空则跳过）
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, chmodSync, statSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const destDir = join(root, 'external-deps', '全局', 'ffmpeg');
const dest = join(destDir, 'ffmpeg');

if (process.platform !== 'linux') {
  console.log('[ffmpeg-linux] 非 Linux 平台，跳过（Windows 用 ffmpeg.exe，无需此步）');
  process.exit(0);
}

if (existsSync(dest) && statSync(dest).size > 0) {
  console.log(`[ffmpeg-linux] 已存在，跳过: ${dest}`);
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });
const DEFAULT_URL = 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz';

function have(cmd) {
  try { execSync(`command -v ${cmd}`, { stdio: 'ignore' }); return true; } catch { return false; }
}

try {
  const src = process.env.FFMPEG_LINUX_SRC;
  if (src) {
    copyFileSync(src, dest);
    console.log(`[ffmpeg-linux] 已从 FFMPEG_LINUX_SRC 复制: ${src}`);
  } else if (have('tar') && have('xz')) {
    const url = process.env.FFMPEG_LINUX_URL || DEFAULT_URL;
    const tmp = join(destDir, '.ffmpeg-dl');
    const tarFile = join(tmp, 'ffmpeg.tar.xz');
    let got = false;
    for (let attempt = 1; attempt <= 3 && !got; attempt++) {
      try {
        rmSync(tmp, { recursive: true, force: true });
        mkdirSync(tmp, { recursive: true });
        console.log(`[ffmpeg-linux] 下载静态构建（第 ${attempt}/3 次）: ${url}`);
        // --retry/-C -：抗抖动与断点续传
        execSync(`curl -fL --retry 3 --retry-delay 2 -C - "${url}" -o "${tarFile}"`, { stdio: 'inherit' });
        // 关键：先做完整性校验，避免半截包被当成功。
        // 曾踩的坑：截断的 xz 解压失败 → 回退复制系统 ffmpeg（动态链接）→ 换机器缺库。
        execSync(`xz -t "${tarFile}"`, { stdio: 'inherit' });
        execSync(`tar -xJf "${tarFile}" -C "${tmp}"`, { stdio: 'inherit' });
        const dir = readdirSync(tmp)
          .map((n) => join(tmp, n))
          .find((d) => { try { return statSync(d).isDirectory(); } catch { return false; } });
        if (!dir) throw new Error('解压后未找到目录');
        const bin = join(dir, 'ffmpeg');
        if (!existsSync(bin)) throw new Error('解压后未找到 ffmpeg');
        copyFileSync(bin, dest);
        got = true;
        console.log('[ffmpeg-linux] ✓ 已下载通过完整性校验的静态 ffmpeg');
        rmSync(tmp, { recursive: true, force: true });
      } catch (e) {
        console.warn(`[ffmpeg-linux] 第 ${attempt} 次失败: ${e.message}`);
      }
    }
    if (!got) throw new Error('静态 ffmpeg 下载/校验失败（已重试 3 次）');
  } else {
    throw new Error('缺少 tar/xz，无法解压下载包');
  }
} catch (err) {
  if (have('ffmpeg')) {
    console.warn(`[ffmpeg-linux] 下载失败（${err.message}）；回退复制系统 ffmpeg —— ⚠ 动态链接，仅适合同源发行版`);
    copyFileSync(execSync('command -v ffmpeg').toString().trim(), dest);
  } else {
    console.error(`[ffmpeg-linux] 无法准备 ffmpeg：${err.message}；且系统无 ffmpeg。录制将回退到系统 PATH（可能不存在）。`);
    process.exit(0); // 不阻断构建：运行期 get_ffmpeg_path 会回退 PATH
  }
}

try { chmodSync(dest, 0o755); } catch { /* 忽略 */ }
console.log(`[ffmpeg-linux] 完成: ${dest}`);
