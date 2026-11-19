/**
 * GlucoseApi.gs — ส่วนเสริมของระบบลา สำหรับ "ระบบสต๊อกน้ำยา Glucose"
 * - พนักงาน: ล็อกอินด้วย PIN เดียวกับระบบลา แต่ต้องได้รับสิทธิ์ "glucose" (คอลัมน์ O ของชีต Staff)
 * - ผู้ดูแล: ล็อกอินด้วยบัญชีผู้ดูแลระบบลา และต้องมีคำว่า glucose (หรือ all) ในคอลัมน์ G ของชีต Admins
 * ใช้คู่กับ IncidentApi.gs (doPost ส่งต่อมาที่ glucoseRoute_ ของไฟล์นี้)
 *
 * ติดตั้ง: ดูฟังก์ชัน setupGlucoseSupport() ด้านล่าง (รันก่อน Deploy)
 */
const GLUCOSE_SYSTEM = 'glucose';

// ===================== เส้นทางของ Glucose (allowlist แคบ) =====================
function glucoseRoute_(body) {
  switch (body.action) {
    case 'staffList':   return stockStaffList_(GLUCOSE_SYSTEM);
    case 'positions':   return { ok: true, positions: POSITIONS };
    case 'login':       return staffLogin_(body.staffId, body.pin, GLUCOSE_SYSTEM);
    case 'changePin':   return staffChangePin_(body.token, body.oldPin, body.newPin, GLUCOSE_SYSTEM);
    case 'verify':      return stockVerify_(body.token, GLUCOSE_SYSTEM);
    case 'logout':      return staffLogout(body.token);
    case 'adminLogin':  return glucoseAdminLogin_(body.username, body.password);
    case 'adminVerify': return glucoseAdminVerify_(body.token);
    case 'adminLogout': return adminLogout(body.token);
    case 'call': {
      const fns = glucoseAdminFns_();
      const f = Object.prototype.hasOwnProperty.call(fns, body.fn) ? fns[body.fn] : null;
      if (!f || !Array.isArray(body.args) || body.args.length < 1 || body.args.length > 6) {
        return { ok: false, code: 'BAD_ACTION', message: 'คำสั่งไม่ถูกต้อง' };
      }
      const v = glucoseAdminVerify_(body.args[0]);          // token ต้องเป็นผู้ดูแลที่มีสิทธิ์ glucose
      if (!v.ok) return v;
      return f.apply(null, body.args);
    }
    default:            return { ok: false, code: 'BAD_ACTION', message: 'คำสั่งไม่ถูกต้อง' };
  }
}

/** ฟังก์ชันผู้ดูแลที่หน้า Glucose เรียกได้ (แคบ: ดูรายชื่อ, รีเซ็ต PIN, เปลี่ยนรหัสผ่านตัวเอง, เปิด/ปิดสิทธิ์ glucose) */
function glucoseAdminFns_() {
  return {
    adminListStaff: adminListStaff,
    adminSaveStaff: adminSaveStaff,
    adminDeleteStaff: adminDeleteStaff,
    adminUnlockStaff: adminUnlockStaff,
    adminResetStaffPin: adminResetStaffPin,
    adminChangeOwnPassword: adminChangeOwnPassword,
    glucoseSetAccess: glucoseSetAccess
  };
}

function glucoseAdminLogin_(username, password) {
  const r = adminLogin(username, password);          // ตรวจรหัสผ่าน/ล็อกเมื่อผิดหลายครั้ง ตามกลไกเดิมทุกอย่าง
  if (!r.ok) return r;
  if (adminSystems_(r.admin.username).indexOf(GLUCOSE_SYSTEM) < 0) {
    endSession_(r.token);
    audit_('admin:' + r.admin.username, 'GLUCOSE_DENIED', r.admin.username, 'ไม่มีสิทธิ์ glucose');
    return { ok: false, code: 'FORBIDDEN', message: 'บัญชีนี้ไม่มีสิทธิ์ใช้ระบบสต๊อกน้ำยา Glucose กรุณาติดต่อผู้ดูแล' };
  }
  audit_('admin:' + r.admin.username, 'GLUCOSE_ADMIN_LOGIN', r.admin.username, '');
  return r;
}

/** ตรวจ token แอดมิน + สิทธิ์ glucose ทุกครั้ง */
function glucoseAdminVerify_(token) {
  return api_(() => {
    const a = requireAdmin_(token);
    if (adminSystems_(a.username).indexOf(GLUCOSE_SYSTEM) < 0) fail_('ไม่มีสิทธิ์ใช้ระบบสต๊อกน้ำยา Glucose', 'FORBIDDEN');
    return { admin: { username: a.username, displayName: a.display } };
  });
}

