/**
 * RecordApi.gs — ส่วนเสริมของระบบลา สำหรับ "ระบบบันทึกการนำส่งสิ่งส่งตรวจ" (Record Specimen)
 * ใช้ล็อกอินผู้ดูแลระบบ (Admins) ร่วมกับระบบลาเท่านั้น ไม่เปิดสิทธิ์อื่นเลย
 * ใช้คู่กับ IncidentApi.gs (doPost ที่นั่งส่งต่อมาที่ recordRoute_ ของไฟล์นี้)
 *
 * ติดตั้ง: ดูฟังก์ชัน setupRecordSupport() ด้านล่าง
 */
const RECORD_SYSTEM = 'record';

// ===================== เส้นทางของ Record Specimen (allowlist แคบ: ล็อกอินแอดมินอย่างเดียว) =====================
function recordRoute_(body) {
  switch (body.action) {
    case 'adminLogin': return recordAdminLogin_(body.username, body.password);
    default:           return { ok: false, code: 'BAD_ACTION', message: 'คำสั่งไม่ถูกต้อง' };
  }
}

/** แอดมินมีคำว่า record (หรือ all / *) ในคอลัมน์ G ของชีต Admins หรือไม่ */
function adminHasSystem_(username, system) {
  const f = findAdmin_(String(username || '').trim().toLowerCase());
  if (!f) return false;
  const raw = sheet_(CFG.SHEET.ADMINS).getRange(f.rowNum, ADMIN_SYSTEMS_COL).getValue();
  const list = String(raw == null ? '' : raw).toLowerCase().split(/[,;\s]+/).filter(Boolean);
  return list.indexOf('all') >= 0 || list.indexOf('*') >= 0 || list.indexOf(system) >= 0;
}

function recordAdminLogin_(username, password) {
  const r = adminLogin(username, password);          // ตรวจรหัสผ่าน/ล็อกเมื่อผิดหลายครั้ง ตามกลไกเดิมทุกอย่าง
  if (!r.ok) return r;
  endSession_(r.token);                               // ไม่ปล่อย token ของระบบลาออกไปนอกโปรเจกต์นี้ (Record สร้าง session ของตัวเอง)
  if (!adminHasSystem_(r.admin.username, RECORD_SYSTEM)) {
    audit_('admin:' + r.admin.username, 'RECORD_DENIED', r.admin.username, 'ไม่มีสิทธิ์ record');
    return { ok: false, code: 'FORBIDDEN', message: 'บัญชีนี้ไม่มีสิทธิ์ใช้ระบบบันทึกสิ่งส่งตรวจ กรุณาติดต่อผู้ดูแล' };
  }
  audit_('admin:' + r.admin.username, 'RECORD_ADMIN_LOGIN', r.admin.username, '');
  return { ok: true, admin: r.admin };
}

// ===================== ติดตั้ง / ทดสอบ (รันเองจากตัวแก้ไข) =====================
/** รันครั้งเดียว: สร้าง RECORD_API_KEY (ไม่สร้างทับถ้ามีอยู่แล้ว) */
function setupRecordSupport() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('RECORD_API_KEY')) {
    Logger.log('มี RECORD_API_KEY อยู่แล้ว ไม่สร้างทับ (ดูได้ที่ Project Settings > Script Properties)');
    return;
  }
  const key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  props.setProperty('RECORD_API_KEY', key);
  Logger.log('RECORD_API_KEY = ' + key);
  Logger.log('ไปที่โปรเจกต์ Record Specimen > Project Settings > Script Properties แล้วตั้ง');
  Logger.log('  LEAVE_API_KEY = ค่าข้างบน   |   LEAVE_API_URL = URL /exec ของระบบลา (ตัวเดียวกับที่ Stock ใช้)');
  Logger.log('แล้วเพิ่มคำว่า record ในคอลัมน์ G (Systems) ของชีต Admins ให้แอดมินที่จะใช้หลังบ้านนี้ (หลายระบบคั่นด้วยเครื่องหมายจุลภาค เช่น incident,record)');
  Logger.log('สุดท้าย Deploy ระบบลาเป็นเวอร์ชันใหม่ (Manage deployments > แก้ไข > New version) เพราะ doPost มีการแก้ไข');
}

/** ทดสอบตรรกะ (ยังไม่ต้อง Deploy): ดูผลที่ Execution log */
function testRecordApi() {
  const key = PropertiesService.getScriptProperties().getProperty('RECORD_API_KEY');
  const call = (k, body) => doPost({ postData: { contents: JSON.stringify(Object.assign({ key: k }, body)) } }).getContent();
  Logger.log('คีย์ถูก + action แปลก      -> ' + call(key, { action: 'deleteEverything' }));
  Logger.log('คีย์ถูก + staffList (ห้าม) -> ' + call(key, { action: 'staffList' }));
  Logger.log('คีย์ถูก + call (ห้าม)      -> ' + call(key, { action: 'call', fn: 'adminListStaff', args: [] }));
  Logger.log('คีย์ผิด + adminLogin        -> ' + call('wrong-key', { action: 'adminLogin', username: 'x', password: 'y' }));
  Logger.log('ทั้งหมดต้องเป็น BAD_ACTION / FORBIDDEN (ห้ามมีข้อมูลพนักงานหลุดออกมา)');
}