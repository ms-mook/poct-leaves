/**
 * ระบบบันทึกการแจ้งลา — Code.gs (กลับมาใช้แบบเดิม: ล็อกอินและข้อมูลพนักงาน/ผู้ดูแลอยู่ในโปรเจกต์นี้)
 * Deploy: Execute as = Me, Who has access = Anyone
 * หลักการ: ทุกการตัดสินสิทธิ์อยู่ที่ server, client ส่งได้แค่ token + ข้อมูลดิบ
 * ฟังก์ชันที่ลงท้ายด้วย _ เป็น private (google.script.run เรียกไม่ได้)
 * ต้องใช้คู่กับ IncidentApi.gs (มี doPost สำหรับ Stock และระบบอุบัติการณ์)
 */

// ===================== CONFIG =====================
const CFG = {
  SHEET: { LEAVE: 'Leave', HOLIDAYS: 'Holidays', STAFF: 'Staff', ADMINS: 'Admins', AUDIT: 'AuditLog', REQUESTS: 'StaffRequests', LATE: 'Arrive late' },
  PAGES: ['Index', 'Admin'],
  DEFAULT_PIN: '1234',
  HASH_ROUNDS: 100,
  MAX_FAILS: 5,              // ใส่รหัสผิดได้กี่ครั้งก่อนล็อก
  LOCK_SECONDS: 900,         // ล็อก 15 นาที (ผู้ดูแล)
  STAFF_LOCK_SECONDS: 300,   // ล็อก 5 นาที (พนักงาน — ลดผลกระทบกรณีมีคนแกล้งใส่ผิดแทน และผู้ดูแลปลดล็อกได้ทันที)
  STAFF_SESSION_SEC: 1800,   // 30 นาที (ต่ออายุทุกครั้งที่ใช้งาน)
  ADMIN_SESSION_SEC: 3600,   // 60 นาที
  MAX_ENTRIES: 10,           // รายการลาต่อการส่ง 1 ครั้ง
  MAX_RANGE_DAYS: 60,        // ลาต่อเนื่องสูงสุดต่อ 1 รายการ
  MAX_PAST_DAYS: 90,         // ลาย้อนหลังได้กี่วัน
  MAX_FUTURE_DAYS: 365,      // ลาล่วงหน้าได้กี่วัน
  OFF_DUTY_MAX_DAYS_PER_MONTH: 3, // งดเวรนอกเวลาได้สูงสุดกี่วัน/เดือน (นับตามเดือนของวันที่งดเวร) ; 0 = ไม่จำกัด
  MAX_ROWS_ADMIN: 500,
  MASK_SICK_FOR_OTHERS: false, // true = พนักงานคนอื่นจะเห็นการลาป่วยของเพื่อนเป็นแค่ "ลา" (ไม่ระบุว่าป่วย)
  TZ: 'Asia/Bangkok'
};

const LEAVE_TYPES = [
  ['sick', 'ลาป่วย'], ['personal', 'ลากิจ'], ['annual', 'ลาพักร้อน'],
  ['off_duty_cancel', 'งดเวรนอกเวลา'], ['other', 'ลาอื่นๆ']
];

const POSITIONS = [
  'นักเทคนิคการแพทย์(MT Fulltime)งานห้องปฏิบัติการเวชศาสตร์ชันสูตร',
  'นักเทคนิคการแพทย์(MT บุคลากรประจำคณะแพทย์ศาสตร์)',
  'พยาบาลวิชาชีพ(RN Parttime, บุคลากรประจำคณะแพทย์ศาสตร์)',
  'นักเทคนิคการแพทย์(MT Parttime)',
  'บุคลากรประจำคณะแพทย์ศาสตร์ ตำแหน่งอื่นๆ'
];

const STATUS = { PENDING: 'Pending', APPROVED: 'Approve', REJECTED: 'Reject', CANCELLED: 'Cancelled' };

// ดัชนีคอลัมน์ (เริ่มที่ 0) — เวลาเขียนชีตใช้ +1
const L = { TS: 0, NAME: 1, POS: 2, TYPE: 3, START: 4, END: 5, DAYS: 6, STATUS: 7, ID: 8, BY: 9, AT: 10, NOTE: 11, STAFFID: 12, WIDTH: 13 };
const S = { ID: 0, NAME: 1, POS: 2, HASH: 3, SALT: 4, MUST: 5, ACTIVE: 6, CREATED: 7, PINCHANGED: 8,
            LEAVE: 9, STOCK: 10, STOCKCENTER: 11, INCIDENT: 12, BLOODGAS: 13, GLUCOSE: 14, WIDTH: 15 };
// สิทธิ์ใช้งานรายระบบ (คอลัมน์ J-O ของชีต Staff: TRUE/FALSE) — เพิ่มระบบใหม่ได้ที่นี่
const SYS_COL = { leave: S.LEAVE, stock: S.STOCK, stockcenter: S.STOCKCENTER, incident: S.INCIDENT, bloodgas: S.BLOODGAS, glucose: S.GLUCOSE };
const SYS_KEYS = Object.keys(SYS_COL);
function hasSys_(row, system) { return isTrue_(row[SYS_COL[system]]); }
/** สิทธิ์เริ่มต้นของพนักงานใหม่: เปิดทุกระบบ ยกเว้นระบบที่ต้องให้ผู้ดูแลเปิดให้เอง (bloodgas, glucose) */
const SYS_OFF_BY_DEFAULT = ['bloodgas', 'glucose'];
function newStaffSys_() { return SYS_KEYS.map(k => SYS_OFF_BY_DEFAULT.indexOf(k) < 0); }
function sysFlags_(row) { const o = {}; SYS_KEYS.forEach(k => { o[k] = hasSys_(row, k); }); return o; }
const A = { USER: 0, DISPLAY: 1, HASH: 2, SALT: 3, ACTIVE: 4, CREATED: 5, WIDTH: 6 };

// ===================== WEB APP ENTRY =====================
function doGet(e) {
  const p = e && e.parameter && e.parameter.page;
  const page = CFG.PAGES.indexOf(p) >= 0 ? p : 'Index';
  const t = HtmlService.createTemplateFromFile(page);
  t.appUrl = ScriptApp.getService().getUrl();
  return t.evaluate()
    .setTitle('ระบบบันทึกการแจ้งลา')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  // ไม่ตั้ง XFrameOptionsMode.ALLOWALL: กัน clickjacking
}

function include_(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ===================== INFRA HELPERS =====================
class AppError extends Error {
  constructor(msg, code) { super(msg); this.code = code || 'ERR'; }
}
function fail_(msg, code) { throw new AppError(msg, code); }

function api_(fn) {
  try {
    return Object.assign({ ok: true }, fn() || {});
  } catch (e) {
    if (e instanceof AppError) return { ok: false, code: e.code, message: e.message };
    console.error(e && e.stack ? e.stack : e);
    return { ok: false, code: 'SERVER', message: 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง' };
  }
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) { fail_('ระบบกำลังประมวลผลหลายรายการ กรุณาลองใหม่', 'BUSY'); }
  try { return fn(); } finally { lock.releaseLock(); }
}

function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) fail_('ไม่พบชีต ' + name + ' (ให้ผู้ดูแลรัน setupSystem)', 'NO_SHEET');
  return sh;
}

function rows_(name, width) {
  const sh = sheet_(name);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, width).getValues().map((row, i) => ({ rowNum: i + 2, row: row }));
}

/** ตั้งรูปแบบตัวเลข/วันที่ แบบไม่ให้ล้ม: คอลัมน์ที่เป็น Table ไม่ยอมให้ตั้งรูปแบบหลายคอลัมน์พร้อมกัน
 *  จึงเขียนค่าที่ค้างอยู่ให้เสร็จก่อน (flush) แล้วดักข้อผิดพลาดตรงนี้ ไม่ให้ไปยกเลิกคำสั่งเขียนอื่นที่อยู่ในชุดเดียวกัน */
function fmt_(range, format) {
  try { SpreadsheetApp.flush(); range.setNumberFormat(format); SpreadsheetApp.flush(); }
  catch (e) { console.warn('ข้ามการตั้งรูปแบบ: ' + e.message); }
}

function isTrue_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }

/** ตัดอักขระควบคุม, ตัดความยาว, กัน formula injection (= + - @ นำหน้า) */
function clean_(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim()
    .replace(/^[=+\-@\s]+/, '')
    .slice(0, max);
}

function audit_(actor, action, target, detail) {
  const row = [new Date(), actor, action, target || '', String(detail || '').slice(0, 500)];
  try {
    const sh = sheet_(CFG.SHEET.AUDIT), r = sh.getLastRow() + 1;
    try { sh.getRange(r, 1, 1, 5).setValues([row]); }
    catch (e1) { row.forEach((v, i) => sh.getRange(r, i + 1).setValue(v)); }   // ชีตแบบ Table บางครั้งไม่ยอมให้เขียนหลายคอลัมน์พร้อมกัน เขียนทีละช่องแทน
  } catch (e) { console.error('audit failed', e); }
}

// ===================== DATE HELPERS =====================
function pad_(n) { return ('0' + n).slice(-2); }
function ymd_(d) { return d.getFullYear() + '-' + pad_(d.getMonth() + 1) + '-' + pad_(d.getDate()); }
function addDays_(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function today_() { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); }

function parseYmd_(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) fail_('รูปแบบวันที่ไม่ถูกต้อง');
  const p = s.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2]);
  if (d.getFullYear() !== p[0] || d.getMonth() !== p[1] - 1 || d.getDate() !== p[2]) fail_('วันที่ไม่ถูกต้อง');
  return d;
}

/** อ่านค่าจากชีต: รองรับ Date จริง และข้อความ DD/MM/YYYY (พ.ศ. หรือ ค.ศ.) ของข้อมูลเก่า */
function toDate_(v) {
  if (v instanceof Date && !isNaN(v)) {
    let y = v.getFullYear();
    if (y > 2400) y -= 543;   // ข้อมูลเก่าที่เก็บปี พ.ศ. แต่ชีตอ่านเป็นปี ค.ศ. (เช่น 2569 -> 2026)
    return new Date(y, v.getMonth(), v.getDate());
  }
  const m = String(v || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  let y = Number(m[3]); if (y > 2400) y -= 543;
  const d = new Date(y, Number(m[2]) - 1, Number(m[1]));
  return isNaN(d) ? null : d;
}

function tsStr_(v) {
  return v instanceof Date ? Utilities.formatDate(v, CFG.TZ, 'yyyy-MM-dd HH:mm') : String(v || '');
}

function holidaySet_() {
  const set = {};
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CFG.SHEET.HOLIDAYS);
  if (!sh || sh.getLastRow() < 2) return set;
  sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(r => {
    const d = toDate_(r[0]); if (d) set[ymd_(d)] = true;
  });
  return set;
}

function countDays_(type, start, end) {
  const cal = Math.round((end - start) / 86400000) + 1;
  if (type === 'off_duty_cancel' || type === 'other') return cal;
  const hol = holidaySet_();
  let n = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const w = d.getDay();
    if (w !== 0 && w !== 6 && !hol[ymd_(d)]) n++;
  }
  return n;
}

/** วันทำงานถัดจากวันสุดท้ายที่ลา (ข้ามเสาร์-อาทิตย์และวันหยุด) = วันที่กลับมาทำงาน */
function nextWorkday_(end) {
  const hol = holidaySet_();
  let d = addDays_(end, 1);
  for (let i = 0; i < 60; i++) {
    const w = d.getDay();
    if (w !== 0 && w !== 6 && !hol[ymd_(d)]) break;
    d = addDays_(d, 1);
  }
  return d;
}

function validateEntry_(e, today, no) {
  const label = 'รายการที่ ' + no + ': ';
  if (!e || typeof e !== 'object') fail_(label + 'ข้อมูลไม่ถูกต้อง');
  const t = LEAVE_TYPES.find(x => x[0] === e.leaveTypeKey);
  if (!t) fail_(label + 'ประเภทการลาไม่ถูกต้อง');
  const start = parseYmd_(e.startDate), end = parseYmd_(e.endDate);
  if (end < start) fail_(label + 'วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
  if (Math.round((end - start) / 86400000) + 1 > CFG.MAX_RANGE_DAYS) fail_(label + 'ลาต่อเนื่องได้ไม่เกิน ' + CFG.MAX_RANGE_DAYS + ' วัน');
  if (start < addDays_(today, -CFG.MAX_PAST_DAYS)) fail_(label + 'ลาย้อนหลังได้ไม่เกิน ' + CFG.MAX_PAST_DAYS + ' วัน');
  if (end > addDays_(today, CFG.MAX_FUTURE_DAYS)) fail_(label + 'ลาล่วงหน้าได้ไม่เกิน ' + CFG.MAX_FUTURE_DAYS + ' วัน');
  const days = countDays_(t[0], start, end);
  if (days < 1) fail_(label + 'ช่วงที่เลือกไม่มีวันทำงาน (เสาร์-อาทิตย์/วันหยุด)');
  return { key: t[0], label: t[1], start: start, end: end, days: days };
}

function overlap_(a, b) { return a.start.getTime() <= b.end.getTime() && a.end.getTime() >= b.start.getTime(); }

// ===== จำกัด "งดเวรนอกเวลา" ไม่เกิน N วัน/เดือน =====
// กติกา: นับเป็น "จำนวนวัน" ตามเดือนของวันที่งดเวรจริง (เดือน พ.ย. 3 วัน, ธ.ค. 3 วัน, ม.ค. 3 วัน แยกกัน)
//        ไม่เกี่ยวกับวันที่กดส่ง | งดหลายวันติดกัน นับทีละวัน | รายการที่คร่อมเดือน แยกนับตามวันที่ตกในแต่ละเดือน
//        นับรายการรออนุมัติ + อนุมัติแล้ว (ปฏิเสธ/ยกเลิกไม่นับ) | นับรายคน
const OFF_DUTY_MONTHS_ = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

/** กระจายวันของช่วง s..e ลงในเดือนต่าง ๆ : into['yyyy-mm'] += จำนวนวัน */
function spreadDays_(s, e, into) {
  for (let d = new Date(s.getFullYear(), s.getMonth(), s.getDate()); d <= e; d.setDate(d.getDate() + 1)) {
    const k = d.getFullYear() + '-' + pad_(d.getMonth() + 1);
    into[k] = (into[k] || 0) + 1;
  }
}

/** จำนวนวันงดเวรนอกเวลาที่พนักงานคนนี้ใช้สิทธิ์ไปแล้วในแต่ละเดือน (รออนุมัติ + อนุมัติแล้ว) */
function offDutyUsed_(me) {
  const label = LEAVE_TYPES.find(x => x[0] === 'off_duty_cancel')[1];
  const used = {};
  rows_(CFG.SHEET.LEAVE, L.WIDTH).forEach(r => {
    if (!isOwn_(r.row, me.row[S.ID], me.row[S.NAME])) return;
    if (r.row[L.TYPE] !== label) return;
    if ([STATUS.REJECTED, STATUS.CANCELLED].indexOf(r.row[L.STATUS]) >= 0) return;
    const s = toDate_(r.row[L.START]), e = toDate_(r.row[L.END]); if (!s || !e) return;
    spreadDays_(s, e, used);
  });
  return used;
}

function checkOffDutyQuota_(me, accepted) {
  const max = CFG.OFF_DUTY_MAX_DAYS_PER_MONTH;
  if (!max) return;                                   // ตั้งเป็น 0 = ไม่จำกัด
  const mine = accepted.filter(v => v.key === 'off_duty_cancel');
  if (!mine.length) return;
  const used = offDutyUsed_(me), adding = {}, sample = {};
  mine.forEach(v => {
    spreadDays_(v.start, v.end, adding);
    for (let d = new Date(v.start); d <= v.end; d.setDate(d.getDate() + 1)) {
      const k = d.getFullYear() + '-' + pad_(d.getMonth() + 1); sample[k] = sample[k] || new Date(d);
    }
  });
  Object.keys(adding).sort().forEach(k => {
    const have = used[k] || 0;
    if (have + adding[k] > max) {
      const d = sample[k];
      fail_('งดเวรนอกเวลาได้ไม่เกิน ' + max + ' วัน/เดือน — เดือน' + OFF_DUTY_MONTHS_[d.getMonth()] + ' ' + (d.getFullYear() + 543) +
            ' มีแล้ว ' + have + ' วัน (รายการนี้เพิ่มอีก ' + adding[k] + ' วัน) จึงเกินกำหนด' +
            (have < max ? ' เหลือสิทธิ์อีก ' + (max - have) + ' วัน' : ''));
    }
  });
}

/** ให้หน้าฟอร์มแสดง "ใช้ไปแล้วกี่วัน/เหลืออีกกี่วัน" : { max, used: {'yyyy-mm': วัน} } */
function getOffDutyQuota(token) {
  return api_(() => {
    const me = requireStaff_(token, false);
    return { max: CFG.OFF_DUTY_MAX_DAYS_PER_MONTH || 0, used: offDutyUsed_(me) };
  });
}

// ===================== CRYPTO / THROTTLE / SESSION =====================
function hex_(bytes) { return bytes.map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join(''); }

function hash_(secret, salt) {
  const pepper = PropertiesService.getScriptProperties().getProperty('PEPPER');
  if (!pepper) fail_('ระบบยังไม่ได้ติดตั้ง (รัน setupSystem)', 'NO_SETUP');
  let h = salt + ':' + secret + ':' + pepper;
  for (let i = 0; i < CFG.HASH_ROUNDS; i++) {
    h = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + salt, Utilities.Charset.UTF_8));
  }
  return h;
}

