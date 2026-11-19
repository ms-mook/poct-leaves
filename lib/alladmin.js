/**
 * ระบบลา — ส่วนรองรับเว็บ "Admin Center" (เฉพาะผู้ดูแลใหญ่) — พอร์ตจาก AllAdminApi.gs
 */
import { db } from './db.js';
import {
  api_, fail_, audit_, isTrue_, tsStr_, ymd_, withLock_, requireAdmin_, findAdmin_, adminRows_, staffRows_, requestRows_,
  isLocked_, lockedSet_, clearFails_, endSession_, hasSys_, isSuperAdmin_, adminLogin, adminLogout, POSITIONS, STATUS,
  S, A, R, SYS_KEYS, ADMIN_SYSTEMS_COL, ADMIN_SUPER_COL, LINE_ADMIN_COL,
  adminListRequests, adminDecideRequest, adminListStaff, adminSaveStaff, adminResetStaffPin, adminDeleteStaff, adminUnlockStaff,
  adminChangeOwnPassword, adminResetAdminPassword, adminDeleteAdmin, adminAddAdmin, adminUpdateAdmin,
  adminGetLeaves, adminDecide, adminCancelLeave, adminReport, adminExportRows, getMonthlyLeaveMatrix, adminGetLate, adminSaveLateMonth
} from './core.js';
import { alladminLineStatus_, alladminLineCode_, alladminLineUnlink_, alladminLineTest_ } from './line.js';

export const ADMIN_SYS_KEYS = SYS_KEYS.concat(['record']);

export function alladminFns_() {
  return {
    adminListRequests, adminDecideRequest,
    adminListStaff, adminSaveStaff, adminResetStaffPin, adminDeleteStaff, adminUnlockStaff,
    adminChangeOwnPassword, adminResetAdminPassword, adminDeleteAdmin,
    alladminUnlockAdmin: alladminUnlockAdmin_,
    alladminListAdmins: alladminListAdmins_, alladminAddAdmin: alladminAddAdmin_, alladminUpdateAdmin: alladminUpdateAdmin_,
    alladminLineStatus: alladminLineStatus_, alladminLineCode: alladminLineCode_, alladminLineUnlink: alladminLineUnlink_, alladminLineTest: alladminLineTest_,
    alladminOverview: alladminOverview_, alladminAudit: alladminAudit_, alladminTrend: alladminTrend_,
    adminGetLeaves, adminDecide, adminCancelLeave, adminReport, adminExportRows,
    getMonthlyLeaveMatrix, adminGetLate, adminSaveLateMonth
  };
}

export async function alladminRoute_(body) {
  switch (body.action) {
    case 'positions':   return { ok: true, positions: POSITIONS };
    case 'adminLogin':  return alladminLogin_(body.username, body.password);
    case 'adminVerify': return alladminVerify_(body.token);
    case 'adminLogout': return adminLogout(body.token);
    case 'call': {
      const fns = alladminFns_();
      const f = Object.prototype.hasOwnProperty.call(fns, body.fn) ? fns[body.fn] : null;
      if (!f || !Array.isArray(body.args) || body.args.length < 1 || body.args.length > 6) return { ok: false, code: 'BAD_ACTION', message: 'คำสั่งไม่ถูกต้อง' };
      const v = await alladminVerify_(body.args[0]);
      if (!v.ok) return v;
      return f.apply(null, body.args);
    }
    default:            return { ok: false, code: 'BAD_ACTION', message: 'คำสั่งไม่ถูกต้อง' };
  }
}

async function alladminLogin_(username, password) {
  const r = await adminLogin(username, password);
  if (!r.ok) return r;
  if (!(await isSuperAdmin_(r.admin.username))) {
    await endSession_(r.token);
    await audit_('admin:' + r.admin.username, 'ALLADMIN_DENIED', r.admin.username, 'ไม่ใช่ผู้ดูแลใหญ่');
    return { ok: false, code: 'FORBIDDEN', message: 'บัญชีนี้ไม่มีสิทธิ์เข้า Admin Center (เฉพาะผู้ดูแลใหญ่)' };
  }
  await audit_('admin:' + r.admin.username, 'ALLADMIN_LOGIN', r.admin.username, '');
  return r;
}

