/**
 * ทดสอบการทำงานจริงแบบครบวงจร (ข้อมูลสมมติ ไม่ใช่ข้อมูลจริง):
 * API ของหน้าเว็บ (/api/rpc), API ของระบบอื่น (/api/exec), การเขียนข้อมูล, ล็อก, การชนกันพร้อมกัน และหน้าเว็บด้วย Playwright
 *
 * ต้องมี Postgres ว่างให้ใช้ :  TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/e2e node test/run.mjs
 * (สคริปต์จะล้างและสร้าง schema ใหม่ในฐานนั้น ห้ามชี้ไปที่ Supabase จริง)
 */
process.env.TZ = 'Asia/Bangkok';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
if (!url || /supabase/.test(url)) { console.error('ต้องตั้ง TEST_DATABASE_URL เป็นฐานทดสอบในเครื่อง'); process.exit(2); }
Object.assign(process.env, {
  DATABASE_URL: url, PEPPER: 'e2e-pepper', STOCK_API_KEY: 'k-stock', INCIDENT_API_KEY: 'k-inc', RECORD_API_KEY: 'k-rec',
  BLOODGAS_API_KEY: 'k-bg', GLUCOSE_API_KEY: 'k-gl', ALLADMIN_API_KEY: 'k-aa', LINE_CHANNEL_TOKEN: ''
});

const postgres = (await import('postgres')).default;
const admin = postgres(url, { onnotice: () => {} });
await admin.unsafe('drop schema public cascade; create schema public;');
await admin.unsafe(readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));

const core = await import('../lib/core.js');
const H = s => { const h = core.makeHash_(s); return [h.hash, h.salt]; };
const [ah, as] = H('TestPassword1'), [ih, is] = H('IncPassword9');
await admin`insert into admins (username, display_name, pw_hash, salt, active, created_at, systems, super) values
  ('tester', 'ผู้ทดสอบ', ${ah}, ${as}, true, now(), 'all', true), ('incadmin', 'แอดมินอุบัติการณ์', ${ih}, ${is}, true, now(), 'incident', false)`;
const mk = async (id, name, pin, must, sys) => { const [h, s] = H(pin); await admin`insert into staff (id, name, position, pin_hash, salt, must_change_pin, active, created_at, sys_leave, sys_stock, sys_stockcenter, sys_incident, sys_bloodgas, sys_glucose)
  values (${id}, ${name}, ${core.POSITIONS[0]}, ${h}, ${s}, ${must}, true, now(), ${sys[0]}, ${sys[1]}, ${sys[2]}, ${sys[3]}, ${sys[4]}, ${sys[5]})`; };
await mk('S0000001', 'นางสาวทดสอบ หนึ่ง', '1234', true, [true, true, true, true, false, false]);
await mk('S0000002', 'นายทดสอบ สอง', '2580', false, [true, true, false, true, true, false]);
await mk('S0000003', 'นางทดสอบ สาม', '1357', false, [false, true, false, false, false, true]);
await admin`insert into holidays (date, name) values (${(() => { const d = new Date(); d.setDate(d.getDate() + 40); return core.ymd_(d); })()}, 'วันหยุดทดสอบ')`;

execSync('node scripts/build.mjs', { cwd: new URL('..', import.meta.url).pathname });
const { startServer } = await import('./server.mjs');
const PORT = 38711, BASE = 'http://127.0.0.1:' + PORT;
const srv = await startServer(PORT);