function verify_(secret, salt, expected) {
  if (!salt || !expected) return false;
  const a = hash_(secret, String(salt)), b = String(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function makeHash_(secret) { const salt = Utilities.getUuid(); return { salt: salt, hash: hash_(secret, salt) }; }

function lockSec_(key) { return /^(staff|pin):/.test(key) ? CFG.STAFF_LOCK_SECONDS : CFG.LOCK_SECONDS; }
function lockMsg_(key) {
  const m = Math.round(lockSec_(key) / 60);
  return /^(staff|pin):/.test(key)
    ? 'ใส่ผิดหลายครั้งเกินไป บัญชีถูกล็อกชั่วคราว กรุณารอ ' + m + ' นาที หรือติดต่อผู้ดูแลเพื่อปลดล็อก'
    : 'ลองผิดหลายครั้งเกินไป กรุณารอ ' + m + ' นาทีแล้วลองใหม่';
}
function failCount_(key) { return Number(CacheService.getScriptCache().get('FAIL:' + key) || 0); }
function isLocked_(key, max) { return failCount_(key) >= (max || CFG.MAX_FAILS); }
function throttle_(key, max) {
  if (isLocked_(key, max)) fail_(lockMsg_(key), 'LOCKED');
}
function penalize_(key) {
  const c = CacheService.getScriptCache();
  c.put('FAIL:' + key, String(failCount_(key) + 1), lockSec_(key));
}
function clearFails_(key) { CacheService.getScriptCache().remove('FAIL:' + key); }

function newSession_(type, id, system, pw) {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('SESS:' + token, JSON.stringify({ type: type, id: id, sys: system || '', pw: pw || '' }),
    type === 'admin' ? CFG.ADMIN_SESSION_SEC : CFG.STAFF_SESSION_SEC);
  return token;
}

function session_(token, type) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) fail_('กรุณาเข้าสู่ระบบ', 'AUTH');
  const c = CacheService.getScriptCache();
  const raw = c.get('SESS:' + token);
  if (!raw) fail_('หมดเวลาการใช้งาน กรุณาเข้าสู่ระบบใหม่', 'AUTH');
  const s = JSON.parse(raw);
  if (s.type !== type) fail_('ไม่มีสิทธิ์ใช้งานส่วนนี้', 'AUTH');
  c.put('SESS:' + token, raw, type === 'admin' ? CFG.ADMIN_SESSION_SEC : CFG.STAFF_SESSION_SEC);
  return s;
}

/** แท็กรหัสผ่านของผู้ดูแลที่ผูกกับ session: เปลี่ยน/รีเซ็ตรหัสผ่านแล้ว session เดิมทุกอันใช้ไม่ได้ทันที */
function pwTag_(hash) { return String(hash || '').slice(0, 16); }
function retagSession_(token, pw) {
  const c = CacheService.getScriptCache(), raw = c.get('SESS:' + token);
  if (!raw) return;
  const s = JSON.parse(raw); s.pw = pw;
  c.put('SESS:' + token, JSON.stringify(s), CFG.ADMIN_SESSION_SEC);
}

function endSession_(token) {
  if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) CacheService.getScriptCache().remove('SESS:' + token);
}

// ===================== LOOKUPS =====================
function findStaff_(id) { return rows_(CFG.SHEET.STAFF, S.WIDTH).find(r => r.row[S.ID] === id) || null; }
function findAdmin_(user) { return rows_(CFG.SHEET.ADMINS, A.WIDTH).find(r => String(r.row[A.USER]).toLowerCase() === user) || null; }
function findLeave_(id) {
  if (typeof id !== 'string' || id.length < 8 || id.length > 64) return null;
  return rows_(CFG.SHEET.LEAVE, L.WIDTH).find(r => r.row[L.ID] === id) || null;
}

/** system = ระบบที่ token นี้ถูกออกให้ (ไม่ระบุ = 'leave'); token ของระบบอื่นใช้กับฟังก์ชันของระบบนี้ไม่ได้ */
function requireStaff_(token, allowMustChange, system) {
  system = system || 'leave';
  const s = session_(token, 'staff');
  if ((s.sys || 'leave') !== system) fail_('กรุณาเข้าสู่ระบบ', 'AUTH');
  const f = findStaff_(s.id);
  if (!f || !isTrue_(f.row[S.ACTIVE])) { endSession_(token); fail_('บัญชีนี้ถูกปิดการใช้งาน', 'AUTH'); }
  if (!hasSys_(f.row, system)) { endSession_(token); fail_('บัญชีนี้ไม่ได้รับสิทธิ์ใช้ระบบนี้ กรุณาติดต่อผู้ดูแล', 'AUTH'); }
  if (!allowMustChange && isTrue_(f.row[S.MUST])) fail_('กรุณาตั้ง PIN ใหม่ก่อนใช้งาน', 'MUST_CHANGE_PIN');
  return f;
}

function requireAdmin_(token) {
  const s = session_(token, 'admin');
  const f = findAdmin_(s.id);
  if (!f || !isTrue_(f.row[A.ACTIVE])) { endSession_(token); fail_('บัญชีผู้ดูแลถูกปิดการใช้งาน', 'AUTH'); }
  if (!s.pw || s.pw !== pwTag_(f.row[A.HASH])) { endSession_(token); fail_('รหัสผ่านถูกเปลี่ยนแล้ว กรุณาเข้าสู่ระบบใหม่', 'AUTH'); }
  return { username: String(f.row[A.USER]), display: String(f.row[A.DISPLAY]), rowNum: f.rowNum };
}

function validPin_(pin) {
  if (!/^\d{4,6}$/.test(pin)) return 'PIN ต้องเป็นตัวเลข 4-6 หลัก';
  if (pin === CFG.DEFAULT_PIN || /^(\d)\1+$/.test(pin)) return 'PIN ง่ายเกินไป กรุณาเลือกเลขอื่น';
  const d = pin.split('').map(Number);
  const diffs = d.slice(1).map((x, i) => x - d[i]);
  if (diffs.every(x => x === 1) || diffs.every(x => x === -1)) return 'PIN ห้ามเป็นเลขเรียงต่อกัน';
  return '';
}

function validPassword_(pw) {
  if (typeof pw !== 'string' || pw.length < 10) fail_('รหัสผ่านต้องยาวอย่างน้อย 10 ตัวอักษร');
  if (pw.length > 100) fail_('รหัสผ่านยาวเกินไป');
}

// ===================== PUBLIC API: ทั่วไป =====================
function getBootstrap() {
  return api_(() => {
    const staff = rows_(CFG.SHEET.STAFF, S.WIDTH)
      .filter(r => isTrue_(r.row[S.ACTIVE]) && hasSys_(r.row, 'leave'))
      .map(r => ({ id: r.row[S.ID], name: r.row[S.NAME] }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'th'));
    return { leaveTypes: LEAVE_TYPES, positions: POSITIONS, staff: staff,
             limits: { maxEntries: CFG.MAX_ENTRIES, pastDays: CFG.MAX_PAST_DAYS, futureDays: CFG.MAX_FUTURE_DAYS, offDutyMaxDays: CFG.OFF_DUTY_MAX_DAYS_PER_MONTH } };
  });
}

// ===================== PUBLIC API: พนักงาน =====================
/** หน้าเว็บระบบลาเรียกตัวนี้ (ล็อกอินเข้า 'leave' เท่านั้น — ไม่รับ system จาก client) */
function staffLogin(staffId, pin) { return staffLogin_(staffId, pin, 'leave'); }

/** ล็อกอินเข้าระบบ system (Stock/Incident เรียกผ่าน doPost ซึ่งเป็นผู้กำหนด system เอง) */
function staffLogin_(staffId, pin, system) {
  return api_(() => {
    staffId = String(staffId || ''); pin = String(pin || '');
    const key = 'staff:' + staffId;
    throttle_(key);
    const f = findStaff_(staffId);
    if (!f || !isTrue_(f.row[S.ACTIVE]) || !verify_(pin, f.row[S.SALT], f.row[S.HASH])) {
      penalize_(key);
      audit_('staff:' + staffId, 'STAFF_LOGIN_FAIL', staffId, system);
      const left = CFG.MAX_FAILS - failCount_(key);
      fail_(left > 0 ? 'ชื่อหรือ PIN ไม่ถูกต้อง (เหลืออีก ' + left + ' ครั้ง ก่อนบัญชีถูกล็อกชั่วคราว)' : lockMsg_(key), left > 0 ? 'BAD_LOGIN' : 'LOCKED');
    }
    clearFails_(key);
    if (!hasSys_(f.row, system)) {   // ตรวจหลังยืนยัน PIN แล้ว เพื่อไม่เปิดเผยสิทธิ์ให้คนที่ไม่รู้ PIN
      audit_('staff:' + f.row[S.NAME], 'STAFF_LOGIN_NO_ACCESS', staffId, system);
      fail_('บัญชีนี้ไม่ได้รับสิทธิ์ใช้ระบบนี้ กรุณาติดต่อผู้ดูแล', 'NO_ACCESS');
    }
    audit_('staff:' + f.row[S.NAME], 'STAFF_LOGIN', staffId, system);
    return { token: newSession_('staff', staffId, system),
             staff: { id: staffId, name: f.row[S.NAME], position: f.row[S.POS] },
             mustChangePin: isTrue_(f.row[S.MUST]) };
  });
}

/** ตรวจว่า token ที่เก็บไว้ในแท็บยังใช้ได้ไหม (กลับเข้าหน้าเดิมหลังรีเฟรชโดยไม่ต้องใส่ PIN ซ้ำ) — ต่ออายุเซสชันตามปกติ */
function staffResume(token) {
  return api_(() => {
    const me = requireStaff_(token, false);
    return { staff: { id: me.row[S.ID], name: me.row[S.NAME], position: me.row[S.POS] } };
  });
}

function staffLogout(token) { return api_(() => { endSession_(token); }); }

function staffChangePin(token, oldPin, newPin) { return staffChangePin_(token, oldPin, newPin, 'leave'); }

function staffChangePin_(token, oldPin, newPin, system) {
  return api_(() => {
    const me = requireStaff_(token, true, system);
    oldPin = String(oldPin || ''); newPin = String(newPin || '');
    const key = 'pin:' + me.row[S.ID];
    throttle_(key);
    if (!verify_(oldPin, me.row[S.SALT], me.row[S.HASH])) { penalize_(key); fail_('PIN เดิมไม่ถูกต้อง' + (CFG.MAX_FAILS - failCount_(key) > 0 ? ' (เหลืออีก ' + (CFG.MAX_FAILS - failCount_(key)) + ' ครั้ง)' : ''), 'BAD_PIN'); }
    clearFails_(key);
    const err = validPin_(newPin); if (err) fail_(err);
    if (newPin === oldPin) fail_('PIN ใหม่ต้องไม่ซ้ำกับ PIN เดิม');
    withLock_(() => {
      const h = makeHash_(newPin);
      const sh = sheet_(CFG.SHEET.STAFF);
      sh.getRange(me.rowNum, S.HASH + 1, 1, 2).setValues([[h.hash, h.salt]]);
      sh.getRange(me.rowNum, S.MUST + 1).setValue(false);
      sh.getRange(me.rowNum, S.PINCHANGED + 1).setValue(new Date());
    });
    audit_('staff:' + me.row[S.NAME], isTrue_(me.row[S.MUST]) ? 'PIN_FIRST_SET' : 'PIN_CHANGED', me.row[S.ID], '');
    return { message: 'เปลี่ยน PIN เรียบร้อยแล้ว' };
  });
}

function calculateDuration(token, leaveTypeKey, startDate, endDate) {
  return api_(() => {
    requireStaff_(token, false);
    const v = validateEntry_({ leaveTypeKey: leaveTypeKey, startDate: startDate, endDate: endDate }, today_(), 1);
    return {
      days: v.days,
      calendarDays: Math.round((v.end - v.start) / 86400000) + 1,
      returnDate: ymd_(nextWorkday_(v.end))
    };
  });
}

function leaveDto_(r) {
  const row = r.row;
  const s = toDate_(row[L.START]), e = toDate_(row[L.END]);
  return {
    id: String(row[L.ID] || ''), staffId: String(row[L.STAFFID] || ''), ts: tsStr_(row[L.TS]), name: String(row[L.NAME]), position: String(row[L.POS]),
    type: String(row[L.TYPE]), start: s ? ymd_(s) : '', end: e ? ymd_(e) : '', days: row[L.DAYS],
    status: String(row[L.STATUS] || STATUS.PENDING), by: String(row[L.BY] || ''), at: tsStr_(row[L.AT]), note: String(row[L.NOTE] || '')
  };
}

