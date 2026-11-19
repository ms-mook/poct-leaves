const INCIDENT_SYSTEM = 'incident';
const ADMIN_SYSTEMS_COL = 7;   // คอลัมน์ G ของชีต Admins
 
// ===================== ตัวรับคำขอ (แทน doPost เดิม) =====================
function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    // webhook จาก LINE (ไม่มี key ในเนื้อหา) : ตรวจกุญแจที่ติดมากับ URL (?k=...) ก่อนเสมอ
    if (Array.isArray(body.events) && !body.key) {
      const wk = PropertiesService.getScriptProperties().getProperty('LINE_WEBHOOK_KEY'), qk = e && e.parameter && e.parameter.k;
      if (!wk || typeof qk !== 'string' || !sameKey_(qk, wk)) { noteRejectedKey_(); return json_({ ok: false, code: 'FORBIDDEN', message: 'ไม่อนุญาต' }); }
      return json_(lineWebhook_(body));
    }
    const caller = identifyCaller_(body.key);
    if (!caller) {
      noteRejectedKey_();
      return json_({ ok: false, code: 'FORBIDDEN', message: 'ไม่อนุญาต' });
    }
    if (body.action === 'notify') return json_(lineNotifyRoute_(caller, body));   // ระบบอื่นขอแจ้งเตือน LINE (Record ถูกปฏิเสธ)
    return json_(caller === 'incident' ? incidentRoute_(body)
               : caller === 'record' ? recordRoute_(body)       // recordRoute_ อยู่ใน RecordApi.gs
               : caller === 'bloodgas' ? bloodgasRoute_(body)   // bloodgasRoute_ อยู่ใน BloodgasApi.gs
               : caller === 'glucose' ? glucoseRoute_(body)     // glucoseRoute_ อยู่ใน GlucoseApi.gs
               : caller === 'alladmin' ? alladminRoute_(body)   // alladminRoute_ อยู่ใน AllAdminApi.gs
               : stockRoute_(body));
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, code: 'SERVER', message: 'ระบบขัดข้อง' });
  }
}
 
/** ระบุว่าใครเรียก จากค่า key (ตรวจทั้งสองค่าเสมอ ไม่ตัดจบเร็ว) */
function identifyCaller_(key) {
  if (typeof key !== 'string' || !key) return null;
  const p = PropertiesService.getScriptProperties();
  const stockKey = p.getProperty('STOCK_API_KEY');
  const incKey = p.getProperty('INCIDENT_API_KEY');
  const recKey = p.getProperty('RECORD_API_KEY');
  const bgKey = p.getProperty('BLOODGAS_API_KEY');
  const glKey = p.getProperty('GLUCOSE_API_KEY');
  const aaKey = p.getProperty('ALLADMIN_API_KEY');
  const isStock = !!stockKey && sameKey_(key, stockKey);
  const isInc = !!incKey && sameKey_(key, incKey);
  const isRec = !!recKey && sameKey_(key, recKey);
  const isBg = !!bgKey && sameKey_(key, bgKey);
  const isGl = !!glKey && sameKey_(key, glKey);
  const isAa = !!aaKey && sameKey_(key, aaKey);
  if (isStock) return 'stock';      // ถ้าเผลอตั้งสองค่าเท่ากัน จะถูกมองเป็น stock (สิทธิ์เดิม) ไม่ใช่สิทธิ์เพิ่ม
  if (isInc) return 'incident';
  if (isRec) return 'record';
  if (isBg) return 'bloodgas';
  if (isGl) return 'glucose';
  if (isAa) return 'alladmin';
  return null;
}
 
/** บันทึกการใช้ key ผิด (จำกัด 20 แถว/ชม. กัน log ถูกถมเต็ม) */
function noteRejectedKey_() {
  const c = CacheService.getScriptCache();
  const n = Number(c.get('APIKEYFAIL') || 0);
  if (n < 20) audit_('api', 'API_KEY_REJECTED', '', '');
  c.put('APIKEYFAIL', String(n + 1), 3600);
}


function incidentAdminFns_() {
  return {
    adminListRequests: adminListRequests, adminDecideRequest: adminDecideRequest,
    adminListStaff: adminListStaff, adminSaveStaff: adminSaveStaff, adminResetStaffPin: adminResetStaffPin, adminDeleteStaff: adminDeleteStaff,
    adminUnlockStaff: adminUnlockStaff,
    adminListAdmins: adminListAdmins, adminAddAdmin: adminAddAdmin, adminUpdateAdmin: adminUpdateAdmin,
    adminChangeOwnPassword: adminChangeOwnPassword, adminResetAdminPassword: adminResetAdminPassword, adminDeleteAdmin: adminDeleteAdmin
  };
}
 
