/**
 * แทน doPost ของ Apps Script (IncidentApi.gs + RecordApi.gs + BloodgasApi.gs + GlucoseApi.gs)
 * ระบบอื่น (Stock, Stock คลังกลาง, Incident, Record, Blood Gas, Glucose, Admin Center) POST JSON รูปแบบเดิมมาที่ /api/exec ได้ทันที
 */
import { db } from './db.js';
import {
  api_, fail_, audit_, prop_, sameKey_, cacheGet_, cachePut_, withLock_, requireAdmin_, findStaff_, requestRows_,
  findAdmin_, adminSystems_, endSession_, isTrue_, POSITIONS, STATUS, SYS_COL, S, R,
  staffLogin_, staffChangePin_, staffLogout, requestStaffAccess, adminLogin, adminLogout,
  stockStaffList_, stockVerify_, stockAdminFns_, stockAdminVerify_,
  adminListRequests, adminDecideRequest, adminListStaff, adminSaveStaff, adminResetStaffPin, adminDeleteStaff, adminUnlockStaff,
  adminListAdmins, adminAddAdmin, adminUpdateAdmin, adminChangeOwnPassword, adminResetAdminPassword, adminDeleteAdmin
} from './core.js';
import { alladminRoute_ } from './alladmin.js';
import { lineWebhook_, lineNotifyRoute_ } from './line.js';

const INCIDENT_SYSTEM = 'incident', RECORD_SYSTEM = 'record', BLOODGAS_SYSTEM = 'bloodgas', GLUCOSE_SYSTEM = 'glucose';
const ADMIN_SYSTEMS_COL = 7;

/** body = JSON ที่ระบบอื่นส่งมา, query = พารามิเตอร์ใน URL (ใช้ ?k= ของ LINE webhook) */
export async function doPost(body, query) {
  try {
    body = body && typeof body === 'object' ? body : {};
    if (Array.isArray(body.events) && !body.key) {
      const wk = prop_('LINE_WEBHOOK_KEY'), qk = query && query.k;
      if (!wk || typeof qk !== 'string' || !sameKey_(qk, wk)) { await noteRejectedKey_(); return { ok: false, code: 'FORBIDDEN', message: 'ไม่อนุญาต' }; }
      return lineWebhook_(body);
    }
    const caller = identifyCaller_(body.key);
    if (!caller) {
      await noteRejectedKey_();
      return { ok: false, code: 'FORBIDDEN', message: 'ไม่อนุญาต' };
    }
    if (body.action === 'notify') return lineNotifyRoute_(caller, body);
    return caller === 'incident' ? incidentRoute_(body)
         : caller === 'record' ? recordRoute_(body)
         : caller === 'bloodgas' ? bloodgasRoute_(body)
         : caller === 'glucose' ? glucoseRoute_(body)
         : caller === 'alladmin' ? alladminRoute_(body)
         : stockRoute_(body);
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return { ok: false, code: 'SERVER', message: 'ระบบขัดข้อง' };
  }
}

function identifyCaller_(key) {
  if (typeof key !== 'string' || !key) return null;
  const k = n => prop_(n);
  const stockKey = k('STOCK_API_KEY'), incKey = k('INCIDENT_API_KEY'), recKey = k('RECORD_API_KEY'),
        bgKey = k('BLOODGAS_API_KEY'), glKey = k('GLUCOSE_API_KEY'), aaKey = k('ALLADMIN_API_KEY');
  const isStock = !!stockKey && sameKey_(key, stockKey);
  const isInc = !!incKey && sameKey_(key, incKey);
  const isRec = !!recKey && sameKey_(key, recKey);
  const isBg = !!bgKey && sameKey_(key, bgKey);
  const isGl = !!glKey && sameKey_(key, glKey);
  const isAa = !!aaKey && sameKey_(key, aaKey);
  if (isStock) return 'stock';
  if (isInc) return 'incident';
  if (isRec) return 'record';
  if (isBg) return 'bloodgas';
  if (isGl) return 'glucose';
  if (isAa) return 'alladmin';
  return null;
}

async function noteRejectedKey_() {
  const n = Number((await cacheGet_('APIKEYFAIL')) || 0);
  if (n < 20) await audit_('api', 'API_KEY_REJECTED', '', '');
  await cachePut_('APIKEYFAIL', String(n + 1), 3600);
}

async function callFn_(fns, body, verify) {
  const f = Object.prototype.hasOwnProperty.call(fns, body.fn) ? fns[body.fn] : null;
  if (!f || !Array.isArray(body.args) || body.args.length < 1 || body.args.length > 6) return { ok: false, code: 'BAD_ACTION', message: 'คำสั่งไม่ถูกต้อง' };
  const v = await verify(body.args[0]);
  if (!v.ok) return v;
  return f.apply(null, body.args);
}

