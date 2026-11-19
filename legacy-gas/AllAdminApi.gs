/**
 * ระบบลา — ส่วนรองรับเว็บ "Admin Center" (เฉพาะผู้ดูแลใหญ่)
 * ใช้คู่กับ IncidentApi.gs (doPost ส่งต่อมาที่ alladminRoute_ ของไฟล์นี้) และ code.gs
 *
 * หลักการ:
 *  - ผู้ดูแลใหญ่ = แถวในชีต Admins ที่คอลัมน์ H (Super) เป็น TRUE ; เข้า Admin Center ได้เฉพาะคนกลุ่มนี้
 *  - สร้าง/แก้ผู้ดูแล (รวมกำหนดสิทธิ์รายระบบในคอลัมน์ G) ทำได้ผ่านเส้นทางนี้เท่านั้นที่ตรวจว่าเป็นผู้ดูแลใหญ่
 *  - ทุกคำสั่งตรวจ token ผู้ดูแล + ความเป็นผู้ดูแลใหญ่ใหม่ทุกครั้ง ; ใช้ฟังก์ชัน admin เดิมของระบบลา กฎและ audit จึงเหมือนเดิม
 */

const ALLADMIN_SYSTEM = 'alladmin';
const ADMIN_SUPER_COL = 8;   // คอลัมน์ H ของชีต Admins
const ADMIN_SYS_KEYS = SYS_KEYS.concat(['record']);   // ระบบที่กำหนดสิทธิ์ Admin ได้ (record ใช้คอลัมน์ G เหมือนกัน)

function alladminFns_() {
  return {
    adminListRequests: adminListRequests, adminDecideRequest: adminDecideRequest,
    adminListStaff: adminListStaff, adminSaveStaff: adminSaveStaff, adminResetStaffPin: adminResetStaffPin,
    adminDeleteStaff: adminDeleteStaff, adminUnlockStaff: adminUnlockStaff,
    adminChangeOwnPassword: adminChangeOwnPassword, adminResetAdminPassword: adminResetAdminPassword, adminDeleteAdmin: adminDeleteAdmin,
    alladminUnlockAdmin: alladminUnlockAdmin_,
    alladminListAdmins: alladminListAdmins_, alladminAddAdmin: alladminAddAdmin_, alladminUpdateAdmin: alladminUpdateAdmin_,
    alladminLineStatus: alladminLineStatus_, alladminLineCode: alladminLineCode_, alladminLineUnlink: alladminLineUnlink_, alladminLineTest: alladminLineTest_,
    alladminOverview: alladminOverview_, alladminAudit: alladminAudit_, alladminTrend: alladminTrend_,
    // หน้า "ระบบแจ้งลา" ใน Admin Center (ดูรายการลา อนุมัติ รายงาน ตารางสรุป มาสาย)
    adminGetLeaves: adminGetLeaves, adminDecide: adminDecide, adminCancelLeave: adminCancelLeave, adminReport: adminReport, adminExportRows: adminExportRows,
    getMonthlyLeaveMatrix: getMonthlyLeaveMatrix, adminGetLate: adminGetLate, adminSaveLateMonth: adminSaveLateMonth
  };
}

function alladminRoute_(body) {
  switch (body.action) {
    case 'positions':   return { ok: true, positions: POSITIONS };
    case 'adminLogin':  return alladminLogin_(body.username, body.password);
    case 'adminVerify': return alladminVerify_(body.token);
    case 'adminLogout': return adminLogout(body.token);
    case 'call': {
      const fns = alladminFns_();
      const f = Object.prototype.hasOwnProperty.call(fns, body.fn) ? fns[body.fn] : null;
      if (!f || !Array.isArray(body.args) || body.args.length < 1 || body.args.length > 6) return { ok: false, code: 'BAD_ACTION', message: 'คำสั่งไม่ถูกต้อง' };
      const v = alladminVerify_(body.args[0]);          // token ต้องเป็นผู้ดูแลใหญ่ ตรวจสดทุกครั้ง
      if (!v.ok) return v;
      return f.apply(null, body.args);
    }
    default:            return { ok: false, code: 'BAD_ACTION', message: 'คำสั่งไม่ถูกต้อง' };
  }
}