// ===================== เส้นทางของ Stock (พฤติกรรมเดิมทุกอย่าง) =====================
function stockRoute_(body) {
  // Stock กับ Stock คลังกลางใช้ key เดียวกัน จึงให้ client บอกชื่อระบบของตัวเอง (รับเฉพาะ 2 ค่านี้ ไม่ระบุ = stock)
  const sys = body.system === 'stockcenter' ? 'stockcenter' : 'stock';
  switch (body.action) {
    case 'staffList':           return stockStaffList_(sys);
    case 'login':               return staffLogin_(body.staffId, body.pin, sys);
    case 'changePin':           return staffChangePin_(body.token, body.oldPin, body.newPin, sys);
    case 'verify':              return stockVerify_(body.token, sys);
    case 'logout':              return staffLogout(body.token);
    case 'positions':           return { ok: true, positions: POSITIONS };
    case 'requestAccess':       return requestStaffAccess(body.name, body.position, body.contact);
    case 'adminLogin':          return stockAdminLogin_(body.username, body.password, sys);
    case 'adminLogout':         return adminLogout(body.token);
    case 'adminListRequests':   { const g = stockAdminVerify_(body.token, sys); return g.ok ? adminListRequests(body.token, body.status) : g; }
    case 'adminDecideRequest':  { const g = stockAdminVerify_(body.token, sys); return g.ok ? adminDecideRequest(body.token, body.requestId, body.decision, body.note) : g; }
    case 'adminVerify':         return stockAdminVerify_(body.token, sys);
    case 'call': {
      const fns = stockAdminFns_();
      const f = Object.prototype.hasOwnProperty.call(fns, body.fn) ? fns[body.fn] : null;
      if (!f || !Array.isArray(body.args) || body.args.length < 1 || body.args.length > 6) return { ok: false, code: 'BAD_ACTION', message: 'คำสั่งไม่ถูกต้อง' };
      const g = stockAdminVerify_(body.args[0], sys);          // token ต้องเป็นผู้ดูแลที่มีสิทธิ์ระบบนี้ (stock / stockcenter)
      if (!g.ok) return g;
      return f.apply(null, body.args);
    }
    default:                    return { ok: false, code: 'BAD_ACTION', message: 'คำสั่งไม่ถูกต้อง' };
  }
}
 
// ===================== เส้นทางของระบบอุบัติการณ์ (allowlist แคบ) =====================
function incidentRoute_(body) {
  switch (body.action) {
    case 'staffList':   return stockStaffList_(INCIDENT_SYSTEM);
    case 'staffListAll': return stockStaffList_('*');   // รายชื่อทุกคนที่ active (สำหรับช่อง "ผู้ที่ก่อให้เกิดอุบัติการณ์")
    case 'login':       return staffLogin_(body.staffId, body.pin, INCIDENT_SYSTEM);
    case 'changePin':   return staffChangePin_(body.token, body.oldPin, body.newPin, INCIDENT_SYSTEM);
    case 'verify':      return stockVerify_(body.token, INCIDENT_SYSTEM);
    case 'logout':      return staffLogout(body.token);
    case 'positions':     return { ok: true, positions: POSITIONS };
    case 'requestAccess': return requestStaffAccess(body.name, body.position, body.contact);
    case 'adminLogin':  return incidentAdminLogin_(body.username, body.password);
    case 'adminVerify': return incidentAdminVerify_(body.token);
    case 'adminLogout': return adminLogout(body.token);
    case 'call': {
      const fns = incidentAdminFns_();
      const f = Object.prototype.hasOwnProperty.call(fns, body.fn) ? fns[body.fn] : null;
      if (!f || !Array.isArray(body.args) || body.args.length < 1 || body.args.length > 6) {
        return { ok: false, code: 'BAD_ACTION', message: 'คำสั่งไม่ถูกต้อง' };
      }
      const v = incidentAdminVerify_(body.args[0]);          // token ต้องเป็นผู้ดูแลที่มีสิทธิ์ incident
      if (!v.ok) return v;
      return f.apply(null, body.args);
    }
    default:            return { ok: false, code: 'BAD_ACTION', message: 'คำสั่งไม่ถูกต้อง' };
  }
}
 