function isOwn_(row, staffId, name) {
  return row[L.STAFFID] === staffId || (!row[L.STAFFID] && row[L.NAME] === name);
}

function getMyLeaves(token) {
  return api_(() => {
    const me = requireStaff_(token, false);
    const list = rows_(CFG.SHEET.LEAVE, L.WIDTH)
      .filter(r => isOwn_(r.row, me.row[S.ID], me.row[S.NAME]))
      .reverse().slice(0, 100).map(leaveDto_);
    return { rows: list };
  });
}

function submitLeave(token, entries) {
  return api_(() => {
    const me = requireStaff_(token, false);
    if (!Array.isArray(entries) || entries.length < 1) fail_('ไม่มีรายการลา');
    if (entries.length > CFG.MAX_ENTRIES) fail_('ส่งได้ครั้งละไม่เกิน ' + CFG.MAX_ENTRIES + ' รายการ');
    let ntf = '';
    const res = withLock_(() => {
      const today = today_();
      const existing = rows_(CFG.SHEET.LEAVE, L.WIDTH)
        .filter(r => isOwn_(r.row, me.row[S.ID], me.row[S.NAME]) &&
                     [STATUS.REJECTED, STATUS.CANCELLED].indexOf(r.row[L.STATUS]) < 0)
        .map(r => ({ start: toDate_(r.row[L.START]), end: toDate_(r.row[L.END]) }))
        .filter(x => x.start && x.end);

      const out = [], accepted = [];
      entries.forEach((e, i) => {
        const v = validateEntry_(e, today, i + 1);
        if (existing.some(x => overlap_(x, v)) || accepted.some(x => overlap_(x, v))) {
          fail_('รายการที่ ' + (i + 1) + ': วันที่ลาซ้ำกับรายการที่มีอยู่แล้ว');
        }
        accepted.push(v);
        out.push([new Date(), me.row[S.NAME], me.row[S.POS], v.label, v.start, v.end, v.days,
                  STATUS.PENDING, Utilities.getUuid(), '', '', '', me.row[S.ID]]);
      });

      checkOffDutyQuota_(me, accepted);   // งดเวรนอกเวลาไม่เกิน N วัน/เดือน (ตรวจก่อนเขียนชีต)
      const sh = sheet_(CFG.SHEET.LEAVE);
      const first = sh.getLastRow() + 1;
      sh.getRange(first, 1, out.length, L.WIDTH).setValues(out);
      fmt_(sh.getRange(first, 1, out.length, 1), 'dd/mm/yyyy HH:mm:ss');
      fmt_(sh.getRange(first, 5, out.length, 2), 'dd/mm/yyyy');
      audit_('staff:' + me.row[S.NAME], 'LEAVE_SUBMIT', me.row[S.ID], out.map(r => r[L.ID]).join(','));
      ntf = '📝 คำขอลาใหม่ รออนุมัติ\n' + me.row[S.NAME] + '\n' + out.slice(0, 5).map(r => '• ' + r[L.TYPE] + ' ' + lineThaiDate_(r[L.START]) + (r[L.DAYS] ? ' (' + r[L.DAYS] + ' วัน)' : '')).join('\n') + (out.length > 5 ? '\n…และอีก ' + (out.length - 5) + ' รายการ' : '');
      return { message: 'บันทึกใบลาเรียบร้อยแล้ว (' + out.length + ' รายการ)', count: out.length };
    });
    if (ntf) lineNotify_('leave', ntf);   // แจ้ง LINE หลังปล่อยล็อกแล้ว ; ล้มเหลวไม่กระทบการบันทึก
    return res;
  });
}

function staffCancelLeave(token, leaveId) {
  return api_(() => {
    const me = requireStaff_(token, false);
    return withLock_(() => {
      const f = findLeave_(leaveId);
      if (!f || !isOwn_(f.row, me.row[S.ID], me.row[S.NAME])) fail_('ไม่พบรายการ');
      if ((f.row[L.STATUS] || STATUS.PENDING) !== STATUS.PENDING) fail_('ยกเลิกได้เฉพาะรายการที่รออนุมัติ');
      const sh = sheet_(CFG.SHEET.LEAVE);
      sh.getRange(f.rowNum, L.STATUS + 1).setValue(STATUS.CANCELLED);
      sh.getRange(f.rowNum, L.BY + 1, 1, 2).setValues([[me.row[S.NAME], new Date()]]);
      audit_('staff:' + me.row[S.NAME], 'LEAVE_CANCEL', leaveId, '');
      return { message: 'ยกเลิกรายการแล้ว' };
    });
  });
}

// ===================== PUBLIC API: แอดมิน (ล็อกอิน / รายการลา) =====================
function adminLogin(username, password) {
  return api_(() => {
    username = String(username || '').trim().toLowerCase().slice(0, 40);
    password = String(password || '').slice(0, 200);
    throttle_('admin:*', 30);
    throttle_('admin:' + username);
    const f = username ? findAdmin_(username) : null;
    if (!f || !isTrue_(f.row[A.ACTIVE]) || !verify_(password, f.row[A.SALT], f.row[A.HASH])) {
      penalize_('admin:*'); penalize_('admin:' + username);
      audit_('admin:' + username, 'ADMIN_LOGIN_FAIL', username, '');
      fail_('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', 'BAD_LOGIN');
    }
    clearFails_('admin:' + username);
    audit_('admin:' + username, 'ADMIN_LOGIN', username, '');
    return { token: newSession_('admin', username, '', pwTag_(f.row[A.HASH])), admin: { username: username, displayName: f.row[A.DISPLAY] } };
  });
}

function adminLogout(token) { return api_(() => { endSession_(token); }); }

function adminSummary(token) {
  return api_(() => {
    requireAdmin_(token);
    const pending = rows_(CFG.SHEET.LEAVE, L.WIDTH).filter(r => !r.row[L.STATUS] || r.row[L.STATUS] === STATUS.PENDING).length;
    const staff = rows_(CFG.SHEET.STAFF, S.WIDTH).filter(r => isTrue_(r.row[S.ACTIVE]));
    return { pending: pending, pendingRequests: pendingRequestCount_(), staffActive: staff.length,
             staffNotChangedPin: staff.filter(r => isTrue_(r.row[S.MUST])).map(r => r.row[S.NAME]) };
  });
}

function adminGetLeaves(token, filter) {
  return api_(() => {
    requireAdmin_(token);
    filter = filter || {};
    const st = String(filter.status || STATUS.PENDING);
    if (['all', STATUS.PENDING, STATUS.APPROVED, STATUS.REJECTED, STATUS.CANCELLED].indexOf(st) < 0) fail_('ตัวกรองไม่ถูกต้อง');
    const month = /^\d{4}(-\d{2})?$/.test(String(filter.month || '')) ? filter.month : '';
    const q = clean_(filter.q, 50).toLowerCase();
    const list = rows_(CFG.SHEET.LEAVE, L.WIDTH).reverse().map(leaveDto_).filter(d =>
      (st === 'all' || d.status === st) &&
      (!month || d.start.indexOf(month) === 0) &&
      (!q || d.name.toLowerCase().indexOf(q) >= 0));
    return { total: list.length, rows: list.slice(0, CFG.MAX_ROWS_ADMIN) };
  });
}

function adminDecide(token, leaveId, decision, note) {
  return api_(() => {
    const adm = requireAdmin_(token);
    if ([STATUS.APPROVED, STATUS.REJECTED].indexOf(decision) < 0) fail_('คำสั่งไม่ถูกต้อง');
    note = clean_(note, 200);
    return withLock_(() => {
      const f = findLeave_(leaveId);
      if (!f) fail_('ไม่พบรายการ (ถ้าเป็นข้อมูลเก่า ให้รัน migrateLegacyLeaveData)');
      const cur = f.row[L.STATUS] || STATUS.PENDING;
      if (cur !== STATUS.PENDING) fail_('รายการนี้ถูกดำเนินการไปแล้ว (' + cur + ') กรุณารีเฟรช', 'STALE');
      const sh = sheet_(CFG.SHEET.LEAVE);
      sh.getRange(f.rowNum, L.STATUS + 1).setValue(decision);
      sh.getRange(f.rowNum, L.BY + 1, 1, 3).setValues([[adm.display, new Date(), note]]);
      audit_('admin:' + adm.username, 'LEAVE_' + decision.toUpperCase(), leaveId, f.row[L.NAME] + (note ? ' | ' + note : ''));
      return { message: decision === STATUS.APPROVED ? 'อนุมัติเรียบร้อย' : 'ปฏิเสธเรียบร้อย' };
    });
  });
}

/** แอดมินยกเลิกใบลาที่อนุมัติแล้ว (กรณีพนักงานยกเลิกเองไม่ได้) — เก็บแถวไว้เป็นประวัติ เปลี่ยนสถานะเป็น Cancelled
 *  จึงหลุดจากปฏิทิน/รายงาน/ตารางสรุปทันที (ทุกจุดนับเฉพาะ Approve) ; ต้องใส่เหตุผล */
function adminCancelLeave(token, leaveId, note) {
  return api_(() => {
    const adm = requireAdmin_(token);
    note = clean_(note, 200);
    if (!note) fail_('กรุณาระบุเหตุผลการยกเลิก');
    let ntf = '';
    const res = withLock_(() => {
      const f = findLeave_(leaveId);
      if (!f) fail_('ไม่พบรายการ');
      const cur = f.row[L.STATUS] || STATUS.PENDING;
      if (cur === STATUS.CANCELLED) fail_('รายการนี้ถูกยกเลิกไปแล้ว กรุณารีเฟรช', 'STALE');
      if (cur !== STATUS.APPROVED) fail_('ยกเลิกได้เฉพาะใบลาที่อนุมัติแล้ว (รายการรออนุมัติให้ใช้ปุ่มไม่อนุมัติ) กรุณารีเฟรช', 'STALE');
      const sh = sheet_(CFG.SHEET.LEAVE);
      sh.getRange(f.rowNum, L.STATUS + 1).setValue(STATUS.CANCELLED);
      sh.getRange(f.rowNum, L.BY + 1, 1, 3).setValues([[adm.display, new Date(), 'ยกเลิกโดยผู้ดูแล: ' + note]]);
      audit_('admin:' + adm.username, 'LEAVE_ADMIN_CANCEL', leaveId, f.row[L.NAME] + ' | ' + note);
      const s = toDate_(f.row[L.START]);
      ntf = '🚫 ผู้ดูแลยกเลิกใบลาที่อนุมัติแล้ว\n' + f.row[L.NAME] + '\n• ' + f.row[L.TYPE] + (s ? ' ' + lineThaiDate_(s) : '') + (f.row[L.DAYS] ? ' (' + f.row[L.DAYS] + ' วัน)' : '') + '\nโดย ' + adm.display + ' : ' + note;
      return { message: 'ยกเลิกใบลาเรียบร้อย' };
    });
    if (ntf) lineNotify_('leave', ntf);
    return res;
  });
}

// ===================== PUBLIC API: แอดมิน (จัดการพนักงาน) =====================
function adminListStaff(token) {
  return api_(() => {
    requireAdmin_(token);
    return { rows: rows_(CFG.SHEET.STAFF, S.WIDTH).map(r => ({
      id: r.row[S.ID], name: r.row[S.NAME], position: r.row[S.POS], active: isTrue_(r.row[S.ACTIVE]),
      mustChangePin: isTrue_(r.row[S.MUST]), created: tsStr_(r.row[S.CREATED]), sys: sysFlags_(r.row),
      locked: isLocked_('staff:' + r.row[S.ID]) || isLocked_('pin:' + r.row[S.ID]) })) };
  });
}

/** แปลง data.sys ({leave,stock,stockcenter,incident,bloodgas,glucose: true/false}) เป็นแถวค่าตามจำนวนระบบ; ไม่ส่งมา = null
 *  ระบบที่ไม่ได้ส่งมาใน sys จะ "คงค่าเดิม" (curRow) หรือเป็นปิด (พนักงานใหม่ เหมือนเดิม) —
 *  หน้า Admin ของระบบอื่นที่ยังไม่รู้จักระบบใหม่ จึงไม่ไปปิดสิทธิ์ที่ผู้ดูแลเปิดไว้โดยไม่ตั้งใจ */
function sysInput_(sys, curRow) {
  if (!sys || typeof sys !== 'object') return null;
  return SYS_KEYS.map(k => Object.prototype.hasOwnProperty.call(sys, k) ? sys[k] === true : (curRow ? hasSys_(curRow, k) : false));
}

/** data: {id?, name, position, active, sys?}  — ไม่ส่ง id = เพิ่มใหม่ (PIN เริ่มต้น 1234 + บังคับเปลี่ยน; ไม่ส่ง sys = เปิดครบทุกระบบ)
 *  ตอนแก้ไข: ไม่ส่ง sys = ไม่แตะสิทธิ์เดิม */
function adminSaveStaff(token, data) {
  return api_(() => {
    const adm = requireAdmin_(token);
    data = data || {};
    const name = clean_(data.name, 80);
    if (name.length < 2) fail_('กรุณากรอกชื่อ-นามสกุล');
    if (POSITIONS.indexOf(data.position) < 0) fail_('ตำแหน่งไม่ถูกต้อง');
    return withLock_(() => {
      const all = rows_(CFG.SHEET.STAFF, S.WIDTH);
      const sh = sheet_(CFG.SHEET.STAFF);
      if (data.id) {
        const f = all.find(r => r.row[S.ID] === data.id);
        if (!f) fail_('ไม่พบพนักงาน');
        const sysVals = sysInput_(data.sys, f.row);
        // ตรวจเฉพาะเมื่อมีการเปลี่ยนชื่อ จะได้ยังเปิด/ปิดใช้งานคนที่ซ้ำอยู่เดิมได้ระหว่างรอลบ
        if (nameKey_(f.row[S.NAME]) !== nameKey_(name)) {
          const dup = findDupStaff_(name, data.id, all);
          if (dup) fail_(dupMsg_(dup), 'DUP_NAME');
        }
        sh.getRange(f.rowNum, S.NAME + 1, 1, 2).setValues([[name, data.position]]);
        sh.getRange(f.rowNum, S.ACTIVE + 1).setValue(data.active === true);
        if (sysVals) sh.getRange(f.rowNum, S.LEAVE + 1, 1, SYS_KEYS.length).setValues([sysVals]);
        audit_('admin:' + adm.username, 'STAFF_UPDATE', data.id, name + ' active=' + (data.active === true) + (sysVals ? ' sys=' + SYS_KEYS.filter((k, i) => sysVals[i]).join(',') : ''));
        return { id: data.id, message: 'แก้ไขเรียบร้อย' };
      }
      const dup = findDupStaff_(name, '', all);
      if (dup) fail_(dupMsg_(dup), 'DUP_NAME');
      const sysVals = sysInput_(data.sys, null);
      const id = 'S' + Utilities.getUuid().slice(0, 8);
      const h = makeHash_(CFG.DEFAULT_PIN);
      sh.getRange(sh.getLastRow() + 1, 1, 1, S.WIDTH)
        .setValues([[id, name, data.position, h.hash, h.salt, true, true, new Date(), ''].concat(sysVals || newStaffSys_())]);
      linkLeaveToStaff_(id, name);
      audit_('admin:' + adm.username, 'STAFF_ADD', id, name);
      return { id: id, message: 'เพิ่มพนักงานแล้ว (PIN เริ่มต้น ' + CFG.DEFAULT_PIN + ')' };
    });
  });
}

