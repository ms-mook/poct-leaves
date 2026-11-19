# ระบบบันทึกการแจ้งลา — Supabase + Vercel

ย้ายเว็บแอประบบลา (Google Apps Script + Google Sheet "Web ระบบลางาน") มาเป็น

- **ฐานข้อมูล**: Supabase (Postgres) — ชีตละ 1 ตาราง คอลัมน์ตรงกับชีตเดิม
- **โค้ด**: GitHub repo นี้
- **โฮสต์**: Vercel (หน้าเว็บ static + API แบบ serverless)

ระบบเดิมบน Apps Script **ไม่ถูกแก้ไข** ใช้งานต่อได้ตามปกติระหว่างทดสอบระบบใหม่คู่ขนาน

## สิ่งที่เหมือนเดิม 100%

| ส่วน | เดิม (Apps Script) | ใหม่ |
|---|---|---|
| หน้าพนักงาน / หน้าผู้ดูแล | `Index.html`, `Admin.html` + include | ไฟล์เดิมทุกบรรทัด (`src/pages/`) ประกอบด้วย `scripts/build.mjs` |
| `google.script.run.xxx()` | เรียกฟังก์ชัน .gs | shim ส่งไป `POST /api/rpc` (หน้าเว็บไม่ต้องแก้) |
| `doPost` ที่ระบบอื่นเรียก | `https://script.google.com/.../exec` | `https://<โดเมน>/api/exec` (หรือ `/exec`) รับ JSON รูปแบบเดิม |
| PIN / รหัสผ่าน | SHA-256 ×100 + salt + PEPPER | อัลกอริทึมเดียวกันทุกไบต์ → ใช้ PIN/รหัสเดิมได้ ถ้าใส่ `PEPPER` เดิม |
| LockService | ล็อกทั้งสคริปต์ | transaction + `pg_advisory_xact_lock` (ล้มกลางทาง = ยกเลิกทั้งก้อน) |
| CacheService (session, ตัวนับรหัสผิด) | cache 6 ชม. | ตาราง `sessions`, `kv` (มีวันหมดอายุ) |
| เมนู URL `?page=Admin` | ✓ | ✓ (และ `/admin`) |

`lib/core.js`, `lib/exec.js`, `lib/alladmin.js`, `lib/line.js` พอร์ตจาก `Code.gs`, `IncidentApi.gs`/`RecordApi.gs`/`BloodgasApi.gs`/`GlucoseApi.gs`, `AllAdminApi.gs`, `LineNotify.gs` ฟังก์ชันต่อฟังก์ชัน ข้อความและรหัสผิดพลาดเหมือนเดิม โค้ดต้นฉบับเก็บไว้ที่ `legacy-gas/` เพื่ออ้างอิง

### ผลทดสอบก่อนส่งมอบ

- `test/parity.mjs` — รัน **โค้ด .gs เดิม** (จำลองชีตจากข้อมูลจริง แบบอ่านอย่างเดียว) เทียบกับโค้ดใหม่บนฐานข้อมูลที่นำเข้า: **ตรงกัน 590/590 กรณี** (รายงาน, ตารางสรุปรายเดือน, ปฏิทิน, ประวัติ, Admin Center, audit, แฮช PIN ฯลฯ)
- `test/run.mjs` — ทดสอบการเขียนข้อมูลครบวงจรบนข้อมูลสมมติ: **68/68 ข้อ** รวมส่งใบลาพร้อมกัน 5 คำขอ (ผ่าน 1), ล็อกหลังใส่ PIN ผิด, API ของ Stock/Incident/Record/Blood Gas/Glucose/Admin Center และเปิดหน้าเว็บจริงด้วย Playwright

## ขั้นตอนติดตั้ง

### 1) Supabase

1. สร้างโปรเจกต์ (แนะนำ region Singapore)
2. SQL Editor → วางไฟล์ `supabase/schema.sql` → Run
3. SQL Editor → วางไฟล์ข้อมูล `seed.sql` (ได้จาก Claude แยกต่างหาก **ไม่อยู่ใน GitHub** เพราะมีข้อมูลส่วนบุคคล) → Run
   - แถวสุดท้ายจะแสดงจำนวนแถว ต้องได้ `staff 29 | admins 2 | leaves 474 | holidays 0 | audit_log 1204 | staff_requests 2 | late_records 15` (ณ วันที่ดึงข้อมูล)
