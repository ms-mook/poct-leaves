/**
 * แจ้งเตือนผู้ดูแลผ่าน LINE Official Account (Messaging API) — ไฟล์ใหม่ วางเพิ่มในโปรเจกต์ "ระบบลา"
 *
 * หลักการ
 *  - ส่งหาผู้ดูแลแต่ละคนเป็นส่วนตัว (push) ; LINE userId เก็บในชีต Admins คอลัมน์ I (ผูกด้วยรหัส 6 หลักที่ผู้ดูแลใหญ่สร้างให้)
 *  - คำขอลา / คำขอเข้าใช้งาน ส่งทันที ; รายการจากระบบอื่นเข้าคิวแล้วรวมเป็นข้อความเดียวทุก 5 นาที (ประหยัดโควตาข้อความ)
 *  - ระบบ Record (บันทึกสิ่งส่งตรวจ) จะไม่ส่งแจ้งเตือนเด็ดขาด
 *  - ถ้ายังไม่ตั้งค่า LINE หรือส่งไม่สำเร็จ จะไม่กระทบการทำงานหลักของระบบ (ทุกจุดครอบ try/catch)
 *
 * Script Properties : LINE_CHANNEL_TOKEN (Channel access token แบบ long-lived) ; LINE_WEBHOOK_KEY (สร้างให้โดย lineSetup)
 */

const LINE_ADMIN_COL = 9;                 // คอลัมน์ I ของชีต Admins = LINE userId
const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const LINE_REPLY_URL = 'https://api.line.me/v2/bot/message/reply';
const LINE_NEVER_ = ['record'];           // ระบบที่ห้ามแจ้งเตือน
const LINE_SYS_LABEL_ = { leave: 'ระบบแจ้งลา', stock: 'Stock หน่วย', stockcenter: 'Stock คลังกลาง', incident: 'อุบัติการณ์', bloodgas: 'Stock Blood Gas', glucose: 'Stock Glucose' };

function lineToken_() { return String(PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_TOKEN') || '').trim(); }
function lineHash_(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36) + ':' + s.length; }
function lineText_(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').trim().slice(0, max || 300); }
function lineThaiDate_(d) { return d instanceof Date ? pad_(d.getDate()) + '/' + pad_(d.getMonth() + 1) + '/' + (d.getFullYear() + 543) : String(d || ''); }

/** แถวผู้ดูแลทั้งหมดพร้อม LINE userId (คอลัมน์ I) */
function lineAdminRows_() {
  const sh = sheet_(CFG.SHEET.ADMINS), n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const w = Math.max(LINE_ADMIN_COL, sh.getLastColumn());
  return sh.getRange(2, 1, n, w).getValues().map((row, i) => ({ rowNum: i + 2, row: row }));
}

/** ผู้ดูแลที่ควรได้รับแจ้งของระบบ sys : ใช้งานอยู่ + ผูก LINE แล้ว + (เป็นผู้ดูแลใหญ่ หรือมีสิทธิ์ระบบนั้น ; ระบบลา/คำขอเข้าใช้ = ผู้ดูแลทุกคน) */
function lineRecipients_(sys) {
  if (LINE_NEVER_.indexOf(sys) >= 0) return [];
  return lineAdminRows_().filter(r => {
    const id = String(r.row[LINE_ADMIN_COL - 1] || '').trim();
    if (!id || !isTrue_(r.row[A.ACTIVE])) return false;
    if (sys === 'leave' || sys === 'request') return true;
    return isTrue_(r.row[ADMIN_SUPER_COL - 1]) || adminSystemsList_(r.row[ADMIN_SYSTEMS_COL - 1]).indexOf(sys) >= 0;
  }).map(r => ({ username: String(r.row[A.USER]), lineId: String(r.row[LINE_ADMIN_COL - 1]).trim() }));
}

function lineCall_(url, payload) {
  const tok = lineToken_();
  if (!tok) return { ok: false, code: 'NO_SETUP' };
  try {
    const res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + tok },
      payload: JSON.stringify(payload), muteHttpExceptions: true });
    const code = res.getResponseCode();
    return { ok: code >= 200 && code < 300, code: code };
  } catch (e) { console.error('lineCall_ ' + e); return { ok: false, code: 'NET', error: String(e && e.message ? e.message : e).slice(0, 160) }; }
}

