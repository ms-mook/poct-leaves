// ส่งคิวแจ้งเตือน LINE ที่ค้างอยู่ (แทน time trigger lineFlush ของ Apps Script)
// เรียกโดย Vercel Cron หรือบริการตั้งเวลาภายนอก พร้อม header  Authorization: Bearer <CRON_SECRET>
import { lineFlush } from '../lib/line.js';
import { sendJson } from '../lib/http.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== 'Bearer ' + secret) return sendJson(res, 401, { ok: false });
  const sent = await lineFlush();
  sendJson(res, 200, { ok: true, sent });
}
