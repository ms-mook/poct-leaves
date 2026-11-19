// เซิร์ฟเวอร์ทดสอบในเครื่อง: เลียนแบบ Vercel (static public/ + api/*.js + rewrites ใน vercel.json)
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rpc = (await import('../api/rpc.js')).default;
const exec = (await import('../api/exec.js')).default;

export function startServer(port) {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
      if (u.pathname === '/api/rpc') return await rpc(req, res);
      if (u.pathname === '/api/exec' || u.pathname === '/exec') { req.query = Object.fromEntries(u.searchParams); return await exec(req, res); }
      let file = u.pathname === '/' ? (u.searchParams.get('page') === 'Admin' ? 'admin.html' : 'index.html') : u.pathname.slice(1);
      if (file === 'admin') file = 'admin.html';
      const p = join(root, 'public', file);
      if (!existsSync(p)) { res.statusCode = 404; return res.end('not found'); }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(readFileSync(p));
    } catch (e) { console.error(e); res.statusCode = 500; res.end('error'); }
  });
  return new Promise(r => srv.listen(port, '127.0.0.1', () => r(srv)));
}