function linePush_(lineId, text) { return lineCall_(LINE_PUSH_URL, { to: lineId, messages: [{ type: 'text', text: lineText_(text, 4500) }] }); }
function lineReply_(replyToken, text) { return lineCall_(LINE_REPLY_URL, { replyToken: replyToken, messages: [{ type: 'text', text: lineText_(text, 1500) }] }); }

/** ส่งทันทีให้ผู้ดูแลที่เกี่ยวข้อง — ไม่โยน error ออกไป */
function lineNotify_(sys, text) {
  try {
    if (LINE_NEVER_.indexOf(sys) >= 0 || !lineToken_()) return 0;
    text = lineText_(text, 1000); if (!text) return 0;
    const cache = CacheService.getScriptCache(), dk = 'LND:' + sys + ':' + lineHash_(text);   // กันส่งซ้ำเนื้อหาเดียวกันภายใน 60 วินาที
    if (cache.get(dk)) return 0;
    cache.put(dk, '1', 60);
    let sent = 0;
    lineRecipients_(sys).forEach(r => { if (linePush_(r.lineId, text).ok) sent++; });
    return sent;
  } catch (e) { console.error('lineNotify_ ' + e); return 0; }
}

// ---------- คิวรวมข้อความ (รายการจากระบบอื่น) ----------
function lineEnqueue_(sys, text) {
  try {
    if (LINE_NEVER_.indexOf(sys) >= 0 || !lineToken_()) return false;
    text = lineText_(String(text == null ? '' : text).replace(/\s+/g, ' '), 200); if (!text) return false;
    const lock = LockService.getScriptLock(); lock.waitLock(5000);
    try {
      const p = PropertiesService.getScriptProperties(); let q = {};
      try { q = JSON.parse(p.getProperty('LINEQ') || '{}') || {}; } catch (e) { q = {}; }
      q[sys] = (q[sys] || []); if (q[sys].length < 40) q[sys].push(text); else q[sys + '_more'] = (q[sys + '_more'] || 0) + 1;
      let s = JSON.stringify(q); if (s.length > 8000) { q = {}; q[sys] = [text]; s = JSON.stringify(q); }
      p.setProperty('LINEQ', s);
    } finally { lock.releaseLock(); }
    return true;
  } catch (e) { console.error('lineEnqueue_ ' + e); return false; }
}

/** ตัวตั้งเวลา (ทุก 5 นาที) : รวมรายการในคิวเป็น 1 ข้อความต่อระบบ ส่งให้ผู้ดูแลที่เกี่ยวข้อง */
function lineFlush() {
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  let q = {};
  try {
    const p = PropertiesService.getScriptProperties();
    try { q = JSON.parse(p.getProperty('LINEQ') || '{}') || {}; } catch (e) { q = {}; }
    p.deleteProperty ? p.deleteProperty('LINEQ') : p.setProperty('LINEQ', '{}');
  } finally { lock.releaseLock(); }
  let sent = 0;
  Object.keys(q).forEach(sys => {
    if (/_more$/.test(sys) || !Array.isArray(q[sys]) || !q[sys].length) return;
    const more = Number(q[sys + '_more'] || 0), n = q[sys].length + more;
    const msg = '🔔 ' + (LINE_SYS_LABEL_[sys] || sys) + ' มีรายการใหม่ ' + n + ' รายการ\n' + q[sys].map(t => '• ' + t).join('\n') + (more ? '\n…และอีก ' + more + ' รายการ' : '');
    lineRecipients_(sys).forEach(r => { if (linePush_(r.lineId, msg).ok) sent++; });
  });
  return sent;
}

