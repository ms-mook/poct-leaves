/**
 * ทดสอบความเหมือน 100% ระหว่าง "โค้ด Apps Script เดิม" กับ "โค้ดใหม่บน Postgres"
 * - รันไฟล์ .gs เดิม (legacy-gas/) ใน Node โดยจำลอง SpreadsheetApp ให้อ่านข้อมูลจากไฟล์ grid JSON ของชีตจริง (อ่านอย่างเดียว)
 * - รันโค้ดใหม่ (lib/) กับฐานข้อมูลที่นำเข้าจากชีตเดียวกัน
 * - เรียกฟังก์ชันอ่านข้อมูลทุกตัวด้วยอาร์กิวเมนต์ชุดเดียวกัน แล้วเทียบผล JSON ทุกฟิลด์
 *
 * ใช้: DATABASE_URL=postgres://... node test/parity.mjs grid1.json grid2.json ...
 */
process.env.TZ = 'Asia/Bangkok';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import vm from 'node:vm';
import { isDeepStrictEqual } from 'node:util';

process.env.PEPPER = process.env.PEPPER || 'parity-test-pepper';
const core = await import('../lib/core.js');
const { alladminRoute_ } = await import('../lib/alladmin.js');
const { db, closeDb } = await import('../lib/db.js');

// ---------- โหลดข้อมูลชีตจริงเป็นตาราง 2 มิติแบบที่ Apps Script อ่านได้ ----------
const sheets = {};
let VmDate = Date;
for (const p of process.argv.slice(2)) {
  let j = JSON.parse(readFileSync(p, 'utf8')); j = j.content || j;
  for (const sh of j.sheets) {
    const rows = ((sh.data || [{}])[0].rowData || []).map(r => (r.values || []).map(cellValue));
    while (rows.length && rows[rows.length - 1].every(v => v === '')) rows.pop();
    sheets[sh.properties.title] = rows;
  }
}
function cellValue(c) {
  const e = c && c.effectiveValue;
  if (!e) return '';
  if ('boolValue' in e) return e.boolValue;
  if ('stringValue' in e) return e.stringValue;
  if ('numberValue' in e) {
    const f = String(c.formattedValue || '');
    if (/\d+\/\d+\/\d+/.test(f) || /\d+:\d+/.test(f)) return { __serial: e.numberValue };   // แปลงเป็น Date ของ vm ตอนอ่าน (instanceof Date ข้าม realm ไม่ได้)
    return e.numberValue;
  }
  return '';
}

function mkSheet(name) {
  const data = sheets[name];
  const width = Math.max(1, ...data.map(r => r.length));
  const cell = (r, c) => { const row = data[r - 1] || []; const v = row[c - 1]; if (v && v.__serial !== undefined) return new VmDate(Date.UTC(1899, 11, 30) + Math.round(v.__serial * 86400) * 1000 - 7 * 3600e3); return v === undefined ? '' : v; };
  const ro = () => { throw new Error('parity: read-only'); };
  return {
    getLastRow: () => data.length, getLastColumn: () => width, getMaxColumns: () => width,
    getRange(r, c, nr, nc) {
      if (typeof r === 'string') return { setNumberFormat: ro, getValues: ro };
      nr = nr || 1; nc = nc || 1;
      return {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, k) => cell(r + i, c + k))),
        getValue: () => cell(r, c), setValue: ro, setValues: ro, setNumberFormat: ro, getDataValidation: () => null
      };
    },
    deleteRow: ro, insertColumnsAfter: ro
  };
}

// ---------- จำลองบริการของ Apps Script ----------
const cache = new Map();
const props = { PEPPER: process.env.PEPPER };
const pad = n => ('0' + n).slice(-2);
const G = {
  console, Logger: { log() {} },
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: n => (sheets[n] ? mkSheet(n) : null) }), flush() {}, DataValidationCriteria: {} },
  CacheService: { getScriptCache: () => ({ get: k => (cache.has(k) ? cache.get(k) : null), put: (k, v) => cache.set(k, String(v)), remove: k => cache.delete(k) }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  Utilities: {
    getUuid: () => randomUUID(),
    formatDate: (d, tz, f) => {
      const s = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      return f === 'yyyy-MM-dd' ? s : s + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    },
    computeDigest: (alg, s) => [...createHash('sha256').update(s, 'utf8').digest()].map(b => (b > 127 ? b - 256 : b)),
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }
  },
  ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/x/exec' }) },
  ContentService: { createTextOutput: s => ({ setMimeType: () => ({ getContent: () => s }) }), MimeType: { JSON: 'json' } },
  UrlFetchApp: { fetch: () => { throw new Error('no network'); } },
  HtmlService: {}
};
const ctx = vm.createContext(G);
VmDate = vm.runInContext('Date', ctx);
const files = ['Code.gs', 'IncidentApi.gs', 'RecordApi.gs', 'BloodgasApi.gs', 'GlucoseApi.gs', 'AllAdminApi.gs', 'LineNotify.gs'];
vm.runInContext(files.map(f => readFileSync(new URL('../legacy-gas/' + f, import.meta.url), 'utf8')).join('\n;\n') +
  '\n;globalThis.__gas = { hash_, getBootstrap, getMyLeaves, getMySummary, getAllLeaves, getStaffCalendar, getOffDutyQuota, calculateDuration, adminSummary, adminGetLeaves, adminListStaff, adminListAdmins, adminReport, adminExportRows, getMonthlyLeaveMatrix, adminGetLate, adminListRequests, stockStaffList_, adminSystems_, alladminRoute_, staffResume };', ctx);