/** เปิด/ปิดสิทธิ์ Glucose ของพนักงานหนึ่งคน (แตะเฉพาะคอลัมน์ glucose) */
function glucoseSetAccess(token, staffId, enabled) {
  return api_(() => {
    const adm = requireAdmin_(token);
    return withLock_(() => {
      const f = findStaff_(String(staffId || ''));
      if (!f) fail_('ไม่พบพนักงาน');
      sheet_(CFG.SHEET.STAFF).getRange(f.rowNum, S.GLUCOSE + 1).setValue(enabled === true);
      audit_('admin:' + adm.username, enabled === true ? 'GLUCOSE_ON' : 'GLUCOSE_OFF', f.row[S.ID], f.row[S.NAME]);
      return { message: (enabled === true ? 'เปิดสิทธิ์ Glucose ให้ ' : 'ปิดสิทธิ์ Glucose ของ ') + f.row[S.NAME] + ' แล้ว' };
    });
  });
}

// ===================== ติดตั้ง / ทดสอบ (รันเองจากตัวแก้ไข) =====================
/**
 * รันครั้งเดียว (หลังแก้ Code.gs 3 จุด และก่อน Deploy เวอร์ชันใหม่):
 *  1) เพิ่มคอลัมน์สิทธิ์ "glucose" (คอลัมน์ O) ในชีต Staff — พนักงานเดิมเริ่มต้น = ยังไม่มีสิทธิ์ (FALSE)
 *  2) สร้าง GLUCOSE_API_KEY (ไม่สร้างทับถ้ามีอยู่แล้ว)
 */
function setupGlucoseSupport() {
  const sh = sheet_(CFG.SHEET.STAFF);
  const col = S.GLUCOSE + 1;
  if (sh.getMaxColumns() < col) sh.insertColumnsAfter(sh.getMaxColumns(), col - sh.getMaxColumns());
  const head = sh.getRange(1, col);
  if (!String(head.getValue()).trim()) head.setValue('glucose');
  const n = sh.getLastRow() - 1;
  if (n > 0) {
    try {
      const rng = sh.getRange(2, col, n, 1);
      rng.setValues(rng.getValues().map(r => [r[0] === '' ? false : r[0]]));
      const dv = sh.getRange(2, S.INCIDENT + 1).getDataValidation();
      if (dv && dv.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.CHECKBOX) rng.insertCheckboxes();
    } catch (e) {
      Logger.log('เติมค่า FALSE ในคอลัมน์ O ไม่สำเร็จ (' + e.message + ') — ปล่อยว่างได้ ระบบถือว่าไม่มีสิทธิ์');
    }
  }
  Logger.log('ชีต Staff: คอลัมน์ O = glucose พร้อมแล้ว');

  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('GLUCOSE_API_KEY')) {
    Logger.log('มี GLUCOSE_API_KEY อยู่แล้ว ไม่สร้างทับ (ดูได้ที่ Project Settings > Script Properties)');
    return;
  }
  const key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  props.setProperty('GLUCOSE_API_KEY', key);
  Logger.log('GLUCOSE_API_KEY = ' + key);
  Logger.log('ไปที่โปรเจกต์ Glucose > Project Settings > Script Properties แล้วตั้ง');
  Logger.log('  LEAVE_API_KEY = ค่าข้างบน   |   LEAVE_API_URL = URL /exec ของระบบลา');
  Logger.log('แล้วเพิ่มคำว่า glucose ในคอลัมน์ G (Systems) ของชีต Admins ให้แอดมินที่จะใช้หลังบ้าน Glucose (เช่น incident,record,bloodgas,glucose)');
  Logger.log('สุดท้าย Deploy ระบบลาเป็นเวอร์ชันใหม่ (Manage deployments > แก้ไข > New version)');
}

/** ทดสอบตรรกะ (ยังไม่ต้อง Deploy): ดูผลที่ Execution log */
function testGlucoseApi() {
  const key = PropertiesService.getScriptProperties().getProperty('GLUCOSE_API_KEY');
  const call = (k, body) => doPost({ postData: { contents: JSON.stringify(Object.assign({ key: k }, body)) } }).getContent();
  Logger.log('คีย์ถูก + staffList          -> ' + call(key, { action: 'staffList' }).slice(0, 160) + '  (ควรเห็นเฉพาะคนที่เปิดสิทธิ์ glucose)');
  Logger.log('คีย์ถูก + call adminSaveStaff -> ' + call(key, { action: 'call', fn: 'adminSaveStaff', args: ['x'] }));
  Logger.log('คีย์ถูก + action แปลก        -> ' + call(key, { action: 'deleteEverything' }));
  Logger.log('คีย์ผิด + staffList          -> ' + call('wrong-key', { action: 'staffList' }));
  Logger.log('สามบรรทัดหลังต้องเป็น BAD_ACTION / FORBIDDEN');
}