// ---------- สิทธิ์ผู้ดูแลใหญ่ ----------
function isSuperAdmin_(username) {
  const f = findAdmin_(String(username || '').trim().toLowerCase());
  if (!f) return false;
  return isTrue_(sheet_(CFG.SHEET.ADMINS).getRange(f.rowNum, ADMIN_SUPER_COL).getValue());
}

function alladminLogin_(username, password) {
  const r = adminLogin(username, password);            // ตรวจรหัสผ่าน/ล็อกเมื่อผิดหลายครั้ง ตามกลไกเดิม
  if (!r.ok) return r;
  if (!isSuperAdmin_(r.admin.username)) {
    endSession_(r.token);
    audit_('admin:' + r.admin.username, 'ALLADMIN_DENIED', r.admin.username, 'ไม่ใช่ผู้ดูแลใหญ่');
    return { ok: false, code: 'FORBIDDEN', message: 'บัญชีนี้ไม่มีสิทธิ์เข้า Admin Center (เฉพาะผู้ดูแลใหญ่)' };
  }
  audit_('admin:' + r.admin.username, 'ALLADMIN_LOGIN', r.admin.username, '');
  return r;
}

function alladminVerify_(token) {
  return api_(() => {
    const a = requireAdmin_(token);
    if (!isSuperAdmin_(a.username)) fail_('ต้องเป็นผู้ดูแลใหญ่เท่านั้น', 'FORBIDDEN');
    return { admin: { username: a.username, displayName: a.display } };
  });
}

// ---------- ผู้ดูแล + สิทธิ์รายระบบ ----------
function rawSystemTokens_(raw) { return String(raw == null ? '' : raw).toLowerCase().split(/[,;\s]+/).filter(Boolean); }

/** ค่าในคอลัมน์ G -> รายชื่อระบบที่รู้จัก ("all" = ทุกระบบ) */
function adminSystemsList_(raw) {
  const list = rawSystemTokens_(raw);
  return (list.indexOf('all') >= 0 || list.indexOf('*') >= 0) ? ADMIN_SYS_KEYS.slice() : list.filter(k => ADMIN_SYS_KEYS.indexOf(k) >= 0);
}

function cleanSystems_(arr) {
  if (!Array.isArray(arr)) fail_('ข้อมูลสิทธิ์ระบบไม่ถูกต้อง');
  const out = [];
  arr.forEach(k => { k = String(k); if (ADMIN_SYS_KEYS.indexOf(k) < 0) fail_('ไม่รู้จักระบบ ' + k.slice(0, 20)); if (out.indexOf(k) < 0) out.push(k); });
  return out;
}

/** แปลงรายการที่เลือกเป็นค่าที่เก็บในคอลัมน์ G: เลือกครบทุกระบบ = "all" (ระบบใหม่ในอนาคตจะได้สิทธิ์ตามอัตโนมัติ)
 *  และคงคำที่ระบบนี้ไม่รู้จักไว้ตามเดิม ไม่ลบทิ้งเงียบ ๆ */
function systemsCell_(chosen, curRaw) {
  const extra = rawSystemTokens_(curRaw).filter(k => k !== 'all' && k !== '*' && ADMIN_SYS_KEYS.indexOf(k) < 0);
  const full = ADMIN_SYS_KEYS.every(k => chosen.indexOf(k) >= 0);
  return (full ? ['all'] : chosen).concat(extra).join(',');
}

function readAdminRows_() {
  const sh = sheet_(CFG.SHEET.ADMINS), n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, ADMIN_SUPER_COL).getValues().map((row, i) => ({ rowNum: i + 2, row: row }));
}

function alladminListAdmins_(token) {
  return api_(() => {
    requireAdmin_(token);
    const lineSet = {}; try { lineAdminRows_().forEach(r => { if (String(r.row[LINE_ADMIN_COL - 1] || '').trim()) lineSet[String(r.row[A.USER]).toLowerCase()] = 1; }); } catch (e) {}
    return { rows: readAdminRows_().map(r => ({ line: !!lineSet[String(r.row[A.USER]).toLowerCase()],
      username: String(r.row[A.USER]), displayName: String(r.row[A.DISPLAY]), active: isTrue_(r.row[A.ACTIVE]),
      created: tsStr_(r.row[A.CREATED]), systems: adminSystemsList_(r.row[ADMIN_SYSTEMS_COL - 1]),
      superAdmin: isTrue_(r.row[ADMIN_SUPER_COL - 1]), locked: isLocked_('admin:' + String(r.row[A.USER]).toLowerCase()) })) };
  });
}

