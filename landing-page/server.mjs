// ============================================================
// 挑战样本库 · 真实后端（零依赖，Node 内置 http）
// 使命：让挑战页面的「登录/积分/VIP/下载条件/频控」落地为服务端权威，
//      持久化到 data/state.json，IP 频控在服务端执行 —— 更接近生产防线。
// 运行：node server.mjs   （默认端口 8787，可用 PORT 覆盖）
// 说明：密码仅做形态校验（测试站不实际鉴权强度），token 为内存+落盘。
// ============================================================
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));   // landing-page/
const DATA_FILE = join(ROOT, 'data', 'state.json');
const PORT = Number(process.env.PORT || 8787);

const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon' };

// ---------- 持久化状态 ----------
let state = { accounts: {}, sessions: {} }; // accounts: account -> {password, points, vip, day, count}
function today() { return new Date().toISOString().slice(0, 10); }
async function load() {
  try { state = JSON.parse(await readFile(DATA_FILE, 'utf8')); }
  catch { state = { accounts: {}, sessions: {} }; }
}
async function save() {
  try {
    await mkdir(join(ROOT, 'data'), { recursive: true });
    await writeFile(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (e) { console.error('[state] 保存失败', e.message); }
}
let saveTimer = null;
function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 100); }

// ---------- 账户 / 会话 ----------
function getAccount(acct) { return state.accounts[acct] || null; }
function ensureAccount(acct) {
  let a = state.accounts[acct];
  if (!a) { a = { password: '', points: 50, vip: false, day: today(), count: 5 }; state.accounts[acct] = a; }
  if (a.day !== today()) { a.day = today(); a.count = 5; }
  return a;
}
function issueToken(acct) {
  const t = randomBytes(16).toString('hex');
  state.sessions[t] = acct;
  persist();
  return t;
}
function who(token) { return token ? state.sessions[token] || null : null; }

// ---------- IP 频控（每 IP 滑动窗口：10s / 5 次，锁 8s→16s→24s 递增） ----------
const RL = new Map(); // ip -> { windowStart, count, lockedUntil, level }
function rateLimit(ip) {
  const now = Date.now(), WINDOW = 10000, LIMIT = 5;
  let r = RL.get(ip) || { windowStart: now, count: 0, lockedUntil: 0, level: 0 };
  if (now >= r.lockedUntil) { r.lockedUntil = 0; }
  if (now - r.windowStart >= WINDOW) { r.windowStart = now; r.count = 0; }
  if (now < r.lockedUntil) return { allowed: false, retry_after: Math.ceil((r.lockedUntil - now) / 1000), locked: true };
  if (r.count >= LIMIT) {
    r.level = Math.min(r.level + 1, 3);
    r.lockedUntil = now + 8000 * r.level;
    const retry = Math.ceil((r.lockedUntil - now) / 1000);
    r.count = 0; r.windowStart = now;
    RL.set(ip, r);
    return { allowed: false, retry_after: retry, locked: true, level: r.level };
  }
  r.count++; RL.set(ip, r);
  return { allowed: true, remaining: LIMIT - r.count, count: r.count };
}

// ---------- JSON 工具 ----------
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function fail(res, code, msg) { json(res, code, { ok: false, error: msg }); }
async function readBody(req) {
  let raw = '';
  for await (const c of req) raw += c;
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

// ---------- 静态服务 ----------
async function serveStatic(req, res, pathname) {
  const p = normalize(pathname);
  const file = p === '/' || p === '\\' ? join(ROOT, 'index.html') : join(ROOT, p);
  // 防目录穿越
  if (!file.startsWith(ROOT) || file.includes('server.mjs') || file.startsWith(join(ROOT, 'data'))) return fail(res, 403, 'forbidden');
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    fail(res, 404, 'not found');
  }
}

// ---------- API ----------
async function api(req, res, path, body, ip) {
  const send = (o) => json(res, 200, { ok: true, ...o });
  if (path === '/api/hello') return send({ s: 'up' });

  if (path === '/api/register' || path === '/api/login') {
    const acct = String(body.account || '').trim().toLowerCase();
    const pwd = String(body.password || '');
    if (acct.length < 3) return fail(res, 400, '账号至少 3 位');
    let a = getAccount(acct);
    if (path === '/api/register') { if (a) return fail(res, 409, '账号已存在'); a = ensureAccount(acct); a.password = pwd; }
    else { if (a && a.password && pwd !== a.password) return fail(res, 401, '密码错误'); a = ensureAccount(acct); if (!a.password) a.password = pwd; }
    persist();
    return send({ token: issueToken(acct), account: acct, points: a.points, vip: a.vip, count_left: a.count });
  }

  if (path === '/api/account') {
    const acct = who(String(req.headers['x-token'] || body.token || ''));
    if (!acct) return fail(res, 401, '未登录');
    const a = getAccount(acct);
    return send({ account: acct, points: a.points, vip: a.vip, count_left: a.count });
  }

  if (path === '/api/earn') {
    const acct = who(String(body.token || ''));
    if (!acct) return fail(res, 401, '未登录');
    const amount = Number(body.amount || 30);
    const a = ensureAccount(acct);
    a.points += amount; persist();
    return send({ points: a.points, earned: amount });
  }

  if (path === '/api/grant-vip') {
    const acct = who(String(body.token || ''));
    if (!acct) return fail(res, 401, '未登录');
    const a = ensureAccount(acct); a.vip = true; persist();
    return send({ vip: true });
  }

  if (path === '/api/download') {
    const acct = who(String(body.token || ''));
    if (!acct) return fail(res, 401, '未登录');
    const a = ensureAccount(acct);
    if (a.points < 100) return send({ allowed: false, reason: `积分不足(${a.points}/100)`, points: a.points, vip: a.vip, count_left: a.count });
    if (!a.vip) return send({ allowed: false, reason: '非 VIP', points: a.points, vip: a.vip, count_left: a.count });
    if (a.count <= 0) return send({ allowed: false, reason: '今日下载次数已用尽', points: a.points, vip: a.vip, count_left: a.count });
    a.count -= 1; persist();
    return send({ allowed: true, reason: 'ok', points: a.points, vip: a.vip, count_left: a.count, url: '/manual.pdf' });
  }

  // 频控演示：服务端按 IP 限流
  if (path === '/api/op') {
    const rl = rateLimit(ip);
    if (!rl.allowed) return json(res, 429, { ok: false, ...rl });
    return send({ ...rl });
  }

  if (path === '/api/verify') {
    // 接收各类验证行为遥测（仅记录，可在真实场景接入判定模型）
    return send({ received: true, points: Number(body.metrics?.samples || 0) });
  }

  return fail(res, 404, 'unknown api');
}

// ---------- 主服务 ----------
load().then(() => {
  createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const path = u.pathname;
    const ip = req.socket.remoteAddress || 'local';
    // 通用 API 头
    if (path.startsWith('/api/')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      const body = await readBody(req);
      try { await api(req, res, path, body, ip); }
      catch (e) { fail(res, 500, e.message); }
      return;
    }
    if (req.method === 'GET') return serveStatic(req, res, path);
    fail(res, 405, 'method not allowed');
  }).listen(PORT, () => {
    console.log(`[challenge-server] http://127.0.0.1:${PORT}  · 挑战样本库后端已启动`);
  });
});