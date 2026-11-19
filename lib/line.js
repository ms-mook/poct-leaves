/**
 * แจ้งเตือนผู้ดูแลผ่าน LINE Official Account — พอร์ตจาก LineNotify.gs
 * ถ้าไม่ได้ตั้ง LINE_CHANNEL_TOKEN จะไม่ส่งอะไรเลย (ค่าเริ่มต้นตอนทดสอบคู่ขนาน กันแจ้งเตือนซ้ำกับระบบเดิม)
 */
import { db, withTx } from './db.js';
import {
  api_, fail_, audit_, isTrue_, prop_, pad_, ymd_, cacheGet_, cachePut_, cacheRemove_,
  adminRows_, findAdmin_, requireAdmin_, withLock_, A, ADMIN_SUPER_COL, ADMIN_SYSTEMS_COL, LINE_ADMIN_COL, SYS_KEYS, uuid_, bindLine
} from './core.js';
import { adminSystemsList_ } from './alladmin.js';

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const LINE_REPLY_URL = 'https://api.line.me/v2/bot/message/reply';
const LINE_NEVER_ = ['record'];
const LINE_SYS_LABEL_ = { leave: 'ระบบแจ้งลา', stock: 'Stock หน่วย', stockcenter: 'Stock คลังกลาง', incident: 'อุบัติการณ์', bloodgas: 'Stock Blood Gas', glucose: 'Stock Glucose' };

function lineToken_() { return prop_('LINE_CHANNEL_TOKEN'); }
function lineHash_(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36) + ':' + s.length; }
function lineText_(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').trim().slice(0, max || 300); }

export async function lineAdminRows_() { return adminRows_(); }

async function lineRecipients_(sys) {
  if (LINE_NEVER_.indexOf(sys) >= 0) return [];
  return (await lineAdminRows_()).filter(r => {
    const id = String(r.row[LINE_ADMIN_COL - 1] || '').trim();
    if (!id || !isTrue_(r.row[A.ACTIVE])) return false;
    if (sys === 'leave' || sys === 'request') return true;
    return isTrue_(r.row[ADMIN_SUPER_COL - 1]) || adminSystemsList_(r.row[ADMIN_SYSTEMS_COL - 1]).indexOf(sys) >= 0;
  }).map(r => ({ username: String(r.row[A.USER]), lineId: String(r.row[LINE_ADMIN_COL - 1]).trim() }));
}

async function lineCall_(url, payload) {
  const tok = lineToken_();
  if (!tok) return { ok: false, code: 'NO_SETUP' };
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(payload) });
    return { ok: res.status >= 200 && res.status < 300, code: res.status };
  } catch (e) { console.error('lineCall_ ' + e); return { ok: false, code: 'NET', error: String(e && e.message ? e.message : e).slice(0, 160) }; }
}

function linePush_(lineId, text) { return lineCall_(LINE_PUSH_URL, { to: lineId, messages: [{ type: 'text', text: lineText_(text, 4500) }] }); }
function lineReply_(replyToken, text) { return lineCall_(LINE_REPLY_URL, { replyToken: replyToken, messages: [{ type: 'text', text: lineText_(text, 1500) }] }); }

export async function lineNotify_(sys, text) {
  try {
    if (LINE_NEVER_.indexOf(sys) >= 0 || !lineToken_()) return 0;
    text = lineText_(text, 1000); if (!text) return 0;
    const dk = 'LND:' + sys + ':' + lineHash_(text);
    if (await cacheGet_(dk)) return 0;
    await cachePut_(dk, '1', 60);
    let sent = 0;
    for (const r of await lineRecipients_(sys)) if ((await linePush_(r.lineId, text)).ok) sent++;
    return sent;
  } catch (e) { console.error('lineNotify_ ' + e); return 0; }
}

// ---------- คิวรวมข้อความ ----------
async function lineEnqueue_(sys, text) {
  try {
    if (LINE_NEVER_.indexOf(sys) >= 0 || !lineToken_()) return false;
    text = lineText_(String(text == null ? '' : text).replace(/\s+/g, ' '), 200); if (!text) return false;
    await withTx(async () => {
      let q = {};
      try { q = JSON.parse((await cacheGet_('LINEQ')) || '{}') || {}; } catch (e) { q = {}; }
      q[sys] = (q[sys] || []); if (q[sys].length < 40) q[sys].push(text); else q[sys + '_more'] = (q[sys + '_more'] || 0) + 1;
      let s = JSON.stringify(q); if (s.length > 8000) { q = {}; q[sys] = [text]; s = JSON.stringify(q); }
      await cachePut_('LINEQ', s, 0);
    }, 5000);
    return true;
  } catch (e) { console.error('lineEnqueue_ ' + e); return false; }
}