function activeSuperCountExcept_(username) {
  return readAdminRows_().filter(r => isTrue_(r.row[A.ACTIVE]) && isTrue_(r.row[ADMIN_SUPER_COL - 1]) && String(r.row[A.USER]).toLowerCase() !== username).length;
}

function ensureSuperHeader_() {
  const sh = sheet_(CFG.SHEET.ADMINS);
  if (!String(sh.getRange(1, ADMIN_SUPER_COL).getValue()).trim()) sh.getRange(1, ADMIN_SUPER_COL).setValue('Super').setFontWeight('bold');
  if (!String(sh.getRange(1, ADMIN_SYSTEMS_COL).getValue()).trim()) sh.getRange(1, ADMIN_SYSTEMS_COL).setValue('Systems').setFontWeight('bold');
}

/** data: {username, displayName, password, systems[], superAdmin} */
function alladminAddAdmin_(token, data) {
  return api_(() => {
    const adm = requireAdmin_(token);
    data = data || {};
    const systems = cleanSystems_(data.systems || []);
    const r = adminAddAdmin(token, { username: data.username, displayName: data.displayName, password: data.password });
    if (!r.ok) return r;                                  // ตรวจชื่อ/รหัสผ่านซ้ำใช้กฎเดิมทั้งหมด (ไม่มีอะไรถูกเขียน)
    const username = String(data.username).trim().toLowerCase();
    return withLock_(() => {
      ensureSuperHeader_();
      const f = findAdmin_(username), sh = sheet_(CFG.SHEET.ADMINS);
      if (!f) fail_('สร้างบัญชีแล้วแต่หาแถวไม่พบ กรุณารีเฟรช');
      sh.getRange(f.rowNum, ADMIN_SYSTEMS_COL).setValue(systemsCell_(systems, ''));
      sh.getRange(f.rowNum, ADMIN_SUPER_COL).setValue(data.superAdmin === true);
      audit_('admin:' + adm.username, 'ALLADMIN_ADMIN_SET', username, 'systems=' + systems.join(',') + ' super=' + (data.superAdmin === true));
      return { message: 'เพิ่มผู้ดูแล ' + username + ' แล้ว' };
    });
  });
}

/** data: {username, displayName, active, systems[], superAdmin} */
function alladminUpdateAdmin_(token, data) {
  return api_(() => {
    const adm = requireAdmin_(token);
    data = data || {};
    const username = String(data.username || '').trim().toLowerCase();
    const systems = cleanSystems_(data.systems || []);
    const wantSuper = data.superAdmin === true, active = data.active === true;
    const f0 = findAdmin_(username);
    if (!f0) fail_('ไม่พบผู้ดูแล');
    const wasSuper = isTrue_(sheet_(CFG.SHEET.ADMINS).getRange(f0.rowNum, ADMIN_SUPER_COL).getValue());
    if (username === adm.username && !wantSuper) fail_('ไม่สามารถถอนสิทธิ์ผู้ดูแลใหญ่ของตัวเองได้');
    if (username === adm.username && !active) fail_('ไม่สามารถปิดการใช้งานบัญชีตัวเองได้');
    if (wasSuper && (!wantSuper || !active) && activeSuperCountExcept_(username) < 1) fail_('ต้องเหลือผู้ดูแลใหญ่ที่ใช้งานได้อย่างน้อย 1 คน');
    const r = adminUpdateAdmin(token, { username: username, displayName: data.displayName, active: active });   // ชื่อที่แสดง/เปิดปิด ใช้กฎเดิม (ล็อกในตัวเอง)
    if (!r.ok) return r;
    return withLock_(() => {
      ensureSuperHeader_();
      const f = findAdmin_(username);
      if (!f) fail_('ไม่พบผู้ดูแล');
      const sh = sheet_(CFG.SHEET.ADMINS);
      // ตรวจซ้ำ "ต้องเหลือผู้ดูแลใหญ่" ภายใต้ล็อก กันสองคนถอนสิทธิ์กันพร้อมกัน
      if (!wantSuper && isTrue_(sh.getRange(f.rowNum, ADMIN_SUPER_COL).getValue()) && activeSuperCountExcept_(username) < 1) fail_('ต้องเหลือผู้ดูแลใหญ่ที่ใช้งานได้อย่างน้อย 1 คน');
      sh.getRange(f.rowNum, ADMIN_SYSTEMS_COL).setValue(systemsCell_(systems, sh.getRange(f.rowNum, ADMIN_SYSTEMS_COL).getValue()));
      sh.getRange(f.rowNum, ADMIN_SUPER_COL).setValue(wantSuper);
      audit_('admin:' + adm.username, 'ALLADMIN_ADMIN_SET', username, 'systems=' + systems.join(',') + ' super=' + wantSuper + ' active=' + active);
      return { message: 'แก้ไขเรียบร้อย' };
    });
  });
}