const rpc = (fn, ...args) => fetch(BASE + '/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fn, args }) }).then(r => r.json());
const ex = (body, q = '') => fetch(BASE + '/api/exec' + q, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) }).then(r => r.json());
// นับจากวันจันทร์ถัดไป เพื่อให้ผลไม่ขึ้นกับวันที่รันทดสอบ (day(0) = จันทร์)
const MON = (() => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return d; })();
const day = n => { const d = new Date(MON); d.setDate(d.getDate() + n); return core.ymd_(d); };
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// ---------- หน้าพนักงาน ----------
let r = await rpc('getBootstrap');
ok(r.ok && r.staff.length === 2 && !r.staff.some(s => s.id === 'S0000003'), 'bootstrap: เฉพาะคนที่มีสิทธิ์ leave');
r = await rpc('deleteEverything'); ok(r.code === 'BAD_ACTION', 'rpc: ฟังก์ชันนอกรายการถูกปฏิเสธ');
r = await rpc('setupAllAdmin'); ok(r.code === 'BAD_ACTION', 'rpc: ฟังก์ชันติดตั้งเรียกจากเว็บไม่ได้');
r = await rpc('staffLogin', 'S0000001', '9999'); ok(r.code === 'BAD_LOGIN' && /เหลืออีก 4 ครั้ง/.test(r.message), 'PIN ผิดนับครั้ง');
r = await rpc('staffLogin', 'S0000001', '1234'); ok(r.ok && r.mustChangePin && /^[a-f0-9]{64}$/.test(r.token), 'login ด้วย PIN เริ่มต้น');
let t1 = r.token;
r = await rpc('getMyLeaves', t1); ok(r.code === 'MUST_CHANGE_PIN', 'ต้องเปลี่ยน PIN ก่อน');
r = await rpc('staffChangePin', t1, '1234', '1111'); ok(!r.ok && /ง่ายเกินไป/.test(r.message), 'PIN ง่ายถูกปฏิเสธ');
r = await rpc('staffChangePin', t1, '1234', '4826'); ok(r.ok, 'เปลี่ยน PIN');
r = await rpc('calculateDuration', t1, 'annual', day(1), day(9)); ok(r.ok && r.calendarDays === 9 && r.days >= 5, 'คำนวณวัน');
r = await rpc('submitLeave', t1, [{ leaveTypeKey: 'annual', startDate: day(1), endDate: day(2) }, { leaveTypeKey: 'sick', startDate: day(2), endDate: day(3) }]);
ok(!r.ok && /รายการที่ 2: วันที่ลาซ้ำ/.test(r.message), 'ตรวจวันซ้ำในใบเดียวกัน ' + JSON.stringify(r));
ok((await admin`select count(*)::int c from leaves`)[0].c === 0, 'ล้มแล้วไม่มีอะไรถูกบันทึก');
r = await rpc('submitLeave', t1, [{ leaveTypeKey: 'annual', startDate: day(1), endDate: day(2) }, { leaveTypeKey: 'off_duty_cancel', startDate: day(20), endDate: day(21) }]);
ok(r.ok && r.count === 2, 'ส่งใบลา 2 รายการ');
r = await rpc('submitLeave', t1, [{ leaveTypeKey: 'off_duty_cancel', startDate: day(22), endDate: day(23) }]);
const sameMonth = day(20).slice(0, 7) === day(23).slice(0, 7) && day(21).slice(0, 7) === day(22).slice(0, 7);
if (sameMonth) ok(!r.ok && /งดเวรนอกเวลาได้ไม่เกิน 3 วัน/.test(r.message), 'โควตางดเวรนอกเวลา');
// ส่งพร้อมกัน 5 คำขอในช่วงวันเดียวกัน: ต้องผ่านแค่ 1 (แทน LockService)
const t2 = (await rpc('staffLogin', 'S0000002', '2580')).token;
const burst = await Promise.all([0, 1, 2, 3, 4].map(() => rpc('submitLeave', t2, [{ leaveTypeKey: 'personal', startDate: day(30), endDate: day(31) }])));
ok(burst.filter(x => x.ok).length === 1, 'ส่งพร้อมกัน: ผ่าน 1 ใบเท่านั้น (ได้ ' + burst.filter(x => x.ok).length + ')');
r = await rpc('getMyLeaves', t1); ok(r.ok && r.rows.length === 2 && r.rows[0].status === 'Pending', 'ประวัติของฉัน');
const pend = r.rows.find(x => x.type === 'งดเวรนอกเวลา');
r = await rpc('staffCancelLeave', t2, pend.id); ok(!r.ok, 'ยกเลิกใบของคนอื่นไม่ได้');
r = await rpc('staffCancelLeave', t1, pend.id); ok(r.ok, 'ยกเลิกใบตัวเอง');
r = await rpc('getAllLeaves', t2, { pageSize: 10 }); ok(r.ok && r.total === 2 && r.rows.every(x => !('note' in x) && !('position' in x)), 'ตารางทั้งหน่วยไม่ส่งข้อมูลเกิน');
r = await rpc('getStaffCalendar', t1, new Date().getMonth() + 1, new Date().getFullYear()); ok(r.ok, 'ปฏิทิน');
r = await rpc('requestStaffAccess', 'นายคนใหม่ ทดลอง', core.POSITIONS[1], '081'); ok(r.ok, 'ขอเพิ่มชื่อ');
r = await rpc('requestStaffAccess', 'คนใหม่ ทดลอง', core.POSITIONS[1], ''); ok(!r.ok, 'ขอซ้ำ (ไม่สนคำนำหน้า) ถูกปฏิเสธ');

