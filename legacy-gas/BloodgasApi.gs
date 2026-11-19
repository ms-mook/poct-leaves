/**
 * BloodgasApi.gs — ส่วนเสริมของระบบลา สำหรับ "ระบบจัดการ Stock Blood Gas"
 * - พนักงาน: ล็อกอินด้วย PIN เดียวกับระบบลา แต่ต้องได้รับสิทธิ์ "bloodgas" (คอลัมน์ N ของชีต Staff)
 * - ผู้ดูแล: ล็อกอินด้วยบัญชีผู้ดูแลระบบลา และต้องมีคำว่า bloodgas (หรือ all) ในคอลัมน์ G ของชีต Admins
 * ใช้คู่กับ IncidentApi.gs (doPost ส่งต่อมาที่ bloodgasRoute_ ของไฟล์นี้)
 *
 * ติดตั้ง: ดูฟังก์ชัน setupBloodgasSupport() ด้านล่าง (รันก่อน Deploy)
 */
const BLOODGAS_SYSTEM = 'bloodgas';

// ===================== เส้นทางของ Blood Gas (allowlist แคบ) =====================
function bloodgasRoute_(body) {
  switch (body.action) {
    case 'staffList':     return stockStaffList_(BLOODGAS_SYSTEM);
    case 'login':         return staffLogin_(body.staffId, body.pin, BLOODGAS_SYSTEM);
    case 'changePin':     return staffChangePin_(body.token, body.oldPin, body.newPin, BLOODGAS_SYSTEM);
    case 'verify':        return stockVerify_(body.token, BLOODGAS_SYSTEM);
    case 'logout':        return staffLogout(body.token);
    case 'positions':     return { ok: true, positions: POSITIONS };
    case 'requestAccess': return requestStaffAccess(body.name, body.position, body.contact);
    case 'adminLogin':    return bloodgasAdminLogin_(body.username, body.password);
    case 'adminVerify':   return bloodgasAdminVerify_(body.token);
    case 'adminLogout':   return adminLogout(body.token);
    case 'call': {
      const fns = bloodgasAdminFns_();
      const f = Object.prototype.hasOwnProperty.call(fns, body.fn) ? fns[body.fn] : null;
      if (!f || !Array.isArray(body.args) || body.args.length < 1 || body.args.length > 6) {
        return { ok: false, code: 'BAD_ACTION', message: 'คำสั่งไม่ถูกต้อง' };
      }
      const v = bloodgasAdminVerify_(body.args[0]);          // token ต้องเป็นผู้ดูแลที่มีสิทธิ์ bloodgas
      if (!v.ok) return v;
      return f.apply(null, body.args);
    }
    default:              return { ok: false, code: 'BAD_ACTION', message: 'คำสั่งไม่ถูกต้อง' };
  }
}

/** ฟังก์ชันผู้ดูแลที่หน้า Blood Gas เรียกได้ (จัดการพนักงานได้ครบ: เพิ่ม/แก้ไข/ลบ/รีเซ็ต PIN/สิทธิ์ทุกระบบ — แต่ไม่มีการเพิ่ม/ลบ/แก้บัญชีผู้ดูแล) */
function bloodgasAdminFns_() {
  return {
    adminListStaff: adminListStaff,
    adminSaveStaff: adminSaveStaff,
    adminDeleteStaff: adminDeleteStaff,
    adminResetStaffPin: adminResetStaffPin,
    adminListRequests: adminListRequests,
    adminChangeOwnPassword: adminChangeOwnPassword,
    bloodgasSetAccess: bloodgasSetAccess,
    bloodgasSetSystem: bloodgasSetSystem,
    bloodgasDecideRequest: bloodgasDecideRequest
  };
}

function bloodgasAdminLogin_(username, password) {
  const r = adminLogin(username, password);          // ตรวจรหัสผ่าน/ล็อกเมื่อผิดหลายครั้ง ตามกลไกเดิมทุกอย่าง
  if (!r.ok) return r;
  if (adminSystems_(r.admin.username).indexOf(BLOODGAS_SYSTEM) < 0) {
    endSession_(r.token);                             // ไม่ปล่อย token ที่ใช้เข้า Blood Gas ไม่ได้ให้หลุดออกไป
    audit_('admin:' + r.admin.username, 'BLOODGAS_DENIED', r.admin.username, 'ไม่มีสิทธิ์ bloodgas');
    return { ok: false, code: 'FORBIDDEN', message: 'บัญชีนี้ไม่มีสิทธิ์ใช้ระบบ Blood Gas กรุณาติดต่อผู้ดูแล' };
  }
  audit_('admin:' + r.admin.username, 'BLOODGAS_ADMIN_LOGIN', r.admin.username, '');
  return r;
}