// ===================== Stock / Stock คลังกลาง =====================
async function stockRoute_(body) {
  const sys = body.system === 'stockcenter' ? 'stockcenter' : 'stock';
  switch (body.action) {
    case 'staffList':          return stockStaffList_(sys);
    case 'login':              return staffLogin_(body.staffId, body.pin, sys);
    case 'changePin':          return staffChangePin_(body.token, body.oldPin, body.newPin, sys);
    case 'verify':             return stockVerify_(body.token, sys);
    case 'logout':             return staffLogout(body.token);
    case 'positions':          return { ok: true, positions: POSITIONS };
    case 'requestAccess':      return requestStaffAccess(body.name, body.position, body.contact);
    case 'adminLogin':         return stockAdminLogin_(body.username, body.password, sys);
    case 'adminLogout':        return adminLogout(body.token);
    case 'adminListRequests':  { const g = await stockAdminVerify_(body.token, sys); return g.ok ? adminListRequests(body.token, body.status) : g; }
    case 'adminDecideRequest': { const g = await stockAdminVerify_(body.token, sys); return g.ok ? adminDecideRequest(body.token, body.requestId, body.decision, body.note) : g; }
    case 'adminVerify':        return stockAdminVerify_(body.token, sys);
    case 'call':               return callFn_(stockAdminFns_(), body, t => stockAdminVerify_(t, sys));
    default:                   return { ok: false, code: 'BAD_ACTION', message: 'คำสั่งไม่ถูกต้อง' };
  }
}

async function stockAdminLogin_(username, password, system) {
  const r = await adminLogin(username, password);
  if (!r.ok) return r;
  if ((await adminSystems_(r.admin.username)).indexOf(system) < 0) {
    await endSession_(r.token);
    await audit_('admin:' + r.admin.username, 'STOCK_DENIED', r.admin.username, 'ไม่มีสิทธิ์ ' + system);
    return { ok: false, code: 'FORBIDDEN', message: 'บัญชีนี้ไม่มีสิทธิ์ใช้ระบบนี้ กรุณาติดต่อผู้ดูแลใหญ่' };
  }
  return r;
}

// ===================== อุบัติการณ์ =====================
function incidentAdminFns_() {
  return {
    adminListRequests, adminDecideRequest,
    adminListStaff, adminSaveStaff, adminResetStaffPin, adminDeleteStaff, adminUnlockStaff,
    adminListAdmins, adminAddAdmin, adminUpdateAdmin,
    adminChangeOwnPassword, adminResetAdminPassword, adminDeleteAdmin
  };
}

async function incidentRoute_(body) {
  switch (body.action) {
    case 'staffList':     return stockStaffList_(INCIDENT_SYSTEM);
    case 'staffListAll':  return stockStaffList_('*');
    case 'login':         return staffLogin_(body.staffId, body.pin, INCIDENT_SYSTEM);
    case 'changePin':     return staffChangePin_(body.token, body.oldPin, body.newPin, INCIDENT_SYSTEM);
    case 'verify':        return stockVerify_(body.token, INCIDENT_SYSTEM);
    case 'logout':        return staffLogout(body.token);
    case 'positions':     return { ok: true, positions: POSITIONS };
    case 'requestAccess': return requestStaffAccess(body.name, body.position, body.contact);
    case 'adminLogin':    return sysAdminLogin_(body.username, body.password, INCIDENT_SYSTEM, 'INCIDENT', 'บัญชีนี้ไม่มีสิทธิ์ใช้ระบบอุบัติการณ์ กรุณาติดต่อผู้ดูแล');
    case 'adminVerify':   return sysAdminVerify_(body.token, INCIDENT_SYSTEM, 'ไม่มีสิทธิ์ใช้ระบบอุบัติการณ์');
    case 'adminLogout':   return adminLogout(body.token);
    case 'call':          return callFn_(incidentAdminFns_(), body, t => sysAdminVerify_(t, INCIDENT_SYSTEM, 'ไม่มีสิทธิ์ใช้ระบบอุบัติการณ์'));
    default:              return { ok: false, code: 'BAD_ACTION', message: 'คำสั่งไม่ถูกต้อง' };
  }
}

/** แบบเดียวกับ incidentAdminLogin_/bloodgasAdminLogin_/glucoseAdminLogin_ ของเดิม */
async function sysAdminLogin_(username, password, system, tag, deniedMsg) {
  const r = await adminLogin(username, password);
  if (!r.ok) return r;
  if ((await adminSystems_(r.admin.username)).indexOf(system) < 0) {
    await endSession_(r.token);
    await audit_('admin:' + r.admin.username, tag + '_DENIED', r.admin.username, 'ไม่มีสิทธิ์ ' + system);
    return { ok: false, code: 'FORBIDDEN', message: deniedMsg };
  }
  await audit_('admin:' + r.admin.username, tag + '_ADMIN_LOGIN', r.admin.username, '');
  return r;
}

