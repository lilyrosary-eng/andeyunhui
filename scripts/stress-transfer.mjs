#!/usr/bin/env node
// 局域网传输暴力压测工具（LocalSend v2 兼容对端）
//
// 为什么需要它：本项目的传输模块曾「小流量正常、大流量爆内存/卡死」，根因是
// 整文件进内存 + 固定 30 s 总超时 + 每 chunk 一次进度事件。靠鼠标点几次小文件
// 永远压不出这类问题。本脚本提供可重复、可量化的暴力压测：
//
//   · serve  —— 把本机变成一个 LocalSend 兼容接收端（可被 App 发现并投送），
//               用于压 App 的**发送端**（流式读盘、超时、并发、内存）。
//   · send   —— 向目标（App 的接收端 127.0.0.1:53317）并行投送大文件，
//               用于压 App 的**接收端**（并发闸、超时、超量保护、内存）。
//   · self   —— 本地自压（serve + send 全在 Node 内），验证脚本本身与协议实现。
//
// 关键能力 --rss-pid：全程采样目标进程的工作集内存并报峰值。
// 「内存不再随文件大小增长」这条结论必须用它来证明，而不是靠肉眼感觉。
//
// 用法：
//   # 1) 压 App 的接收端：先在 App 里打开「传输」面板（让服务监听 :53317），然后
//   node scripts/stress-transfer.mjs send --target 127.0.0.1:53317 --file D:\big.bin --jobs 4 --rss-pid <App的PID>
//   # 2) 没有大文件时自动造一个（默认 2 GB，写临时文件，不占内存）
//   node scripts/stress-transfer.mjs send --target 127.0.0.1:53317 --size-gb 8 --jobs 6 --rss-pid <PID>
//   # 3) 压 App 的发送端：跑起 serve，然后在 App 的传输面板里向「stresstest」投送文件
//   node scripts/stress-transfer.mjs serve --port 53318 --dir .\_stress_recv --announce --rss-pid <PID>
//   # 4) 自压（不需要 App）
//   node scripts/stress-transfer.mjs self --size-gb 2 --jobs 4
//
// 纯 Node 标准库，无第三方依赖。

import http from 'node:http';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';

const MULTICAST_GROUP = '224.0.0.167';
const MULTICAST_PORT = 53317;
const PROTOCOL_VERSION = '2.1';
const FINGERPRINT = 'stress-' + randomUUID();

// ============================ 参数解析 ============================
function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const opts = { mode, jobs: 1, sizeGb: 0, port: 53318, rounds: 1, chunkMb: 4, slowBps: 0 };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--announce') { opts.announce = true; continue; }
    const key = a.replace(/^--/, '');
    const val = rest[++i];
    if (val === undefined) fail(`参数 ${a} 缺少取值`);
    if (key === 'ports') continue;
    switch (key) {
      case 'target': opts.target = val; break;
      case 'file': opts.file = val; break;
      case 'dir': opts.dir = val; break;
      case 'port': opts.port = Number(val); break;
      case 'jobs': opts.jobs = Math.max(1, Number(val)); break;
      case 'size-gb': opts.sizeGb = Number(val); break;
      case 'rounds': opts.rounds = Math.max(1, Number(val)); break;
      case 'chunk-mb': opts.chunkMb = Math.max(1, Number(val)); break;
      case 'slow-mbps': opts.slowBps = Number(val) * 1024 * 1024; break;
      case 'rss-pid': opts.rssPid = Number(val); break;
      default: fail(`未知参数 ${a}`);
    }
  }
  return opts;
}
function fail(msg) { console.error(`[stress] ${msg}`); process.exit(1); }

const MB = 1024 * 1024;
const gb = (n) => `${n.toFixed(2)} GiB`;
const mbps = (bytes, ms) => `${(bytes / MB / (ms / 1000)).toFixed(1)} MiB/s`;