function adminUnlockStaff(token, staffId) {
  return api_(() => {
    const adm = requireAdmin_(token);
    const f = findStaff_(String(staffId || ''));
    if (!f) fail_('ไม่พบพนักงาน');
    clearFails_('staff:' + f.row[S.ID]); clearFails_('pin:' + f.row[S.ID]);
    audit_('admin:' + adm.username, 'STAFF_UNLOCK', f.row[S.ID], f.row[S.NAME]);
    return { message: 'ปลดล็อก ' + f.row[S.NAME] + ' แล้ว ลองเข้าสู่ระบบได้ทันที' };
  });
}

function adminResetStaffPin(token, staffId) {
  return api_(() => {
    const adm = requireAdmin_(token);
    return withLock_(() => {
      const f = findStaff_(String(staffId || ''));
      if (!f) fail_('ไม่พบพนักงาน');
      const h = makeHash_(CFG.DEFAULT_PIN);
      const sh = sheet_(CFG.SHEET.STAFF);
      sh.getRange(f.rowNum, S.HASH + 1, 1, 2).setValues([[h.hash, h.salt]]);
      sh.getRange(f.rowNum, S.MUST + 1).setValue(true);
      clearFails_('staff:' + f.row[S.ID]); clearFails_('pin:' + f.row[S.ID]);
      audit_('admin:' + adm.username, 'STAFF_PIN_RESET', f.row[S.ID], f.row[S.NAME]);
      return { message: 'รีเซ็ต PIN เป็น ' + CFG.DEFAULT_PIN + ' แล้ว พนักงานต้องตั้งใหม่ตอนเข้าครั้งถัดไป' };
    });
  });
}

// ===================== PUBLIC API: แอดมิน (จัดการแอดมิน) =====================
/** เฉพาะผู้ดูแลใหญ่ — ใช้กับการเพิ่ม/แก้/ตั้งรหัส/ลบ บัญชีผู้ดูแล (isSuperAdmin_ อยู่ใน AllAdminApi.gs) */
function requireSuper_(adm) {
  if (!isSuperAdmin_(adm.username)) fail_('เฉพาะผู้ดูแลใหญ่เท่านั้นที่จัดการบัญชีผู้ดูแลระบบได้ (ไปที่ Admin Center)', 'SUPER_ONLY');
}

function adminListAdmins(token) {
  return api_(() => {
    requireAdmin_(token);
    return { rows: rows_(CFG.SHEET.ADMINS, A.WIDTH).map(r => ({
      username: r.row[A.USER], displayName: r.row[A.DISPLAY], active: isTrue_(r.row[A.ACTIVE]), created: tsStr_(r.row[A.CREATED]) })) };
  });
}

function activeAdminCountExcept_(username) {
  return rows_(CFG.SHEET.ADMINS, A.WIDTH)
    .filter(r => isTrue_(r.row[A.ACTIVE]) && String(r.row[A.USER]).toLowerCase() !== username).length;
}

/** data: {username, displayName, password} */
function adminAddAdmin(token, data) {
  return api_(() => {
    const adm = requireAdmin_(token);
    requireSuper_(adm);   // เฉพาะผู้ดูแลใหญ่ (คอลัมน์ H ของชีต Admins) จัดการบัญชีผู้ดูแลได้
    data = data || {};
    const username = String(data.username || '').trim().toLowerCase();
    if (!/^[a-z0-9_.-]{3,30}$/.test(username)) fail_('ชื่อผู้ใช้ใช้ a-z 0-9 _ . - ยาว 3-30 ตัว');
    const display = clean_(data.displayName, 60);
    if (display.length < 2) fail_('กรุณากรอกชื่อที่แสดง');
    validPassword_(data.password);
    return withLock_(() => {
      if (findAdmin_(username)) fail_('มีชื่อผู้ใช้นี้แล้ว');
      const h = makeHash_(data.password);
      const sh = sheet_(CFG.SHEET.ADMINS);
      sh.getRange(sh.getLastRow() + 1, 1, 1, A.WIDTH).setValues([[username, display, h.hash, h.salt, true, new Date()]]);
      audit_('admin:' + adm.username, 'ADMIN_ADD', username, display);
      return { message: 'เพิ่มผู้ดูแลระบบแล้ว' };
    });
  });
}

/** data: {username, displayName, active} */
function adminUpdateAdmin(token, data) {
  return api_(() => {
    const adm = requireAdmin_(token);
    requireSuper_(adm);   // เฉพาะผู้ดูแลใหญ่ (คอลัมน์ H ของชีต Admins) จัดการบัญชีผู้ดูแลได้
    data = data || {};
    const username = String(data.username || '').trim().toLowerCase();
    const display = clean_(data.displayName, 60);
    if (display.length < 2) fail_('กรุณากรอกชื่อที่แสดง');
    return withLock_(() => {
      const f = findAdmin_(username);
      if (!f) fail_('ไม่พบผู้ดูแล');
      const active = data.active === true;
      if (!active && username === adm.username) fail_('ไม่สามารถปิดการใช้งานบัญชีตัวเองได้');
      if (!active && activeAdminCountExcept_(username) < 1) fail_('ต้องเหลือผู้ดูแลที่ใช้งานได้อย่างน้อย 1 คน');
      const sh = sheet_(CFG.SHEET.ADMINS);
      sh.getRange(f.rowNum, A.DISPLAY + 1).setValue(display);
      sh.getRange(f.rowNum, A.ACTIVE + 1).setValue(active);
      audit_('admin:' + adm.username, 'ADMIN_UPDATE', username, display + ' active=' + active);
      return { message: 'แก้ไขเรียบร้อย' };
    });
  });
}

function adminChangeOwnPassword(token, oldPassword, newPassword) {
  return api_(() => {
    const adm = requireAdmin_(token);
    const key = 'adminpw:' + adm.username;
    throttle_(key);
    const f = findAdmin_(adm.username);
    if (!verify_(String(oldPassword || ''), f.row[A.SALT], f.row[A.HASH])) { penalize_(key); fail_('รหัสผ่านเดิมไม่ถูกต้อง', 'BAD_PIN'); }
    clearFails_(key);
    validPassword_(newPassword);
    withLock_(() => {
      const h = makeHash_(newPassword);
      sheet_(CFG.SHEET.ADMINS).getRange(f.rowNum, A.HASH + 1, 1, 2).setValues([[h.hash, h.salt]]);
      retagSession_(token, pwTag_(h.hash));   // session ปัจจุบันของผู้เปลี่ยนยังใช้ต่อได้ ส่วน session อื่นถูกตัดทิ้ง
    });
    audit_('admin:' + adm.username, 'ADMIN_PASSWORD_CHANGE', adm.username, '');
    return { message: 'เปลี่ยนรหัสผ่านแล้ว' };
  });
}

function adminResetAdminPassword(token, username, newPassword) {
  return api_(() => {
    const adm = requireAdmin_(token);
    requireSuper_(adm);   // เฉพาะผู้ดูแลใหญ่ (คอลัมน์ H ของชีต Admins) จัดการบัญชีผู้ดูแลได้
    username = String(username || '').trim().toLowerCase();
    if (username === adm.username) fail_('ใช้เมนูเปลี่ยนรหัสผ่านของตัวเองแทน');
    validPassword_(newPassword);
    return withLock_(() => {
      const f = findAdmin_(username);
      if (!f) fail_('ไม่พบผู้ดูแล');
      const h = makeHash_(newPassword);
      sheet_(CFG.SHEET.ADMINS).getRange(f.rowNum, A.HASH + 1, 1, 2).setValues([[h.hash, h.salt]]);
      clearFails_('admin:' + username);
      audit_('admin:' + adm.username, 'ADMIN_PASSWORD_RESET', username, '');
      return { message: 'ตั้งรหัสผ่านใหม่แล้ว' };
    });
  });
}

function resetAdminPasswordManual() {
  const ENABLED = false;
  const USERNAME = '';   // เช่น 'mukdarat'
  const PASSWORD = '';   // รหัสผ่านใหม่ ยาว 10 ตัวขึ้นไป
 
  if (!ENABLED) { Logger.log('ยังไม่เปิดใช้งาน: แก้ ENABLED เป็น true ก่อนรันจริง'); return; }
  const username = String(USERNAME).trim().toLowerCase();
  if (!username) { Logger.log('ยังไม่ได้ใส่ USERNAME'); return; }
  if (PASSWORD.length < 10) { Logger.log('รหัสผ่านต้องยาวอย่างน้อย 10 ตัวอักษร'); return; }
 
  withLock_(() => {
    const f = findAdmin_(username);
    if (!f) { Logger.log('ไม่พบผู้ใช้ "' + username + '" ในชีต Admins (ดูชื่อที่คอลัมน์ A)'); return; }
    const h = makeHash_(PASSWORD), sh = sheet_(CFG.SHEET.ADMINS);
    sh.getRange(f.rowNum, A.HASH + 1, 1, 2).setValues([[h.hash, h.salt]]);
    sh.getRange(f.rowNum, A.ACTIVE + 1).setValue(true);
    clearFails_('admin:' + username);
    audit_('system', 'ADMIN_PASSWORD_RESET_MANUAL', username, '');
    Logger.log('ตั้งรหัสผ่านใหม่ให้ ' + username + ' แล้ว (เปิดใช้งานบัญชีด้วย) — เปลี่ยน ENABLED กลับเป็น false และลบรหัสผ่านออกจากโค้ดตอนนี้');
  });
}

function adminDeleteAdmin(token, username) {
  return api_(() => {
    const adm = requireAdmin_(token);
    requireSuper_(adm);   // เฉพาะผู้ดูแลใหญ่ (คอลัมน์ H ของชีต Admins) จัดการบัญชีผู้ดูแลได้
    username = String(username || '').trim().toLowerCase();
    if (username === adm.username) fail_('ไม่สามารถลบบัญชีตัวเองได้');
    return withLock_(() => {
      const f = findAdmin_(username);
      if (!f) fail_('ไม่พบผู้ดูแล');
      if (isTrue_(f.row[A.ACTIVE]) && activeAdminCountExcept_(username) < 1) fail_('ต้องเหลือผู้ดูแลที่ใช้งานได้อย่างน้อย 1 คน');
      sheet_(CFG.SHEET.ADMINS).deleteRow(f.rowNum);
      audit_('admin:' + adm.username, 'ADMIN_DELETE', username, '');
      return { message: 'ลบผู้ดูแลแล้ว' };
    });
  });
}

// ===================== SETUP (รันเองจากตัวแก้ไข Apps Script) =====================
/** รันครั้งเดียว (รันซ้ำได้ ไม่ทำลายข้อมูล): สร้างชีต หัวตาราง รูปแบบ และคีย์ลับสำหรับ hash */
function setupSystem() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ensure = (name, headers, startCol) => {
    const created = !ss.getSheetByName(name);
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (created || startCol > 1) {
      const need = startCol - 1 + headers.length;
      if (sh.getMaxColumns() < need) sh.insertColumnsAfter(sh.getMaxColumns(), need - sh.getMaxColumns());
      sh.getRange(1, startCol, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    return sh;
  };

  const leaveExists = !!ss.getSheetByName(CFG.SHEET.LEAVE);
  const leaveHeaders = ['Timestamp', 'ชื่อ - นามสกุล', 'ตำแหน่ง', 'ประเภทการลา', 'เริ่มต้น', 'สิ้นสุด', 'จำนวน', 'สถานะ'];
  const extra = ['LeaveID', 'ผู้ดำเนินการ', 'เวลาดำเนินการ', 'หมายเหตุ', 'StaffID'];
  const leave = leaveExists ? ensure(CFG.SHEET.LEAVE, extra, 9) : ensure(CFG.SHEET.LEAVE, leaveHeaders.concat(extra), 1);
  fmt_(leave.getRange('A2:A'), 'dd/mm/yyyy HH:mm:ss');
  fmt_(leave.getRange('E2:F'), 'dd/mm/yyyy');
  fmt_(leave.getRange('K2:K'), 'dd/mm/yyyy HH:mm:ss');

  const hol = ensure(CFG.SHEET.HOLIDAYS, ['วันที่', 'ชื่อวันหยุด'], 1);
  fmt_(hol.getRange('A2:A'), 'dd/mm/yyyy');

  const staff = ensure(CFG.SHEET.STAFF, ['StaffID', 'ชื่อ-นามสกุล', 'ตำแหน่ง', 'PIN Hash', 'Salt', 'ต้องเปลี่ยน PIN', 'ใช้งาน', 'สร้างเมื่อ', 'เปลี่ยน PIN ล่าสุด'].concat(SYS_KEYS), 1);
  fmt_(staff.getRange('D2:E'), '@');

  const admins = ensure(CFG.SHEET.ADMINS, ['Username', 'ชื่อที่แสดง', 'Password Hash', 'Salt', 'ใช้งาน', 'สร้างเมื่อ'], 1);
  fmt_(admins.getRange('C2:D'), '@');

  const audit = ensure(CFG.SHEET.AUDIT, ['เวลา', 'ผู้กระทำ', 'การกระทำ', 'เป้าหมาย', 'รายละเอียด'], 1);
  fmt_(audit.getRange('A2:A'), 'dd/mm/yyyy HH:mm:ss');

  const reqSheet = ensure(CFG.SHEET.REQUESTS, ['RequestID', 'ชื่อ-นามสกุล', 'ตำแหน่ง', 'ข้อมูลติดต่อ', 'สถานะ', 'ส่งเมื่อ', 'ดำเนินการโดย', 'เวลาดำเนินการ', 'StaffID', 'หมายเหตุ'], 1);
  fmt_(reqSheet.getRange('F2:F'), 'dd/mm/yyyy HH:mm:ss');
  fmt_(reqSheet.getRange('H2:H'), 'dd/mm/yyyy HH:mm:ss');

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('PEPPER')) {
    props.setProperty('PEPPER', Utilities.getUuid() + Utilities.getUuid());
    Logger.log('สร้างคีย์ลับ PEPPER แล้ว (ห้ามลบ ไม่งั้นทุกรหัสผ่านใช้ไม่ได้)');
  }
  Logger.log('setupSystem เสร็จสิ้น');
}

/**
 * สร้างแอดมินคนแรก: แก้ 2 ค่าด้านล่าง -> รัน -> "ลบรหัสผ่านออกจากโค้ดทันที"
 * ทำงานได้เฉพาะตอนที่ยังไม่มีแอดมินในชีต
 */