/** รันครั้งเดียวจากตัวแก้ไข : สร้างกุญแจ webhook + พยายามตั้งตัวตั้งเวลาทุก 5 นาที (ไม่ได้ก็ตั้งเองในเมนูทริกเกอร์) */
function lineSetup() {
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('LINE_WEBHOOK_KEY')) p.setProperty('LINE_WEBHOOK_KEY', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  // ตัวตั้งเวลา : ถ้าโปรเจกต์ไม่ได้ให้สิทธิ์ script.scriptapp จะสร้างอัตโนมัติไม่ได้ → ให้ตั้งเองในเมนู "ทริกเกอร์" (ดูข้อความใน Logger)
  try {
    const has = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'lineFlush');
    if (!has) ScriptApp.newTrigger('lineFlush').timeBased().everyMinutes(5).create();
    Logger.log('ตั้งตัวตั้งเวลา lineFlush ทุก 5 นาทีแล้ว');
  } catch (e) {
    Logger.log('สร้างตัวตั้งเวลาอัตโนมัติไม่ได้ (' + e.message + ')\nให้ตั้งเอง: เมนูซ้าย "ทริกเกอร์" > เพิ่มทริกเกอร์ > ฟังก์ชัน lineFlush > แหล่งที่มาของกิจกรรม: ตามเวลา > ตัวจับเวลาตามนาที > ทุก 5 นาที');
  }
  const url = ScriptApp.getService().getUrl();
  Logger.log('Webhook URL (ใส่ใน LINE Developers > Messaging API > Webhook URL):\n' + url + '?k=' + p.getProperty('LINE_WEBHOOK_KEY'));
  Logger.log(lineToken_() ? 'พบ LINE_CHANNEL_TOKEN แล้ว' : 'ยังไม่ได้ตั้ง LINE_CHANNEL_TOKEN ใน Script Properties');
}

// ---------- ผูกบัญชี LINE ของผู้ดูแล ----------
/** สร้างรหัสผูก 6 หลัก (อายุ 10 นาที) ให้ผู้ดูแล username — เรียกผ่านเส้นทางผู้ดูแลใหญ่เท่านั้น */
function alladminLineCode_(token, username) {
  return api_(() => {
    requireAdmin_(token);
    username = String(username || '').trim().toLowerCase();
    if (!findAdmin_(username)) fail_('ไม่พบผู้ดูแล');
    if (!lineToken_()) fail_('ยังไม่ได้ตั้ง LINE_CHANNEL_TOKEN ในโปรเจกต์ระบบลา', 'NO_SETUP');
    const cache = CacheService.getScriptCache();
    let code = '', tries = 0;
    do { code = String(parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 8), 16) % 900000 + 100000); tries++; } while (cache.get('LNK:' + code) && tries < 20);
    cache.put('LNK:' + code, username, 600);
    audit_('admin', 'LINE_CODE', username, '');
    return { code: code, minutes: 10 };
  });
}

function alladminLineStatus_(token) {
  return api_(() => {
    requireAdmin_(token);
    const p = PropertiesService.getScriptProperties();
    return { configured: !!lineToken_(), webhook: !!p.getProperty('LINE_WEBHOOK_KEY'),
      linked: lineAdminRows_().filter(r => String(r.row[LINE_ADMIN_COL - 1] || '').trim()).map(r => String(r.row[A.USER])) };
  });
}

function alladminLineUnlink_(token, username) {
  return api_(() => {
    requireAdmin_(token);
    username = String(username || '').trim().toLowerCase();
    return withLock_(() => {
      const f = lineAdminRows_().find(r => String(r.row[A.USER]).toLowerCase() === username);
      if (!f) fail_('ไม่พบผู้ดูแล');
      sheet_(CFG.SHEET.ADMINS).getRange(f.rowNum, LINE_ADMIN_COL).setValue('');
      audit_('admin', 'LINE_UNLINK', username, '');
      return { message: 'ยกเลิกการผูก LINE ของ ' + username + ' แล้ว' };
    });
  });
}