function adminSystems_(username) {
  const f = findAdmin_(String(username || '').trim().toLowerCase());
  if (!f) return [];
  if (isSuperAdmin_(username)) return Object.keys(SYS_COL).concat(['record']);   // ผู้ดูแลใหญ่เข้าได้ทุกระบบ (กันล็อกตัวเองออก)
  const raw = sheet_(CFG.SHEET.ADMINS).getRange(f.rowNum, ADMIN_SYSTEMS_COL).getValue();
  const list = String(raw == null ? '' : raw).toLowerCase().split(/[,;\s]+/).filter(Boolean);
  return (list.indexOf('all') >= 0 || list.indexOf('*') >= 0) ? Object.keys(SYS_COL) : list;
}
 
function incidentAdminLogin_(username, password) {
  const r = adminLogin(username, password);          // ตรวจรหัสผ่าน/ล็อกเมื่อผิดหลายครั้ง ตามกลไกเดิมทุกอย่าง
  if (!r.ok) return r;
  if (adminSystems_(r.admin.username).indexOf(INCIDENT_SYSTEM) < 0) {
    endSession_(r.token);                             // ไม่ปล่อย token ที่ใช้เข้าอุบัติการณ์ไม่ได้ให้หลุดออกไป
    audit_('admin:' + r.admin.username, 'INCIDENT_DENIED', r.admin.username, 'ไม่มีสิทธิ์ incident');
    return { ok: false, code: 'FORBIDDEN', message: 'บัญชีนี้ไม่มีสิทธิ์ใช้ระบบอุบัติการณ์ กรุณาติดต่อผู้ดูแล' };
  }
  audit_('admin:' + r.admin.username, 'INCIDENT_ADMIN_LOGIN', r.admin.username, '');
  return r;
}
 
/** ตรวจ token แอดมิน + สิทธิ์ incident ทุกครั้ง (token ของแอดมินระบบลาที่ไม่มีสิทธิ์จะใช้ไม่ได้) */
function incidentAdminVerify_(token) {
  return api_(() => {
    const a = requireAdmin_(token);
    if (adminSystems_(a.username).indexOf(INCIDENT_SYSTEM) < 0) fail_('ไม่มีสิทธิ์ใช้ระบบอุบัติการณ์', 'FORBIDDEN');
    return { admin: { username: a.username, displayName: a.display } };
  });
}
 
// ===================== ติดตั้ง / ทดสอบ (รันเองจากตัวแก้ไข) =====================
/** รันครั้งเดียว: เติมหัวคอลัมน์ G และสร้าง INCIDENT_API_KEY (ไม่สร้างทับถ้ามีอยู่แล้ว) */
function setupIncidentSupport() {
  const sh = sheet_(CFG.SHEET.ADMINS);
  if (!String(sh.getRange(1, ADMIN_SYSTEMS_COL).getValue()).trim()) {
    sh.getRange(1, ADMIN_SYSTEMS_COL).setValue('Systems').setFontWeight('bold');
  }
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('INCIDENT_API_KEY')) {
    Logger.log('มี INCIDENT_API_KEY อยู่แล้ว ไม่สร้างทับ (ดูได้ที่ Project Settings > Script Properties)');
    return;
  }
  const key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  props.setProperty('INCIDENT_API_KEY', key);
  Logger.log('INCIDENT_API_KEY = ' + key);
  Logger.log('ไปที่โปรเจกต์อุบัติการณ์ > Project Settings > Script Properties แล้วตั้ง');
  Logger.log('  LEAVE_API_KEY = ค่าข้างบน   |   LEAVE_API_URL = URL /exec ของระบบลา (ตัวเดียวกับที่ Stock ใช้)');
  Logger.log('แล้วเพิ่มคำว่า incident ในคอลัมน์ G ของชีต Admins ให้แอดมินที่จะใช้หลังบ้านอุบัติการณ์');
}
 
