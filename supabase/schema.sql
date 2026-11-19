-- =====================================================================
-- ระบบบันทึกการแจ้งลา — schema สำหรับ Supabase (Postgres)
-- โคลนจาก Google Sheet "Web ระบบลางาน" : ชีตละ 1 ตาราง คอลัมน์ตรงกับชีตเดิม
-- รันใน Supabase > SQL Editor ครั้งเดียว (รันซ้ำได้ ไม่ลบข้อมูล)
--
-- ความปลอดภัย: เปิด RLS ทุกตาราง และ "ไม่สร้าง policy" = anon/authenticated key อ่าน/เขียนไม่ได้เลย
-- เว็บอ่านเขียนผ่าน API บน Vercel ด้วย DATABASE_URL (role postgres) เท่านั้น เหมือน Apps Script เดิม
-- =====================================================================

-- ชีต Staff (A-O)
create table if not exists staff (
  id              text primary key,               -- A StaffID
  name            text not null,                  -- B ชื่อ-นามสกุล
  position        text not null default '',       -- C ตำแหน่ง
  pin_hash        text not null default '',       -- D PIN Hash
  salt            text not null default '',       -- E Salt
  must_change_pin boolean not null default true,  -- F ต้องเปลี่ยน PIN
  active          boolean not null default true,  -- G ใช้งาน
  created_at      timestamptz,                    -- H สร้างเมื่อ
  pin_changed_at  timestamptz,                    -- I เปลี่ยน PIN ล่าสุด
  sys_leave       boolean not null default false, -- J leave
  sys_stock       boolean not null default false, -- K stock
  sys_stockcenter boolean not null default false, -- L stockcenter
  sys_incident    boolean not null default false, -- M incident
  sys_bloodgas    boolean not null default false, -- N bloodgas
  sys_glucose     boolean not null default false, -- O glucose
  seq             bigserial                       -- ลำดับแถวเดิมในชีต
);

-- ชีต Admins (A-I)
create table if not exists admins (
  username     text primary key,               -- A Username (ตัวพิมพ์เล็ก)
  display_name text not null default '',       -- B ชื่อที่แสดง
  pw_hash      text not null default '',       -- C Password Hash
  salt         text not null default '',       -- D Salt
  active       boolean not null default true,  -- E ใช้งาน
  created_at   timestamptz,                    -- F สร้างเมื่อ
  systems      text not null default '',       -- G Systems (เช่น incident,record หรือ all)
  super        boolean not null default false, -- H Super (ผู้ดูแลใหญ่)
  line_user_id text not null default '',       -- I LineUserId
  seq          bigserial
);

-- ชีต Leave (A-M)
create table if not exists leaves (
  id         text primary key,                 -- I LeaveID
  ts         timestamptz,                      -- A Timestamp
  name       text not null default '',         -- B ชื่อ - นามสกุล
  position   text not null default '',         -- C ตำแหน่ง
  type       text not null default '',         -- D ประเภทการลา (ป้ายภาษาไทย เช่น ลาป่วย)
  start_date date,                             -- E เริ่มต้น
  end_date   date,                             -- F สิ้นสุด
  days       numeric,                          -- G จำนวน
  status     text not null default 'Pending',  -- H สถานะ: Pending | Approve | Reject | Cancelled
  by_name    text not null default '',         -- J ผู้ดำเนินการ
  at         timestamptz,                      -- K เวลาดำเนินการ
  note       text not null default '',         -- L หมายเหตุ
  staff_id   text not null default '',         -- M StaffID (ไม่ผูก FK: ลบพนักงานแล้วประวัติยังอยู่ เหมือนเดิม)
  seq        bigserial                         -- ลำดับแถวเดิม (เรียงใหม่สุด = seq มากสุด)
);
create index if not exists leaves_staff_idx on leaves (staff_id);
create index if not exists leaves_status_idx on leaves (status);
create index if not exists leaves_start_idx on leaves (start_date);

-- ชีต Holidays (A-B)
create table if not exists holidays (
  date date primary key,          -- A วันที่
  name text not null default ''   -- B ชื่อวันหยุด
);

-- ชีต AuditLog (A-E)
create table if not exists audit_log (
  seq    bigserial primary key,
  ts     timestamptz not null default now(),  -- A เวลา
  actor  text not null default '',            -- B ผู้กระทำ
  action text not null default '',            -- C การกระทำ
  target text not null default '',            -- D เป้าหมาย
  detail text not null default ''             -- E รายละเอียด
);
create index if not exists audit_ts_idx on audit_log (ts);

-- ชีต StaffRequests (A-J)
create table if not exists staff_requests (
  id       text primary key,                -- A RequestID
  name     text not null default '',        -- B ชื่อ-นามสกุล
  position text not null default '',        -- C ตำแหน่ง
  contact  text not null default '',        -- D ข้อมูลติดต่อ
  status   text not null default 'Pending', -- E สถานะ
  ts       timestamptz,                     -- F ส่งเมื่อ
  by_name  text not null default '',        -- G ดำเนินการโดย
  at       timestamptz,                     -- H เวลาดำเนินการ
  staff_id text not null default '',        -- I StaffID
  note     text not null default '',        -- J หมายเหตุ
  seq      bigserial
);

-- ชีต "Arrive late" (A-G)
create table if not exists late_records (
  id       text primary key,         -- A RecordID
  staff_id text not null default '', -- B StaffID
  name     text not null default '', -- C ชื่อ-นามสกุล
  date     date,                     -- D วันที่
  note     text not null default '', -- E หมายเหตุ
  by_name  text not null default '', -- F บันทึกโดย
  at       timestamptz,              -- G บันทึกเมื่อ
  seq      bigserial
);
create index if not exists late_staff_idx on late_records (staff_id, date);

-- ===== แทน CacheService / PropertiesService ของ Apps Script =====
-- session ของพนักงาน/ผู้ดูแล (แทน CacheService 'SESS:')
create table if not exists sessions (
  token      text primary key,
  type       text not null,             -- staff | admin
  subject    text not null,             -- StaffID หรือ username
  sys        text not null default '',  -- ระบบที่ออก token ให้
  pw         text not null default '',  -- แท็กรหัสผ่านผู้ดูแล (ตัดเซสชันเมื่อเปลี่ยนรหัส)
  expires_at timestamptz not null
);
create index if not exists sessions_exp_idx on sessions (expires_at);

-- ค่าชั่วคราวมีวันหมดอายุ (ตัวนับใส่รหัสผิด FAIL:, REQCOUNT, รหัสผูก LINE ฯลฯ) และคิว LINE
create table if not exists kv (
  key        text primary key,
  value      text not null,
  expires_at timestamptz            -- null = ไม่หมดอายุ
);

-- ===== สำเนาดิบทุกเซลล์จาก Google Sheet ณ เวลาที่นำเข้า (ไว้ตรวจว่าโคลนครบ 100%) =====
create table if not exists sheet_snapshot (
  sheet       text not null,
  row_no      int not null,          -- เลขแถวในชีต (1 = หัวตาราง)
  cells       jsonb not null,        -- [{ "v": ค่าจริง, "f": ค่าที่แสดง }, ...]
  imported_at timestamptz not null default now(),
  primary key (sheet, row_no)
);

-- ===== ปิดการเข้าถึงจาก anon/authenticated ทั้งหมด =====
do $$
declare t text;
begin
  foreach t in array array['staff','admins','leaves','holidays','audit_log','staff_requests','late_records','sessions','kv','sheet_snapshot'] loop
    execute format('alter table %I enable row level security', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table %I from anon, authenticated', t);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all sequences in schema public from anon, authenticated';
  end if;
end $$;