function alladminLineTest_(token, username) {
  return api_(() => {
    requireAdmin_(token);
    username = String(username || '').trim().toLowerCase();
    const f = lineAdminRows_().find(r => String(r.row[A.USER]).toLowerCase() === username);
    if (!f) fail_('ไม่พบผู้ดูแล');
    const id = String(f.row[LINE_ADMIN_COL - 1] || '').trim();
    if (!id) fail_('ผู้ดูแลคนนี้ยังไม่ได้ผูก LINE');
    const r = linePush_(id, '✅ ทดสอบการแจ้งเตือนจาก BRS.POCT Admin Center\nถ้าคุณเห็นข้อความนี้ แปลว่าผูก LINE สำเร็จแล้ว');
    if (!r.ok) fail_('ส่งไม่สำเร็จ (' + r.code + (r.error ? ': ' + r.error : '') + ') ตรวจ Channel access token และว่าผู้ดูแลยังเป็นเพื่อนกับ OA อยู่', 'ERR');
    return { message: 'ส่งข้อความทดสอบแล้ว' };
  });
}

/** รับ webhook จาก LINE : ผู้ดูแลพิมพ์ "ผูก 123456" ในแชต OA เพื่อผูกบัญชี (ตอบ 200 เสมอ) */
function lineWebhook_(body) {
  try {
    (Array.isArray(body.events) ? body.events : []).slice(0, 10).forEach(ev => {
      const uid = ev && ev.source && typeof ev.source.userId === 'string' ? ev.source.userId : '';
      if (!/^U[0-9a-f]{32}$/.test(uid) || !ev.replyToken) return;
      if (ev.type === 'follow') { lineReply_(ev.replyToken, 'สวัสดีครับ 👋 ถ้าคุณเป็นผู้ดูแลระบบ ให้ขอ "รหัสผูก LINE" จากผู้ดูแลใหญ่ใน Admin Center แล้วพิมพ์ในแชตนี้ว่า\nผูก 123456'); return; }
      if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return;
      const t = String(ev.message.text || '').trim();
      const cache = CacheService.getScriptCache();
      if (/^(เลิกผูก|ยกเลิกการผูก)$/.test(t)) {
        const f = lineAdminRows_().find(r => String(r.row[LINE_ADMIN_COL - 1] || '').trim() === uid);
        if (f) { sheet_(CFG.SHEET.ADMINS).getRange(f.rowNum, LINE_ADMIN_COL).setValue(''); audit_('line', 'LINE_UNLINK', String(f.row[A.USER]), 'self'); lineReply_(ev.replyToken, 'ยกเลิกการผูก LINE แล้ว จะไม่ได้รับแจ้งเตือนอีก'); }
        else lineReply_(ev.replyToken, 'บัญชี LINE นี้ยังไม่ได้ผูกกับผู้ดูแลคนใด');
        return;
      }
      const m = t.match(/^(?:ผูก|link)\s*(\d{6})$/i);
      if (!m) { lineReply_(ev.replyToken, 'พิมพ์ "ผูก" ตามด้วยรหัส 6 หลัก เช่น ผูก 123456\nหรือพิมพ์ "เลิกผูก" เพื่อยกเลิกการแจ้งเตือน'); return; }
      const fk = 'LNF:' + uid, fails = Number(cache.get(fk) || 0);
      if (fails >= 5) { lineReply_(ev.replyToken, 'ลองผิดหลายครั้ง กรุณารอ 10 นาทีแล้วลองใหม่'); return; }
      const uname = cache.get('LNK:' + m[1]);
      if (!uname) { cache.put(fk, String(fails + 1), 600); lineReply_(ev.replyToken, 'รหัสไม่ถูกต้องหรือหมดอายุ กรุณาขอรหัสใหม่จากผู้ดูแลใหญ่'); return; }
      withLock_(() => {
        const rows = lineAdminRows_(), other = rows.find(r => String(r.row[LINE_ADMIN_COL - 1] || '').trim() === uid && String(r.row[A.USER]).toLowerCase() !== uname);
        const f = rows.find(r => String(r.row[A.USER]).toLowerCase() === uname);
        if (!f) { lineReply_(ev.replyToken, 'ไม่พบบัญชีผู้ดูแล'); return; }
        if (other) { lineReply_(ev.replyToken, 'บัญชี LINE นี้ผูกกับผู้ดูแลอีกคนอยู่แล้ว กรุณาพิมพ์ "เลิกผูก" ก่อน'); return; }
        const sh = sheet_(CFG.SHEET.ADMINS);
        if (!String(sh.getRange(1, LINE_ADMIN_COL).getValue()).trim()) sh.getRange(1, LINE_ADMIN_COL).setValue('LineUserId').setFontWeight('bold');
        sh.getRange(f.rowNum, LINE_ADMIN_COL).setValue(uid);
        cache.remove('LNK:' + m[1]);
        audit_('line', 'LINE_LINK', uname, '');
        lineReply_(ev.replyToken, '✅ ผูกบัญชีกับ ' + String(f.row[A.DISPLAY] || uname) + ' เรียบร้อย\nต่อไปจะได้รับแจ้งเตือนรายการใหม่ที่นี่');
      });
    });
  } catch (e) { console.error('lineWebhook_ ' + e); }
  return { ok: true };
}