/** รวมคิวเป็น 1 ข้อความต่อระบบแล้วส่ง (เรียกจาก cron หรืออัตโนมัติทุก ~5 นาทีเมื่อมีคำขอเข้ามา) */
export async function lineFlush() {
  let q = {};
  await withTx(async () => {
    try { q = JSON.parse((await cacheGet_('LINEQ')) || '{}') || {}; } catch (e) { q = {}; }
    await cacheRemove_('LINEQ');
    await cachePut_('LINEQ_LAST', String(Date.now()), 0);
  }, 10000);
  let sent = 0;
  for (const sys of Object.keys(q)) {
    if (/_more$/.test(sys) || !Array.isArray(q[sys]) || !q[sys].length) continue;
    const more = Number(q[sys + '_more'] || 0), n = q[sys].length + more;
    const msg = '🔔 ' + (LINE_SYS_LABEL_[sys] || sys) + ' มีรายการใหม่ ' + n + ' รายการ\n' + q[sys].map(t => '• ' + t).join('\n') + (more ? '\n…และอีก ' + more + ' รายการ' : '');
    for (const r of await lineRecipients_(sys)) if ((await linePush_(r.lineId, msg)).ok) sent++;
  }
  return sent;
}

/** แทน time trigger 5 นาทีของ Apps Script: ถ้าคิวค้างเกิน 5 นาที ให้ส่งตอนมีคำขอใดก็ได้เข้ามา */
export async function lineFlushIfDue() {
  try {
    if (!lineToken_()) return;
    const last = Number((await cacheGet_('LINEQ_LAST')) || 0);
    if (Date.now() - last < 5 * 60 * 1000) return;
    const q = await cacheGet_('LINEQ');
    if (!q || q === '{}') { await cachePut_('LINEQ_LAST', String(Date.now()), 0); return; }
    await lineFlush();
  } catch (e) { console.error('lineFlushIfDue ' + e); }
}

// ---------- ผูกบัญชี LINE ของผู้ดูแล ----------
export function alladminLineCode_(token, username) {
  return api_(async () => {
    await requireAdmin_(token);
    username = String(username || '').trim().toLowerCase();
    if (!(await findAdmin_(username))) fail_('ไม่พบผู้ดูแล');
    if (!lineToken_()) fail_('ยังไม่ได้ตั้ง LINE_CHANNEL_TOKEN ในโปรเจกต์ระบบลา', 'NO_SETUP');
    let code = '', tries = 0;
    do { code = String(parseInt(uuid_().replace(/-/g, '').slice(0, 8), 16) % 900000 + 100000); tries++; } while ((await cacheGet_('LNK:' + code)) && tries < 20);
    await cachePut_('LNK:' + code, username, 600);
    await audit_('admin', 'LINE_CODE', username, '');
    return { code: code, minutes: 10 };
  });
}

export function alladminLineStatus_(token) {
  return api_(async () => {
    await requireAdmin_(token);
    return { configured: !!lineToken_(), webhook: !!prop_('LINE_WEBHOOK_KEY'),
      linked: (await lineAdminRows_()).filter(r => String(r.row[LINE_ADMIN_COL - 1] || '').trim()).map(r => String(r.row[A.USER])) };
  });
}

export function alladminLineUnlink_(token, username) {
  return api_(async () => {
    await requireAdmin_(token);
    username = String(username || '').trim().toLowerCase();
    return withLock_(async () => {
      const f = (await lineAdminRows_()).find(r => String(r.row[A.USER]).toLowerCase() === username);
      if (!f) fail_('ไม่พบผู้ดูแล');
      await db()`update admins set line_user_id = '' where username = ${f.key}`;
      await audit_('admin', 'LINE_UNLINK', username, '');
      return { message: 'ยกเลิกการผูก LINE ของ ' + username + ' แล้ว' };
    });
  });
}

export function alladminLineTest_(token, username) {
  return api_(async () => {
    await requireAdmin_(token);
    username = String(username || '').trim().toLowerCase();
    const f = (await lineAdminRows_()).find(r => String(r.row[A.USER]).toLowerCase() === username);
    if (!f) fail_('ไม่พบผู้ดูแล');
    const id = String(f.row[LINE_ADMIN_COL - 1] || '').trim();
    if (!id) fail_('ผู้ดูแลคนนี้ยังไม่ได้ผูก LINE');
    const r = await linePush_(id, '✅ ทดสอบการแจ้งเตือนจาก BRS.POCT Admin Center\nถ้าคุณเห็นข้อความนี้ แปลว่าผูก LINE สำเร็จแล้ว');
    if (!r.ok) fail_('ส่งไม่สำเร็จ (' + r.code + (r.error ? ': ' + r.error : '') + ') ตรวจ Channel access token และว่าผู้ดูแลยังเป็นเพื่อนกับ OA อยู่', 'ERR');
    return { message: 'ส่งข้อความทดสอบแล้ว' };
  });
}

