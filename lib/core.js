/**
 * ระบบบันทึกการแจ้งลา — พอร์ตจาก Code.gs (Apps Script) มาเป็น Node + Postgres
 * หลักการเดิมทุกอย่าง: ทุกการตัดสินสิทธิ์อยู่ที่ server, client ส่งได้แค่ token + ข้อมูลดิบ
 * ข้อความ, รหัสผิดพลาด (code) และรูปแบบผลลัพธ์ ตรงกับของเดิม เพื่อให้หน้าเว็บและระบบอื่นใช้ต่อได้ทันที
 *
 * ข้อมูล: แต่ละตารางถูกอ่านออกมาเป็น "แถว" ที่ใช้ดัชนีคอลัมน์เดียวกับชีตเดิม (L, S, A, R, LT)
 * ตรรกะจึงเหมือน Code.gs บรรทัดต่อบรรทัด ต่างกันแค่การเขียนข้อมูลที่ระบุแถวด้วย primary key แทนเลขแถว
 */
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { db, withTx } from './db.js';

// ===================== CONFIG =====================
export const CFG = {
  DEFAULT_PIN: '1234',
  HASH_ROUNDS: 100,
  MAX_FAILS: 5,
  LOCK_SECONDS: 900,
  STAFF_LOCK_SECONDS: 300,
  STAFF_SESSION_SEC: 1800,
  ADMIN_SESSION_SEC: 3600,
  MAX_ENTRIES: 10,
  MAX_RANGE_DAYS: 60,
  MAX_PAST_DAYS: 90,
  MAX_FUTURE_DAYS: 365,
  OFF_DUTY_MAX_DAYS_PER_MONTH: 3,
  MAX_ROWS_ADMIN: 500,
  MASK_SICK_FOR_OTHERS: false,
  TZ: 'Asia/Bangkok'
};

export const LEAVE_TYPES = [
  ['sick', 'ลาป่วย'], ['personal', 'ลากิจ'], ['annual', 'ลาพักร้อน'],
  ['off_duty_cancel', 'งดเวรนอกเวลา'], ['other', 'ลาอื่นๆ']
];

export const POSITIONS = [
  'นักเทคนิคการแพทย์(MT Fulltime)งานห้องปฏิบัติการเวชศาสตร์ชันสูตร',
  'นักเทคนิคการแพทย์(MT บุคลากรประจำคณะแพทย์ศาสตร์)',
  'พยาบาลวิชาชีพ(RN Parttime, บุคลากรประจำคณะแพทย์ศาสตร์)',
  'นักเทคนิคการแพทย์(MT Parttime)',
  'บุคลากรประจำคณะแพทย์ศาสตร์ ตำแหน่งอื่นๆ'
];

export const STATUS = { PENDING: 'Pending', APPROVED: 'Approve', REJECTED: 'Reject', CANCELLED: 'Cancelled' };

// ดัชนีคอลัมน์ (เหมือนชีตเดิม)
export const L = { TS: 0, NAME: 1, POS: 2, TYPE: 3, START: 4, END: 5, DAYS: 6, STATUS: 7, ID: 8, BY: 9, AT: 10, NOTE: 11, STAFFID: 12, WIDTH: 13 };
export const S = { ID: 0, NAME: 1, POS: 2, HASH: 3, SALT: 4, MUST: 5, ACTIVE: 6, CREATED: 7, PINCHANGED: 8,
                   LEAVE: 9, STOCK: 10, STOCKCENTER: 11, INCIDENT: 12, BLOODGAS: 13, GLUCOSE: 14, WIDTH: 15 };
export const SYS_COL = { leave: S.LEAVE, stock: S.STOCK, stockcenter: S.STOCKCENTER, incident: S.INCIDENT, bloodgas: S.BLOODGAS, glucose: S.GLUCOSE };
export const SYS_KEYS = Object.keys(SYS_COL);
const SYS_DB_COL = { leave: 'sys_leave', stock: 'sys_stock', stockcenter: 'sys_stockcenter', incident: 'sys_incident', bloodgas: 'sys_bloodgas', glucose: 'sys_glucose' };
export function hasSys_(row, system) { return isTrue_(row[SYS_COL[system]]); }
const SYS_OFF_BY_DEFAULT = ['bloodgas', 'glucose'];
function newStaffSys_() { return SYS_KEYS.map(k => SYS_OFF_BY_DEFAULT.indexOf(k) < 0); }
function sysFlags_(row) { const o = {}; SYS_KEYS.forEach(k => { o[k] = hasSys_(row, k); }); return o; }
// Admins: A-F เดิม + G Systems, H Super, I LineUserId
export const A = { USER: 0, DISPLAY: 1, HASH: 2, SALT: 3, ACTIVE: 4, CREATED: 5, WIDTH: 6 };
export const ADMIN_SYSTEMS_COL = 7;   // คอลัมน์ G (นับจาก 1 เหมือนเดิม)
export const ADMIN_SUPER_COL = 8;     // คอลัมน์ H
export const LINE_ADMIN_COL = 9;      // คอลัมน์ I
export const R = { ID: 0, NAME: 1, POS: 2, CONTACT: 3, STATUS: 4, TS: 5, BY: 6, AT: 7, STAFFID: 8, NOTE: 9, WIDTH: 10 };
export const LT = { ID: 0, STAFFID: 1, NAME: 2, DATE: 3, NOTE: 4, BY: 5, AT: 6, WIDTH: 7 };

// ===================== INFRA HELPERS =====================
export class AppError extends Error {
  constructor(msg, code) { super(msg); this.code = code || 'ERR'; }
}
export function fail_(msg, code) { throw new AppError(msg, code); }

/** แทน api_ เดิม: คืน {ok:true,...} หรือ {ok:false, code, message} */
export async function api_(fn) {
  try {
    return Object.assign({ ok: true }, (await fn()) || {});
  } catch (e) {
    if (e instanceof AppError) return { ok: false, code: e.code, message: e.message };
    if (e && e.code === '55P03') return { ok: false, code: 'BUSY', message: 'ระบบกำลังประมวลผลหลายรายการ กรุณาลองใหม่' };
    console.error(e && e.stack ? e.stack : e);
    return { ok: false, code: 'SERVER', message: 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง' };
  }
}

export function withLock_(fn) { return withTx(fn); }

export function isTrue_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }

export function clean_(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim()
    .replace(/^[=+\-@\s]+/, '')
    .slice(0, max);
}

export async function audit_(actor, action, target, detail) {
  try {
    await db()`insert into audit_log (ts, actor, action, target, detail)
               values (${new Date()}, ${String(actor || '')}, ${String(action || '')}, ${String(target || '')}, ${String(detail || '').slice(0, 500)})`;
  } catch (e) { console.error('audit failed', e); }
}

/** แทน Utilities.getUuid() */
export function uuid_() { return randomUUID(); }
export function prop_(name) { return String(process.env[name] || '').trim(); }

// ===================== แปลงตาราง <-> แถวแบบชีตเดิม =====================
function d_(s) { if (!s) return ''; const p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
function n_(v) { return v == null ? '' : Number(v); }
function t_(v) { return v == null ? '' : v; }   // timestamptz -> Date หรือ ''

export async function staffRows_() {
  const rs = await db()`select * from staff order by seq`;
  return rs.map(x => ({ key: x.id, row: [x.id, x.name, x.position, x.pin_hash, x.salt, x.must_change_pin, x.active, t_(x.created_at), t_(x.pin_changed_at),
    x.sys_leave, x.sys_stock, x.sys_stockcenter, x.sys_incident, x.sys_bloodgas, x.sys_glucose] }));
}
export async function adminRows_() {
  const rs = await db()`select * from admins order by seq`;
  return rs.map(x => ({ key: x.username, row: [x.username, x.display_name, x.pw_hash, x.salt, x.active, t_(x.created_at), x.systems, x.super, x.line_user_id] }));
}
export async function leaveRows_() {
  const rs = await db()`select * from leaves order by seq`;
  return rs.map(x => ({ key: x.id, row: [t_(x.ts), x.name, x.position, x.type, d_(x.start_date), d_(x.end_date), n_(x.days), x.status, x.id, x.by_name, t_(x.at), x.note, x.staff_id] }));
}
export async function requestRows_() {
  const rs = await db()`select * from staff_requests order by seq`;
  return rs.map(x => ({ key: x.id, row: [x.id, x.name, x.position, x.contact, x.status, t_(x.ts), x.by_name, t_(x.at), x.staff_id, x.note] }));
}
export async function lateRows_() {
  const rs = await db()`select * from late_records order by seq`;
  return rs.map(x => ({ key: x.id, row: [x.id, x.staff_id, x.name, d_(x.date), x.note, x.by_name, t_(x.at)] }));
}

// ===================== DATE HELPERS =====================
export function pad_(n) { return ('0' + n).slice(-2); }
export function ymd_(d) { return d.getFullYear() + '-' + pad_(d.getMonth() + 1) + '-' + pad_(d.getDate()); }
function addDays_(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function today_() { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); }

function parseYmd_(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) fail_('รูปแบบวันที่ไม่ถูกต้อง');
  const p = s.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2]);
  if (d.getFullYear() !== p[0] || d.getMonth() !== p[1] - 1 || d.getDate() !== p[2]) fail_('วันที่ไม่ถูกต้อง');
  return d;
}

