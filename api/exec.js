// แทน URL /exec ของ Apps Script (doPost) — ระบบอื่นเปลี่ยน LEAVE_API_URL มาที่ https://<โดเมน>/api/exec ได้เลย
import { doPost } from '../lib/exec.js';
import { lineFlushIfDue } from '../lib/line.js';
import { readJson, sendJson, queryOf } from '../lib/http.js';

export default async function handler(req, res) {
  if (req.method === 'GET') return sendJson(res, 200, { ok: true, service: 'leave-api' });
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, code: 'BAD_ACTION', message: 'คำสั่งไม่ถูกต้อง' });
  const body = await readJson(req);
  const out = await doPost(body || {}, queryOf(req));
  await lineFlushIfDue();
  sendJson(res, 200, out);   // ตอบ 200 เสมอเหมือน Apps Script (ระบบปลายทางอ่าน ok/code จาก JSON)
}
