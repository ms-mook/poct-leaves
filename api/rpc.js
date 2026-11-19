// แทน google.script.run : หน้าเว็บส่ง { fn, args } มาที่นี่ (เรียกได้เฉพาะฟังก์ชันในรายการ)
import * as core from '../lib/core.js';
import '../lib/line.js';
import { lineFlushIfDue } from '../lib/line.js';
import { readJson, sendJson } from '../lib/http.js';

const PUBLIC_FNS = [
  // หน้าพนักงาน (Index)
  'getBootstrap', 'staffLogin', 'staffResume', 'staffLogout', 'staffChangePin', 'calculateDuration', 'submitLeave',
  'getMyLeaves', 'staffCancelLeave', 'getMySummary', 'requestStaffAccess', 'getAllLeaves', 'getStaffCalendar', 'getOffDutyQuota',
  // หน้าผู้ดูแล (Admin)
  'adminLogin', 'adminLogout', 'adminChangeOwnPassword', 'adminSummary', 'adminGetLeaves', 'adminDecide', 'adminCancelLeave',
  'adminListStaff', 'adminSaveStaff', 'adminUnlockStaff', 'adminResetStaffPin', 'adminDeleteStaff',
  'adminListAdmins', 'adminAddAdmin', 'adminUpdateAdmin', 'adminResetAdminPassword', 'adminDeleteAdmin',
  'adminReport', 'adminExportRows', 'adminListRequests', 'adminDecideRequest', 'adminClearRequests',
  'getMonthlyLeaveMatrix', 'adminGetLate', 'adminSaveLateMonth'
];

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, code: 'BAD_ACTION', message: 'คำสั่งไม่ถูกต้อง' });
  const body = await readJson(req);
  const fn = body && typeof body.fn === 'string' ? body.fn : '';
  const args = body && Array.isArray(body.args) ? body.args.slice(0, 8) : [];
  if (PUBLIC_FNS.indexOf(fn) < 0 || typeof core[fn] !== 'function') return sendJson(res, 400, { ok: false, code: 'BAD_ACTION', message: 'คำสั่งไม่ถูกต้อง' });
  const out = await core[fn](...args);
  await lineFlushIfDue();
  sendJson(res, 200, out == null ? null : out);
}