// ============================ RSS 采样 ============================
// 「内存不随文件大小增长」这条结论必须靠数据证明，故全程采样目标进程工作集。
function startRssWatch(pid) {
  if (!pid) return { stop: async () => null };
  let peak = 0;
  let last = 0;
  const cmd = process.platform === 'win32'
    ? `powershell -NoProfile -Command "(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64"`
    : `sh -c "grep VmRSS /proc/${pid}/status | awk '{print \\$2 * 1024}'"`;
  const timer = setInterval(() => {
    exec(cmd, { timeout: 5000 }, (err, stdout) => {
      if (err) return;
      const v = Number(String(stdout).trim());
      if (Number.isFinite(v) && v > 0) { last = v; if (v > peak) peak = v; }
    });
  }, 500);
  return {
    stop: async () => {
      clearInterval(timer);
      return { peak, last };
    },
  };
}

// ============================ 大文件生成 ============================
// 用 1 MiB 的零块顺序写盘：造 8 GiB 文件也只占 8 GiB 磁盘、几乎不占内存。
function ensureBigFile(sizeGb, dir = os.tmpdir()) {
  const target = path.join(dir, `stress_${sizeGb}GiB.bin`);
  const want = Math.round(sizeGb * 1024 * 1024 * 1024);
  if (fs.existsSync(target) && fs.statSync(target).size === want) {
    console.log(`[stress] 复用已存在的大文件: ${target}`);
    return target;
  }
  console.log(`[stress] 生成 ${gb(sizeGb)} 测试文件: ${target}`);
  const chunk = Buffer.alloc(1024 * 1024, 0);
  const fd = fs.openSync(target, 'w');
  const t0 = Date.now();
  let written = 0;
  while (written < want) {
    const n = Math.min(chunk.length, want - written);
    fs.writeSync(fd, chunk, 0, n);
    written += n;
  }
  fs.closeSync(fd);
  console.log(`[stress] 生成完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  return target;
}

// ============================ 限速读流 ============================
// 用于验证「长期低速传输不会被固定超时掐断」——旧实现的 30 s 总超时正是在这里暴露的。
function throttledReadStream(file, chunkBytes, bytesPerSec) {
  async function* gen() {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(chunkBytes);
      const perChunkMs = (chunkBytes / bytesPerSec) * 1000;
      while (true) {
        const n = fs.readSync(fd, buf, 0, chunkBytes, null);
        if (n <= 0) break;
        yield Buffer.from(buf.subarray(0, n));
        if (perChunkMs > 0) await new Promise((r) => setTimeout(r, perChunkMs));
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return Readable.from(gen());
}

// ============================ HTTP 小工具 ============================
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': body.length });
  res.end(body);
}

// ============================ serve：LocalSend 兼容接收端 ============================
function startServe(opts) {
  const saveDir = path.resolve(opts.dir || './_stress_recv');
  fs.mkdirSync(saveDir, { recursive: true });
  const sessions = new Map(); // sessionId -> { files: Map(fileId -> {path, size, received}) }
  const stats = { uploads: 0, bytes: 0, inflight: 0, peakInflight: 0, errors: [], startedAt: Date.now() };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    if (p === '/api/localsend/v2/info' && req.method === 'GET') {
      return sendJson(res, 200, {
        alias: 'stresstest', version: PROTOCOL_VERSION, deviceModel: 'node', deviceType: 'desktop',
        fingerprint: FINGERPRINT, download: false, protocol: 'http',
      });
    }
    if (p === '/api/localsend/v2/register' && req.method === 'POST') {
      await readJsonBody(req).catch(() => ({}));
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/localsend/v2/prepare-upload' && req.method === 'POST') {
      const body = await readJsonBody(req).catch(() => null);
      if (!body?.files) return sendJson(res, 400, { error: 'bad request' });
      const sessionId = randomUUID();
      const files = new Map();
      const tokens = {};
      for (const [fid, f] of Object.entries(body.files)) {
        const token = randomUUID();
        const dest = path.join(saveDir, `${sessionId}_${path.basename(String(f.fileName || fid))}`);
        files.set(fid, { path: dest, size: Number(f.size) || 0, received: 0 });
        tokens[fid] = token;
      }
      sessions.set(sessionId, { files, tokens, startedAt: Date.now() });
      return sendJson(res, 200, { sessionId, files: tokens });
    }
    if (p === '/api/localsend/v2/upload' && req.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId');
      const fileId = url.searchParams.get('fileId');
      const token = url.searchParams.get('token');
      const s = sessions.get(sessionId);
      const meta = s?.files.get(fileId);
      if (!s || !meta || s.tokens[fileId] !== token) return sendJson(res, 403, { error: 'invalid session/token' });
      stats.inflight++;
      stats.peakInflight = Math.max(stats.peakInflight, stats.inflight);
      const t0 = Date.now();
      try {
        await pipeline(req, fs.createWriteStream(meta.path));
        meta.received = fs.statSync(meta.path).size;
        stats.uploads++;
        stats.bytes += meta.received;
        const sizeOk = meta.size === 0 || meta.received === meta.size;
        if (!sizeOk) stats.errors.push(`size mismatch: 声明 ${meta.size} 实收 ${meta.received}`);
        console.log(
          `[serve] 收到 ${path.basename(meta.path)} ${gb(meta.received / 1024 / 1024 / 1024)} ` +
          `${mbps(meta.received, Date.now() - t0)} 并发=${stats.inflight}${sizeOk ? '' : ' ⚠ 大小不符'}`,
        );
        res.writeHead(200, { 'Content-Length': 0 }); res.end();
      } catch (e) {
        stats.errors.push(String(e.message || e));
        res.writeHead(500); res.end();
      } finally {
        stats.inflight--;
      }
      return;
    }
    if (p === '/api/localsend/v2/cancel' && req.method === 'POST') return sendJson(res, 200, { ok: true });
    if (p === '/api/localsend/v2/transfer' && req.method === 'POST') return sendJson(res, 200, { ok: true });
    res.writeHead(404, { 'Content-Length': 0 }); res.end();
  });

  return new Promise((resolve) => {
    server.listen(opts.port, '0.0.0.0', () => {
      console.log(`[serve] 接收端已监听 http://0.0.0.0:${opts.port}  保存目录: ${saveDir}`);
      let udp = null;
      if (opts.announce) {
        // 组播公告：让 App 的「传输」面板能发现本机，从而把文件投过来压 App 的发送端
        udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        const announce = () => {
          const msg = Buffer.from(JSON.stringify({
            alias: 'stresstest', version: PROTOCOL_VERSION, deviceModel: 'node', deviceType: 'desktop',
            fingerprint: FINGERPRINT, port: opts.port, protocol: 'http', download: false, announce: true,
          }));
          try {
            udp.send(msg, MULTICAST_PORT, MULTICAST_GROUP);
            udp.send(msg, MULTICAST_PORT, '255.255.255.255');
          } catch { /* 无网卡时忽略 */ }
        };
        udp.bind(() => { try { udp.setBroadcast(true); udp.addMembership(MULTICAST_GROUP); } catch { /* ignore */ } announce(); });
        setInterval(announce, 3000);
        console.log('[serve] 已开启组播公告：App 传输面板应能看到设备「stresstest」');
      }
      resolve({ server, udp, stats, saveDir });
    });
  });
}