// ---------- หน้าผู้ดูแล ----------
r = await rpc('adminLogin', 'TESTER', 'wrong-password'); ok(r.code === 'BAD_LOGIN', 'admin รหัสผิด');
r = await rpc('adminLogin', 'TESTER', 'TestPassword1'); ok(r.ok && r.admin.username === 'tester', 'admin login (ไม่สนตัวพิมพ์)');
const at = r.token;
r = await rpc('adminSummary', at); ok(r.ok && r.pending === 2 && r.pendingRequests === 1, 'สรุปแอดมิน');
r = await rpc('adminGetLeaves', at, { status: 'Pending' }); const lv = r.rows[0];
r = await rpc('adminDecide', at, lv.id, 'Approve', 'ok'); ok(r.ok, 'อนุมัติ');
r = await rpc('adminDecide', at, lv.id, 'Reject', ''); ok(r.code === 'STALE', 'อนุมัติซ้ำ = STALE');
r = await rpc('adminCancelLeave', at, lv.id, ''); ok(!r.ok, 'ยกเลิกต้องมีเหตุผล');
r = await rpc('adminReport', at, '2020-01-01', '2021-01-01'); ok(r.ok, 'รายงาน');
r = await rpc('adminListRequests', at, 'Pending'); r = await rpc('adminDecideRequest', at, r.rows[0].id, 'Approve', '');
ok(r.ok && /PIN เริ่มต้น 1234/.test(r.message), 'อนุมัติคำขอ = เพิ่มพนักงาน');
r = await rpc('adminListStaff', at); ok(r.ok && r.rows.length === 4, 'รายชื่อพนักงาน 4 คน');
const s1 = r.rows.find(x => x.id === 'S0000001'); ok(s1.mustChangePin === false, 'สถานะ PIN อัปเดต');
r = await rpc('adminSaveStaff', at, { id: 'S0000003', name: 'นางทดสอบ สาม', position: core.POSITIONS[0], active: true, sys: { leave: true } });
ok(r.ok, 'แก้ไขสิทธิ์'); r = await rpc('adminListStaff', at); const s3 = r.rows.find(x => x.id === 'S0000003');
ok(s3.sys.leave && s3.sys.stock && s3.sys.glucose && !s3.sys.incident, 'ส่ง sys บางระบบ = ระบบอื่นคงค่าเดิม');
for (let i = 0; i < 5; i++) await rpc('staffLogin', 'S0000003', '0000');
r = await rpc('staffLogin', 'S0000003', '1357'); ok(r.code === 'LOCKED', 'ล็อกหลังผิด 5 ครั้ง');
r = await rpc('adminListStaff', at); ok(r.rows.find(x => x.id === 'S0000003').locked, 'แสดงถูกล็อก');
r = await rpc('adminUnlockStaff', at, 'S0000003'); r = await rpc('staffLogin', 'S0000003', '1357'); ok(r.ok, 'ปลดล็อกแล้วเข้าได้');
const lateDay = (() => { const d = new Date(); d.setDate(1); return d; })();
r = await rpc('adminSaveLateMonth', at, 'S0000002', lateDay.getMonth() + 1, lateDay.getFullYear() + 543, [1], 'สาย'); ok(r.ok, 'บันทึกมาสาย (ปี พ.ศ.)');
r = await rpc('getMonthlyLeaveMatrix', at, lateDay.getMonth() + 1, lateDay.getFullYear()); ok(r.ok && r.leaveMap.S0000002 && r.leaveMap.S0000002[1] === 'F', 'ตาราง F');
r = await rpc('adminAddAdmin', at, { username: 'newadm', displayName: 'ใหม่', password: 'NewPassword1' }); ok(r.ok, 'เพิ่มผู้ดูแล (super)');
r = await rpc('adminChangeOwnPassword', at, 'TestPassword1', 'TestPassword2'); ok(r.ok, 'เปลี่ยนรหัสตัวเอง');
r = await rpc('adminSummary', at); ok(r.ok, 'session ปัจจุบันยังใช้ได้หลังเปลี่ยนรหัส');
r = await rpc('adminDeleteAdmin', at, 'tester'); ok(!r.ok, 'ลบตัวเองไม่ได้');