function sysAdminVerify_(token, system, deniedMsg) {
  return api_(async () => {
    const a = await requireAdmin_(token);
    if ((await adminSystems_(a.username)).indexOf(system) < 0) fail_(deniedMsg, 'FORBIDDEN');
    return { admin: { username: a.username, displayName: a.display } };
  });
}

// ===================== Record Specimen =====================
async function recordRoute_(body) {
  switch (body.action) {
    case 'adminLogin': return recordAdminLogin_(body.username, body.password);
    default:           return { ok: false, code: 'BAD_ACTION', message: 'คำสั่งไม่ถูกต้อง' };
  }
}

async function adminHasSystem_(username, system) {
  const f = await findAdmin_(String(username || '').trim().toLowerCase());
  if (!f) return false;
  const raw = f.row[ADMIN_SYSTEMS_COL - 1];
  const list = String(raw == null ? '' : raw).toLowerCase().split(/[,;\s]+/).filter(Boolean);
  return list.indexOf('all') >= 0 || list.indexOf('*') >= 0 || list.indexOf(system) >= 0;
}

async function recordAdminLogin_(username, password) {
  const r = await adminLogin(username, password);
  if (!r.ok) return r;
  await endSession_(r.token);
  if (!(await adminHasSystem_(r.admin.username, RECORD_SYSTEM))) {
    await audit_('admin:' + r.admin.username, 'RECORD_DENIED', r.admin.username, 'ไม่มีสิทธิ์ record');
    return { ok: false, code: 'FORBIDDEN', message: 'บัญชีนี้ไม่มีสิทธิ์ใช้ระบบบันทึกสิ่งส่งตรวจ กรุณาติดต่อผู้ดูแล' };
  }
  await audit_('admin:' + r.admin.username, 'RECORD_ADMIN_LOGIN', r.admin.username, '');
  return { ok: true, admin: r.admin };
}

// ===================== Blood Gas =====================
function bloodgasAdminFns_() {
  return { adminListStaff, adminSaveStaff, adminDeleteStaff, adminResetStaffPin, adminListRequests, adminChangeOwnPassword,
           bloodgasSetAccess, bloodgasSetSystem, bloodgasDecideRequest };
}

async function bloodgasRoute_(body) {
  const deny = 'ไม่มีสิทธิ์ใช้ระบบ Blood Gas';
  switch (body.action) {
    case 'staffList':     return stockStaffList_(BLOODGAS_SYSTEM);
    case 'login':         return staffLogin_(body.staffId, body.pin, BLOODGAS_SYSTEM);
    case 'changePin':     return staffChangePin_(body.token, body.oldPin, body.newPin, BLOODGAS_SYSTEM);
    case 'verify':        return stockVerify_(body.token, BLOODGAS_SYSTEM);
    case 'logout':        return staffLogout(body.token);
    case 'positions':     return { ok: true, positions: POSITIONS };
    case 'requestAccess': return requestStaffAccess(body.name, body.position, body.contact);
    case 'adminLogin':    return sysAdminLogin_(body.username, body.password, BLOODGAS_SYSTEM, 'BLOODGAS', 'บัญชีนี้ไม่มีสิทธิ์ใช้ระบบ Blood Gas กรุณาติดต่อผู้ดูแล');
    case 'adminVerify':   return sysAdminVerify_(body.token, BLOODGAS_SYSTEM, deny);
    case 'adminLogout':   return adminLogout(body.token);
    case 'call':          return callFn_(bloodgasAdminFns_(), body, t => sysAdminVerify_(t, BLOODGAS_SYSTEM, deny));
    default:              return { ok: false, code: 'BAD_ACTION', message: 'คำสั่งไม่ถูกต้อง' };
  }
}

async function setStaffFlag_(token, staffId, col, enabled, onTag, offTag, label) {
  const adm = await requireAdmin_(token);
  return withLock_(async () => {
    const f = await findStaff_(String(staffId || ''));
    if (!f) fail_('ไม่พบพนักงาน');
    await db()`update staff set ${db()({ [col]: enabled === true })} where id = ${f.key}`;
    await audit_('admin:' + adm.username, enabled === true ? onTag : offTag, f.row[S.ID], f.row[S.NAME]);
    return { message: (enabled === true ? 'เปิดสิทธิ์ ' + label + ' ให้ ' : 'ปิดสิทธิ์ ' + label + ' ของ ') + f.row[S.NAME] + ' แล้ว' };
  });
}