/** ทดสอบตรรกะ (ยังไม่ต้อง Deploy): ดูผลที่ Execution log */
function testIncidentApi() {
  const key = PropertiesService.getScriptProperties().getProperty('INCIDENT_API_KEY');
  const call = (k, body) => doPost({ postData: { contents: JSON.stringify(Object.assign({ key: k }, body)) } }).getContent();
  Logger.log('คีย์ถูก + staffList     -> ' + call(key, { action: 'staffList' }).slice(0, 160));
  Logger.log('คีย์ถูก + call (ห้าม)   -> ' + call(key, { action: 'call', fn: 'adminListStaff', args: [] }));
  Logger.log('คีย์ผิด + staffList     -> ' + call('wrong-key', { action: 'staffList' }));
  Logger.log('คีย์ถูก + action แปลก   -> ' + call(key, { action: 'deleteEverything' }));
}

function diagnoseIncidentAdmin() {
  const USERNAME = 'mukdarat';   // ใส่ชื่อผู้ใช้แอดมินที่ล็อกอินอุบัติการณ์ไม่ได้
  const p = PropertiesService.getScriptProperties();
  const inc = p.getProperty('INCIDENT_API_KEY'), stock = p.getProperty('STOCK_API_KEY');
  Logger.log('INCIDENT_API_KEY: ' + (inc ? 'ตั้งแล้ว ขึ้นต้น ' + inc.slice(0, 6) + ' ยาว ' + inc.length : 'ยังไม่ได้ตั้ง (รัน setupIncidentSupport)'));
  Logger.log('STOCK_API_KEY: ' + (stock ? 'ตั้งแล้ว ขึ้นต้น ' + stock.slice(0, 6) : 'ยังไม่ได้ตั้ง'));
  if (inc && stock && inc === stock) Logger.log('!!! สองคีย์เท่ากัน ระบบจะมองเป็น stock เสมอ ให้สร้าง INCIDENT_API_KEY ใหม่');
  const sh = sheet_(CFG.SHEET.ADMINS);
  Logger.log('หัวคอลัมน์ G: "' + sh.getRange(1, ADMIN_SYSTEMS_COL).getValue() + '"');
  const u = String(USERNAME).trim().toLowerCase();
  const f = u ? findAdmin_(u) : null;
  if (!f) {
    Logger.log(u ? 'ไม่พบชื่อผู้ใช้ "' + u + '" ในชีต Admins' : 'ยังไม่ได้ใส่ USERNAME');
    Logger.log('ชื่อผู้ใช้ที่มี: ' + rows_(CFG.SHEET.ADMINS, A.WIDTH).map(r => r.row[A.USER]).join(', '));
    return;
  }
  Logger.log('ใช้งาน(Active): ' + isTrue_(f.row[A.ACTIVE]));
  Logger.log('ค่าในคอลัมน์ G: ' + JSON.stringify(sh.getRange(f.rowNum, ADMIN_SYSTEMS_COL).getValue()));
  Logger.log('ระบบที่ระบบอ่านได้: [' + adminSystems_(u).join(', ') + '] -> มี incident = ' + (adminSystems_(u).indexOf(INCIDENT_SYSTEM) >= 0));
  const c = CacheService.getScriptCache();
  Logger.log('ตัวนับรหัสผิด: ผู้ใช้นี้=' + (c.get('FAIL:admin:' + u) || 0) + ' (ล็อกที่ 5), รวมทุกบัญชี=' + (c.get('FAIL:admin:*') || 0) + ' (ล็อกที่ 30)');
}

/** ปลดล็อกการเข้าสู่ระบบแอดมินที่ถูกล็อกจากการลองผิดหลายครั้ง */
function unlockAdminLogin() {
  const USERNAME = '';
  clearFails_('admin:' + String(USERNAME).trim().toLowerCase());
  clearFails_('admin:*');
  Logger.log('ปลดล็อกแล้ว');
}

// ===================== สิทธิ์ผู้ดูแลของ Stock / Stock คลังกลาง (ตรวจคอลัมน์ G เหมือนระบบอื่น) =====================
function stockAdminLogin_(username, password, system) {
  const r = adminLogin(username, password);
  if (!r.ok) return r;
  if (adminSystems_(r.admin.username).indexOf(system) < 0) {
    endSession_(r.token);
    audit_('admin:' + r.admin.username, 'STOCK_DENIED', r.admin.username, 'ไม่มีสิทธิ์ ' + system);
    return { ok: false, code: 'FORBIDDEN', message: 'บัญชีนี้ไม่มีสิทธิ์ใช้ระบบนี้ กรุณาติดต่อผู้ดูแลใหญ่' };
  }
  return r;
}