/** ปลดล็อกการเข้าสู่ระบบของผู้ดูแล (ที่ถูกล็อกจากการใส่รหัสผ่านผิดหลายครั้ง) */
function alladminUnlockAdmin_(token, username) {
  return api_(() => {
    const adm = requireAdmin_(token);
    username = String(username || '').trim().toLowerCase();
    if (!findAdmin_(username)) fail_('ไม่พบผู้ดูแล');
    clearFails_('admin:' + username);
    audit_('admin:' + adm.username, 'ADMIN_UNLOCK', username, '');
    return { message: 'ปลดล็อก ' + username + ' แล้ว ลองเข้าสู่ระบบได้ทันที' };
  });
}

// ---------- ภาพรวม / audit ----------
function alladminOverview_(token) {
  return api_(() => {
    requireAdmin_(token);
    const staff = rows_(CFG.SHEET.STAFF, S.WIDTH), perSys = {};
    SYS_KEYS.forEach(k => { perSys[k] = staff.filter(r => isTrue_(r.row[S.ACTIVE]) && hasSys_(r.row, k)).length; });
    const admins = readAdminRows_();
    let pending = 0;
    try { pending = rows_(CFG.SHEET.REQUESTS, R.WIDTH).filter(r => r.row[R.STATUS] === STATUS.PENDING).length; } catch (e) { /* ไม่มีชีตคำขอ */ }
    return {
      staff: { total: staff.length, active: staff.filter(r => isTrue_(r.row[S.ACTIVE])).length,
               locked: staff.filter(r => isLocked_('staff:' + r.row[S.ID]) || isLocked_('pin:' + r.row[S.ID])).length,
               defaultPin: staff.filter(r => isTrue_(r.row[S.ACTIVE]) && isTrue_(r.row[S.MUST])).length, perSys: perSys },
      admins: { total: admins.length, active: admins.filter(r => isTrue_(r.row[A.ACTIVE])).length,
                supers: admins.filter(r => isTrue_(r.row[A.ACTIVE]) && isTrue_(r.row[ADMIN_SUPER_COL - 1])).length },
      pendingRequests: pending,
      security: securityCounts_()
    };
  });
}

// ---- จัดหมวด/ระบบของรายการในบันทึกกิจกรรม (จัดจากชื่อ action จึงเป็นการประมาณ ไม่ใช่ค่าที่บันทึกไว้ตรง ๆ) ----
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
  if (a === 'STAFF_LOGIN' && ADMIN_SYS_KEYS.indexOf(d) >= 0) return d;   // รายการเข้าสู่ระบบของเจ้าหน้าที่ใส่ชื่อระบบไว้ในรายละเอียด
  return '';
}
/** จำนวนเหตุการณ์ผิดปกติ (ล็อกอินพลาด/ถูกปฏิเสธ) ใน 24 ชั่วโมงล่าสุด จากรายการล่าสุดไม่เกิน 1000 แถว */
function securityCounts_() {
  try {
    const sh = sheet_(CFG.SHEET.AUDIT), last = sh.getLastRow();
    if (last < 2) return { fail24h: 0, scanned: 0 };
    const scan = Math.min(last - 1, 1000), all = sh.getRange(last - scan + 1, 1, scan, 3).getValues(), since = Date.now() - 24 * 3600e3;
    let n = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      const t = all[i][0] instanceof Date ? all[i][0].getTime() : NaN;
      if (!isNaN(t) && t < since) break;
      if (auditKind_(all[i][2]) === 'fail') n++;
    }
    return { fail24h: n, scanned: scan };
  } catch (e) { return { fail24h: 0, scanned: 0 }; }
}