function alladminVerify_(token) {
  return api_(async () => {
    const a = await requireAdmin_(token);
    if (!(await isSuperAdmin_(a.username))) fail_('ต้องเป็นผู้ดูแลใหญ่เท่านั้น', 'FORBIDDEN');
    return { admin: { username: a.username, displayName: a.display } };
  });
}

// ---------- ผู้ดูแล + สิทธิ์รายระบบ ----------
function rawSystemTokens_(raw) { return String(raw == null ? '' : raw).toLowerCase().split(/[,;\s]+/).filter(Boolean); }

export function adminSystemsList_(raw) {
  const list = rawSystemTokens_(raw);
  return (list.indexOf('all') >= 0 || list.indexOf('*') >= 0) ? ADMIN_SYS_KEYS.slice() : list.filter(k => ADMIN_SYS_KEYS.indexOf(k) >= 0);
}

function cleanSystems_(arr) {
  if (!Array.isArray(arr)) fail_('ข้อมูลสิทธิ์ระบบไม่ถูกต้อง');
  const out = [];
  arr.forEach(k => { k = String(k); if (ADMIN_SYS_KEYS.indexOf(k) < 0) fail_('ไม่รู้จักระบบ ' + k.slice(0, 20)); if (out.indexOf(k) < 0) out.push(k); });
  return out;
}

function systemsCell_(chosen, curRaw) {
  const extra = rawSystemTokens_(curRaw).filter(k => k !== 'all' && k !== '*' && ADMIN_SYS_KEYS.indexOf(k) < 0);
  const full = ADMIN_SYS_KEYS.every(k => chosen.indexOf(k) >= 0);
  return (full ? ['all'] : chosen).concat(extra).join(',');
}

function alladminListAdmins_(token) {
  return api_(async () => {
    await requireAdmin_(token);
    const rows = await adminRows_(), locked = await lockedSet_();
    return { rows: rows.map(r => ({ line: !!String(r.row[LINE_ADMIN_COL - 1] || '').trim(),
      username: String(r.row[A.USER]), displayName: String(r.row[A.DISPLAY]), active: isTrue_(r.row[A.ACTIVE]),
      created: tsStr_(r.row[A.CREATED]), systems: adminSystemsList_(r.row[ADMIN_SYSTEMS_COL - 1]),
      superAdmin: isTrue_(r.row[ADMIN_SUPER_COL - 1]), locked: !!locked['admin:' + String(r.row[A.USER]).toLowerCase()] })) };
  });
}

async function activeSuperCountExcept_(username) {
  return (await adminRows_()).filter(r => isTrue_(r.row[A.ACTIVE]) && isTrue_(r.row[ADMIN_SUPER_COL - 1]) && String(r.row[A.USER]).toLowerCase() !== username).length;
}

function alladminAddAdmin_(token, data) {
  return api_(async () => {
    const adm = await requireAdmin_(token);
    data = data || {};
    const systems = cleanSystems_(data.systems || []);
    const r = await adminAddAdmin(token, { username: data.username, displayName: data.displayName, password: data.password });
    if (!r.ok) return r;
    const username = String(data.username).trim().toLowerCase();
    return withLock_(async () => {
      const f = await findAdmin_(username);
      if (!f) fail_('สร้างบัญชีแล้วแต่หาแถวไม่พบ กรุณารีเฟรช');
      await db()`update admins set systems = ${systemsCell_(systems, '')}, super = ${data.superAdmin === true} where username = ${f.key}`;
      await audit_('admin:' + adm.username, 'ALLADMIN_ADMIN_SET', username, 'systems=' + systems.join(',') + ' super=' + (data.superAdmin === true));
      return { message: 'เพิ่มผู้ดูแล ' + username + ' แล้ว' };
    });
  });
}