/** ตรวจ token แอดมิน + สิทธิ์ bloodgas ทุกครั้ง */
function bloodgasAdminVerify_(token) {
  return api_(() => {
    const a = requireAdmin_(token);
    if (adminSystems_(a.username).indexOf(BLOODGAS_SYSTEM) < 0) fail_('ไม่มีสิทธิ์ใช้ระบบ Blood Gas', 'FORBIDDEN');
    return { admin: { username: a.username, displayName: a.display } };
  });
}

// ===================== งานผู้ดูแล: เปิด/ปิดสิทธิ์ และอนุมัติคำขอ =====================
/** เปิด/ปิดสิทธิ์ Blood Gas ของพนักงานหนึ่งคน (แตะเฉพาะคอลัมน์ bloodgas ไม่แก้ข้อมูลอื่น) */
function bloodgasSetAccess(token, staffId, enabled) {
  return api_(() => {
    const adm = requireAdmin_(token);
    return withLock_(() => {
      const f = findStaff_(String(staffId || ''));
      if (!f) fail_('ไม่พบพนักงาน');
      sheet_(CFG.SHEET.STAFF).getRange(f.rowNum, S.BLOODGAS + 1).setValue(enabled === true);
      audit_('admin:' + adm.username, enabled === true ? 'BLOODGAS_ON' : 'BLOODGAS_OFF', f.row[S.ID], f.row[S.NAME]);
      return { message: (enabled === true ? 'เปิดสิทธิ์ Blood Gas ให้ ' : 'ปิดสิทธิ์ Blood Gas ของ ') + f.row[S.NAME] + ' แล้ว' };
    });
  });
}

/** เปิด/ปิดสิทธิ์ "ระบบใดก็ได้" ของพนักงานหนึ่งคน (leave, stock, stockcenter, incident, bloodgas) — แตะเฉพาะคอลัมน์ของระบบนั้น
 *  ใช้จากหน้า Admin ของ Blood Gas เพื่อจัดการสิทธิ์ทุกระบบในที่เดียว (ทุกครั้งบันทึก AuditLog) */
function bloodgasSetSystem(token, staffId, system, enabled) {
  return api_(() => {
    const adm = requireAdmin_(token);
    system = String(system || '');
    if (!Object.prototype.hasOwnProperty.call(SYS_COL, system)) fail_('ไม่รู้จักระบบนี้');
    return withLock_(() => {
      const f = findStaff_(String(staffId || ''));
      if (!f) fail_('ไม่พบพนักงาน');
      sheet_(CFG.SHEET.STAFF).getRange(f.rowNum, SYS_COL[system] + 1).setValue(enabled === true);
      audit_('admin:' + adm.username, (enabled === true ? 'SYS_ON ' : 'SYS_OFF ') + system, f.row[S.ID], f.row[S.NAME]);
      return { message: (enabled === true ? 'เปิดสิทธิ์ ' : 'ปิดสิทธิ์ ') + system + ' ให้ ' + f.row[S.NAME] + ' แล้ว' };
    });
  });
}

/** อนุมัติ/ปฏิเสธคำขอเข้าใช้งาน: ถ้าอนุมัติจากหน้า Blood Gas จะเปิดสิทธิ์ Blood Gas ให้คนใหม่ด้วยทันที */
function bloodgasDecideRequest(token, requestId, decision, note) {
  const r = adminDecideRequest(token, requestId, decision, note);
  if (!r.ok || decision !== STATUS.APPROVED) return r;
  try {
    const req = rows_(CFG.SHEET.REQUESTS, R.WIDTH).find(x => x.row[R.ID] === String(requestId || ''));
    const staffId = req ? String(req.row[R.STAFFID] || '') : '';
    const st = staffId ? findStaff_(staffId) : null;
    if (st) {
      sheet_(CFG.SHEET.STAFF).getRange(st.rowNum, S.BLOODGAS + 1).setValue(true);
      audit_('admin:' + requireAdmin_(token).username, 'BLOODGAS_ON', staffId, st.row[S.NAME] + ' (จากการอนุมัติคำขอ)');
      r.message = (r.message || '') + ' และเปิดสิทธิ์ Blood Gas ให้แล้ว';
    }
  } catch (e) {
    console.error('bloodgasDecideRequest: ' + (e && e.stack ? e.stack : e));
    r.message = (r.message || '') + ' (แต่เปิดสิทธิ์ Blood Gas ไม่สำเร็จ กรุณาเปิดที่แท็บพนักงาน)';
  }
  return r;
}