// ---------- API ของระบบอื่น (แทน doPost) ----------
r = await ex({ key: 'wrong', action: 'staffList' }); ok(r.code === 'FORBIDDEN', 'key ผิด');
r = await ex({ key: 'k-stock', action: 'staffList' }); ok(r.ok && r.staff.length === 4, 'stock staffList');
r = await ex({ key: 'k-stock', system: 'stockcenter', action: 'staffList' }); ok(r.ok && r.staff.length === 2, 'stockcenter staffList');
r = await ex({ key: 'k-stock', action: 'login', staffId: 'S0000003', pin: '1357' }); ok(r.ok, 'stock login');
const st = r.token;
r = await ex({ key: 'k-stock', action: 'verify', token: st }); ok(r.ok && r.staff.id === 'S0000003', 'stock verify');
r = await rpc('getMyLeaves', st); ok(r.code === 'AUTH', 'token ของ Stock ใช้กับระบบลาไม่ได้');
r = await ex({ key: 'k-inc', action: 'login', staffId: 'S0000003', pin: '1357' }); ok(r.code === 'NO_ACCESS', 'ไม่มีสิทธิ์ incident');
r = await ex({ key: 'k-inc', action: 'staffListAll' }); ok(r.ok && r.staff.length === 4, 'incident staffListAll');
r = await ex({ key: 'k-inc', action: 'adminLogin', username: 'incadmin', password: 'IncPassword9' }); ok(r.ok, 'incident admin login');
const it = r.token;
r = await ex({ key: 'k-inc', action: 'call', fn: 'adminListStaff', args: [it] }); ok(r.ok, 'incident call');
r = await ex({ key: 'k-bg', action: 'adminLogin', username: 'incadmin', password: 'IncPassword9' }); ok(r.code === 'FORBIDDEN', 'bloodgas ปฏิเสธแอดมินไม่มีสิทธิ์');
r = await ex({ key: 'k-rec', action: 'adminLogin', username: 'tester', password: 'TestPassword2' }); ok(r.ok && !r.token, 'record login ไม่คืน token');
r = await ex({ key: 'k-rec', action: 'staffList' }); ok(r.code === 'BAD_ACTION', 'record แคบ');
r = await ex({ key: 'k-aa', action: 'adminLogin', username: 'incadmin', password: 'IncPassword9' }); ok(r.code === 'FORBIDDEN', 'alladmin เฉพาะ super');
r = await ex({ key: 'k-aa', action: 'adminLogin', username: 'tester', password: 'TestPassword2' }); const aa = r.token;
r = await ex({ key: 'k-aa', action: 'call', fn: 'alladminOverview', args: [aa] }); ok(r.ok && r.staff.total === 4, 'Admin Center overview');
r = await ex({ key: 'k-aa', action: 'call', fn: 'alladminUpdateAdmin', args: [aa, { username: 'incadmin', displayName: 'แอดมินอุบัติการณ์', active: true, systems: ['incident', 'bloodgas'], superAdmin: false }] }); ok(r.ok, 'กำหนดสิทธิ์ผู้ดูแล');
r = await ex({ key: 'k-bg', action: 'adminLogin', username: 'incadmin', password: 'IncPassword9' }); ok(r.ok, 'bloodgas ผ่านหลังให้สิทธิ์');
r = await ex({ key: 'k-bg', action: 'call', fn: 'bloodgasSetAccess', args: [r.token, 'S0000001', true] }); ok(r.ok, 'bloodgasSetAccess');
r = await ex({ key: 'k-aa', action: 'call', fn: 'alladminAudit', args: [aa, { kind: 'fail' }] }); ok(r.ok && r.rows.length > 0, 'audit log');
r = await ex({ events: [{}] }, '?k=nope'); ok(r.code === 'FORBIDDEN', 'LINE webhook ต้องมี k');
r = await ex({ key: 'k-rec', action: 'notify', text: 'x' }); ok(r.code === 'DISABLED', 'record ห้ามแจ้งเตือน');
r = await fetch(BASE + '/exec', { method: 'POST', body: JSON.stringify({ key: 'k-gl', action: 'staffList' }) }).then(x => x.json()); ok(r.ok && r.staff.length === 1, '/exec (path เดิม) + glucose');