const gas = G.__gas;

// ---------- สร้าง session เดียวกันทั้งสองฝั่ง ----------
const staff = (await core.staffRows_()).filter(r => r.row[core.S.ACTIVE] && r.row[core.S.LEAVE] && !r.row[core.S.MUST]);
const admins = await core.adminRows_();
async function staffToken(id) {
  const t = randomBytes(32).toString('hex');
  cache.set('SESS:' + t, JSON.stringify({ type: 'staff', id, sys: 'leave', pw: '' }));
  await db()`insert into sessions (token,type,subject,sys,pw,expires_at) values (${t},'staff',${id},'leave','',${new Date(Date.now() + 3600e3)})`;
  return t;
}
async function adminToken(a) {
  const t = randomBytes(32).toString('hex'), pw = String(a.row[core.A.HASH]).slice(0, 16), u = String(a.row[core.A.USER]).toLowerCase();
  cache.set('SESS:' + t, JSON.stringify({ type: 'admin', id: u, sys: '', pw }));
  await db()`insert into sessions (token,type,subject,sys,pw,expires_at) values (${t},'admin',${u},'',${pw},${new Date(Date.now() + 3600e3)})`;
  return t;
}

let pass = 0, failN = 0;
async function cmp(label, gasFn, portFn) {
  const a = JSON.parse(JSON.stringify(gasFn()));
  const b = JSON.parse(JSON.stringify(await portFn()));
  if (isDeepStrictEqual(a, b)) { pass++; return; }
  failN++;
  console.log('ไม่ตรง: ' + label);
  console.log('  GAS : ' + JSON.stringify(a).slice(0, 400));
  console.log('  ใหม่: ' + JSON.stringify(b).slice(0, 400));
}

for (const [sec, salt] of [['1234', 'a1b2'], ['รหัสผ่านไทย-ยาว!@#', randomUUID()], ['', 'x'], ['987654', randomUUID()]])
  await cmp('hash_ ' + sec, () => gas.hash_(sec, salt), () => core.hash_(sec, salt));
await cmp('getBootstrap', () => gas.getBootstrap(), () => core.getBootstrap());

const months = [];
for (let y = 2025; y <= 2027; y++) for (let m = 1; m <= 12; m++) months.push([m, y]);
const periods = [['2024-10-01', '2025-09-30'], ['2025-10-01', '2026-09-30'], ['2026-10-01', '2027-09-30'], ['2025-01-01', '2025-12-31'], ['2026-01-01', '2026-12-31']];

for (const s of staff) {
  const t = await staffToken(s.row[core.S.ID]);
  const id = s.row[core.S.ID];
  await cmp('staffResume ' + id, () => gas.staffResume(t), () => core.staffResume(t));
  await cmp('getMyLeaves ' + id, () => gas.getMyLeaves(t), () => core.getMyLeaves(t));
  await cmp('getOffDutyQuota ' + id, () => gas.getOffDutyQuota(t), () => core.getOffDutyQuota(t));
  for (const p of periods) await cmp('getMySummary ' + id + ' ' + p, () => gas.getMySummary(t, p[0], p[1]), () => core.getMySummary(t, p[0], p[1]));
}
const st0 = await staffToken(staff[0].row[core.S.ID]);
for (const f of [{}, { status: 'Pending' }, { status: 'Approve', pageSize: 100, page: 2 }, { status: 'Reject', pageSize: 10 }, { q: 'ลาป่วย', pageSize: 50 }, { q: 'นาง', page: 3 }, { page: 999 }])
  await cmp('getAllLeaves ' + JSON.stringify(f), () => gas.getAllLeaves(st0, f), () => core.getAllLeaves(st0, f));