function bloodgasSetAccess(token, staffId, enabled) {
  return api_(() => setStaffFlag_(token, staffId, 'sys_bloodgas', enabled, 'BLOODGAS_ON', 'BLOODGAS_OFF', 'Blood Gas'));
}

const SYS_DB = { leave: 'sys_leave', stock: 'sys_stock', stockcenter: 'sys_stockcenter', incident: 'sys_incident', bloodgas: 'sys_bloodgas', glucose: 'sys_glucose' };
function bloodgasSetSystem(token, staffId, system, enabled) {
  return api_(async () => {
    const adm = await requireAdmin_(token);
    system = String(system || '');
    if (!Object.prototype.hasOwnProperty.call(SYS_COL, system)) fail_('ไม่รู้จักระบบนี้');
    return withLock_(async () => {
      const f = await findStaff_(String(staffId || ''));
      if (!f) fail_('ไม่พบพนักงาน');
      await db()`update staff set ${db()({ [SYS_DB[system]]: enabled === true })} where id = ${f.key}`;
      await audit_('admin:' + adm.username, (enabled === true ? 'SYS_ON ' : 'SYS_OFF ') + system, f.row[S.ID], f.row[S.NAME]);
      return { message: (enabled === true ? 'เปิดสิทธิ์ ' : 'ปิดสิทธิ์ ') + system + ' ให้ ' + f.row[S.NAME] + ' แล้ว' };
    });
  });
}

async function bloodgasDecideRequest(token, requestId, decision, note) {
  const r = await adminDecideRequest(token, requestId, decision, note);
  if (!r.ok || decision !== STATUS.APPROVED) return r;
  try {
    const req = (await requestRows_()).find(x => x.row[R.ID] === String(requestId || ''));
    const staffId = req ? String(req.row[R.STAFFID] || '') : '';
    const st = staffId ? await findStaff_(staffId) : null;
    if (st) {
      await db()`update staff set sys_bloodgas = true where id = ${st.key}`;
      await audit_('admin:' + (await requireAdmin_(token)).username, 'BLOODGAS_ON', staffId, st.row[S.NAME] + ' (จากการอนุมัติคำขอ)');
      r.message = (r.message || '') + ' และเปิดสิทธิ์ Blood Gas ให้แล้ว';
    }
  } catch (e) {
    console.error('bloodgasDecideRequest: ' + (e && e.stack ? e.stack : e));
    r.message = (r.message || '') + ' (แต่เปิดสิทธิ์ Blood Gas ไม่สำเร็จ กรุณาเปิดที่แท็บพนักงาน)';
  }
  return r;
}

// ===================== Glucose =====================
function glucoseAdminFns_() {
  return { adminListStaff, adminSaveStaff, adminDeleteStaff, adminUnlockStaff, adminResetStaffPin, adminChangeOwnPassword, glucoseSetAccess };
}

async function glucoseRoute_(body) {
  const deny = 'ไม่มีสิทธิ์ใช้ระบบสต๊อกน้ำยา Glucose';
  switch (body.action) {
    case 'staffList':   return stockStaffList_(GLUCOSE_SYSTEM);
    case 'positions':   return { ok: true, positions: POSITIONS };
    case 'login':       return staffLogin_(body.staffId, body.pin, GLUCOSE_SYSTEM);
    case 'changePin':   return staffChangePin_(body.token, body.oldPin, body.newPin, GLUCOSE_SYSTEM);
    case 'verify':      return stockVerify_(body.token, GLUCOSE_SYSTEM);
    case 'logout':      return staffLogout(body.token);
    case 'adminLogin':  return sysAdminLogin_(body.username, body.password, GLUCOSE_SYSTEM, 'GLUCOSE', 'บัญชีนี้ไม่มีสิทธิ์ใช้ระบบสต๊อกน้ำยา Glucose กรุณาติดต่อผู้ดูแล');
    case 'adminVerify': return sysAdminVerify_(body.token, GLUCOSE_SYSTEM, deny);
    case 'adminLogout': return adminLogout(body.token);
    case 'call':        return callFn_(glucoseAdminFns_(), body, t => sysAdminVerify_(t, GLUCOSE_SYSTEM, deny));
    default:            return { ok: false, code: 'BAD_ACTION', message: 'คำสั่งไม่ถูกต้อง' };
  }
}

function glucoseSetAccess(token, staffId, enabled) {
  return api_(() => setStaffFlag_(token, staffId, 'sys_glucose', enabled, 'GLUCOSE_ON', 'GLUCOSE_OFF', 'Glucose'));
}