function setupFirstAdmin() {
  const USERNAME = '';
  const DISPLAY_NAME = 'ผู้ดูแลระบบ';
  const PASSWORD = '';   // <-- ใส่รหัสผ่านชั่วคราวตรงนี้ ยาว 10 ตัวขึ้นไป แล้วลบทิ้งหลังรัน

  if (rows_(CFG.SHEET.ADMINS, A.WIDTH).length > 0) { Logger.log('มีแอดมินอยู่แล้ว ไม่ทำอะไร'); return; }
  if (PASSWORD.length < 10) { Logger.log('รหัสผ่านต้องยาวอย่างน้อย 10 ตัวอักษร'); return; }
  const h = makeHash_(PASSWORD);
  const sh = sheet_(CFG.SHEET.ADMINS);
  sh.getRange(2, 1, 1, A.WIDTH).setValues([[USERNAME.toLowerCase(), DISPLAY_NAME, h.hash, h.salt, true, new Date()]]);
  audit_('system', 'ADMIN_FIRST_CREATED', USERNAME, '');
  Logger.log('สร้างแอดมิน ' + USERNAME + ' แล้ว — ลบรหัสผ่านออกจากโค้ดตอนนี้');
}

/** ผูกใบลาเก่าที่ยังไม่มี StaffID (ชื่อตรงกัน) เข้ากับพนักงานคนนี้ — เรียกภายใน withLock_ */
function linkLeaveToStaff_(staffId, name) {
  const sh = sheet_(CFG.SHEET.LEAVE), n = sh.getLastRow() - 1;
  if (n < 1) return 0;
  const key = normName_(name).toLowerCase();
  const names = sh.getRange(2, L.NAME + 1, n, 1).getValues();
  const range = sh.getRange(2, L.STAFFID + 1, n, 1);
  const cur = range.getValues();
  let c = 0;
  const out = cur.map((v, i) => {
    if (!v[0] && normName_(names[i][0]).toLowerCase() === key) { c++; return [staffId]; }
    return v;
  });
  if (c) range.setValues(out);
  return c;
}

/** คีย์เทียบชื่อ: ตัดคำนำหน้า (นาย/นางสาว/นาง/น.ส.) ช่องว่าง และตัวพิมพ์ */
function nameKey_(s) { return normName_(s).replace(/^(นางสาว|นาง|นาย|น\.ส\.|น\.ส|นส\.|นส)\s*/, '').replace(/\s+/g, '').toLowerCase(); }

/** หาพนักงานที่ชื่อซ้ำ (ไม่สนคำนำหน้า/ช่องว่าง/ตัวพิมพ์) รวมคนที่ปิดใช้งานอยู่ */
function findDupStaff_(name, exceptId, all) {
  const key = nameKey_(name);
  if (!key) return null;
  return (all || rows_(CFG.SHEET.STAFF, S.WIDTH))
    .find(r => r.row[S.ID] !== exceptId && nameKey_(r.row[S.NAME]) === key) || null;
}
function dupMsg_(r) {
  return 'มีชื่อนี้ในระบบแล้ว: "' + r.row[S.NAME] + '"' +
    (isTrue_(r.row[S.ACTIVE]) ? '' : ' (ปิดใช้งานอยู่ — ให้เปิดใช้งานคนเดิมแทนการเพิ่มใหม่)');
}

/** รันเองจากตัวแก้ไข (อ่านอย่างเดียว): ดูรายชื่อที่ซ้ำกันอยู่ตอนนี้ เพื่อเลือกลบ */
function previewDuplicateStaff() {
  const staff = rows_(CFG.SHEET.STAFF, S.WIDTH);
  const leaveCount = {};
  rows_(CFG.SHEET.LEAVE, L.WIDTH).forEach(r => { const id = r.row[L.STAFFID]; if (id) leaveCount[id] = (leaveCount[id] || 0) + 1; });
  const groups = {};
  staff.forEach(r => { const k = nameKey_(r.row[S.NAME]); if (k) (groups[k] = groups[k] || []).push(r); });
  const keys = Object.keys(groups).filter(k => groups[k].length > 1);
  if (!keys.length) { Logger.log('ไม่พบชื่อซ้ำ'); return; }
  Logger.log('พบชื่อซ้ำ ' + keys.length + ' กลุ่ม');
  keys.forEach((k, i) => {
    Logger.log('--- กลุ่ม ' + (i + 1));
    groups[k].forEach(r => Logger.log(
      'แถว ' + r.rowNum + ' | ' + r.row[S.ID] + ' | ' + r.row[S.NAME] + ' | ' + (isTrue_(r.row[S.ACTIVE]) ? 'ใช้งาน' : 'ปิดใช้งาน') +
      ' | PIN: ' + (r.row[S.PINCHANGED] ? 'เคยเปลี่ยนแล้ว' : 'ยังเป็นค่าเริ่มต้น') +
      ' | ใบลา ' + (leaveCount[r.row[S.ID]] || 0) + ' ใบ | ระบบ: ' + SYS_KEYS.filter(s => hasSys_(r.row, s)).join(',')));
  });
}

/** เขียนค่าลงคอลัมน์หนึ่ง (เริ่มแถว 2) แล้วอ่านกลับตรวจ: ถ้ารวดเดียวไม่ติด ลองชุดละ 25 แถว แล้วทีละช่อง */
function writeColumnVerified_(sh, col, values) {
  const n = values.length, rg = sh.getRange(2, col, n, 1);
  const same = () => {
    SpreadsheetApp.flush();
    const got = rg.getValues();
    for (let i = 0; i < n; i++) if (String(got[i][0]) !== String(values[i][0])) return false;
    return true;
  };
  rg.setValues(values);
  if (same()) return 'รวดเดียว';
  for (let s = 0; s < n; s += 25) sh.getRange(2 + s, col, Math.min(25, n - s), 1).setValues(values.slice(s, s + 25));
  if (same()) return 'ทีละ 25 แถว';
  for (let i = 0; i < n; i++) sh.getRange(2 + i, col).setValue(values[i][0]);
  return same() ? 'ทีละช่อง' : 'ไม่สำเร็จ';
}

/** ตัวช่วยร่วมของ preview/ซ่อมจริง: แก้ปีของวันที่เก่า, เติม LeaveID, เติมสถานะว่าง, ผูก StaffID จากชื่อ
 *  และ "ผูกใหม่" ถ้า StaffID ที่มีอยู่ไม่ตรงกับรหัสในชีต Staff แต่ชื่อตรงกับพนักงานคนใดคนหนึ่ง (เช่น รหัสที่เหลือจากการทดสอบระบบแยกโปรเจกต์) */
function repairLeave_(commit) {
  const sh = sheet_(CFG.SHEET.LEAVE);
  const n = sh.getLastRow() - 1;
  if (n < 1) { Logger.log('ไม่มีข้อมูลในชีต Leave'); return; }
  const data = sh.getRange(2, 1, n, L.WIDTH).getValues();
  const idByName = {}, valid = {};
  rows_(CFG.SHEET.STAFF, S.WIDTH).forEach(r => { idByName[nameKey_(r.row[S.NAME])] = r.row[S.ID]; valid[r.row[S.ID]] = true; });

  const dates = [], status = [], ids = [], staffIds = [];
  let yearFixed = 0, textFixed = 0, idAdded = 0, statusFixed = 0, linked = 0, relinked = 0;
  const badDates = [], unmatched = {};
  data.forEach((row, i) => {
    const s = toDate_(row[L.START]), e = toDate_(row[L.END]);
    if (!s || !e) badDates.push(i + 2);
    [row[L.START], row[L.END]].forEach(v => {
      if (v instanceof Date) { if (v.getFullYear() > 2400) yearFixed++; }
      else if (toDate_(v)) textFixed++;
    });
    dates.push([s || row[L.START], e || row[L.END]]);
    if (!row[L.STATUS]) statusFixed++;
    status.push([row[L.STATUS] || STATUS.PENDING]);
    if (!row[L.ID]) idAdded++;
    ids.push([row[L.ID] || Utilities.getUuid()]);
    let sid = row[L.STAFFID];
    const nm = normName_(row[L.NAME]);
    if (sid && !valid[sid]) {   // รหัสที่ไม่มีในชีต Staff: ผูกใหม่เฉพาะเมื่อชื่อตรงตัว ไม่เช่นนั้นคงรหัสเดิมไว้
      const alt = idByName[nameKey_(nm)];
      if (alt) { sid = alt; relinked++; }
    }
    if (!sid) {   // ผูกด้วยชื่อที่ตรงตัวหลังตัดคำนำหน้าเท่านั้น ไม่เดา
      if (idByName[nameKey_(nm)]) { sid = idByName[nameKey_(nm)]; linked++; }
      else if (nm) unmatched[nm] = (unmatched[nm] || 0) + 1;
    }
    staffIds.push([sid || '']);
  });

  if (commit) {
    fmt_(sh.getRange(2, L.START + 1, n, 2).setValues(dates), 'dd/mm/yyyy');
    sh.getRange(2, L.STATUS + 1, n, 1).setValues(status);
    sh.getRange(2, L.ID + 1, n, 1).setValues(ids);
    const how = writeColumnVerified_(sh, L.STAFFID + 1, staffIds);
    Logger.log('เขียน StaffID: ' + how);
    audit_('system', 'LEAVE_REPAIR', '', 'ปีที่แก้ ' + yearFixed + ', ข้อความ->วันที่ ' + textFixed + ', LeaveID ' + idAdded + ', ผูก StaffID ' + linked + ', ผูกใหม่ ' + relinked);
    SpreadsheetApp.flush();
    const cnt = col => sh.getRange(2, col + 1, n, 1).getValues().filter(v => v[0]).length;
    Logger.log('ตรวจหลังเขียน: มี LeaveID ' + cnt(L.ID) + '/' + n + ' แถว | มี StaffID ' + cnt(L.STAFFID) + '/' + n + ' แถว');
  }
  Logger.log((commit ? '[ซ่อมแล้ว] ' : '[ตัวอย่าง ยังไม่เขียนข้อมูล] ') + 'ทั้งหมด ' + n + ' แถว');
  Logger.log('- วันที่ที่ปีเป็น พ.ศ. (เช่น 2569) แล้วจะแก้เป็น ค.ศ.: ' + yearFixed + ' เซลล์');
  Logger.log('- วันที่เป็นข้อความแล้วจะแปลงเป็นวันที่จริง: ' + textFixed + ' เซลล์');
  Logger.log('- แถวที่จะเติม LeaveID: ' + idAdded + ' | เติมสถานะว่างเป็น Pending: ' + statusFixed);
  Logger.log('- แถวที่ผูก StaffID ได้ (ชื่อตรงกับ Staff): ' + linked + ' | แถวที่ผูกใหม่ (รหัสเดิมไม่มีในชีต Staff): ' + relinked);
  if (badDates.length) Logger.log('- แถวที่อ่านวันที่ไม่ได้ (ตรวจเอง): ' + badDates.join(', '));
  const un = Object.keys(unmatched);
  if (un.length) Logger.log('- ชื่อที่ยังไม่ตรงกับ Staff ' + un.length + ' ชื่อ (เพิ่มใน Staff หรือแก้การสะกดแล้วรันใหม่):\n' + un.map(k => k + ' (' + unmatched[k] + ' แถว)').join('\n'));
}

/** ขั้นที่ 1: ดูตัวอย่างผลการซ่อม (ไม่เขียนข้อมูล) */
function previewLeaveRepair() { repairLeave_(false); }

/**
 * ขั้นที่ 2: ซ่อมข้อมูลเก่าจริง — เปลี่ยน ENABLED เป็น true -> รัน -> เปลี่ยนกลับเป็น false
 * *** ทำสำเนาไฟล์ชีตก่อนรันเสมอ (File > Make a copy) *** รันซ้ำได้ ไม่ทับค่าที่มีอยู่แล้ว
 */
function migrateLegacyLeaveData() {
  const ENABLED = false;
  if (!ENABLED) { Logger.log('ยังไม่เปิดใช้งาน: แก้ ENABLED เป็น true ก่อนรันจริง'); return; }
  withLock_(() => repairLeave_(true));
}