const AUDIT_MAX_ = 400;

/** กิจกรรมรายวันของทุกระบบ สำหรับกราฟหน้าภาพรวม : days = 7..30 (ค่าเริ่มต้น 14) ; สแกนท้ายชีต Audit ไม่เกิน 3000 แถวรอบเดียว
 *  คืน { days:[{date,login,change,fail,other}], bySys:{คีย์ระบบ:จำนวน}, byKind:{...}, scanned, covered } ; covered=false ถ้าบันทึกเก่ากว่าช่วงที่ขอไม่ถึง (กราฟอาจไม่ครบทุกวัน) */
function alladminTrend_(token, days) {
  return api_(() => {
    requireAdmin_(token);
    days = Math.max(7, Math.min(Math.floor(Number(days)) || 14, 30));
    const sh = sheet_(CFG.SHEET.AUDIT), last = sh.getLastRow();
    const now = Date.now(), day = 86400000, keyOf = t => Utilities.formatDate(new Date(t), CFG.TZ, 'yyyy-MM-dd');
    const list = [], idx = {};
    for (let i = days - 1; i >= 0; i--) { const k = keyOf(now - i * day); idx[k] = list.length; list.push({ date: k, login: 0, change: 0, fail: 0, other: 0 }); }
    const bySys = {}, byKind = { login: 0, change: 0, fail: 0, other: 0 };
    if (last < 2) return { days: list, bySys: bySys, byKind: byKind, scanned: 0, covered: true };
    const scan = Math.min(last - 1, 3000), all = sh.getRange(last - scan + 1, 1, scan, 5).getValues(), since = now - days * day;
    let covered = scan === last - 1;
    for (let i = all.length - 1; i >= 0; i--) {
      const t = all[i][0] instanceof Date ? all[i][0].getTime() : NaN;
      if (isNaN(t)) continue;
      if (t < since) { covered = true; break; }
      const k = idx[keyOf(t)]; if (k === undefined) continue;
      const kind = auditKind_(all[i][2]); list[k][kind]++; byKind[kind]++;
      const sy = auditSys_(all[i][2], all[i][4]); if (sy) bySys[sy] = (bySys[sy] || 0) + 1;
    }
    return { days: list, bySys: bySys, byKind: byKind, scanned: scan, covered: covered };
  });
}

/** filter: {q (ค้นข้อความ), action, kind (fail|login|change|other), sys (คีย์ระบบ), limit} — คืนรายการล่าสุดก่อน */
function alladminAudit_(token, filter) {
  return api_(() => {
    requireAdmin_(token);
    filter = filter || {};
    const sh = sheet_(CFG.SHEET.AUDIT), last = sh.getLastRow();
    if (last < 2) return { rows: [], scanned: 0 };
    const scan = Math.min(last - 1, 3000), start = last - scan + 1;
    const q = String(filter.q || '').trim().toLowerCase().slice(0, 60), act = String(filter.action || '').trim().slice(0, 60);
    const limit = Math.max(1, Math.min(Number(filter.limit) || 100, AUDIT_MAX_));
    const kind = String(filter.kind || '').trim(), sysF = String(filter.sys || '').trim();
    const all = sh.getRange(start, 1, scan, 5).getValues(), out = [];
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
      const v = all[i], text = (String(v[1]) + ' ' + String(v[2]) + ' ' + String(v[3]) + ' ' + String(v[4])).toLowerCase();
      if (act && String(v[2]) !== act) continue;
      if (q && text.indexOf(q) < 0) continue;
      const k = auditKind_(v[2]), sy = auditSys_(v[2], v[4]);
      if (kind && k !== kind) continue;
      if (sysF && sy !== sysF) continue;
      out.push({ ts: tsStr_(v[0]), actor: String(v[1]), action: String(v[2]), target: String(v[3]), detail: String(v[4]), kind: k, sys: sy });
    }
    return { rows: out, scanned: scan };
  });
}