// ============================ send：向目标并行投送 ============================
function postJson(target, urlPath, obj) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(obj));
    const req = http.request({
      host: target.host, port: target.port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function uploadOne(target, sessionId, fileId, token, filePath, size, opts) {
  return new Promise((resolve, reject) => {
    const url = `/api/localsend/v2/upload?sessionId=${encodeURIComponent(sessionId)}&fileId=${encodeURIComponent(fileId)}&token=${encodeURIComponent(token)}`;
    const req = http.request({
      host: target.host, port: target.port, path: url, method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': size },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 200) return resolve();
        reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    const src = opts.slowBps > 0
      ? throttledReadStream(filePath, opts.chunkMb * MB, opts.slowBps)
      : fs.createReadStream(filePath, { highWaterMark: opts.chunkMb * MB });
    src.on('error', reject);
    src.pipe(req);
  });
}

async function sendMode(opts) {
  if (!opts.target) fail('send 模式需要 --target <ip:port>');
  const [host, portStr] = opts.target.split(':');
  const target = { host, port: Number(portStr || 53317) };
  const filePath = opts.file || (opts.sizeGb > 0 ? ensureBigFile(opts.sizeGb) : fail('需要 --file <path> 或 --size-gb <n>'));

  console.log('[stress] 开始压测目标接收端（每个文件一次 prepare-upload + 并行 upload）');
  const rss = startRssWatch(opts.rssPid);
  let totalBytes = 0;
  const t0 = Date.now();

  for (let round = 1; round <= opts.rounds; round++) {
    const files = {};
    for (let j = 0; j < opts.jobs; j++) {
      const fid = `f${round}_${j}_${randomUUID().slice(0, 8)}`;
      files[fid] = { id: fid, fileName: `${path.basename(filePath)}.j${j}`, size: fs.statSync(filePath).size, fileType: 'other' };
    }
    const prep = await postJson(target, '/api/localsend/v2/prepare-upload', {
      info: { alias: 'stresstest', version: PROTOCOL_VERSION, deviceModel: 'node', deviceType: 'desktop', fingerprint: FINGERPRINT },
      files,
    });
    const sessionId = prep.sessionId;
    if (!sessionId) fail(`prepare-upload 未返回 sessionId: ${JSON.stringify(prep).slice(0, 200)}`);

    const tRound = Date.now();
    // 真并行：jobs 个 upload 同时发出 → 直接压目标的并发闸与写盘
    const results = await Promise.allSettled(
      Object.keys(files).map((fid) => uploadOne(target, sessionId, fid, prep.files[fid], filePath, files[fid].size, opts)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected');
    const roundBytes = ok * files[Object.keys(files)[0]].size;
    totalBytes += roundBytes;
    console.log(
      `[stress] 第 ${round}/${opts.rounds} 轮: 成功 ${ok}/${opts.jobs} 并发, ` +
      `${gb(roundBytes / 1024 / 1024 / 1024)} 用时 ${((Date.now() - tRound) / 1000).toFixed(1)}s ${mbps(roundBytes, Date.now() - tRound)}`,
    );
    for (const f of failed.slice(0, 3)) console.log(`[stress]   失败: ${f.reason?.message || f.reason}`);
  }

  const r = await rss.stop();
  console.log('==================== 结果 ====================');
  console.log(`总投送: ${gb(totalBytes / 1024 / 1024 / 1024)}  总用时 ${((Date.now() - t0) / 1000).toFixed(1)}s  平均 ${mbps(totalBytes, Date.now() - t0)}`);
  if (r) console.log(`目标进程 RSS: 峰值 ${(r.peak / MB).toFixed(1)} MiB  结束 ${(r.last / MB).toFixed(1)} MiB`);
  console.log('判据：峰值 RSS 不应随总投送量增长（传 8 GiB 与传 100 MiB 的峰值应当接近）。');
}

// ============================ 主流程 ============================
const opts = parseArgs(process.argv.slice(2));
if (opts.mode === 'serve') {
  const s = await startServe(opts);
  const rss = startRssWatch(opts.rssPid);
  process.on('SIGINT', async () => {
    const r = await rss.stop();
    console.log(`\n[serve] 累计 ${s.stats.uploads} 个文件 / ${gb(s.stats.bytes / 1024 / 1024 / 1024)}；峰值并发 ${s.stats.peakInflight}`);
    if (r) console.log(`[serve] 目标进程 RSS 峰值 ${(r.peak / MB).toFixed(1)} MiB`);
    if (s.stats.errors.length) console.log(`[serve] 异常 ${s.stats.errors.length} 条：${s.stats.errors.slice(0, 5).join(' | ')}`);
    process.exit(0);
  });
  console.log('[serve] Ctrl+C 结束并输出汇总');
} else if (opts.mode === 'send') {
  await sendMode(opts);
} else if (opts.mode === 'self') {
  // 自压：验证脚本自身与协议实现，同时给出与本机磁盘/网络的吞吐基线
  const s = await startServe({ ...opts, port: opts.port + 1, dir: path.join(os.tmpdir(), 'stress_recv'), announce: false });
  try {
    await sendMode({ ...opts, target: `127.0.0.1:${opts.port + 1}` });
  } finally {
    console.log(`[self] 接收端统计：${s.stats.uploads} 个文件，峰值并发 ${s.stats.peakInflight}`);
    s.server.close();
  }
} else {
  console.log('用法: node scripts/stress-transfer.mjs <serve|send|self> [选项]');
  console.log('  serve  --port 53318 [--dir ./_stress_recv] [--announce] [--rss-pid <pid>]');
  console.log('  send   --target <ip:port> [--file <path> | --size-gb <n>] [--jobs N] [--rounds N] [--slow-mbps N] [--rss-pid <pid>]');
  console.log('  self   [--size-gb <n>] [--jobs N] [--port 53318]');
}