// ===================== นำเข้ารายชื่อพนักงานจากชีต Leave (รันเองจากตัวแก้ไข) =====================
function normName_(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
function posKey_(s) { return String(s == null ? '' : s).replace(/\s+/g, ''); }

/** วางแผนการนำเข้า (ไม่เขียนอะไรลงชีต) */
function planStaffImport_() {
  const ACTIVE_WITHIN_DAYS = 180;  // คนที่ไม่มีใบลาเลยในช่วงนี้ จะถูกนำเข้าเป็น "ปิดใช้งาน"
  const posMap = {};
  POSITIONS.forEach(p => { posMap[posKey_(p)] = p; });

  const known = {};  // ชื่อ (ปรับรูปแบบแล้ว) -> StaffID ของคนที่มีใน Staff อยู่แล้ว
  rows_(CFG.SHEET.STAFF, S.WIDTH).forEach(r => { known[nameKey_(r.row[S.NAME])] = r.row[S.ID]; });

  const found = {};
  rows_(CFG.SHEET.LEAVE, L.WIDTH).forEach(r => {
    const name = clean_(normName_(r.row[L.NAME]), 80);
    if (name.length < 2) return;
    const key = nameKey_(name);
    const f = found[key] || (found[key] = { name: name, last: null, posRaw: '' });
    f.name = name; 
    const ts = r.row[L.TS] instanceof Date ? r.row[L.TS] : null;
    if (ts && (!f.last || ts > f.last)) f.last = ts;
  });

  const cutoff = addDays_(today_(), -ACTIVE_WITHIN_DAYS);
  const toAdd = [], noPos = [];
  let existingCount = 0;
  Object.keys(found).forEach(key => {
    const f = found[key];
    if (known[key]) { existingCount++; return; }
    const pos = posMap[posKey_(f.posRaw)];
    if (!pos) { noPos.push(f.name + '  (ตำแหน่งในชีต: ' + f.posRaw + ')'); return; }
    toAdd.push({ name: f.name, position: pos, active: !f.last || f.last >= cutoff });
  });
  return { toAdd: toAdd, noPos: noPos, existingCount: existingCount, totalFound: Object.keys(found).length, known: known };
}

/** ขั้นที่ 1: ดูตัวอย่างว่าจะนำเข้าใครบ้าง (ไม่เขียนข้อมูล) ดูผลที่ Execution log */
function previewStaffFromLeave() {
  const p = planStaffImport_();
  Logger.log('พบชื่อไม่ซ้ำใน Leave ' + p.totalFound + ' คน | มีใน Staff แล้ว ' + p.existingCount + ' | จะเพิ่ม ' + p.toAdd.length + ' คน');
  p.toAdd.forEach(a => Logger.log((a.active ? '[ใช้งาน] ' : '[ปิดใช้งาน] ') + a.name + ' | ' + a.position));
  if (p.noPos.length) Logger.log('ข้าม ' + p.noPos.length + ' คน (ตำแหน่งไม่ตรงรายการ ให้เพิ่มเองในหน้า Admin):\n' + p.noPos.join('\n'));
}

/**
 * ขั้นที่ 2: นำเข้าจริง — เปลี่ยน ENABLED เป็น true -> รัน -> เปลี่ยนกลับเป็น false
 * (กันไม่ให้ใครเรียกฟังก์ชันนี้จากหน้าเว็บได้)
 */
function importStaffFromLeave() {
  const ENABLED = false;
  if (!ENABLED) { Logger.log('ยังไม่เปิดใช้งาน: แก้ ENABLED เป็น true ก่อนรันจริง'); return; }

  withLock_(() => {
    const p = planStaffImport_();
    const now = new Date();
    const newRows = p.toAdd.map(a => {
      const h = makeHash_(CFG.DEFAULT_PIN);
      return ['S' + Utilities.getUuid().slice(0, 8), a.name, a.position, h.hash, h.salt, true, a.active, now, ''].concat(newStaffSys_());
    });
    if (newRows.length) {
      const sh = sheet_(CFG.SHEET.STAFF);
      sh.getRange(sh.getLastRow() + 1, 1, newRows.length, S.WIDTH).setValues(newRows);
    }

    // เติม StaffID ให้ใบลาเก่า (ถ้าว่าง) เพื่อให้ประวัติเดิมผูกกับพนักงานแต่ละคน
    const idByName = {};
    Object.keys(p.known).forEach(k => { idByName[k] = p.known[k]; });
    newRows.forEach(r => { idByName[nameKey_(r[S.NAME])] = r[S.ID]; });
    const lsh = sheet_(CFG.SHEET.LEAVE);
    const n = lsh.getLastRow() - 1;
    let filled = 0;
    if (n > 0) {
      const idRange = lsh.getRange(2, L.STAFFID + 1, n, 1);
      const cur = idRange.getValues();
      const names = lsh.getRange(2, L.NAME + 1, n, 1).getValues();
      idRange.setValues(cur.map((c, i) => {
        if (c[0]) return c;
        const id = idByName[nameKey_(clean_(names[i][0], 80))];
        if (id) { filled++; return [id]; }
        return c;
      }));
    }
    audit_('system', 'STAFF_IMPORT_FROM_LEAVE', '', 'เพิ่ม ' + newRows.length + ' คน, เติม StaffID ' + filled + ' แถว');
    Logger.log('นำเข้าแล้ว ' + newRows.length + ' คน | เติม StaffID ในใบลาเก่า ' + filled + ' แถว | ข้าม ' + p.noPos.length + ' คน (ตำแหน่งไม่ตรง)');
    if (p.noPos.length) Logger.log(p.noPos.join('\n'));
  });
}

/**
 * ใช้เฉพาะกรณีสร้าง PEPPER ใหม่ (คีย์เดิมหาย) ทำให้ PIN เดิมของทุกคนใช้ไม่ได้:
 * รีเซ็ต PIN ของพนักงานทุกคนเป็นค่าเริ่มต้น + บังคับตั้งใหม่ตอนเข้าครั้งแรก
 * เปลี่ยน ENABLED เป็น true -> รัน -> เปลี่ยนกลับเป็น false (ผู้ดูแล: ลบแถวในชีต Admins แล้วรัน setupFirstAdmin ใหม่)
 */
function resetAllStaffPins() {
  const ENABLED = false;
  if (!ENABLED) { Logger.log('ยังไม่เปิดใช้งาน: แก้ ENABLED เป็น true ก่อนรันจริง'); return; }
  withLock_(() => {
    const sh = sheet_(CFG.SHEET.STAFF), all = rows_(CFG.SHEET.STAFF, S.WIDTH);
    all.forEach(r => {
      const h = makeHash_(CFG.DEFAULT_PIN);
      sh.getRange(r.rowNum, S.HASH + 1, 1, 2).setValues([[h.hash, h.salt]]);
      sh.getRange(r.rowNum, S.MUST + 1).setValue(true);
    });
    audit_('system', 'ALL_PINS_RESET', '', 'รีเซ็ต ' + all.length + ' คน');
    Logger.log('รีเซ็ต PIN ของพนักงาน ' + all.length + ' คนแล้ว');
  });
}

// ===================== คำขอเข้าใช้งาน (พนักงานขอเพิ่มชื่อเอง) =====================
const R = { ID: 0, NAME: 1, POS: 2, CONTACT: 3, STATUS: 4, TS: 5, BY: 6, AT: 7, STAFFID: 8, NOTE: 9, WIDTH: 10 };

function pendingRequestCount_() {
  try { return rows_(CFG.SHEET.REQUESTS, R.WIDTH).filter(r => r.row[R.STATUS] === STATUS.PENDING).length; } catch (e) { return 0; }
}

/** เพิ่มพนักงานใหม่ (PIN เริ่มต้น + บังคับเปลี่ยน) — ต้องเรียกภายใน withLock_ */
function addStaffRow_(name, position) {
  const key = normName_(name).toLowerCase();
  const dup = findDupStaff_(name, ''); if (dup) fail_(dupMsg_(dup), 'DUP_NAME');
  const id = 'S' + Utilities.getUuid().slice(0, 8);
  const h = makeHash_(CFG.DEFAULT_PIN);
  const sh = sheet_(CFG.SHEET.STAFF);
  sh.getRange(sh.getLastRow() + 1, 1, 1, S.WIDTH).setValues([[id, name, position, h.hash, h.salt, true, true, new Date(), ''].concat(newStaffSys_())]);
  linkLeaveToStaff_(id, name);
  return id;
}

/** สาธารณะ (ไม่ต้องล็อกอิน): พนักงานส่งคำขอเพิ่มชื่อ — จำกัดอัตราและจำนวนคำขอค้างเพื่อกัน spam */
function requestStaffAccess(name, position, contact) {
  return api_(() => {
    name = clean_(normName_(name), 80);
    contact = clean_(contact, 100);
    if (name.length < 2) fail_('กรุณากรอกชื่อ-นามสกุล');
    if (POSITIONS.indexOf(position) < 0) fail_('กรุณาเลือกตำแหน่ง');
    const cache = CacheService.getScriptCache();
    const n = Number(cache.get('REQCOUNT') || 0);
    if (n >= 15) fail_('มีคำขอเข้ามาจำนวนมากในช่วงนี้ กรุณาลองใหม่ภายหลัง หรือติดต่อผู้ดูแลโดยตรง', 'LOCKED');
    let ntf = '';
    const res = withLock_(() => {
      const key = nameKey_(name);
      const exists = !!findDupStaff_(name, '');
      const reqs = rows_(CFG.SHEET.REQUESTS, R.WIDTH).filter(r => r.row[R.STATUS] === STATUS.PENDING);
      if (exists || reqs.some(r => nameKey_(r.row[R.NAME]) === key)) {
        fail_('ชื่อนี้มีอยู่ในระบบหรือกำลังรอการอนุมัติอยู่แล้ว ถ้าเข้าสู่ระบบไม่ได้ กรุณาติดต่อผู้ดูแล');
      }
      if (reqs.length >= 50) fail_('มีคำขอรออนุมัติจำนวนมาก กรุณาติดต่อผู้ดูแลโดยตรง', 'LOCKED');
      const id = Utilities.getUuid();
      const sh = sheet_(CFG.SHEET.REQUESTS);
      sh.getRange(sh.getLastRow() + 1, 1, 1, R.WIDTH).setValues([[id, name, position, contact, STATUS.PENDING, new Date(), '', '', '', '']]);
      cache.put('REQCOUNT', String(n + 1), 3600);
      audit_('public', 'STAFF_REQUEST', id, name);
      ntf = '🙋 คำขอเข้าใช้งานระบบใหม่\n' + name + ' (' + position + ')\nรอผู้ดูแลอนุมัติใน Admin Center';
      return { message: 'ส่งคำขอเรียบร้อยแล้ว กรุณารอผู้ดูแลอนุมัติ จากนั้นเข้าสู่ระบบด้วย PIN ที่ผู้ดูแลแจ้ง' };
    });
    if (ntf) lineNotify_('request', ntf);
    return res;
  });
}

function adminListRequests(token, status) {
  return api_(() => {
    requireAdmin_(token);
    const all = status === 'all';
    const list = rows_(CFG.SHEET.REQUESTS, R.WIDTH).reverse()
      .filter(r => all || r.row[R.STATUS] === STATUS.PENDING)
      .slice(0, 200)
      .map(r => ({ id: r.row[R.ID], name: String(r.row[R.NAME]), position: String(r.row[R.POS]), contact: String(r.row[R.CONTACT] || ''),
                   status: String(r.row[R.STATUS]), ts: tsStr_(r.row[R.TS]), by: String(r.row[R.BY] || ''), at: tsStr_(r.row[R.AT]), note: String(r.row[R.NOTE] || '') }));
    return { rows: list };
  });
}

function adminDecideRequest(token, requestId, decision, note) {
  return api_(() => {
    const adm = requireAdmin_(token);
    if ([STATUS.APPROVED, STATUS.REJECTED].indexOf(decision) < 0) fail_('คำสั่งไม่ถูกต้อง');
    note = clean_(note, 200);
    return withLock_(() => {
      const f = rows_(CFG.SHEET.REQUESTS, R.WIDTH).find(r => r.row[R.ID] === String(requestId || ''));
      if (!f) fail_('ไม่พบคำขอ');
      if (f.row[R.STATUS] !== STATUS.PENDING) fail_('คำขอนี้ถูกดำเนินการแล้ว กรุณารีเฟรช', 'STALE');
      const staffId = decision === STATUS.APPROVED ? addStaffRow_(f.row[R.NAME], f.row[R.POS]) : '';
      const sh = sheet_(CFG.SHEET.REQUESTS);
      sh.getRange(f.rowNum, R.STATUS + 1).setValue(decision);
      sh.getRange(f.rowNum, R.BY + 1, 1, 3).setValues([[adm.display, new Date(), staffId]]);
      sh.getRange(f.rowNum, R.NOTE + 1).setValue(note);
      audit_('admin:' + adm.username, 'REQUEST_' + decision.toUpperCase(), f.row[R.ID], f.row[R.NAME]);
      return { message: decision === STATUS.APPROVED
        ? 'เพิ่ม "' + f.row[R.NAME] + '" เข้าระบบแล้ว PIN เริ่มต้น ' + CFG.DEFAULT_PIN + ' กรุณาแจ้งผู้ขอ'
        : 'ปฏิเสธคำขอแล้ว' };
    });
  });
}

/** ปฏิเสธคำขอเข้าใช้งานที่ค้างทั้งหมดในครั้งเดียว (ล้างสแปม) และรีเซ็ตตัวนับอัตราคำขอ */
function adminClearRequests(token) {
  return api_(() => {
    const adm = requireAdmin_(token);
    return withLock_(() => {
      const pend = rows_(CFG.SHEET.REQUESTS, R.WIDTH).filter(r => r.row[R.STATUS] === STATUS.PENDING);
      const sh = sheet_(CFG.SHEET.REQUESTS), now = new Date();
      pend.forEach(f => {
        sh.getRange(f.rowNum, R.STATUS + 1).setValue(STATUS.REJECTED);
        sh.getRange(f.rowNum, R.BY + 1, 1, 3).setValues([[adm.display, now, '']]);
        sh.getRange(f.rowNum, R.NOTE + 1).setValue('ล้างคำขอค้างโดยผู้ดูแล');
      });
      CacheService.getScriptCache().remove('REQCOUNT');
      audit_('admin:' + adm.username, 'REQUEST_CLEAR', String(pend.length), '');
      return { message: pend.length ? 'ล้างคำขอที่ค้าง ' + pend.length + ' รายการแล้ว' : 'ไม่มีคำขอที่ค้างอยู่' };
    });
  });
}

// ===================== รายงาน / สรุปการลา =====================
function range_(from, to) {
  const f = parseYmd_(from), t = parseYmd_(to);
  if (t < f) fail_('ช่วงวันที่ไม่ถูกต้อง');
  if ((t - f) / 86400000 > 800) fail_('ช่วงวันที่ยาวเกินไป');
  return { f: ymd_(f), t: ymd_(t) };
}
function numDays_(d) { return Number(d.days) || 0; }
function sumDays_(arr) { return arr.reduce((a, d) => a + numDays_(d), 0); }
function inRange_(d, r) { return !!d.start && d.start >= r.f && d.start <= r.t; }  // นับตามวันแรกที่ลา
function typeLabels_(list) {
  const labels = LEAVE_TYPES.map(t => t[1]);
  list.forEach(d => { if (labels.indexOf(d.type) < 0) labels.push(d.type); });
  return labels;
}

/** สรุปการลาของตัวเอง (พนักงาน) */
function getMySummary(token, from, to) {
  return api_(() => {
    const me = requireStaff_(token, false);
    const r = range_(from, to);
    const mine = rows_(CFG.SHEET.LEAVE, L.WIDTH)
      .filter(x => isOwn_(x.row, me.row[S.ID], me.row[S.NAME])).map(leaveDto_).filter(d => inRange_(d, r));
    const types = typeLabels_(mine).map(l => ({
      label: l,
      approved: sumDays_(mine.filter(d => d.type === l && d.status === STATUS.APPROVED)),
      pending: sumDays_(mine.filter(d => d.type === l && d.status === STATUS.PENDING))
    }));
    return { types: types, requests: mine.length,
             approvedTotal: types.reduce((a, t) => a + t.approved, 0), pendingTotal: types.reduce((a, t) => a + t.pending, 0) };
  });
}

/** แดชบอร์ด + สรุปรายบุคคล (แอดมิน) */
function adminReport(token, from, to) {
  return api_(() => {
    requireAdmin_(token);
    const r = range_(from, to);
    const all = rows_(CFG.SHEET.LEAVE, L.WIDTH).map(leaveDto_);
    const list = all.filter(d => inRange_(d, r));
    const labels = typeLabels_(list);
    const approved = list.filter(d => d.status === STATUS.APPROVED);

    const byType = labels.map(l => ({ label: l, days: sumDays_(approved.filter(d => d.type === l)) }));

    const byMonth = [];
    const cur = parseYmd_(r.f); cur.setDate(1);
    const end = parseYmd_(r.t);
    while (cur <= end) {
      const key = cur.getFullYear() + '-' + pad_(cur.getMonth() + 1);
      byMonth.push({ month: key, days: sumDays_(approved.filter(d => d.start.slice(0, 7) === key)) });
      cur.setMonth(cur.getMonth() + 1);
    }

    const staffRows = rows_(CFG.SHEET.STAFF, S.WIDTH);
    const nameToId = {};
    staffRows.forEach(s => { nameToId[normName_(s.row[S.NAME]).toLowerCase()] = s.row[S.ID]; });
    const people = {};
    staffRows.forEach(s => {
      if (isTrue_(s.row[S.ACTIVE])) people[s.row[S.ID]] = { name: s.row[S.NAME], position: s.row[S.POS], days: {}, approved: 0, pending: 0, requests: 0 };
    });
    list.forEach(d => {
      const k = d.staffId || nameToId[normName_(d.name).toLowerCase()] || ('n:' + normName_(d.name).toLowerCase());
      const p = people[k] || (people[k] = { name: d.name, position: d.position, days: {}, approved: 0, pending: 0, requests: 0 });
      p.requests++;
      if (d.status === STATUS.APPROVED) { p.days[d.type] = (p.days[d.type] || 0) + numDays_(d); p.approved += numDays_(d); }
      else if (d.status === STATUS.PENDING) p.pending += numDays_(d);
    });
    const peopleList = Object.keys(people).map(k => {
      const p = people[k];
      return { name: String(p.name), position: String(p.position), byType: labels.map(l => p.days[l] || 0), approved: p.approved, pending: p.pending, requests: p.requests };
    }).sort((a, b) => b.approved - a.approved || String(a.name).localeCompare(String(b.name), 'th'));

    const today = ymd_(today_()), horizon = ymd_(addDays_(today_(), 14));
    const brief = d => ({ name: d.name, type: d.type, start: d.start, end: d.end, days: d.days, status: d.status });
    const onLeave = all.filter(d => d.status === STATUS.APPROVED && d.start <= today && d.end >= today).slice(0, 60).map(brief);
    const upcoming = all.filter(d => (d.status === STATUS.APPROVED || d.status === STATUS.PENDING) && d.start > today && d.start <= horizon)
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)).slice(0, 60).map(brief);

    return { labels: labels, byType: byType, byMonth: byMonth, people: peopleList, onLeave: onLeave, upcoming: upcoming,
             totals: { requests: list.length, approvedDays: sumDays_(approved),
                       pendingNow: all.filter(d => d.status === STATUS.PENDING).length, onLeaveToday: onLeave.length } };
  });
}