export function toDate_(v) {
  if (v instanceof Date && !isNaN(v)) {
    let y = v.getFullYear();
    if (y > 2400) y -= 543;
    return new Date(y, v.getMonth(), v.getDate());
  }
  const m = String(v || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  let y = Number(m[3]); if (y > 2400) y -= 543;
  const d = new Date(y, Number(m[2]) - 1, Number(m[1]));
  return isNaN(d) ? null : d;
}

export function tsStr_(v) {
  return v instanceof Date ? ymd_(v) + ' ' + pad_(v.getHours()) + ':' + pad_(v.getMinutes()) : String(v || '');
}

async function holidaySet_() {
  const set = {};
  (await db()`select date from holidays`).forEach(r => { const d = d_(r.date); if (d) set[ymd_(d)] = true; });
  return set;
}

async function countDays_(type, start, end) {
  const cal = Math.round((end - start) / 86400000) + 1;
  if (type === 'off_duty_cancel' || type === 'other') return cal;
  const hol = await holidaySet_();
  let n = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const w = d.getDay();
    if (w !== 0 && w !== 6 && !hol[ymd_(d)]) n++;
  }
  return n;
}

async function nextWorkday_(end) {
  const hol = await holidaySet_();
  let d = addDays_(end, 1);
  for (let i = 0; i < 60; i++) {
    const w = d.getDay();
    if (w !== 0 && w !== 6 && !hol[ymd_(d)]) break;
    d = addDays_(d, 1);
  }
  return d;
}

async function validateEntry_(e, today, no) {
  const label = 'รายการที่ ' + no + ': ';
  if (!e || typeof e !== 'object') fail_(label + 'ข้อมูลไม่ถูกต้อง');
  const t = LEAVE_TYPES.find(x => x[0] === e.leaveTypeKey);
  if (!t) fail_(label + 'ประเภทการลาไม่ถูกต้อง');
  const start = parseYmd_(e.startDate), end = parseYmd_(e.endDate);
  if (end < start) fail_(label + 'วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
  if (Math.round((end - start) / 86400000) + 1 > CFG.MAX_RANGE_DAYS) fail_(label + 'ลาต่อเนื่องได้ไม่เกิน ' + CFG.MAX_RANGE_DAYS + ' วัน');
  if (start < addDays_(today, -CFG.MAX_PAST_DAYS)) fail_(label + 'ลาย้อนหลังได้ไม่เกิน ' + CFG.MAX_PAST_DAYS + ' วัน');
  if (end > addDays_(today, CFG.MAX_FUTURE_DAYS)) fail_(label + 'ลาล่วงหน้าได้ไม่เกิน ' + CFG.MAX_FUTURE_DAYS + ' วัน');
  const days = await countDays_(t[0], start, end);
  if (days < 1) fail_(label + 'ช่วงที่เลือกไม่มีวันทำงาน (เสาร์-อาทิตย์/วันหยุด)');
  return { key: t[0], label: t[1], start: start, end: end, days: days };
}

function overlap_(a, b) { return a.start.getTime() <= b.end.getTime() && a.end.getTime() >= b.start.getTime(); }

// ===== งดเวรนอกเวลาไม่เกิน N วัน/เดือน =====
const OFF_DUTY_MONTHS_ = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

function spreadDays_(s, e, into) {
  for (let d = new Date(s.getFullYear(), s.getMonth(), s.getDate()); d <= e; d.setDate(d.getDate() + 1)) {
    const k = d.getFullYear() + '-' + pad_(d.getMonth() + 1);
    into[k] = (into[k] || 0) + 1;
  }
}

async function offDutyUsed_(me) {
  const label = LEAVE_TYPES.find(x => x[0] === 'off_duty_cancel')[1];
  const used = {};
  (await leaveRows_()).forEach(r => {
    if (!isOwn_(r.row, me.row[S.ID], me.row[S.NAME])) return;
    if (r.row[L.TYPE] !== label) return;
    if ([STATUS.REJECTED, STATUS.CANCELLED].indexOf(r.row[L.STATUS]) >= 0) return;
    const s = toDate_(r.row[L.START]), e = toDate_(r.row[L.END]); if (!s || !e) return;
    spreadDays_(s, e, used);
  });
  return used;
}

async function checkOffDutyQuota_(me, accepted) {
  const max = CFG.OFF_DUTY_MAX_DAYS_PER_MONTH;
  if (!max) return;
  const mine = accepted.filter(v => v.key === 'off_duty_cancel');
  if (!mine.length) return;
  const used = await offDutyUsed_(me), adding = {}, sample = {};
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

export function getOffDutyQuota(token) {
  return api_(async () => {
    const me = await requireStaff_(token, false);
    return { max: CFG.OFF_DUTY_MAX_DAYS_PER_MONTH || 0, used: await offDutyUsed_(me) };
  });
}

// ===================== CRYPTO / THROTTLE / SESSION =====================
/** อัลกอริทึมเดียวกับ hash_ ของ Apps Script ทุกไบต์ (SHA-256 วน 100 รอบ + salt + PEPPER) — PIN/รหัสผ่านเดิมจึงใช้ต่อได้ */
export function hash_(secret, salt) {
  const pepper = prop_('PEPPER');
  if (!pepper) fail_('ระบบยังไม่ได้ติดตั้ง (ตั้งค่า PEPPER)', 'NO_SETUP');
  let h = salt + ':' + secret + ':' + pepper;
  for (let i = 0; i < CFG.HASH_ROUNDS; i++) h = createHash('sha256').update(h + salt, 'utf8').digest('hex');
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

export function makeHash_(secret) { const salt = uuid_(); return { salt: salt, hash: hash_(secret, salt) }; }

// ----- แทน CacheService (ตาราง kv มีวันหมดอายุ) -----
export async function cacheGet_(k) {
  const r = await db()`select value from kv where key = ${k} and (expires_at is null or expires_at > now())`;
  return r.length ? r[0].value : null;
}
export async function cachePut_(k, v, sec) {
  const exp = sec ? new Date(Date.now() + sec * 1000) : null;
  await db()`insert into kv (key, value, expires_at) values (${k}, ${String(v)}, ${exp})
             on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at`;
}
export async function cacheRemove_(k) { await db()`delete from kv where key = ${k}`; }

function lockSec_(key) { return /^(staff|pin):/.test(key) ? CFG.STAFF_LOCK_SECONDS : CFG.LOCK_SECONDS; }
function lockMsg_(key) {
  const m = Math.round(lockSec_(key) / 60);
  return /^(staff|pin):/.test(key)
    ? 'ใส่ผิดหลายครั้งเกินไป บัญชีถูกล็อกชั่วคราว กรุณารอ ' + m + ' นาที หรือติดต่อผู้ดูแลเพื่อปลดล็อก'
    : 'ลองผิดหลายครั้งเกินไป กรุณารอ ' + m + ' นาทีแล้วลองใหม่';
}
export async function failCount_(key) { return Number((await cacheGet_('FAIL:' + key)) || 0); }
export async function isLocked_(key, max) { return (await failCount_(key)) >= (max || CFG.MAX_FAILS); }
async function throttle_(key, max) { if (await isLocked_(key, max)) fail_(lockMsg_(key), 'LOCKED'); }
async function penalize_(key) { await cachePut_('FAIL:' + key, String((await failCount_(key)) + 1), lockSec_(key)); }
export async function clearFails_(key) { await cacheRemove_('FAIL:' + key); }

/** รายชื่อคีย์ล็อกทั้งหมดที่ยังไม่หมดอายุ (ใช้แสดงสถานะ "ถูกล็อก" ทีละหลายคนโดยไม่ query ซ้ำ) */
export async function lockedSet_(max) {
  const rs = await db()`select key, value from kv where key like 'FAIL:%' and (expires_at is null or expires_at > now())`;
  const out = {};
  rs.forEach(r => { if (Number(r.value) >= (max || CFG.MAX_FAILS)) out[r.key.slice(5)] = true; });
  return out;
}

function newToken_() { return randomBytes(32).toString('hex'); }   // 64 ตัวอักษร a-f0-9 เหมือนเดิม

export async function newSession_(type, id, system, pw) {
  const token = newToken_();
  const sec = type === 'admin' ? CFG.ADMIN_SESSION_SEC : CFG.STAFF_SESSION_SEC;
  await db()`insert into sessions (token, type, subject, sys, pw, expires_at)
             values (${token}, ${type}, ${String(id)}, ${system || ''}, ${pw || ''}, ${new Date(Date.now() + sec * 1000)})`;
  if (Math.random() < 0.05) await db()`delete from sessions where expires_at < now()`;   // เก็บกวาดเซสชันหมดอายุเป็นครั้งคราว
  return token;
}

async function session_(token, type) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) fail_('กรุณาเข้าสู่ระบบ', 'AUTH');
  const r = await db()`select type, subject, sys, pw from sessions where token = ${token} and expires_at > now()`;
  if (!r.length) fail_('หมดเวลาการใช้งาน กรุณาเข้าสู่ระบบใหม่', 'AUTH');
  const s = r[0];
  if (s.type !== type) fail_('ไม่มีสิทธิ์ใช้งานส่วนนี้', 'AUTH');
  const sec = type === 'admin' ? CFG.ADMIN_SESSION_SEC : CFG.STAFF_SESSION_SEC;
  await db()`update sessions set expires_at = ${new Date(Date.now() + sec * 1000)} where token = ${token}`;
  return { type: s.type, id: s.subject, sys: s.sys, pw: s.pw };
}

function pwTag_(hash) { return String(hash || '').slice(0, 16); }
async function retagSession_(token, pw) {
  await db()`update sessions set pw = ${pw}, expires_at = ${new Date(Date.now() + CFG.ADMIN_SESSION_SEC * 1000)} where token = ${token}`;
}

export async function endSession_(token) {
  if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) await db()`delete from sessions where token = ${token}`;
}