function alladminUpdateAdmin_(token, data) {
  return api_(async () => {
    const adm = await requireAdmin_(token);
    data = data || {};
    const username = String(data.username || '').trim().toLowerCase();
    const systems = cleanSystems_(data.systems || []);
    const wantSuper = data.superAdmin === true, active = data.active === true;
    const f0 = await findAdmin_(username);
    if (!f0) fail_('ไม่พบผู้ดูแล');
    const wasSuper = isTrue_(f0.row[ADMIN_SUPER_COL - 1]);
    if (username === adm.username && !wantSuper) fail_('ไม่สามารถถอนสิทธิ์ผู้ดูแลใหญ่ของตัวเองได้');
    if (username === adm.username && !active) fail_('ไม่สามารถปิดการใช้งานบัญชีตัวเองได้');
    if (wasSuper && (!wantSuper || !active) && (await activeSuperCountExcept_(username)) < 1) fail_('ต้องเหลือผู้ดูแลใหญ่ที่ใช้งานได้อย่างน้อย 1 คน');
    const r = await adminUpdateAdmin(token, { username: username, displayName: data.displayName, active: active });
    if (!r.ok) return r;
    return withLock_(async () => {
      const f = await findAdmin_(username);
      if (!f) fail_('ไม่พบผู้ดูแล');
      if (!wantSuper && isTrue_(f.row[ADMIN_SUPER_COL - 1]) && (await activeSuperCountExcept_(username)) < 1) fail_('ต้องเหลือผู้ดูแลใหญ่ที่ใช้งานได้อย่างน้อย 1 คน');
      await db()`update admins set systems = ${systemsCell_(systems, f.row[ADMIN_SYSTEMS_COL - 1])}, super = ${wantSuper} where username = ${f.key}`;
      await audit_('admin:' + adm.username, 'ALLADMIN_ADMIN_SET', username, 'systems=' + systems.join(',') + ' super=' + wantSuper + ' active=' + active);
      return { message: 'แก้ไขเรียบร้อย' };
    });
  });
}

function alladminUnlockAdmin_(token, username) {
  return api_(async () => {
    const adm = await requireAdmin_(token);
    username = String(username || '').trim().toLowerCase();
    if (!(await findAdmin_(username))) fail_('ไม่พบผู้ดูแล');
    await clearFails_('admin:' + username);
    await audit_('admin:' + adm.username, 'ADMIN_UNLOCK', username, '');
    return { message: 'ปลดล็อก ' + username + ' แล้ว ลองเข้าสู่ระบบได้ทันที' };
  });
}

// ---------- ภาพรวม / audit ----------
function alladminOverview_(token) {
  return api_(async () => {
    await requireAdmin_(token);
    const staff = await staffRows_(), perSys = {}, locked = await lockedSet_();
    SYS_KEYS.forEach(k => { perSys[k] = staff.filter(r => isTrue_(r.row[S.ACTIVE]) && hasSys_(r.row, k)).length; });
    const admins = await adminRows_();
    let pending = 0;
    try { pending = (await requestRows_()).filter(r => r.row[R.STATUS] === STATUS.PENDING).length; } catch (e) { /* ไม่มีตาราง */ }
    return {
      staff: { total: staff.length, active: staff.filter(r => isTrue_(r.row[S.ACTIVE])).length,
               locked: staff.filter(r => locked['staff:' + r.row[S.ID]] || locked['pin:' + r.row[S.ID]]).length,
               defaultPin: staff.filter(r => isTrue_(r.row[S.ACTIVE]) && isTrue_(r.row[S.MUST])).length, perSys: perSys },
      admins: { total: admins.length, active: admins.filter(r => isTrue_(r.row[A.ACTIVE])).length,
                supers: admins.filter(r => isTrue_(r.row[A.ACTIVE]) && isTrue_(r.row[ADMIN_SUPER_COL - 1])).length },
      pendingRequests: pending,
      security: await securityCounts_()
    };
  });
}

function auditKind_(action) {
  const a = String(action || '').toUpperCase();
  if (/DENIED|FAIL|REJECT|BAD_|LOCKED|SUPER_ONLY|NO_ACCESS|MUST_CHANGE|API_KEY_REJECTED/.test(a)) return 'fail';
  if (/LOGIN|LOGOUT/.test(a)) return 'login';
  if (/ADD|UPDATE|DELETE|RESET|UNLOCK|_SET|MIGRATE|CHANGE|IMPORT|CLEAR|CREATED|FIRST_SET|REPAIR|CANCEL|SUBMIT|REQUEST/.test(a)) return 'change';
  return 'other';
}
const AUDIT_PREFIX_SYS_ = { LEAVE_: 'leave', STOCK_: 'stock', STOCKCENTER_: 'stockcenter', INCIDENT_: 'incident', BLOODGAS_: 'bloodgas', GLUCOSE_: 'glucose', RECORD_: 'record' };
function auditSys_(action, detail) {
  const a = String(action || '').toUpperCase();
  const keys = Object.keys(AUDIT_PREFIX_SYS_);
  for (let i = 0; i < keys.length; i++) if (a.indexOf(keys[i]) === 0) return AUDIT_PREFIX_SYS_[keys[i]];
  const d = String(detail || '').trim().toLowerCase();
  if (a === 'STAFF_LOGIN' && ADMIN_SYS_KEYS.indexOf(d) >= 0) return d;
  return '';
}