for (const [m, y] of months) await cmp('getStaffCalendar ' + m + '/' + y, () => gas.getStaffCalendar(st0, m, y), () => core.getStaffCalendar(st0, m, y));
const d = n => { const x = new Date(); x.setDate(x.getDate() + n); return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()); };
for (const c of [['sick', d(1), d(3)], ['annual', d(0), d(10)], ['off_duty_cancel', d(2), d(4)], ['other', d(5), d(5)], ['personal', d(-100), d(-99)], ['sick', d(5), d(1)], ['bad', d(1), d(1)], ['sick', '2026-02-30', '2026-03-01'], ['annual', d(1), d(80)]])
  await cmp('calculateDuration ' + c, () => gas.calculateDuration(st0, ...c), () => core.calculateDuration(st0, ...c));

for (const a of admins) {
  const t = await adminToken(a), u = String(a.row[core.A.USER]);
  await cmp('adminSummary ' + u, () => gas.adminSummary(t), () => core.adminSummary(t));
  await cmp('adminListStaff', () => gas.adminListStaff(t), () => core.adminListStaff(t));
  await cmp('adminListAdmins', () => gas.adminListAdmins(t), () => core.adminListAdmins(t));
  await cmp('adminListRequests all', () => gas.adminListRequests(t, 'all'), () => core.adminListRequests(t, 'all'));
  await cmp('adminListRequests pending', () => gas.adminListRequests(t, 'Pending'), () => core.adminListRequests(t, 'Pending'));
  await cmp('adminSystems_ ' + u, () => gas.adminSystems_(u), () => core.adminSystems_(u));
  for (const f of [{}, { status: 'all' }, { status: 'Approve', month: '2026' }, { status: 'all', month: '2026-03' }, { status: 'Reject' }, { status: 'Cancelled' }, { status: 'all', q: 'นาง' }, { status: 'x' }])
    await cmp('adminGetLeaves ' + JSON.stringify(f), () => gas.adminGetLeaves(t, f), () => core.adminGetLeaves(t, f));
  for (const p of periods) {
    await cmp('adminReport ' + p, () => gas.adminReport(t, p[0], p[1]), () => core.adminReport(t, p[0], p[1]));
    await cmp('adminExportRows ' + p, () => gas.adminExportRows(t, p[0], p[1]), () => core.adminExportRows(t, p[0], p[1]));
  }
  for (const [m, y] of months) await cmp('getMonthlyLeaveMatrix ' + m + '/' + y, () => gas.getMonthlyLeaveMatrix(t, m, y), () => core.getMonthlyLeaveMatrix(t, m, y + 543));
  for (const s of staff.slice(0, 8)) for (const [m, y] of months.slice(10, 20))
    await cmp('adminGetLate ' + s.row[0] + ' ' + m + '/' + y, () => gas.adminGetLate(t, s.row[0], m, y), () => core.adminGetLate(t, s.row[0], m, y));
  for (const body of [
    { action: 'call', fn: 'alladminListAdmins', args: [t] }, { action: 'call', fn: 'alladminOverview', args: [t] },
    { action: 'call', fn: 'alladminAudit', args: [t, {}] }, { action: 'call', fn: 'alladminAudit', args: [t, { kind: 'fail', limit: 400 }] },
    { action: 'call', fn: 'alladminAudit', args: [t, { sys: 'leave', q: 'staff' }] }, { action: 'call', fn: 'alladminAudit', args: [t, { action: 'STAFF_LOGIN' }] },
    { action: 'call', fn: 'alladminTrend', args: [t, 14] }, { action: 'call', fn: 'alladminTrend', args: [t, 30] },
    { action: 'call', fn: 'adminReport', args: [t, '2025-10-01', '2026-09-30'] }, { action: 'call', fn: 'nope', args: [t] }, { action: 'positions' }
  ]) await cmp('alladminRoute_ ' + body.action + ' ' + (body.fn || '') + ' ' + JSON.stringify(body.args ? body.args.slice(1) : ''), () => gas.alladminRoute_(body), () => alladminRoute_(body));
}
for (const sys of ['leave', 'stock', 'stockcenter', 'incident', 'bloodgas', 'glucose', '*'])
  await cmp('stockStaffList_ ' + sys, () => gas.stockStaffList_(sys), () => core.stockStaffList_(sys));

console.log('\nผลเทียบ: ตรงกัน ' + pass + ' / ' + (pass + failN) + (failN ? '  (ไม่ตรง ' + failN + ')' : ''));
await db()`delete from sessions`;
await closeDb();
process.exit(failN ? 1 : 0);