// ===================== LOOKUPS =====================
export async function findStaff_(id) { return (await staffRows_()).find(r => r.row[S.ID] === id) || null; }
export async function findAdmin_(user) { return (await adminRows_()).find(r => String(r.row[A.USER]).toLowerCase() === user) || null; }
async function findLeave_(id) {
  if (typeof id !== 'string' || id.length < 8 || id.length > 64) return null;
  return (await leaveRows_()).find(r => r.row[L.ID] === id) || null;
}

export async function requireStaff_(token, allowMustChange, system) {
  system = system || 'leave';
  const s = await session_(token, 'staff');
  if ((s.sys || 'leave') !== system) fail_('กรุณาเข้าสู่ระบบ', 'AUTH');
  const f = await findStaff_(s.id);
  if (!f || !isTrue_(f.row[S.ACTIVE])) { await endSession_(token); fail_('บัญชีนี้ถูกปิดการใช้งาน', 'AUTH'); }
  if (!hasSys_(f.row, system)) { await endSession_(token); fail_('บัญชีนี้ไม่ได้รับสิทธิ์ใช้ระบบนี้ กรุณาติดต่อผู้ดูแล', 'AUTH'); }
  if (!allowMustChange && isTrue_(f.row[S.MUST])) fail_('กรุณาตั้ง PIN ใหม่ก่อนใช้งาน', 'MUST_CHANGE_PIN');
  return f;
}