4. ตาราง `sheet_snapshot` เก็บทุกเซลล์ของทุกชีตแบบดิบ (ค่าจริง + ค่าที่แสดง) ไว้ตรวจย้อนหลัง

ทุกตารางเปิด RLS และไม่มี policy: anon key อ่าน/เขียนไม่ได้เลย เข้าถึงข้อมูลได้ผ่าน API ของเว็บนี้เท่านั้น (เหมือน Apps Script ที่ชีตไม่ได้แชร์สาธารณะ)

### 2) Vercel

1. Add New Project → Import `ms-mook/poct-leaves` (Framework Preset: **Other**, ค่าอื่นอ่านจาก `vercel.json`)
2. ตั้ง Environment Variables ตาม `.env.example`
   - `DATABASE_URL` = Supabase → Connect → **Transaction pooler** (พอร์ต 6543)
   - `PEPPER` และ `*_API_KEY` = คัดลอกจาก Apps Script ระบบลา → Project Settings → Script Properties
   - `LINE_CHANNEL_TOKEN` **เว้นว่างระหว่างทดสอบ** (ไม่งั้นผู้ดูแลจะได้แจ้งเตือนซ้ำจากสองระบบ)
3. Deploy

ถ้าไม่ใส่ `PEPPER` เดิม ทุกคนจะเข้าสู่ระบบไม่ได้ (ระบบตอบ "ระบบยังไม่ได้ติดตั้ง")

## ระหว่างทดสอบคู่ขนาน

- ข้อมูลในระบบใหม่เป็น "ภาพถ่าย" ณ วันที่นำเข้า ใบลาที่ส่งในระบบเดิมหลังจากนั้นจะไม่มาเอง
- ทดลองส่งใบลา/อนุมัติในระบบใหม่ได้เต็มที่ ไม่กระทบชีตเดิม
- ระบบอื่น (Stock, Incident ฯลฯ) ยังชี้ไประบบลาเดิม จนกว่าจะเปลี่ยน `LEAVE_API_URL`

## วันย้ายจริง (cutover)

1. แจ้งพนักงานงดใช้ระบบเดิมช่วงสั้น ๆ
2. ดึงข้อมูลชีตล่าสุด → สร้าง `seed.sql` ใหม่ด้วย `scripts/sheet_json_to_sql.py` → Run ใน Supabase (ล้างแล้วใส่ใหม่ทั้งหมด)
3. ใส่ `LINE_CHANNEL_TOKEN`, `LINE_WEBHOOK_KEY` ใน Vercel → Redeploy และเปลี่ยน Webhook URL ใน LINE Developers เป็น `https://<โดเมน>/api/exec?k=<LINE_WEBHOOK_KEY>`
4. เปลี่ยน Script Property `LEAVE_API_URL` ของทุกระบบเป็น `https://<โดเมน>/api/exec`
5. ปิดการ Deploy เว็บแอประบบลาเดิม (เก็บชีตไว้เป็นข้อมูลสำรอง)

## แจ้งเตือน LINE แบบรวมทุก 5 นาที

เดิมใช้ time trigger `lineFlush` ทุก 5 นาที ระบบใหม่ส่งคิวที่ค้างเกิน 5 นาทีอัตโนมัติเมื่อมีคำขอใดเข้ามา และมี `/api/cron-line` (ใช้ header `Authorization: Bearer <CRON_SECRET>`) ให้บริการตั้งเวลาภายนอกหรือ Supabase `pg_cron` เรียกได้ถ้าต้องการให้ตรงเวลา

## พัฒนา / ทดสอบในเครื่อง

```bash
npm install
npm run build                                   # สร้าง public/
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/e2e npm test   # ฐานทดสอบว่าง (ห้ามชี้ไป Supabase จริง)
```

## โครงสร้าง

```
api/            rpc.js (แทน google.script.run), exec.js (แทน doPost), cron-line.js
lib/            core.js, exec.js, alladmin.js, line.js, db.js, http.js
src/pages/      HTML/CSS/JS เดิมจาก Apps Script
supabase/       schema.sql
scripts/        build.mjs, sheet_json_to_sql.py (ชีต -> SQL)
legacy-gas/     โค้ด Apps Script ต้นฉบับ (อ้างอิงเท่านั้น)
test/           parity.mjs, run.mjs, server.mjs
```