/** แถวล่าสุดของ AuditLog ไม่เกิน n แถว (ใหม่สุดก่อน) + จำนวนทั้งหมด */
async function auditTail_(n) {
  const rows = await db()`select ts, actor, action, target, detail from audit_log order by seq desc limit ${n}`;
  const total = Number((await db()`select count(*)::int as c from audit_log`)[0].c);
  return { rows: rows.map(r => [r.ts, r.actor, r.action, r.target, r.detail]), total };
}

async function securityCounts_() {
  try {
    const t = await auditTail_(1000);
    if (!t.total) return { fail24h: 0, scanned: 0 };
    const since = Date.now() - 24 * 3600e3;
    let n = 0;
    for (const v of t.rows) {
      const ts = v[0] instanceof Date ? v[0].getTime() : NaN;
      if (!isNaN(ts) && ts < since) break;
      if (auditKind_(v[2]) === 'fail') n++;
    }
    return { fail24h: n, scanned: t.rows.length };
  } catch (e) { return { fail24h: 0, scanned: 0 }; }
}

const AUDIT_MAX_ = 400;

function alladminTrend_(token, days) {
  return api_(async () => {
    await requireAdmin_(token);
    days = Math.max(7, Math.min(Math.floor(Number(days)) || 14, 30));
    const now = Date.now(), day = 86400000, keyOf = t => ymd_(new Date(t));
    const list = [], idx = {};
    for (let i = days - 1; i >= 0; i--) { const k = keyOf(now - i * day); idx[k] = list.length; list.push({ date: k, login: 0, change: 0, fail: 0, other: 0 }); }
    const bySys = {}, byKind = { login: 0, change: 0, fail: 0, other: 0 };
    const t = await auditTail_(3000);
    if (!t.total) return { days: list, bySys: bySys, byKind: byKind, scanned: 0, covered: true };
    const since = now - days * day;
    let covered = t.rows.length === t.total;
    for (const v of t.rows) {
      const ts = v[0] instanceof Date ? v[0].getTime() : NaN;
      if (isNaN(ts)) continue;
      if (ts < since) { covered = true; break; }
      const k = idx[keyOf(ts)]; if (k === undefined) continue;
      const kind = auditKind_(v[2]); list[k][kind]++; byKind[kind]++;
      const sy = auditSys_(v[2], v[4]); if (sy) bySys[sy] = (bySys[sy] || 0) + 1;
    }
    return { days: list, bySys: bySys, byKind: byKind, scanned: t.rows.length, covered: covered };
  });
}

function alladminAudit_(token, filter) {
  return api_(async () => {
    await requireAdmin_(token);
    filter = filter || {};
    const t = await auditTail_(3000);
    if (!t.total) return { rows: [], scanned: 0 };
    const q = String(filter.q || '').trim().toLowerCase().slice(0, 60), act = String(filter.action || '').trim().slice(0, 60);
    const limit = Math.max(1, Math.min(Number(filter.limit) || 100, AUDIT_MAX_));
    const kind = String(filter.kind || '').trim(), sysF = String(filter.sys || '').trim();
    const out = [];
    for (const v of t.rows) {
      if (out.length >= limit) break;
      const text = (String(v[1]) + ' ' + String(v[2]) + ' ' + String(v[3]) + ' ' + String(v[4])).toLowerCase();
      if (act && String(v[2]) !== act) continue;
      if (q && text.indexOf(q) < 0) continue;
      const k = auditKind_(v[2]), sy = auditSys_(v[2], v[4]);
      if (kind && k !== kind) continue;
      if (sysF && sy !== sysF) continue;
      out.push({ ts: tsStr_(v[0]), actor: String(v[1]), action: String(v[2]), target: String(v[3]), detail: String(v[4]), kind: k, sys: sy });
    }
    return { rows: out, scanned: t.rows.length };
  });
}