// ---------- หน้าเว็บจริงด้วย Playwright ----------
const require = createRequire(import.meta.url);
let pw = null; try { pw = require('playwright'); } catch (e) { console.log('(ข้ามการทดสอบหน้าเว็บ: ไม่มี playwright)'); }
if (pw) {
  const browser = await pw.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.route(/cdn\.jsdelivr\.net\/npm\/sweetalert2/, r => r.fulfill({ contentType: 'application/javascript', body: 'window.Swal={fire:function(o){window.__swal=(window.__swal||[]).concat([o]);return Promise.resolve({isConfirmed:true,value:""})}}' }));
  await page.goto(BASE + '/');
  await page.waitForSelector('#screenLogin:not([hidden])', { timeout: 15000 });
  await page.selectOption('#staffSelect', 'S0000002');
  await page.fill('#pinInput', '2580');
  await page.click('#loginBtn');
  await page.waitForSelector('#screenApp:not([hidden])', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('#allBody tr').length > 0 && !/กำลังโหลด/.test(document.querySelector('#allBody').textContent));
  ok((await page.textContent('#userName')).includes('ทดสอบ สอง'), 'UI: เข้าสู่ระบบพนักงาน');
  await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/staff.png' : '/tmp/staff.png', fullPage: false });
  await page.goto(BASE + '/?page=Admin');
  await page.waitForSelector('#screenLogin:not([hidden])', { timeout: 15000 });
  await page.fill('#uName', 'tester'); await page.fill('#uPass', 'TestPassword2'); await page.click('#loginBtn');
  await page.waitForSelector('#screenApp:not([hidden])', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('#statTiles .tile').length >= 4);
  ok(true, 'UI: เข้าสู่ระบบผู้ดูแล + แดชบอร์ด');
  await page.click('[data-tab=staff]'); await page.waitForFunction(() => document.querySelectorAll('#staffBody tr').length >= 4);
  ok(true, 'UI: แท็บพนักงาน');
  await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/admin.png' : '/tmp/admin.png', fullPage: false });
  ok(errors.length === 0, 'UI: ไม่มี JavaScript error ' + errors.join(' | '));
  await browser.close();
}

console.log('ผ่านทั้งหมด ' + n + ' ข้อ');
srv.close(); await admin.end(); const { closeDb } = await import('../lib/db.js'); await closeDb();
process.exit(0);