// ===================== ติดตั้ง / ทดสอบ (รันเองจากตัวแก้ไข) =====================
/**
 * รันครั้งเดียว (ก่อน Deploy เวอร์ชันใหม่):
 *  1) เพิ่มคอลัมน์สิทธิ์ "bloodgas" (คอลัมน์ N) ในชีต Staff — พนักงานเดิมทุกคนเริ่มต้น = ยังไม่มีสิทธิ์ (FALSE)
 *  2) สร้าง BLOODGAS_API_KEY (ไม่สร้างทับถ้ามีอยู่แล้ว)
 */
function setupBloodgasSupport() {
  const sh = sheet_(CFG.SHEET.STAFF);
  const col = S.BLOODGAS + 1;
  if (sh.getMaxColumns() < col) sh.insertColumnsAfter(sh.getMaxColumns(), col - sh.getMaxColumns());
  const head = sh.getRange(1, col);
  if (!String(head.getValue()).trim()) head.setValue('bloodgas');
  const n = sh.getLastRow() - 1;
  if (n > 0) {
    try {
      const rng = sh.getRange(2, col, n, 1);
      rng.setValues(rng.getValues().map(r => [r[0] === '' ? false : r[0]]));
      const dv = sh.getRange(2, S.INCIDENT + 1).getDataValidation();   // ถ้าคอลัมน์ M เป็นช่องติ๊ก ให้คอลัมน์ N เป็นช่องติ๊กเหมือนกัน
      if (dv && dv.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.CHECKBOX) rng.insertCheckboxes();
    } catch (e) {
      Logger.log('เติมค่า FALSE ในคอลัมน์ N ไม่สำเร็จ (' + e.message + ') — ปล่อยว่างได้ ระบบถือว่าไม่มีสิทธิ์');
    }
  }
  Logger.log('ชีต Staff: คอลัมน์ N = bloodgas พร้อมแล้ว');

  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('BLOODGAS_API_KEY')) {
    Logger.log('มี BLOODGAS_API_KEY อยู่แล้ว ไม่สร้างทับ (ดูได้ที่ Project Settings > Script Properties)');
    return;
  }
  const key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  props.setProperty('BLOODGAS_API_KEY', key);
  Logger.log('BLOODGAS_API_KEY = ' + key);
  Logger.log('ไปที่โปรเจกต์ Blood Gas > Project Settings > Script Properties แล้วตั้ง');
  Logger.log('  LEAVE_API_KEY = ค่าข้างบน   |   LEAVE_API_URL = URL /exec ของระบบลา (ตัวเดียวกับที่ Stock ใช้)');
  Logger.log('แล้วเพิ่มคำว่า bloodgas ในคอลัมน์ G (Systems) ของชีต Admins ให้แอดมินที่จะใช้หน้าผู้ดูแล Blood Gas (หลายระบบคั่นด้วยจุลภาค เช่น incident,record,bloodgas)');
  Logger.log('สุดท้าย Deploy ระบบลาเป็นเวอร์ชันใหม่ (Manage deployments > แก้ไข > New version)');
}

/** ทดสอบตรรกะ (ยังไม่ต้อง Deploy): ดูผลที่ Execution log */
function testBloodgasApi() {
  const key = PropertiesService.getScriptProperties().getProperty('BLOODGAS_API_KEY');
  const call = (k, body) => doPost({ postData: { contents: JSON.stringify(Object.assign({ key: k }, body)) } }).getContent();
  Logger.log('คีย์ถูก + staffList          -> ' + call(key, { action: 'staffList' }).slice(0, 160) + '  (ควรเห็นเฉพาะคนที่เปิดสิทธิ์ bloodgas)');
  Logger.log('คีย์ถูก + call adminSaveStaff -> ' + call(key, { action: 'call', fn: 'adminSaveStaff', args: ['x'] }));
  Logger.log('คีย์ถูก + action แปลก        -> ' + call(key, { action: 'deleteEverything' }));
  Logger.log('คีย์ผิด + staffList          -> ' + call('wrong-key', { action: 'staffList' }));
  Logger.log('สามบรรทัดหลังต้องเป็น BAD_ACTION / FORBIDDEN');
}