/** รายการจากระบบอื่นขอแจ้งเตือน (ผ่านกุญแจของระบบนั้น) — Record ถูกปิดไว้เสมอ */
/** คำขอแจ้งเตือนถูกปฏิเสธ : บันทึกลงบันทึกกิจกรรม (ดูได้ที่ Admin Center > บันทึกกิจกรรม ค้น LINE_NOTIFY_REJECT) เพื่อไล่หาสาเหตุได้ */
function lineRej_(caller, body) {
  try { audit_('line', 'LINE_NOTIFY_REJECT', String(caller), 'sys=' + String(body && body.sys) + ' mode=' + String(body && body.mode)); } catch (e) {}
  return { ok: false, code: 'BAD_ACTION', message: 'คำสั่งไม่ถูกต้อง' };
}
function lineNotifyRoute_(caller, body) {
  if (LINE_NEVER_.indexOf(caller) >= 0) return { ok: false, code: 'DISABLED', message: 'ระบบนี้ไม่ส่งแจ้งเตือน' };
  let sys = caller;
  if (body.sys != null && body.sys !== caller && caller !== 'stock') return lineRej_(caller, body);
  if (caller === 'stock' && body.sys != null) { if (typeof body.sys !== 'string' || ['stock', 'stockcenter'].indexOf(body.sys) < 0) return lineRej_(caller, body); sys = body.sys; }   // กุญแจ Stock ใช้ร่วมกับคลังกลาง
  if (SYS_KEYS.indexOf(sys) < 0 || LINE_NEVER_.indexOf(sys) >= 0) return lineRej_(caller, body);
  const cache = CacheService.getScriptCache(), rk = 'LNR:' + sys + ':' + Math.floor(Date.now() / 60000), n = Number(cache.get(rk) || 0);
  if (n >= 30) return { ok: false, code: 'BUSY', message: 'ส่งถี่เกินไป' };   // กันระบบปลายทางยิงรัว
  cache.put(rk, String(n + 1), 120);
  if (body.mode === 'now') {                       // ส่งทันที: อนุญาตเฉพาะอุบัติการณ์ (เหตุเร่งด่วน)
    if (sys !== 'incident') return lineRej_(caller, body);
    return { ok: lineNotify_(sys, body.text) > 0 };
  }
  return { ok: lineEnqueue_(sys, body.text) };
}

/** รันจากตัวแก้ไข (ครั้งเดียว) : ขอสิทธิ์ UrlFetch + แสดงสาเหตุจริงถ้าส่ง LINE ไม่ได้ ; ดูผลที่ Logger */
function lineDebug() {
  const tok = lineToken_();
  Logger.log('LINE_CHANNEL_TOKEN: ' + (tok ? 'มี (ยาว ' + tok.length + ' ตัวอักษร)' : 'ไม่มี'));
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', { headers: { Authorization: 'Bearer ' + tok }, muteHttpExceptions: true });
  Logger.log('LINE bot info → HTTP ' + res.getResponseCode() + ' ' + String(res.getContentText()).slice(0, 200));
  Logger.log(res.getResponseCode() === 200 ? 'token ใช้ได้' : 'token ไม่ถูกต้อง/ถูกยกเลิก ให้ Issue ใหม่แล้วใส่ที่ LINE_CHANNEL_TOKEN');
}