// ===================== ติดตั้ง (รันเองจากตัวแก้ไข) =====================
/** รันครั้งเดียว: เติมหัวคอลัมน์ G/H, สร้าง ALLADMIN_API_KEY (ไม่สร้างทับถ้ามีอยู่แล้ว) และตั้งผู้ดูแลใหญ่คนแรก
 *  แก้ FIRST_SUPER เป็นชื่อผู้ใช้ผู้ดูแลที่จะเป็นผู้ดูแลใหญ่ ก่อนรัน */
function setupAllAdmin() {
  const FIRST_SUPER = 'mukdarat';
  ensureSuperHeader_();
  const f = findAdmin_(FIRST_SUPER);
  if (!f) { Logger.log('ไม่พบผู้ใช้ "' + FIRST_SUPER + '" ในชีต Admins — แก้ FIRST_SUPER ให้ตรงกับคอลัมน์ A แล้วรันใหม่'); return; }
  sheet_(CFG.SHEET.ADMINS).getRange(f.rowNum, ADMIN_SUPER_COL).setValue(true);
  Logger.log('ตั้ง ' + FIRST_SUPER + ' เป็นผู้ดูแลใหญ่แล้ว');
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('ALLADMIN_API_KEY')) { Logger.log('มี ALLADMIN_API_KEY อยู่แล้ว ไม่สร้างทับ (ดูได้ที่ Project Settings > Script Properties)'); return; }
  const key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  props.setProperty('ALLADMIN_API_KEY', key);
  Logger.log('ALLADMIN_API_KEY = ' + key);
  Logger.log('ไปที่โปรเจกต์ Admin Center > Project Settings > Script Properties แล้วตั้ง LEAVE_API_KEY = ค่าข้างบน  |  LEAVE_API_URL = URL /exec ของระบบลา');
}

/** ก่อนเปิดใช้การตรวจสิทธิ์ผู้ดูแลของ Stock: ผู้ดูแลทุกคนเคยเข้า Stock/Stock คลังกลางได้โดยไม่ตรวจคอลัมน์ G
 *  ฟังก์ชันนี้เติม stock และ stockcenter ให้ผู้ดูแลที่ยังไม่มี เพื่อให้ "ไม่มีใครเสียสิทธิ์เดิม" แล้วค่อยตัดสิทธิ์ที่ไม่ต้องการที่ Admin Center
 *  commit = false (ค่าเริ่มต้นของ migrateAdminSystemsPreview) แสดงผลใน Execution log เท่านั้น ไม่เขียนชีต */
function migrateAdminSystems_(commit) {
  const sh = sheet_(CFG.SHEET.ADMINS);
  readAdminRows_().forEach(r => {
    const user = String(r.row[A.USER]), raw = r.row[ADMIN_SYSTEMS_COL - 1], toks = rawSystemTokens_(raw);
    if (toks.indexOf('all') >= 0 || toks.indexOf('*') >= 0) { Logger.log(user + ': all (ไม่ต้องแก้)'); return; }
    const add = ['stock', 'stockcenter'].filter(k => toks.indexOf(k) < 0);
    if (!add.length) { Logger.log(user + ': ' + toks.join(',') + ' (ครบแล้ว)'); return; }
    const next = toks.concat(add).join(',');
    Logger.log(user + ': "' + toks.join(',') + '" -> "' + next + '"' + (commit ? ' (เขียนแล้ว)' : ' (ตัวอย่าง ยังไม่เขียน)'));
    if (commit) { sh.getRange(r.rowNum, ADMIN_SYSTEMS_COL).setValue(next); audit_('system', 'ADMIN_SYS_MIGRATE', user, next); }
  });
}
function migrateAdminSystemsPreview() { ensureSuperHeader_(); migrateAdminSystems_(false); }
function migrateAdminSystems() { ensureSuperHeader_(); migrateAdminSystems_(true); }