export async function requireAdmin_(token) {
  const s = await session_(token, 'admin');
  const f = await findAdmin_(s.id);
  if (!f || !isTrue_(f.row[A.ACTIVE])) { await endSession_(token); fail_('บัญชีผู้ดูแลถูกปิดการใช้งาน', 'AUTH'); }
  if (!s.pw || s.pw !== pwTag_(f.row[A.HASH])) { await endSession_(token); fail_('รหัสผ่านถูกเปลี่ยนแล้ว กรุณาเข้าสู่ระบบใหม่', 'AUTH'); }
  return { username: String(f.row[A.USER]), display: String(f.row[A.DISPLAY]), key: f.key };
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
export function getBootstrap() {
  return api_(async () => {
    const staff = (await staffRows_())
      .filter(r => isTrue_(r.row[S.ACTIVE]) && hasSys_(r.row, 'leave'))
      .map(r => ({ id: r.row[S.ID], name: r.row[S.NAME] }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'th'));
    return { leaveTypes: LEAVE_TYPES, positions: POSITIONS, staff: staff,
             limits: { maxEntries: CFG.MAX_ENTRIES, pastDays: CFG.MAX_PAST_DAYS, futureDays: CFG.MAX_FUTURE_DAYS, offDutyMaxDays: CFG.OFF_DUTY_MAX_DAYS_PER_MONTH } };
  });
}

// ===================== PUBLIC API: พนักงาน =====================
export function staffLogin(staffId, pin) { return staffLogin_(staffId, pin, 'leave'); }

export function staffLogin_(staffId, pin, system) {
  return api_(async () => {
    staffId = String(staffId || ''); pin = String(pin || '');
    const key = 'staff:' + staffId;
    await throttle_(key);
    const f = await findStaff_(staffId);
    if (!f || !isTrue_(f.row[S.ACTIVE]) || !verify_(pin, f.row[S.SALT], f.row[S.HASH])) {
      await penalize_(key);
      await audit_('staff:' + staffId, 'STAFF_LOGIN_FAIL', staffId, system);
      const left = CFG.MAX_FAILS - (await failCount_(key));
      fail_(left > 0 ? 'ชื่อหรือ PIN ไม่ถูกต้อง (เหลืออีก ' + left + ' ครั้ง ก่อนบัญชีถูกล็อกชั่วคราว)' : lockMsg_(key), left > 0 ? 'BAD_LOGIN' : 'LOCKED');
    }
    await clearFails_(key);
    if (!hasSys_(f.row, system)) {
      await audit_('staff:' + f.row[S.NAME], 'STAFF_LOGIN_NO_ACCESS', staffId, system);
      fail_('บัญชีนี้ไม่ได้รับสิทธิ์ใช้ระบบนี้ กรุณาติดต่อผู้ดูแล', 'NO_ACCESS');
    }
    await audit_('staff:' + f.row[S.NAME], 'STAFF_LOGIN', staffId, system);
    return { token: await newSession_('staff', staffId, system),
             staff: { id: staffId, name: f.row[S.NAME], position: f.row[S.POS] },
             mustChangePin: isTrue_(f.row[S.MUST]) };
  });
}

export function staffResume(token) {
  return api_(async () => {
    const me = await requireStaff_(token, false);
    return { staff: { id: me.row[S.ID], name: me.row[S.NAME], position: me.row[S.POS] } };
  });
}

export function staffLogout(token) { return api_(async () => { await endSession_(token); }); }

export function staffChangePin(token, oldPin, newPin) { return staffChangePin_(token, oldPin, newPin, 'leave'); }

export function staffChangePin_(token, oldPin, newPin, system) {
  return api_(async () => {
    const me = await requireStaff_(token, true, system);
    oldPin = String(oldPin || ''); newPin = String(newPin || '');
    const key = 'pin:' + me.row[S.ID];
    await throttle_(key);
    if (!verify_(oldPin, me.row[S.SALT], me.row[S.HASH])) {
      await penalize_(key);
      const left = CFG.MAX_FAILS - (await failCount_(key));
      fail_('PIN เดิมไม่ถูกต้อง' + (left > 0 ? ' (เหลืออีก ' + left + ' ครั้ง)' : ''), 'BAD_PIN');
    }
    await clearFails_(key);
    const err = validPin_(newPin); if (err) fail_(err);
    if (newPin === oldPin) fail_('PIN ใหม่ต้องไม่ซ้ำกับ PIN เดิม');
    await withLock_(async () => {
      const h = makeHash_(newPin);
      await db()`update staff set pin_hash = ${h.hash}, salt = ${h.salt}, must_change_pin = false, pin_changed_at = ${new Date()} where id = ${me.key}`;
    });
    await audit_('staff:' + me.row[S.NAME], isTrue_(me.row[S.MUST]) ? 'PIN_FIRST_SET' : 'PIN_CHANGED', me.row[S.ID], '');
    return { message: 'เปลี่ยน PIN เรียบร้อยแล้ว' };
  });
}

export function calculateDuration(token, leaveTypeKey, startDate, endDate) {
  return api_(async () => {
    await requireStaff_(token, false);
    const v = await validateEntry_({ leaveTypeKey: leaveTypeKey, startDate: startDate, endDate: endDate }, today_(), 1);
    return {
      days: v.days,
      calendarDays: Math.round((v.end - v.start) / 86400000) + 1,
      returnDate: ymd_(await nextWorkday_(v.end))
    };
  });
}

export function leaveDto_(r) {
  const row = r.row;
  const s = toDate_(row[L.START]), e = toDate_(row[L.END]);
  return {
    id: String(row[L.ID] || ''), staffId: String(row[L.STAFFID] || ''), ts: tsStr_(row[L.TS]), name: String(row[L.NAME]), position: String(row[L.POS]),
    type: String(row[L.TYPE]), start: s ? ymd_(s) : '', end: e ? ymd_(e) : '', days: row[L.DAYS],
    status: String(row[L.STATUS] || STATUS.PENDING), by: String(row[L.BY] || ''), at: tsStr_(row[L.AT]), note: String(row[L.NOTE] || '')
  };
}

export function isOwn_(row, staffId, name) {
  return row[L.STAFFID] === staffId || (!row[L.STAFFID] && row[L.NAME] === name);
}

export function getMyLeaves(token) {
  return api_(async () => {
    const me = await requireStaff_(token, false);
    const list = (await leaveRows_())
      .filter(r => isOwn_(r.row, me.row[S.ID], me.row[S.NAME]))
      .reverse().slice(0, 100).map(leaveDto_);
    return { rows: list };
  });
}

export function submitLeave(token, entries) {
  return api_(async () => {
    const me = await requireStaff_(token, false);
    if (!Array.isArray(entries) || entries.length < 1) fail_('ไม่มีรายการลา');
    if (entries.length > CFG.MAX_ENTRIES) fail_('ส่งได้ครั้งละไม่เกิน ' + CFG.MAX_ENTRIES + ' รายการ');
    let ntf = '';
    const res = await withLock_(async () => {
      const today = today_();
      const existing = (await leaveRows_())
        .filter(r => isOwn_(r.row, me.row[S.ID], me.row[S.NAME]) &&
                     [STATUS.REJECTED, STATUS.CANCELLED].indexOf(r.row[L.STATUS]) < 0)
        .map(r => ({ start: toDate_(r.row[L.START]), end: toDate_(r.row[L.END]) }))
        .filter(x => x.start && x.end);

      const out = [], accepted = [];
      for (let i = 0; i < entries.length; i++) {
        const v = await validateEntry_(entries[i], today, i + 1);
        if (existing.some(x => overlap_(x, v)) || accepted.some(x => overlap_(x, v))) {
          fail_('รายการที่ ' + (i + 1) + ': วันที่ลาซ้ำกับรายการที่มีอยู่แล้ว');
        }
        accepted.push(v);
        out.push([new Date(), me.row[S.NAME], me.row[S.POS], v.label, v.start, v.end, v.days,
                  STATUS.PENDING, uuid_(), '', '', '', me.row[S.ID]]);
      }

      await checkOffDutyQuota_(me, accepted);
      for (const r of out) {
        await db()`insert into leaves (id, ts, name, position, type, start_date, end_date, days, status, by_name, at, note, staff_id)
                   values (${r[L.ID]}, ${r[L.TS]}, ${r[L.NAME]}, ${r[L.POS]}, ${r[L.TYPE]}, ${ymd_(r[L.START])}, ${ymd_(r[L.END])}, ${r[L.DAYS]},
                           ${r[L.STATUS]}, '', ${null}, '', ${r[L.STAFFID]})`;
      }
      await audit_('staff:' + me.row[S.NAME], 'LEAVE_SUBMIT', me.row[S.ID], out.map(r => r[L.ID]).join(','));
      ntf = '📝 คำขอลาใหม่ รออนุมัติ\n' + me.row[S.NAME] + '\n' + out.slice(0, 5).map(r => '• ' + r[L.TYPE] + ' ' + lineThaiDate_(r[L.START]) + (r[L.DAYS] ? ' (' + r[L.DAYS] + ' วัน)' : '')).join('\n') + (out.length > 5 ? '\n…และอีก ' + (out.length - 5) + ' รายการ' : '');
      return { message: 'บันทึกใบลาเรียบร้อยแล้ว (' + out.length + ' รายการ)', count: out.length };
    });
    if (ntf) await lineNotify_('leave', ntf);
    return res;
  });
}

export function staffCancelLeave(token, leaveId) {
  return api_(async () => {
    const me = await requireStaff_(token, false);
    return withLock_(async () => {
      const f = await findLeave_(leaveId);
      if (!f || !isOwn_(f.row, me.row[S.ID], me.row[S.NAME])) fail_('ไม่พบรายการ');
      if ((f.row[L.STATUS] || STATUS.PENDING) !== STATUS.PENDING) fail_('ยกเลิกได้เฉพาะรายการที่รออนุมัติ');
      await db()`update leaves set status = ${STATUS.CANCELLED}, by_name = ${me.row[S.NAME]}, at = ${new Date()} where id = ${f.key}`;
      await audit_('staff:' + me.row[S.NAME], 'LEAVE_CANCEL', leaveId, '');
      return { message: 'ยกเลิกรายการแล้ว' };
    });
  });
}

// ===================== PUBLIC API: แอดมิน (ล็อกอิน / รายการลา) =====================
export function adminLogin(username, password) {
  return api_(async () => {
    username = String(username || '').trim().toLowerCase().slice(0, 40);
    password = String(password || '').slice(0, 200);
    await throttle_('admin:*', 30);
    await throttle_('admin:' + username);
    const f = username ? await findAdmin_(username) : null;
    if (!f || !isTrue_(f.row[A.ACTIVE]) || !verify_(password, f.row[A.SALT], f.row[A.HASH])) {
      await penalize_('admin:*'); await penalize_('admin:' + username);
      await audit_('admin:' + username, 'ADMIN_LOGIN_FAIL', username, '');
      fail_('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', 'BAD_LOGIN');
    }
    await clearFails_('admin:' + username);
    await audit_('admin:' + username, 'ADMIN_LOGIN', username, '');
    return { token: await newSession_('admin', username, '', pwTag_(f.row[A.HASH])), admin: { username: username, displayName: f.row[A.DISPLAY] } };
  });
}

export function adminLogout(token) { return api_(async () => { await endSession_(token); }); }

export function adminSummary(token) {
  return api_(async () => {
    await requireAdmin_(token);
    const pending = (await leaveRows_()).filter(r => !r.row[L.STATUS] || r.row[L.STATUS] === STATUS.PENDING).length;
    const staff = (await staffRows_()).filter(r => isTrue_(r.row[S.ACTIVE]));
    return { pending: pending, pendingRequests: await pendingRequestCount_(), staffActive: staff.length,
             staffNotChangedPin: staff.filter(r => isTrue_(r.row[S.MUST])).map(r => r.row[S.NAME]) };
  });
}

export function adminGetLeaves(token, filter) {
  return api_(async () => {
    await requireAdmin_(token);
    filter = filter || {};
    const st = String(filter.status || STATUS.PENDING);
    if (['all', STATUS.PENDING, STATUS.APPROVED, STATUS.REJECTED, STATUS.CANCELLED].indexOf(st) < 0) fail_('ตัวกรองไม่ถูกต้อง');
    const month = /^\d{4}(-\d{2})?$/.test(String(filter.month || '')) ? filter.month : '';
    const q = clean_(filter.q, 50).toLowerCase();
    const list = (await leaveRows_()).reverse().map(leaveDto_).filter(d =>
      (st === 'all' || d.status === st) &&
      (!month || d.start.indexOf(month) === 0) &&
      (!q || d.name.toLowerCase().indexOf(q) >= 0));
    return { total: list.length, rows: list.slice(0, CFG.MAX_ROWS_ADMIN) };
  });
}

export function adminDecide(token, leaveId, decision, note) {
  return api_(async () => {
    const adm = await requireAdmin_(token);
    if ([STATUS.APPROVED, STATUS.REJECTED].indexOf(decision) < 0) fail_('คำสั่งไม่ถูกต้อง');
    note = clean_(note, 200);
    return withLock_(async () => {
      const f = await findLeave_(leaveId);
      if (!f) fail_('ไม่พบรายการ (ถ้าเป็นข้อมูลเก่า ให้รัน migrateLegacyLeaveData)');
      const cur = f.row[L.STATUS] || STATUS.PENDING;
      if (cur !== STATUS.PENDING) fail_('รายการนี้ถูกดำเนินการไปแล้ว (' + cur + ') กรุณารีเฟรช', 'STALE');
      await db()`update leaves set status = ${decision}, by_name = ${adm.display}, at = ${new Date()}, note = ${note} where id = ${f.key}`;
      await audit_('admin:' + adm.username, 'LEAVE_' + decision.toUpperCase(), leaveId, f.row[L.NAME] + (note ? ' | ' + note : ''));
      return { message: decision === STATUS.APPROVED ? 'อนุมัติเรียบร้อย' : 'ปฏิเสธเรียบร้อย' };
    });
  });
}

export function adminCancelLeave(token, leaveId, note) {
  return api_(async () => {
    const adm = await requireAdmin_(token);
    note = clean_(note, 200);
    if (!note) fail_('กรุณาระบุเหตุผลการยกเลิก');
    let ntf = '';
    const res = await withLock_(async () => {
      const f = await findLeave_(leaveId);
      if (!f) fail_('ไม่พบรายการ');
      const cur = f.row[L.STATUS] || STATUS.PENDING;
      if (cur === STATUS.CANCELLED) fail_('รายการนี้ถูกยกเลิกไปแล้ว กรุณารีเฟรช', 'STALE');
      if (cur !== STATUS.APPROVED) fail_('ยกเลิกได้เฉพาะใบลาที่อนุมัติแล้ว (รายการรออนุมัติให้ใช้ปุ่มไม่อนุมัติ) กรุณารีเฟรช', 'STALE');
      await db()`update leaves set status = ${STATUS.CANCELLED}, by_name = ${adm.display}, at = ${new Date()}, note = ${'ยกเลิกโดยผู้ดูแล: ' + note} where id = ${f.key}`;
      await audit_('admin:' + adm.username, 'LEAVE_ADMIN_CANCEL', leaveId, f.row[L.NAME] + ' | ' + note);
      const s = toDate_(f.row[L.START]);
      ntf = '🚫 ผู้ดูแลยกเลิกใบลาที่อนุมัติแล้ว\n' + f.row[L.NAME] + '\n• ' + f.row[L.TYPE] + (s ? ' ' + lineThaiDate_(s) : '') + (f.row[L.DAYS] ? ' (' + f.row[L.DAYS] + ' วัน)' : '') + '\nโดย ' + adm.display + ' : ' + note;
      return { message: 'ยกเลิกใบลาเรียบร้อย' };
    });
    if (ntf) await lineNotify_('leave', ntf);
    return res;
  });
}

// ===================== PUBLIC API: แอดมิน (จัดการพนักงาน) =====================
export function adminListStaff(token) {
  return api_(async () => {
    await requireAdmin_(token);
    const locked = await lockedSet_();
    return { rows: (await staffRows_()).map(r => ({
      id: r.row[S.ID], name: r.row[S.NAME], position: r.row[S.POS], active: isTrue_(r.row[S.ACTIVE]),
      mustChangePin: isTrue_(r.row[S.MUST]), created: tsStr_(r.row[S.CREATED]), sys: sysFlags_(r.row),
      locked: !!(locked['staff:' + r.row[S.ID]] || locked['pin:' + r.row[S.ID]]) })) };
  });
}

function sysInput_(sys, curRow) {
  if (!sys || typeof sys !== 'object') return null;
  return SYS_KEYS.map(k => Object.prototype.hasOwnProperty.call(sys, k) ? sys[k] === true : (curRow ? hasSys_(curRow, k) : false));
}

async function setStaffSys_(id, vals) {
  const o = {}; SYS_KEYS.forEach((k, i) => { o[SYS_DB_COL[k]] = vals[i] === true; });
  await db()`update staff set ${db()(o)} where id = ${id}`;
}

export async function insertStaff_(id, name, position, h, sysVals) {
  await db()`insert into staff (id, name, position, pin_hash, salt, must_change_pin, active, created_at, pin_changed_at,
                                sys_leave, sys_stock, sys_stockcenter, sys_incident, sys_bloodgas, sys_glucose)
             values (${id}, ${name}, ${position}, ${h.hash}, ${h.salt}, true, true, ${new Date()}, ${null},
                     ${sysVals[0]}, ${sysVals[1]}, ${sysVals[2]}, ${sysVals[3]}, ${sysVals[4]}, ${sysVals[5]})`;
}

export function adminSaveStaff(token, data) {
  return api_(async () => {
    const adm = await requireAdmin_(token);
    data = data || {};
    const name = clean_(data.name, 80);
    if (name.length < 2) fail_('กรุณากรอกชื่อ-นามสกุล');
    if (POSITIONS.indexOf(data.position) < 0) fail_('ตำแหน่งไม่ถูกต้อง');
    return withLock_(async () => {
      const all = await staffRows_();
      if (data.id) {
        const f = all.find(r => r.row[S.ID] === data.id);
        if (!f) fail_('ไม่พบพนักงาน');
        const sysVals = sysInput_(data.sys, f.row);
        if (nameKey_(f.row[S.NAME]) !== nameKey_(name)) {
          const dup = findDupStaff_(name, data.id, all);
          if (dup) fail_(dupMsg_(dup), 'DUP_NAME');
        }
        await db()`update staff set name = ${name}, position = ${data.position}, active = ${data.active === true} where id = ${f.key}`;
        if (sysVals) await setStaffSys_(f.key, sysVals);
        await audit_('admin:' + adm.username, 'STAFF_UPDATE', data.id, name + ' active=' + (data.active === true) + (sysVals ? ' sys=' + SYS_KEYS.filter((k, i) => sysVals[i]).join(',') : ''));
        return { id: data.id, message: 'แก้ไขเรียบร้อย' };
      }
      const dup = findDupStaff_(name, '', all);
      if (dup) fail_(dupMsg_(dup), 'DUP_NAME');
      const sysVals = sysInput_(data.sys, null);
      const id = 'S' + uuid_().slice(0, 8);
      await insertStaff_(id, name, data.position, makeHash_(CFG.DEFAULT_PIN), sysVals || newStaffSys_());
      await linkLeaveToStaff_(id, name);
      await audit_('admin:' + adm.username, 'STAFF_ADD', id, name);
      return { id: id, message: 'เพิ่มพนักงานแล้ว (PIN เริ่มต้น ' + CFG.DEFAULT_PIN + ')' };
    });
  });
}

export function adminUnlockStaff(token, staffId) {
  return api_(async () => {
    const adm = await requireAdmin_(token);
    const f = await findStaff_(String(staffId || ''));
    if (!f) fail_('ไม่พบพนักงาน');
    await clearFails_('staff:' + f.row[S.ID]); await clearFails_('pin:' + f.row[S.ID]);
    await audit_('admin:' + adm.username, 'STAFF_UNLOCK', f.row[S.ID], f.row[S.NAME]);
    return { message: 'ปลดล็อก ' + f.row[S.NAME] + ' แล้ว ลองเข้าสู่ระบบได้ทันที' };
  });
}

export function adminResetStaffPin(token, staffId) {
  return api_(async () => {
    const adm = await requireAdmin_(token);
    return withLock_(async () => {
      const f = await findStaff_(String(staffId || ''));
      if (!f) fail_('ไม่พบพนักงาน');
      const h = makeHash_(CFG.DEFAULT_PIN);
      await db()`update staff set pin_hash = ${h.hash}, salt = ${h.salt}, must_change_pin = true where id = ${f.key}`;
      await clearFails_('staff:' + f.row[S.ID]); await clearFails_('pin:' + f.row[S.ID]);
      await audit_('admin:' + adm.username, 'STAFF_PIN_RESET', f.row[S.ID], f.row[S.NAME]);
      return { message: 'รีเซ็ต PIN เป็น ' + CFG.DEFAULT_PIN + ' แล้ว พนักงานต้องตั้งใหม่ตอนเข้าครั้งถัดไป' };
    });
  });
}

// ===================== PUBLIC API: แอดมิน (จัดการแอดมิน) =====================
async function requireSuper_(adm) {
  if (!(await isSuperAdmin_(adm.username))) fail_('เฉพาะผู้ดูแลใหญ่เท่านั้นที่จัดการบัญชีผู้ดูแลระบบได้ (ไปที่ Admin Center)', 'SUPER_ONLY');
}

export function adminListAdmins(token) {
  return api_(async () => {
    await requireAdmin_(token);
    return { rows: (await adminRows_()).map(r => ({
      username: r.row[A.USER], displayName: r.row[A.DISPLAY], active: isTrue_(r.row[A.ACTIVE]), created: tsStr_(r.row[A.CREATED]) })) };
  });
}

async function activeAdminCountExcept_(username) {
  return (await adminRows_()).filter(r => isTrue_(r.row[A.ACTIVE]) && String(r.row[A.USER]).toLowerCase() !== username).length;
}

export function adminAddAdmin(token, data) {
  return api_(async () => {
    const adm = await requireAdmin_(token);
    await requireSuper_(adm);
    data = data || {};
    const username = String(data.username || '').trim().toLowerCase();
    if (!/^[a-z0-9_.-]{3,30}$/.test(username)) fail_('ชื่อผู้ใช้ใช้ a-z 0-9 _ . - ยาว 3-30 ตัว');
    const display = clean_(data.displayName, 60);
    if (display.length < 2) fail_('กรุณากรอกชื่อที่แสดง');
    validPassword_(data.password);
    return withLock_(async () => {
      if (await findAdmin_(username)) fail_('มีชื่อผู้ใช้นี้แล้ว');
      const h = makeHash_(data.password);
      await db()`insert into admins (username, display_name, pw_hash, salt, active, created_at) values (${username}, ${display}, ${h.hash}, ${h.salt}, true, ${new Date()})`;
      await audit_('admin:' + adm.username, 'ADMIN_ADD', username, display);
      return { message: 'เพิ่มผู้ดูแลระบบแล้ว' };
    });
  });
}

export function adminUpdateAdmin(token, data) {
  return api_(async () => {
    const adm = await requireAdmin_(token);
    await requireSuper_(adm);
    data = data || {};
    const username = String(data.username || '').trim().toLowerCase();
    const display = clean_(data.displayName, 60);
    if (display.length < 2) fail_('กรุณากรอกชื่อที่แสดง');
    return withLock_(async () => {
      const f = await findAdmin_(username);
      if (!f) fail_('ไม่พบผู้ดูแล');
      const active = data.active === true;
      if (!active && username === adm.username) fail_('ไม่สามารถปิดการใช้งานบัญชีตัวเองได้');
      if (!active && (await activeAdminCountExcept_(username)) < 1) fail_('ต้องเหลือผู้ดูแลที่ใช้งานได้อย่างน้อย 1 คน');
      await db()`update admins set display_name = ${display}, active = ${active} where username = ${f.key}`;
      await audit_('admin:' + adm.username, 'ADMIN_UPDATE', username, display + ' active=' + active);
      return { message: 'แก้ไขเรียบร้อย' };
    });
  });
}

export function adminChangeOwnPassword(token, oldPassword, newPassword) {
  return api_(async () => {
    const adm = await requireAdmin_(token);
    const key = 'adminpw:' + adm.username;
    await throttle_(key);
    const f = await findAdmin_(adm.username);
    if (!verify_(String(oldPassword || ''), f.row[A.SALT], f.row[A.HASH])) { await penalize_(key); fail_('รหัสผ่านเดิมไม่ถูกต้อง', 'BAD_PIN'); }
    await clearFails_(key);
    validPassword_(newPassword);
    await withLock_(async () => {
      const h = makeHash_(newPassword);
      await db()`update admins set pw_hash = ${h.hash}, salt = ${h.salt} where username = ${f.key}`;
      await retagSession_(token, pwTag_(h.hash));
    });
    await audit_('admin:' + adm.username, 'ADMIN_PASSWORD_CHANGE', adm.username, '');
    return { message: 'เปลี่ยนรหัสผ่านแล้ว' };
  });
}

export function adminResetAdminPassword(token, username, newPassword) {
  return api_(async () => {
    const adm = await requireAdmin_(token);
    await requireSuper_(adm);
    username = String(username || '').trim().toLowerCase();
    if (username === adm.username) fail_('ใช้เมนูเปลี่ยนรหัสผ่านของตัวเองแทน');
    validPassword_(newPassword);
    return withLock_(async () => {
      const f = await findAdmin_(username);
      if (!f) fail_('ไม่พบผู้ดูแล');
      const h = makeHash_(newPassword);
      await db()`update admins set pw_hash = ${h.hash}, salt = ${h.salt} where username = ${f.key}`;
      await clearFails_('admin:' + username);
      await audit_('admin:' + adm.username, 'ADMIN_PASSWORD_RESET', username, '');
      return { message: 'ตั้งรหัสผ่านใหม่แล้ว' };
    });
  });
}

export function adminDeleteAdmin(token, username) {
  return api_(async () => {
    const adm = await requireAdmin_(token);
    await requireSuper_(adm);
    username = String(username || '').trim().toLowerCase();
    if (username === adm.username) fail_('ไม่สามารถลบบัญชีตัวเองได้');
    return withLock_(async () => {
      const f = await findAdmin_(username);
      if (!f) fail_('ไม่พบผู้ดูแล');
      if (isTrue_(f.row[A.ACTIVE]) && (await activeAdminCountExcept_(username)) < 1) fail_('ต้องเหลือผู้ดูแลที่ใช้งานได้อย่างน้อย 1 คน');
      await db()`delete from admins where username = ${f.key}`;
      await audit_('admin:' + adm.username, 'ADMIN_DELETE', username, '');
      return { message: 'ลบผู้ดูแลแล้ว' };
    });
  });
}

// ===================== ชื่อ / ผูกใบลาเก่า =====================
async function linkLeaveToStaff_(staffId, name) {
  const key = normName_(name).toLowerCase();
  const rs = await db()`select id, name from leaves where staff_id = ''`;
  const ids = rs.filter(r => normName_(r.name).toLowerCase() === key).map(r => r.id);
  if (ids.length) await db()`update leaves set staff_id = ${staffId} where id in ${db()(ids)}`;
  return ids.length;
}

export function normName_(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
export function nameKey_(s) { return normName_(s).replace(/^(นางสาว|นาง|นาย|น\.ส\.|น\.ส|นส\.|นส)\s*/, '').replace(/\s+/g, '').toLowerCase(); }

function findDupStaff_(name, exceptId, all) {
  const key = nameKey_(name);
  if (!key) return null;
  return all.find(r => r.row[S.ID] !== exceptId && nameKey_(r.row[S.NAME]) === key) || null;
}
function dupMsg_(r) {
  return 'มีชื่อนี้ในระบบแล้ว: "' + r.row[S.NAME] + '"' +
    (isTrue_(r.row[S.ACTIVE]) ? '' : ' (ปิดใช้งานอยู่ — ให้เปิดใช้งานคนเดิมแทนการเพิ่มใหม่)');
}

// ===================== คำขอเข้าใช้งาน =====================
export async function pendingRequestCount_() {
  try { return (await requestRows_()).filter(r => r.row[R.STATUS] === STATUS.PENDING).length; } catch (e) { return 0; }
}

async function addStaffRow_(name, position) {
  const dup = findDupStaff_(name, '', await staffRows_()); if (dup) fail_(dupMsg_(dup), 'DUP_NAME');
  const id = 'S' + uuid_().slice(0, 8);
  await insertStaff_(id, name, position, makeHash_(CFG.DEFAULT_PIN), newStaffSys_());
  await linkLeaveToStaff_(id, name);
  return id;
}

export function requestStaffAccess(name, position, contact) {
  return api_(async () => {
    name = clean_(normName_(name), 80);
    contact = clean_(contact, 100);
    if (name.length < 2) fail_('กรุณากรอกชื่อ-นามสกุล');
    if (POSITIONS.indexOf(position) < 0) fail_('กรุณาเลือกตำแหน่ง');
    const n = Number((await cacheGet_('REQCOUNT')) || 0);
    if (n >= 15) fail_('มีคำขอเข้ามาจำนวนมากในช่วงนี้ กรุณาลองใหม่ภายหลัง หรือติดต่อผู้ดูแลโดยตรง', 'LOCKED');
    let ntf = '';
    const res = await withLock_(async () => {
      const key = nameKey_(name);
      const exists = !!findDupStaff_(name, '', await staffRows_());
      const reqs = (await requestRows_()).filter(r => r.row[R.STATUS] === STATUS.PENDING);
      if (exists || reqs.some(r => nameKey_(r.row[R.NAME]) === key)) {
        fail_('ชื่อนี้มีอยู่ในระบบหรือกำลังรอการอนุมัติอยู่แล้ว ถ้าเข้าสู่ระบบไม่ได้ กรุณาติดต่อผู้ดูแล');
      }
      if (reqs.length >= 50) fail_('มีคำขอรออนุมัติจำนวนมาก กรุณาติดต่อผู้ดูแลโดยตรง', 'LOCKED');
      const id = uuid_();
      await db()`insert into staff_requests (id, name, position, contact, status, ts) values (${id}, ${name}, ${position}, ${contact}, ${STATUS.PENDING}, ${new Date()})`;
      await cachePut_('REQCOUNT', String(n + 1), 3600);
      await audit_('public', 'STAFF_REQUEST', id, name);
      ntf = '🙋 คำขอเข้าใช้งานระบบใหม่\n' + name + ' (' + position + ')\nรอผู้ดูแลอนุมัติใน Admin Center';
      return { message: 'ส่งคำขอเรียบร้อยแล้ว กรุณารอผู้ดูแลอนุมัติ จากนั้นเข้าสู่ระบบด้วย PIN ที่ผู้ดูแลแจ้ง' };
    });
    if (ntf) await lineNotify_('request', ntf);
    return res;
  });
}

export function adminListRequests(token, status) {
  return api_(async () => {
    await requireAdmin_(token);
    const all = status === 'all';
    const list = (await requestRows_()).reverse()
      .filter(r => all || r.row[R.STATUS] === STATUS.PENDING)
      .slice(0, 200)
      .map(r => ({ id: r.row[R.ID], name: String(r.row[R.NAME]), position: String(r.row[R.POS]), contact: String(r.row[R.CONTACT] || ''),
                   status: String(r.row[R.STATUS]), ts: tsStr_(r.row[R.TS]), by: String(r.row[R.BY] || ''), at: tsStr_(r.row[R.AT]), note: String(r.row[R.NOTE] || '') }));
    return { rows: list };
  });
}

export function adminDecideRequest(token, requestId, decision, note) {
  return api_(async () => {
    const adm = await requireAdmin_(token);
    if ([STATUS.APPROVED, STATUS.REJECTED].indexOf(decision) < 0) fail_('คำสั่งไม่ถูกต้อง');
    note = clean_(note, 200);
    return withLock_(async () => {
      const f = (await requestRows_()).find(r => r.row[R.ID] === String(requestId || ''));
      if (!f) fail_('ไม่พบคำขอ');
      if (f.row[R.STATUS] !== STATUS.PENDING) fail_('คำขอนี้ถูกดำเนินการแล้ว กรุณารีเฟรช', 'STALE');
      const staffId = decision === STATUS.APPROVED ? await addStaffRow_(f.row[R.NAME], f.row[R.POS]) : '';
      await db()`update staff_requests set status = ${decision}, by_name = ${adm.display}, at = ${new Date()}, staff_id = ${staffId}, note = ${note} where id = ${f.key}`;
      await audit_('admin:' + adm.username, 'REQUEST_' + decision.toUpperCase(), f.row[R.ID], f.row[R.NAME]);
      return { message: decision === STATUS.APPROVED
        ? 'เพิ่ม "' + f.row[R.NAME] + '" เข้าระบบแล้ว PIN เริ่มต้น ' + CFG.DEFAULT_PIN + ' กรุณาแจ้งผู้ขอ'
        : 'ปฏิเสธคำขอแล้ว' };
    });
  });
}

export function adminClearRequests(token) {
  return api_(async () => {
    const adm = await requireAdmin_(token);
    return withLock_(async () => {
      const pend = (await requestRows_()).filter(r => r.row[R.STATUS] === STATUS.PENDING);
      if (pend.length) {
        await db()`update staff_requests set status = ${STATUS.REJECTED}, by_name = ${adm.display}, at = ${new Date()}, staff_id = '', note = 'ล้างคำขอค้างโดยผู้ดูแล'
                   where id in ${db()(pend.map(f => f.key))}`;
      }
      await cacheRemove_('REQCOUNT');
      await audit_('admin:' + adm.username, 'REQUEST_CLEAR', String(pend.length), '');
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
function inRange_(d, r) { return !!d.start && d.start >= r.f && d.start <= r.t; }
function typeLabels_(list) {
  const labels = LEAVE_TYPES.map(t => t[1]);
  list.forEach(d => { if (labels.indexOf(d.type) < 0) labels.push(d.type); });
  return labels;
}

export function getMySummary(token, from, to) {
  return api_(async () => {
    const me = await requireStaff_(token, false);
    const r = range_(from, to);
    const mine = (await leaveRows_())
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

export function adminReport(token, from, to) {
  return api_(async () => {
    await requireAdmin_(token);
    const r = range_(from, to);
    const all = (await leaveRows_()).map(leaveDto_);
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

    const staffRows = await staffRows_();
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

export function adminExportRows(token, from, to) {
  return api_(async () => {
    await requireAdmin_(token);
    const r = range_(from, to);
    const list = (await leaveRows_()).map(leaveDto_).filter(d => inRange_(d, r))
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    return { total: list.length, rows: list.slice(0, 5000) };
  });
}

// ===================== ตารางการลาของทั้งหน่วย =====================
export function getAllLeaves(token, filter) {
  return api_(async () => {
    const me = await requireStaff_(token, false);
    filter = filter || {};
    const status = [STATUS.PENDING, STATUS.APPROVED, STATUS.REJECTED].indexOf(filter.status) >= 0 ? filter.status : 'all';
    const q = clean_(filter.q, 50).toLowerCase();
    const size = [10, 25, 50, 100].indexOf(Number(filter.pageSize)) >= 0 ? Number(filter.pageSize) : 25;
    const sickLabel = LEAVE_TYPES.find(t => t[0] === 'sick')[1];

    const list = (await leaveRows_()).reverse()
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

// ===================== ลบพนักงาน / ปฏิทิน / ตารางสรุปรายเดือน =====================
export function adminDeleteStaff(token, staffId) {
  return api_(async () => {
    const adm = await requireAdmin_(token);
    const id = String(staffId || '').trim();
    return withLock_(async () => {
      const f = await findStaff_(id);
      if (!f) fail_('ไม่พบพนักงานคนนี้');
      const hasPending = (await leaveRows_()).some(r =>
        (r.row[L.STATUS] || STATUS.PENDING) === STATUS.PENDING && isOwn_(r.row, id, f.row[S.NAME]));
      if (hasPending) fail_('พนักงานคนนี้ยังมีใบลารออนุมัติ กรุณาอนุมัติหรือปฏิเสธก่อนลบ');
      await db()`delete from staff where id = ${f.key}`;
      await audit_('admin:' + adm.username, 'STAFF_DELETE', id, String(f.row[S.NAME]));
      return { message: 'ลบ "' + f.row[S.NAME] + '" ออกจากรายชื่อแล้ว ประวัติการลายังอยู่' };
    });
  });
}

export function getStaffCalendar(token, month, year) {
  return api_(async () => {
    const me = await requireStaff_(token, false);
    const ym = monthArgs_(month, year);
    const first = new Date(ym.y, ym.m - 1, 1), last = new Date(ym.y, ym.m, 0);
    const hol = await holidaySet_();
    const TITLES = /^(นางสาว|นาง|นาย|น\.ส\.|ทนพญ\.|ทนพ\.|ดร\.|พญ\.|นพ\.|ผศ\.|รศ\.|ศ\.)\s*/;
    const parts = {};
    (await staffRows_()).forEach(r => {
      const t = String(r.row[S.NAME] || '').trim().replace(TITLES, '').split(/\s+/);
      parts[String(r.row[S.ID])] = { first: t[0] || String(r.row[S.NAME]), last: t.slice(1).join(' '), key: normName_(r.row[S.NAME]).toLowerCase() };
    });
    const cnt = {}; Object.keys(parts).forEach(id => { cnt[parts[id].first] = (cnt[parts[id].first] || 0) + 1; });
    const nameToId = {}; Object.keys(parts).forEach(id => { nameToId[parts[id].key] = id; });
    const label = id => { const p = parts[id]; return cnt[p.first] > 1 && p.last ? p.first + ' ' + p.last.charAt(0) + '.' : p.first; };
    const days = {};
    (await leaveRows_()).forEach(r => {
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

export function getMonthlyLeaveMatrix(token, month, year) {
  return api_(async () => {
    await requireAdmin_(token);
    const ym = monthArgs_(month, year);
    const staffs = (await staffRows_()).filter(r => isTrue_(r.row[S.ACTIVE]))
      .map(r => ({ id: String(r.row[S.ID]), name: String(r.row[S.NAME]) }));
    const leaveMap = await buildLeaveMap_(ym.y, ym.m);
    (await lateRows_()).forEach(r => {
      const d = toDate_(r.row[LT.DATE]);
      const id = String(r.row[LT.STAFFID] || '');
      if (!d || !id || d.getFullYear() !== ym.y || d.getMonth() !== ym.m - 1) return;
      const map = leaveMap[id] || (leaveMap[id] = {});
      if (!map[d.getDate()]) map[d.getDate()] = 'F';
    });
    return { month: ym.m, year: ym.y, daysInMonth: new Date(ym.y, ym.m, 0).getDate(), staffs: staffs, leaveMap: leaveMap };
  });
}

// ===================== บันทึกมาสาย / ขาดเวร (F) =====================
export function adminGetLate(token, staffId, month, year) {
  return api_(async () => {
    await requireAdmin_(token);
    const ym = monthArgs_(month, year);
    const id = String(staffId || '');
    if (!(await findStaff_(id))) fail_('ไม่พบพนักงาน');
    const records = [];
    (await lateRows_()).forEach(r => {
      if (String(r.row[LT.STAFFID]) !== id) return;
      const d = toDate_(r.row[LT.DATE]);
      if (d && d.getFullYear() === ym.y && d.getMonth() === ym.m - 1) records.push({ day: d.getDate(), note: String(r.row[LT.NOTE] || '') });
    });
    return { records: records,
             leaveDays: Object.keys((await buildLeaveMap_(ym.y, ym.m))[id] || {}).map(Number),
             daysInMonth: new Date(ym.y, ym.m, 0).getDate() };
  });
}

export function adminSaveLateMonth(token, staffId, month, year, days, note) {
  return api_(async () => {
    const adm = await requireAdmin_(token);
    const ym = monthArgs_(month, year);
    const staff = await findStaff_(String(staffId || ''));
    if (!staff) fail_('ไม่พบพนักงาน');
    const dim = new Date(ym.y, ym.m, 0).getDate();
    if (!Array.isArray(days) || days.length > 31) fail_('ข้อมูลวันที่ไม่ถูกต้อง');
    const want = {};
    days.forEach(v => { const n = Math.floor(Number(v)); if (!(n >= 1 && n <= dim)) fail_('วันที่ไม่ถูกต้อง'); want[n] = true; });
    note = clean_(note, 100);

    return withLock_(async () => {
      const id = String(staff.row[S.ID]), name = String(staff.row[S.NAME]);
      const mine = (await lateRows_()).filter(r => String(r.row[LT.STAFFID]) === id)
        .map(r => ({ key: r.key, d: toDate_(r.row[LT.DATE]) }))
        .filter(x => x.d && x.d.getFullYear() === ym.y && x.d.getMonth() === ym.m - 1);
      const have = {};
      mine.forEach(x => { have[x.d.getDate()] = true; });
      const toAdd = Object.keys(want).map(Number).filter(d => !have[d]).sort((a, b) => a - b);
      const toDel = mine.filter(x => !want[x.d.getDate()]);

      const today = today_(), leaveDays = (await buildLeaveMap_(ym.y, ym.m))[id] || {};
      toAdd.forEach(d => {
        if (new Date(ym.y, ym.m - 1, d) > today) fail_('บันทึกมาสายล่วงหน้าไม่ได้ (วันที่ ' + d + ')');
        if (leaveDays[d]) fail_('วันที่ ' + d + ' มีใบลาที่อนุมัติแล้ว ไม่สามารถบันทึกมาสายซ้ำได้');
      });

      if (toDel.length) await db()`delete from late_records where id in ${db()(toDel.map(x => x.key))}`;
      const now = new Date();
      for (const d of toAdd) {
        await db()`insert into late_records (id, staff_id, name, date, note, by_name, at)
                   values (${uuid_()}, ${id}, ${name}, ${ymd_(new Date(ym.y, ym.m - 1, d))}, ${note}, ${adm.display}, ${now})`;
      }
      await audit_('admin:' + adm.username, 'LATE_SAVE', id, name + ' ' + ym.m + '/' + ym.y + ' เพิ่ม ' + toAdd.length + ' ลบ ' + toDel.length);
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

async function buildLeaveMap_(y, m) {
  const nameToId = {};
  (await staffRows_()).forEach(r => { nameToId[normName_(r.row[S.NAME]).toLowerCase()] = String(r.row[S.ID]); });
  const hol = await holidaySet_();
  const first = new Date(y, m - 1, 1), last = new Date(y, m, 0);
  const leaveMap = {};
  (await leaveRows_()).forEach(r => {
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

// ===================== STOCK API (ใช้ร่วมกับระบบอื่น) =====================
export function sameKey_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function stockStaffList_(system) {
  return api_(async () => ({
    staff: (await staffRows_())
      .filter(r => isTrue_(r.row[S.ACTIVE]) && (system === '*' || hasSys_(r.row, system)))
      .map(r => ({ id: r.row[S.ID], name: r.row[S.NAME] }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'th'))
  }));
}

export function stockVerify_(token, system) {
  return api_(async () => {
    const me = await requireStaff_(token, false, system);
    return { staff: { id: String(me.row[S.ID]), name: String(me.row[S.NAME]) } };
  });
}

export function stockAdminFns_() {
  return {
    adminSummary, adminListRequests, adminDecideRequest,
    adminListStaff, adminSaveStaff, adminResetStaffPin, adminDeleteStaff, adminUnlockStaff,
    adminListAdmins, adminAddAdmin, adminUpdateAdmin,
    adminChangeOwnPassword, adminResetAdminPassword, adminDeleteAdmin
  };
}

export function stockAdminVerify_(token, system) {
  return api_(async () => {
    const a = await requireAdmin_(token);
    if (system && (await adminSystems_(a.username)).indexOf(system) < 0) fail_('บัญชีนี้ไม่มีสิทธิ์ใช้ระบบนี้', 'FORBIDDEN');
    return { admin: { username: a.username, displayName: a.display } };
  });
}

// ===== ฟังก์ชันที่ไฟล์อื่นใช้ (ประกาศไว้ที่นี่เพื่อเลี่ยง import วน) =====
export async function adminSystems_(username) {
  const f = await findAdmin_(String(username || '').trim().toLowerCase());
  if (!f) return [];
  if (await isSuperAdmin_(username)) return Object.keys(SYS_COL).concat(['record']);
  const raw = f.row[ADMIN_SYSTEMS_COL - 1];
  const list = String(raw == null ? '' : raw).toLowerCase().split(/[,;\s]+/).filter(Boolean);
  return (list.indexOf('all') >= 0 || list.indexOf('*') >= 0) ? Object.keys(SYS_COL) : list;
}

export async function isSuperAdmin_(username) {
  const f = await findAdmin_(String(username || '').trim().toLowerCase());
  if (!f) return false;
  return isTrue_(f.row[ADMIN_SUPER_COL - 1]);
}

// LINE (อยู่ใน line.js) — ผูกแบบ late binding กัน import วน
let lineMod = null;
export function bindLine(m) { lineMod = m; }
export function lineNotify_(sys, text) { return lineMod ? lineMod.lineNotify_(sys, text) : 0; }
export function lineThaiDate_(d) { return d instanceof Date ? pad_(d.getDate()) + '/' + pad_(d.getMonth() + 1) + '/' + (d.getFullYear() + 543) : String(d || ''); }