/** webhook จาก LINE : ผู้ดูแลพิมพ์ "ผูก 123456" */
export async function lineWebhook_(body) {
  try {
    for (const ev of (Array.isArray(body.events) ? body.events : []).slice(0, 10)) {
      const uid = ev && ev.source && typeof ev.source.userId === 'string' ? ev.source.userId : '';
      if (!/^U[0-9a-f]{32}$/.test(uid) || !ev.replyToken) continue;
      if (ev.type === 'follow') { await lineReply_(ev.replyToken, 'สวัสดีครับ 👋 ถ้าคุณเป็นผู้ดูแลระบบ ให้ขอ "รหัสผูก LINE" จากผู้ดูแลใหญ่ใน Admin Center แล้วพิมพ์ในแชตนี้ว่า\nผูก 123456'); continue; }
      if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') continue;
      const t = String(ev.message.text || '').trim();
      if (/^(เลิกผูก|ยกเลิกการผูก)$/.test(t)) {
        const f = (await lineAdminRows_()).find(r => String(r.row[LINE_ADMIN_COL - 1] || '').trim() === uid);
        if (f) { await db()`update admins set line_user_id = '' where username = ${f.key}`; await audit_('line', 'LINE_UNLINK', String(f.row[A.USER]), 'self'); await lineReply_(ev.replyToken, 'ยกเลิกการผูก LINE แล้ว จะไม่ได้รับแจ้งเตือนอีก'); }
        else await lineReply_(ev.replyToken, 'บัญชี LINE นี้ยังไม่ได้ผูกกับผู้ดูแลคนใด');
        continue;
      }
      const m = t.match(/^(?:ผูก|link)\s*(\d{6})$/i);
      if (!m) { await lineReply_(ev.replyToken, 'พิมพ์ "ผูก" ตามด้วยรหัส 6 หลัก เช่น ผูก 123456\nหรือพิมพ์ "เลิกผูก" เพื่อยกเลิกการแจ้งเตือน'); continue; }
      const fk = 'LNF:' + uid, fails = Number((await cacheGet_(fk)) || 0);
      if (fails >= 5) { await lineReply_(ev.replyToken, 'ลองผิดหลายครั้ง กรุณารอ 10 นาทีแล้วลองใหม่'); continue; }
      const uname = await cacheGet_('LNK:' + m[1]);
      if (!uname) { await cachePut_(fk, String(fails + 1), 600); await lineReply_(ev.replyToken, 'รหัสไม่ถูกต้องหรือหมดอายุ กรุณาขอรหัสใหม่จากผู้ดูแลใหญ่'); continue; }
      const reply = await withLock_(async () => {
        const rows = await lineAdminRows_(), other = rows.find(r => String(r.row[LINE_ADMIN_COL - 1] || '').trim() === uid && String(r.row[A.USER]).toLowerCase() !== uname);
        const f = rows.find(r => String(r.row[A.USER]).toLowerCase() === uname);
        if (!f) return 'ไม่พบบัญชีผู้ดูแล';
        if (other) return 'บัญชี LINE นี้ผูกกับผู้ดูแลอีกคนอยู่แล้ว กรุณาพิมพ์ "เลิกผูก" ก่อน';
        await db()`update admins set line_user_id = ${uid} where username = ${f.key}`;
        await cacheRemove_('LNK:' + m[1]);
        await audit_('line', 'LINE_LINK', uname, '');
        return '✅ ผูกบัญชีกับ ' + String(f.row[A.DISPLAY] || uname) + ' เรียบร้อย\nต่อไปจะได้รับแจ้งเตือนรายการใหม่ที่นี่';
      });
      await lineReply_(ev.replyToken, reply);
    }
  } catch (e) { console.error('lineWebhook_ ' + e); }
  return { ok: true };
}

async function lineRej_(caller, body) {
  try { await audit_('line', 'LINE_NOTIFY_REJECT', String(caller), 'sys=' + String(body && body.sys) + ' mode=' + String(body && body.mode)); } catch (e) {}
  return { ok: false, code: 'BAD_ACTION', message: 'คำสั่งไม่ถูกต้อง' };
}

export async function lineNotifyRoute_(caller, body) {
  if (LINE_NEVER_.indexOf(caller) >= 0) return { ok: false, code: 'DISABLED', message: 'ระบบนี้ไม่ส่งแจ้งเตือน' };
  let sys = caller;
  if (body.sys != null && body.sys !== caller && caller !== 'stock') return lineRej_(caller, body);
  if (caller === 'stock' && body.sys != null) { if (typeof body.sys !== 'string' || ['stock', 'stockcenter'].indexOf(body.sys) < 0) return lineRej_(caller, body); sys = body.sys; }
  if (SYS_KEYS.indexOf(sys) < 0 || LINE_NEVER_.indexOf(sys) >= 0) return lineRej_(caller, body);
  const rk = 'LNR:' + sys + ':' + Math.floor(Date.now() / 60000), n = Number((await cacheGet_(rk)) || 0);
  if (n >= 30) return { ok: false, code: 'BUSY', message: 'ส่งถี่เกินไป' };
  await cachePut_(rk, String(n + 1), 120);
  if (body.mode === 'now') {
    if (sys !== 'incident') return lineRej_(caller, body);
    return { ok: (await lineNotify_(sys, body.text)) > 0 };
  }
  return { ok: await lineEnqueue_(sys, body.text) };
}

export function lineThaiDate_(d) { return d instanceof Date ? pad_(d.getDate()) + '/' + pad_(d.getMonth() + 1) + '/' + (d.getFullYear() + 543) : String(d || ''); }

bindLine({ lineNotify_ });