/** รายการลาทั้งหมดในช่วงเวลา สำหรับส่งออก CSV */
function adminExportRows(token, from, to) {
  return api_(() => {
    requireAdmin_(token);
    const r = range_(from, to);
    const list = rows_(CFG.SHEET.LEAVE, L.WIDTH).map(leaveDto_).filter(d => inRange_(d, r))
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    return { total: list.length, rows: list.slice(0, 5000) };
  });
}

// ===================== ตารางการลาของทั้งหน่วย (พนักงานที่ล็อกอินแล้วดูได้) =====================
/** คืนเฉพาะข้อมูลที่จำเป็น: ไม่ส่งตำแหน่ง หมายเหตุ หรือผู้อนุมัติของคนอื่น แบ่งหน้าและค้นหาที่ server */
function getAllLeaves(token, filter) {
  return api_(() => {
    const me = requireStaff_(token, false);
    filter = filter || {};
    const status = [STATUS.PENDING, STATUS.APPROVED, STATUS.REJECTED].indexOf(filter.status) >= 0 ? filter.status : 'all';
    const q = clean_(filter.q, 50).toLowerCase();
    const size = [10, 25, 50, 100].indexOf(Number(filter.pageSize)) >= 0 ? Number(filter.pageSize) : 25;
    const sickLabel = LEAVE_TYPES.find(t => t[0] === 'sick')[1];

    const list = rows_(CFG.SHEET.LEAVE, L.WIDTH).reverse()
      .map(r => ({ d: leaveDto_(r), mine: isOwn_(r.row, me.row[S.ID], me.row[S.NAME]) }))
      .filter(x => x.d.status !== STATUS.CANCELLED &&
                   (status === 'all' || x.d.status === status) &&
                   (!q || x.d.name.toLowerCase().indexOf(q) >= 0 || x.d.type.toLowerCase().indexOf(q) >= 0));

    const pages = Math.max(1, Math.ceil(list.length / size));
    const page = Math.min(Math.max(1, Math.floor(Number(filter.page)) || 1), pages);
    const rows = list.slice((page - 1) * size, page * size).map(x => ({
      name: x.d.name,
      type: (CFG.MASK_SICK_FOR_OTHERS && !x.mine && x.d.type === sickLabel) ? 'ลา' : x.d.type,
      start: x.d.start, end: x.d.end, days: x.d.days, status: x.d.status, ts: x.d.ts, mine: x.mine
    }));
    return { rows: rows, total: list.length, page: page, pages: pages };
  });
}

/** ตรวจสอบ (อ่านอย่างเดียว): หัวคอลัมน์ A-M และจำนวนค่าในคอลัมน์ LeaveID/StaffID ดูผลที่ Execution log */
function checkLeaveColumns() {
  const sh = sheet_(CFG.SHEET.LEAVE), n = sh.getLastRow() - 1;
  Logger.log('หัวตาราง A1:M1 = ' + JSON.stringify(sh.getRange(1, 1, 1, L.WIDTH).getValues()[0]));
  if (n < 1) { Logger.log('ไม่มีแถวข้อมูล'); return; }
  const d = sh.getRange(2, 1, n, L.WIDTH).getValues();
  const cnt = i => d.filter(r => r[i] !== '' && r[i] != null).length;
  Logger.log('แถวข้อมูล ' + n + ' | มี LeaveID ' + cnt(L.ID) + ' | มี StaffID ' + cnt(L.STAFFID) + ' | มีสถานะ ' + cnt(L.STATUS));
  Logger.log('ตัวอย่างแถวที่ 2 (คอลัมน์ H-M): ' + JSON.stringify(d[0].slice(L.STATUS, L.WIDTH)));
  Logger.log('ตัวอย่างแถวสุดท้าย (คอลัมน์ H-M): ' + JSON.stringify(d[n - 1].slice(L.STATUS, L.WIDTH)));
}

/**
 * ฟังก์ชันปรับปรุง StaffID ย้อนหลังในชีต Leave ให้ตรงกับ StaffID ที่เปิดใช้งาน (TRUE) ในชีต Staff
 * *** เขียนทับ StaffID ของใบลาด้วยการเทียบชื่อแบบหลวม จึงมีตัวกัน: เปลี่ยน ENABLED เป็น true เฉพาะตอนรันเอง แล้วเปลี่ยนกลับ ***
 */
function fixLegacyLeaveStaffIds() {
  const ENABLED = false;
  if (!ENABLED) { Logger.log('ยังไม่เปิดใช้งาน: แก้ ENABLED เป็น true ก่อนรันจริง'); return; }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const staffSheet = ss.getSheetByName(CFG.SHEET.STAFF || 'Staff');
  const leaveSheet = ss.getSheetByName(CFG.SHEET.LEAVE || 'Leave');

  if (!staffSheet || !leaveSheet) return;

  // Helper สำหรับล้างคำนำหน้า อักขระซ่อน และเว้นวรรค
  function cleanName(rawName) {
    if (!rawName) return '';
    let name = String(rawName).trim();
    name = name.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '');
    name = name.replace(/^(นาย|นางสาว|นาง|น\.ส\.|น\.ส)\s*/g, '');
    name = name.replace(/\s+/g, '');
    return name.toLowerCase();
  }

  // 1. อ่านชีต Staff
  const staffData = staffSheet.getDataRange().getValues();
  const validStaffMap = {};      // Map ชื่อเต็ม
  const validStaffList = [];     // Array ไว้ค้นหาแบบ Partial Match

  // วนลูปเริ่มจาก index 1 (บรรทัดที่ 2 ใน Sheet)
  for (let i = 1; i < staffData.length; i++) {
    const row = staffData[i];
    const staffId = String(row[0]).trim();
    const rawName = String(row[1]).trim();
    const colG = String(row[6]).trim().toUpperCase(); // คอลัมน์ G
    const colF = String(row[5]).trim().toUpperCase(); // คอลัมน์ F

    // ยืดหยุ่น: ถ้านับเป็น TRUE ใน Col G หรือ Col F หรือถ้าเป็นแถวที่ 1 (อรพรรณ) ให้ดึงแน่นอน
    const isGTrue = (colG === 'TRUE' || colG === '1') || (i === 1 && colF === 'TRUE');

    const cleaned = cleanName(rawName);

    if (cleaned && isGTrue) {
      validStaffMap[cleaned] = staffId;
      validStaffList.push({ cleaned: cleaned, staffId: staffId });
    }
  }

  // 2. อ่านชีต Leave
  const leaveLastRow = leaveSheet.getLastRow();
  if (leaveLastRow < 2) return;

  const leaveNames = leaveSheet.getRange(2, 2, leaveLastRow - 1, 1).getValues();
  const leaveStaffIds = leaveSheet.getRange(2, 13, leaveLastRow - 1, 1).getValues();

  let updatedCount = 0;
  let notFoundList = [];

  for (let i = 0; i < leaveNames.length; i++) {
    const rawLeaveName = leaveNames[i][0];
    const currentStaffId = leaveStaffIds[i][0];
    const cleanedLeaveName = cleanName(rawLeaveName);

    if (!cleanedLeaveName) continue;

    let correctStaffId = validStaffMap[cleanedLeaveName];

    // หากค้นหาตรงๆ ไม่เจอ ให้ลองค้นแบบ Partial Match
    if (!correctStaffId) {
      const match = validStaffList.find(s =>
        s.cleaned.includes(cleanedLeaveName) || cleanedLeaveName.includes(s.cleaned.substring(0, 6))
      );
      if (match) {
        correctStaffId = match.staffId;
      }
    }

    if (correctStaffId) {
      if (currentStaffId !== correctStaffId) {
        leaveStaffIds[i][0] = correctStaffId;
        updatedCount++;
      }
    } else {
      notFoundList.push(`แถวที่ ${i + 2}: ${rawLeaveName}`);
    }
  }

  // 3. บันทึกผลกลับชีต Leave
  if (updatedCount > 0) {
    leaveSheet.getRange(2, 13, leaveStaffIds.length, 1).setValues(leaveStaffIds);
  }

  Logger.log(`=== สรุปการแก้ไข ===`);
  Logger.log(`อัปเดตเพิ่มอีก: ${updatedCount} รายการ`);
  if (notFoundList.length > 0) {
    Logger.log(`คงเหลือที่ไม่พบ (อาจต้องเช็กใน Sheet หรือตั้งค่า G=TRUE): \n` + notFoundList.join('\n'));
  } else {
    Logger.log(`จับคู่สำเร็จครบ 100% ทุกแถวเรียบร้อยแล้ว!`);
  }
}

// ===================== ลบพนักงาน / ตารางสรุปการลารายเดือน =====================
/** ลบพนักงานออกจากชีต Staff (ประวัติการลาและ StaffID ในใบลายังอยู่ เพื่อให้ตารางสรุปยังนับของเดิมได้) */
function adminDeleteStaff(token, staffId) {
  return api_(() => {
    const adm = requireAdmin_(token);
    const id = String(staffId || '').trim();
    return withLock_(() => {
      const f = findStaff_(id);
      if (!f) fail_('ไม่พบพนักงานคนนี้');
      const hasPending = rows_(CFG.SHEET.LEAVE, L.WIDTH).some(r =>
        (r.row[L.STATUS] || STATUS.PENDING) === STATUS.PENDING && isOwn_(r.row, id, f.row[S.NAME]));
      if (hasPending) fail_('พนักงานคนนี้ยังมีใบลารออนุมัติ กรุณาอนุมัติหรือปฏิเสธก่อนลบ');
      sheet_(CFG.SHEET.STAFF).deleteRow(f.rowNum);
      audit_('admin:' + adm.username, 'STAFF_DELETE', id, String(f.row[S.NAME]));
      return { message: 'ลบ "' + f.row[S.NAME] + '" ออกจากรายชื่อแล้ว ประวัติการลายังอยู่' };
    });
  });
}

/**
 * ตารางสรุปการลารายเดือน (แอดมินเท่านั้น) คืนสัญลักษณ์ V/P/S/F/O ต่อวันของพนักงานแต่ละคน
 * ลาพักร้อน/ลากิจ/ลาป่วย นับเฉพาะวันทำงาน (ข้ามเสาร์-อาทิตย์และวันหยุด) ตรงกับจำนวนวันที่บันทึกไว้
 */
/** ปฏิทินการลาของทั้งหน่วยรายเดือน (มุมมองพนักงาน): ใบที่อนุมัติแล้ว + รออนุมัติ (ติดธง p) — ไม่รวมไม่อนุมัติ/ยกเลิก
 *  คืน days = { "5": [{ n: ชื่อจริง, s: V|P|S|O|L, p: 0|1, m: 0|1 }] }  (m = ของฉัน, L = ลาทั่วไปเมื่อซ่อนประเภทลาป่วย) */
function getStaffCalendar(token, month, year) {
  return api_(() => {
    const me = requireStaff_(token, false);
    const ym = monthArgs_(month, year);
    const first = new Date(ym.y, ym.m - 1, 1), last = new Date(ym.y, ym.m, 0);
    const hol = holidaySet_();
    const TITLES = /^(นางสาว|นาง|นาย|น\.ส\.|ทนพญ\.|ทนพ\.|ดร\.|พญ\.|นพ\.|ผศ\.|รศ\.|ศ\.)\s*/;
    const parts = {};
    rows_(CFG.SHEET.STAFF, S.WIDTH).forEach(r => {
      const t = String(r.row[S.NAME] || '').trim().replace(TITLES, '').split(/\s+/);
      parts[String(r.row[S.ID])] = { first: t[0] || String(r.row[S.NAME]), last: t.slice(1).join(' '), key: normName_(r.row[S.NAME]).toLowerCase() };
    });
    const cnt = {}; Object.keys(parts).forEach(id => { cnt[parts[id].first] = (cnt[parts[id].first] || 0) + 1; });
    const nameToId = {}; Object.keys(parts).forEach(id => { nameToId[parts[id].key] = id; });
    const label = id => { const p = parts[id]; return cnt[p.first] > 1 && p.last ? p.first + ' ' + p.last.charAt(0) + '.' : p.first; };
    const days = {};
    rows_(CFG.SHEET.LEAVE, L.WIDTH).forEach(r => {
      const row = r.row, status = String(row[L.STATUS] || STATUS.PENDING);
      if (status !== STATUS.APPROVED && status !== STATUS.PENDING) return;
      let sym = symbolOfLeave_(String(row[L.TYPE] || ''));
      const s = toDate_(row[L.START]), e = toDate_(row[L.END]);
      if (!sym || sym === 'F' || !s || !e || e < first || s > last) return;
      const id = String(row[L.STAFFID] || '') || nameToId[normName_(row[L.NAME]).toLowerCase()];
      if (!id || !parts[id]) return;
      const mine = id === String(me.row[S.ID]);
      if (CFG.MASK_SICK_FOR_OTHERS && !mine && sym === 'S') sym = 'L';
      const workingOnly = sym === 'V' || sym === 'P' || sym === 'S' || sym === 'L';
      for (let d = new Date(s > first ? s : first); d <= (e < last ? e : last); d.setDate(d.getDate() + 1)) {
        const w = d.getDay();
        if (workingOnly && (w === 0 || w === 6 || hol[ymd_(d)])) continue;
        (days[d.getDate()] || (days[d.getDate()] = [])).push({ n: label(id), s: sym, p: status === STATUS.PENDING ? 1 : 0, m: mine ? 1 : 0 });
      }
    });
    const holidays = []; for (let d = 1; d <= last.getDate(); d++) if (hol[ymd_(new Date(ym.y, ym.m - 1, d))]) holidays.push(d);
    return { month: ym.m, year: ym.y, daysInMonth: last.getDate(), days: days, holidays: holidays };
  });
}

