// ============================================================
// 可破坏可重建沙箱靶场（only 127.0.0.1，不强攻生产 adyh）
// 故意含漏洞：SQL 注入 / 越权访问 / 可清库 + 可重建。用于"强攻·破坏性"授权测试。
// 数据：node:sqlite -> data/sandbox.db（reset.mjs 删除即一键重建）。
// 运行：node server.mjs   （本地 :8781）
// ============================================================
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
mkdirSync(ROOT + '/data', { recursive: true });
const db = new DatabaseSync(ROOT + '/data/sandbox.db');
const PORT = 8781;

// 建表 + 种子（数据缺失时自动重建）
function seed() {
  db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, account TEXT, password TEXT, role TEXT);
           CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, title TEXT, secret TEXT);`);
  const u = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (u === 0) {
    db.prepare("INSERT INTO users (account,password,role) VALUES ('admin','admin123','admin'),('alice','pw123','user')").run();
    db.prepare("INSERT INTO docs (title,secret) VALUES ('架构白皮书','S3CRET_部署内网/32'),('财务报表','S3CRET_2025'),('用户清单','S3CRET_真实邮箱')").run();
    console.log('[sandbox] 已播种种子数据');
  }
}
seed();

const json = (res, c, o) => { res.writeHead(c, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)); };

createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    let rd = {}; try { rd = body ? JSON.parse(body) : {}; } catch (_) {}
    try {
      // 1) 登录 - SQL 注入漏洞（直接字符串拼接）
      if (p === '/login' && req.method === 'POST') {
        const q = `SELECT id,account,role FROM users WHERE account='${rd.account || ''}' AND password='${rd.password || ''}'`;
        const row = db.prepare(q).get();
        return json(res, row ? 200 : 401, { ok: !!row, user: row && { account: row.account, role: row.role } });
      }
      // 2) 越权：无鉴权访问全部数据
      if (p === '/admin') {
        const users = db.prepare('SELECT id,account,password,role FROM users').all();
        const docs = db.prepare('SELECT id,title,secret FROM docs').all();
        return json(res, 200, { users, docs });
      }
      // 3) 文档列表（仅标题）
      if (p === '/docs') return json(res, 200, { docs: db.prepare('SELECT id,title FROM docs').all() });
      // 4) 单文档 - id 拼接（SQLi 读取通道）
      if (p === '/doc') {
        const q = `SELECT id,title,secret FROM docs WHERE id=${u.searchParams.get('id') || 1}`;
        return json(res, 200, { doc: db.prepare(q).get() || null });
      }
      // 5) 删除单文档（字符串拼接 SQL）- 破坏单项
      if (p === '/doc/delete') {
        const q = `DELETE FROM docs WHERE id=${u.searchParams.get('id') || 0}`;
        db.exec(q);
        return json(res, 200, { deleted: true, query: q });
      }
      // 6) 清库（破坏性）—— 可重建
      if (p === '/nuke') {
        db.exec('DELETE FROM users; DELETE FROM docs;');
        return json(res, 200, { nuked: true, users: 0, docs: 0 });
      }
      if (p === '/health') return json(res, 200, { ok: true, users: db.prepare('SELECT COUNT(*) c FROM users').get().c });
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });
}).listen(PORT, '127.0.0.1', () => console.log(`[sandbox] 靶场 http://127.0.0.1:${PORT}（可破坏·可重建）`));