function getMonthlyLeaveMatrix(token, month, year) {
  return api_(() => {
    requireAdmin_(token);
    const ym = monthArgs_(month, year);
    const staffs = rows_(CFG.SHEET.STAFF, S.WIDTH).filter(r => isTrue_(r.row[S.ACTIVE]))
      .map(r => ({ id: String(r.row[S.ID]), name: String(r.row[S.NAME]) }));
    const leaveMap = buildLeaveMap_(ym.y, ym.m);
    lateRows_().forEach(r => {
      const d = toDate_(r.row[LT.DATE]);
      const id = String(r.row[LT.STAFFID] || '');
      if (!d || !id || d.getFullYear() !== ym.y || d.getMonth() !== ym.m - 1) return;
      const map = leaveMap[id] || (leaveMap[id] = {});
      if (!map[d.getDate()]) map[d.getDate()] = 'F';
    });
    return { month: ym.m, year: ym.y, daysInMonth: new Date(ym.y, ym.m, 0).getDate(), staffs: staffs, leaveMap: leaveMap };
  });
}

// ===================== บันทึกมาสาย / ขาดเวร (F) โดยแอดมิน — ชีต "Arrive late" =====================
const LT = { ID: 0, STAFFID: 1, NAME: 2, DATE: 3, NOTE: 4, BY: 5, AT: 6, WIDTH: 7 };
const LATE_HEADERS = ['RecordID', 'StaffID', 'ชื่อ-นามสกุล', 'วันที่', 'หมายเหตุ', 'บันทึกโดย', 'บันทึกเมื่อ'];

function lateSheet_(create) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CFG.SHEET.LATE);
  if (!sh && create) {
    sh = ss.insertSheet(CFG.SHEET.LATE);
    sh.getRange(1, 1, 1, LATE_HEADERS.length).setValues([LATE_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function lateRows_() {
  const sh = lateSheet_(false);
  if (!sh || sh.getLastRow() < 2) return [];
  const cols = Math.max(1, Math.min(LT.WIDTH, sh.getLastColumn()));
  return sh.getRange(2, 1, sh.getLastRow() - 1, cols).getValues().map((row, i) => {
    while (row.length < LT.WIDTH) row.push('');
    return { rowNum: i + 2, row: row };
  });
}

/** วันที่มาสายที่บันทึกไว้ของพนักงานคนนี้ในเดือนนั้น + วันที่มีใบลาอนุมัติ (ใช้ล็อกปฏิทิน) */
function adminGetLate(token, staffId, month, year) {
  return api_(() => {
    requireAdmin_(token);
    const ym = monthArgs_(month, year);
    const id = String(staffId || '');
    if (!findStaff_(id)) fail_('ไม่พบพนักงาน');
    const records = [];
    lateRows_().forEach(r => {
      if (String(r.row[LT.STAFFID]) !== id) return;
      const d = toDate_(r.row[LT.DATE]);
      if (d && d.getFullYear() === ym.y && d.getMonth() === ym.m - 1) records.push({ day: d.getDate(), note: String(r.row[LT.NOTE] || '') });
    });
    return { records: records,
             leaveDays: Object.keys(buildLeaveMap_(ym.y, ym.m)[id] || {}).map(Number),
             daysInMonth: new Date(ym.y, ym.m, 0).getDate() };
  });
}

/** บันทึกวันมาสายของพนักงานคนนี้ทั้งเดือน: days = วันที่ที่ติ๊กไว้ทั้งหมด (เพิ่มวันใหม่ และลบวันที่เอาติ๊กออก) */
function adminSaveLateMonth(token, staffId, month, year, days, note) {
  return api_(() => {
    const adm = requireAdmin_(token);
    const ym = monthArgs_(month, year);
    const staff = findStaff_(String(staffId || ''));
    if (!staff) fail_('ไม่พบพนักงาน');
    const dim = new Date(ym.y, ym.m, 0).getDate();
    if (!Array.isArray(days) || days.length > 31) fail_('ข้อมูลวันที่ไม่ถูกต้อง');
    const want = {};
    days.forEach(v => { const n = Math.floor(Number(v)); if (!(n >= 1 && n <= dim)) fail_('วันที่ไม่ถูกต้อง'); want[n] = true; });
    note = clean_(note, 100);

    return withLock_(() => {
      const id = String(staff.row[S.ID]), name = String(staff.row[S.NAME]);
      const sh = lateSheet_(true);
      if (sh.getMaxColumns() < LT.WIDTH) sh.insertColumnsAfter(sh.getMaxColumns(), LT.WIDTH - sh.getMaxColumns());
      const mine = lateRows_().filter(r => String(r.row[LT.STAFFID]) === id)
        .map(r => ({ rowNum: r.rowNum, d: toDate_(r.row[LT.DATE]) }))
        .filter(x => x.d && x.d.getFullYear() === ym.y && x.d.getMonth() === ym.m - 1);
      const have = {};
      mine.forEach(x => { have[x.d.getDate()] = true; });
      const toAdd = Object.keys(want).map(Number).filter(d => !have[d]).sort((a, b) => a - b);
      const toDel = mine.filter(x => !want[x.d.getDate()]).sort((a, b) => b.rowNum - a.rowNum);

      const today = today_(), leaveDays = buildLeaveMap_(ym.y, ym.m)[id] || {};
      toAdd.forEach(d => {
        if (new Date(ym.y, ym.m - 1, d) > today) fail_('บันทึกมาสายล่วงหน้าไม่ได้ (วันที่ ' + d + ')');
        if (leaveDays[d]) fail_('วันที่ ' + d + ' มีใบลาที่อนุมัติแล้ว ไม่สามารถบันทึกมาสายซ้ำได้');
      });

      toDel.forEach(x => sh.deleteRow(x.rowNum));   // ลบจากล่างขึ้นบน เลขแถวที่เหลือจึงไม่เลื่อน
      if (toAdd.length) {
        const now = new Date();
        const rows = toAdd.map(d => [Utilities.getUuid(), id, name, new Date(ym.y, ym.m - 1, d), note, adm.display, now]);
        const start = sh.getLastRow() + 1;
        sh.getRange(start, 1, rows.length, LT.WIDTH).setValues(rows);
        fmt_(sh.getRange(start, 4, rows.length, 1), 'dd/mm/yyyy');
        fmt_(sh.getRange(start, 7, rows.length, 1), 'dd/mm/yyyy HH:mm:ss');
      }
      audit_('admin:' + adm.username, 'LATE_SAVE', id, name + ' ' + ym.m + '/' + ym.y + ' เพิ่ม ' + toAdd.length + ' ลบ ' + toDel.length);
      return { message: 'บันทึกมาสายของ ' + name + ' เรียบร้อย (เพิ่ม ' + toAdd.length + ' วัน, ลบ ' + toDel.length + ' วัน)' };
    });
  });
}

function monthArgs_(month, year) {
  const m = Math.floor(Number(month));
  let y = Math.floor(Number(year));
  if (y > 2400) y -= 543;
  if (!(m >= 1 && m <= 12) || !(y >= 2000 && y <= 2100)) fail_('เดือนหรือปีไม่ถูกต้อง');
  return { m: m, y: y };
}

function symbolOfLeave_(label) {
  if (label.indexOf('พักร้อน') >= 0 || label.indexOf('พักผ่อน') >= 0) return 'V';
  if (label.indexOf('ลากิจ') >= 0) return 'P';
  if (label.indexOf('ลาป่วย') >= 0) return 'S';
  if (label.indexOf('งดเวร') >= 0 || label.indexOf('นอกเวลา') >= 0) return 'O';
  if (label.indexOf('ขาดเวร') >= 0 || label.indexOf('มาสาย') >= 0) return 'F';
  return '';
}

function buildLeaveMap_(y, m) {
  const nameToId = {};
  rows_(CFG.SHEET.STAFF, S.WIDTH).forEach(r => { nameToId[normName_(r.row[S.NAME]).toLowerCase()] = String(r.row[S.ID]); });
  const hol = holidaySet_();
  const first = new Date(y, m - 1, 1), last = new Date(y, m, 0);
  const leaveMap = {};
  rows_(CFG.SHEET.LEAVE, L.WIDTH).forEach(r => {
    const row = r.row;
    if (String(row[L.STATUS] || '').trim().toLowerCase() !== 'approve') return;
    const sym = symbolOfLeave_(String(row[L.TYPE] || ''));
    const s = toDate_(row[L.START]), e = toDate_(row[L.END]);
    if (!sym || !s || !e || e < first || s > last) return;
    const id = String(row[L.STAFFID] || '') || nameToId[normName_(row[L.NAME]).toLowerCase()];
    if (!id) return;
    const workingOnly = sym === 'V' || sym === 'P' || sym === 'S';
    for (let d = new Date(s > first ? s : first); d <= (e < last ? e : last); d.setDate(d.getDate() + 1)) {
      const w = d.getDay();
      if (workingOnly && (w === 0 || w === 6 || hol[ymd_(d)])) continue;
      (leaveMap[id] || (leaveMap[id] = {}))[d.getDate()] = sym;
    }
  });
  return leaveMap;
}

function debugLate() {
  const step = (name, fn) => {
    try { Logger.log('ผ่าน  ' + name + ' -> ' + fn()); }
    catch (e) { Logger.log('ล้มเหลว  ' + name + ' : ' + e.message + '\n' + (e.stack || '')); }
  };
  step('อ่านชีต Staff', () => rows_(CFG.SHEET.STAFF, S.WIDTH).length + ' แถว');
  step('อ่านชีต Leave', () => rows_(CFG.SHEET.LEAVE, L.WIDTH).length + ' แถว');
  step('อ่านชีต Holidays', () => Object.keys(holidaySet_()).length + ' วัน');
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CFG.SHEET.LATE);
  Logger.log(sh ? 'ชีตมีอยู่: ' + sh.getLastRow() + ' แถว, ' + sh.getLastColumn() + ' คอลัมน์ (ต้องการ ' + LT.WIDTH + ')' : 'ยังไม่มีชีต ' + CFG.SHEET.LATE);
  step('อ่านชีต ' + CFG.SHEET.LATE, () => lateRows_().length + ' แถว');
  const now = new Date();
  step('สร้างแผนที่การลาเดือนนี้', () => Object.keys(buildLeaveMap_(now.getFullYear(), now.getMonth() + 1)).length + ' คนมีวันลา');
}

// =====================================================================
//  STOCK API  —  ให้ระบบ Stock เรียกมาที่นี่เพื่อ: ดูรายชื่อ, ล็อกอิน, ตรวจ token, เปลี่ยน PIN, ออกจากระบบ
//  ป้องกันด้วย API key ลับ (เก็บใน Script Properties ชื่อ STOCK_API_KEY)
// =====================================================================

/** รันครั้งเดียวจากตัวแก้ไข: สร้างคีย์ลับแล้วแสดงใน Execution log (ไม่สร้างทับถ้ามีอยู่แล้ว) */
function setupStockApiKey() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('STOCK_API_KEY')) {
    Logger.log('มี STOCK_API_KEY อยู่แล้ว ไม่สร้างทับ (ดูได้ที่ Project Settings > Script Properties)');
    return;
  }
  const key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  props.setProperty('STOCK_API_KEY', key);
  Logger.log('STOCK_API_KEY = ' + key);
  Logger.log('คัดลอกไปใส่ Script Properties ของโปรเจกต์ Stock (ชื่อ LEAVE_API_KEY) และห้ามแชร์ต่อ');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sameKey_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** รายชื่อพนักงานที่ใช้งานอยู่ (id + ชื่อ) สำหรับ dropdown หน้า Login ของ Stock */
function stockStaffList_(system) {
  return api_(() => ({
    staff: rows_(CFG.SHEET.STAFF, S.WIDTH)
      .filter(r => isTrue_(r.row[S.ACTIVE]) && (system === '*' || hasSys_(r.row, system)))   // '*' = ทุกคนที่ใช้งานอยู่ (ใช้กับรายชื่อ "ผู้ก่อเหตุ" ของอุบัติการณ์)
      .map(r => ({ id: r.row[S.ID], name: r.row[S.NAME] }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'th'))
  }));
}

/** ตรวจ token (และต่ออายุ session ตามปกติ) คืนเฉพาะ id + ชื่อ */
function stockVerify_(token, system) {
  return api_(() => {
    const me = requireStaff_(token, false, system);
    return { staff: { id: String(me.row[S.ID]), name: String(me.row[S.NAME]) } };
  });
}

/** ทดสอบตรรกะในตัวแก้ไข (ยังไม่ต้อง Deploy): รันแล้วดู Execution log */
function testStockApi() {
  const key = PropertiesService.getScriptProperties().getProperty('STOCK_API_KEY');
  const call = (k, action) => doPost({ postData: { contents: JSON.stringify({ key: k, action: action }) } }).getContent();
  Logger.log('คีย์ถูก  + staffList -> ' + call(key, 'staffList').slice(0, 200));
  Logger.log('คีย์ผิด  + staffList -> ' + call('wrong-key', 'staffList'));
  Logger.log('คีย์ถูก  + action แปลก -> ' + call(key, 'deleteEverything'));
}

/** ฟังก์ชันผู้ดูแลที่อนุญาตให้ Stock เรียกผ่าน doPost (ทุกตัวตรวจ token ผู้ดูแลเองด้วย requireAdmin_) */
function stockAdminFns_() {
  return {
    adminSummary: adminSummary, adminListRequests: adminListRequests, adminDecideRequest: adminDecideRequest,
    adminListStaff: adminListStaff, adminSaveStaff: adminSaveStaff, adminResetStaffPin: adminResetStaffPin, adminDeleteStaff: adminDeleteStaff, adminUnlockStaff: adminUnlockStaff,
    adminListAdmins: adminListAdmins, adminAddAdmin: adminAddAdmin, adminUpdateAdmin: adminUpdateAdmin,
    adminChangeOwnPassword: adminChangeOwnPassword, adminResetAdminPassword: adminResetAdminPassword, adminDeleteAdmin: adminDeleteAdmin
  };
}

/** ตรวจ token ผู้ดูแล (เบา) สำหรับหน้า Stock */
function stockAdminVerify_(token, system) {
  return api_(() => {
    const a = requireAdmin_(token);
    if (system && adminSystems_(a.username).indexOf(system) < 0) fail_('บัญชีนี้ไม่มีสิทธิ์ใช้ระบบนี้', 'FORBIDDEN');   // คอลัมน์ G ของชีต Admins
    return { admin: { username: a.username, displayName: a.display } };
  });
}