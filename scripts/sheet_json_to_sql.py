#!/usr/bin/env python3
"""
แปลงข้อมูลที่อ่านจาก Google Sheets API (spreadsheets.get + includeGridData, fields effectiveValue/formattedValue)
เป็นไฟล์ SQL สำหรับนำเข้า Supabase แบบโคลนครบทุกแถว

ใช้:  python3 scripts/sheet_json_to_sql.py OUT.sql grid1.json [grid2.json ...]
- อ่านอย่างเดียว ไม่แตะชีตต้นฉบับ
- ไฟล์ OUT.sql มีข้อมูลส่วนบุคคลและ PIN hash : ห้าม commit ขึ้น GitHub (อยู่ใน .gitignore แล้ว)
- รันซ้ำได้: ล้างตารางข้อมูลแล้วใส่ใหม่ทั้งหมด (ใช้ตอน sync รอบสุดท้ายก่อนย้ายจริง)
"""
import json, sys, uuid
from datetime import datetime, timedelta

BASE = datetime(1899, 12, 30)   # serial 0 ของ Google Sheets (เวลาตามโซนของไฟล์ = Asia/Bangkok)
TZ = '+07'


def load(paths):
    sheets = {}
    for p in paths:
        j = json.load(open(p, encoding='utf-8'))
        j = j.get('content', j)
        for sh in j['sheets']:
            rows = []
            for r in (sh.get('data') or [{}])[0].get('rowData', []):
                rows.append(r.get('values', []))
            sheets[sh['properties']['title']] = rows
    return sheets


def ev(cell):
    e = cell.get('effectiveValue') if cell else None
    if not e:
        return None
    return list(e.values())[0]


def cells(row, width):
    out = list(row) + [{}] * max(0, width - len(row))
    return out[:width] if width else out


def q(s):
    if s is None:
        return 'null'
    return "'" + str(s).replace("'", "''") + "'"


def text(cell):
    """เหมือน String(v || '') ของ Apps Script"""
    v = ev(cell)
    if v is None or v is False or v == '':
        return ''
    if v is True:
        return 'true'
    if isinstance(v, str):
        return v
    return cell.get('formattedValue', str(v))


def boolean(cell):
    v = ev(cell)
    return 'true' if (v is True or str(v).upper() == 'TRUE') else 'false'


def ts(cell):
    v = ev(cell)
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        d = BASE + timedelta(seconds=round(v * 86400))
        if d.year > 2400:
            d = d.replace(year=d.year - 543)
        return q(d.strftime('%Y-%m-%d %H:%M:%S') + TZ)
    if isinstance(v, str) and v.strip():
        return date_from_text(v, with_time=True)
    return 'null'


def date_from_text(s, with_time=False):
    """ข้อความ DD/MM/YYYY (พ.ศ. หรือ ค.ศ.) เหมือน toDate_ เดิม"""
    import re
    m = re.match(r'^\s*(\d{1,2})/(\d{1,2})/(\d{4})', s)
    if not m:
        return 'null'
    y = int(m.group(3))
    if y > 2400:
        y -= 543
    try:
        d = datetime(y, int(m.group(2)), int(m.group(1)))
    except ValueError:
        return 'null'
    return q(d.strftime('%Y-%m-%d') + (' 00:00:00' + TZ if with_time else ''))


def date(cell):
    v = ev(cell)
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        d = BASE + timedelta(days=int(v // 1))
        y = d.year - 543 if d.year > 2400 else d.year
        return q('%04d-%02d-%02d' % (y, d.month, d.day))
    if isinstance(v, str):
        return date_from_text(v)
    return 'null'


def num(cell):
    v = ev(cell)
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return repr(v)
    try:
        return repr(float(str(v)))
    except Exception:
        return 'null'


def data_rows(rows):
    """แถวข้อมูล (ข้ามหัวตาราง) ที่ไม่ว่างทั้งแถว"""
    out = []
    for i, r in enumerate(rows[1:], start=2):
        if any(ev(c) not in (None, '') for c in r):
            out.append((i, r))
    return out


def main():
    out_path, paths = sys.argv[1], sys.argv[2:]
    S = load(paths)
    L = []
    w = L.append
    w('-- สร้างโดย scripts/sheet_json_to_sql.py เมื่อ ' + datetime.now().strftime('%Y-%m-%d %H:%M:%S'))
    w('-- มีข้อมูลส่วนบุคคล/PIN hash : ห้ามเผยแพร่ ห้าม commit')
    w('begin;')
    w('truncate staff, admins, leaves, holidays, audit_log, staff_requests, late_records, sheet_snapshot, sessions restart identity;')

    # ---- สำเนาดิบ ----
    for name, rows in S.items():
        for i, r in enumerate(rows, start=1):
            arr = [{'v': ev(c), 'f': (c or {}).get('formattedValue')} for c in r]
            w('insert into sheet_snapshot (sheet,row_no,cells) values (%s,%d,%s::jsonb);' % (q(name), i, q(json.dumps(arr, ensure_ascii=False))))

    counts = {}
    # ---- Staff ----
    n = 0
    for _, r in data_rows(S.get('Staff', [])):
        c = cells(r, 15)
        if not text(c[0]):
            continue
        w('insert into staff (id,name,position,pin_hash,salt,must_change_pin,active,created_at,pin_changed_at,sys_leave,sys_stock,sys_stockcenter,sys_incident,sys_bloodgas,sys_glucose) values (%s);' % ','.join([
            q(text(c[0])), q(text(c[1])), q(text(c[2])), q(text(c[3])), q(text(c[4])), boolean(c[5]), boolean(c[6]), ts(c[7]), ts(c[8]),
            boolean(c[9]), boolean(c[10]), boolean(c[11]), boolean(c[12]), boolean(c[13]), boolean(c[14])]))
        n += 1
    counts['staff'] = n

    # ---- Admins ----
    n = 0
    for _, r in data_rows(S.get('Admins', [])):
        c = cells(r, 9)
        if not text(c[0]):
            continue
        w('insert into admins (username,display_name,pw_hash,salt,active,created_at,systems,super,line_user_id) values (%s);' % ','.join([
            q(text(c[0]).strip()), q(text(c[1])), q(text(c[2])), q(text(c[3])), boolean(c[4]), ts(c[5]), q(text(c[6])), boolean(c[7]), q(text(c[8]).strip())]))
        n += 1
    counts['admins'] = n

    # ---- Leave ----
    n = 0
    for _, r in data_rows(S.get('Leave', [])):
        c = cells(r, 13)
        lid = text(c[8]) or str(uuid.uuid4())
        w('insert into leaves (id,ts,name,position,type,start_date,end_date,days,status,by_name,at,note,staff_id) values (%s);' % ','.join([
            q(lid), ts(c[0]), q(text(c[1])), q(text(c[2])), q(text(c[3])), date(c[4]), date(c[5]), num(c[6]),
            q(text(c[7])), q(text(c[9])), ts(c[10]), q(text(c[11])), q(text(c[12]))]))
        n += 1
    counts['leaves'] = n

    # ---- Holidays ----
    n = 0
    seen = set()
    for _, r in data_rows(S.get('Holidays', [])):
        c = cells(r, 2)
        d = date(c[0])
        if d == 'null' or d in seen:
            continue
        seen.add(d)
        w('insert into holidays (date,name) values (%s,%s);' % (d, q(text(c[1]))))
        n += 1
    counts['holidays'] = n

    # ---- AuditLog ----
    n = 0
    for _, r in data_rows(S.get('AuditLog', [])):
        c = cells(r, 5)
        t = ts(c[0])
        w('insert into audit_log (ts,actor,action,target,detail) values (%s,%s,%s,%s,%s);' % (
            t if t != 'null' else 'now()', q(text(c[1])), q(text(c[2])), q(text(c[3])), q(text(c[4]))))
        n += 1
    counts['audit_log'] = n

    # ---- StaffRequests ----
    n = 0
    for _, r in data_rows(S.get('StaffRequests', [])):
        c = cells(r, 10)
        w('insert into staff_requests (id,name,position,contact,status,ts,by_name,at,staff_id,note) values (%s);' % ','.join([
            q(text(c[0]) or str(uuid.uuid4())), q(text(c[1])), q(text(c[2])), q(text(c[3])), q(text(c[4])), ts(c[5]), q(text(c[6])), ts(c[7]), q(text(c[8])), q(text(c[9]))]))
        n += 1
    counts['staff_requests'] = n

    # ---- Arrive late ----
    n = 0
    for _, r in data_rows(S.get('Arrive late', [])):
        c = cells(r, 7)
        w('insert into late_records (id,staff_id,name,date,note,by_name,at) values (%s);' % ','.join([
            q(text(c[0]) or str(uuid.uuid4())), q(text(c[1])), q(text(c[2])), date(c[3]), q(text(c[4])), q(text(c[5])), ts(c[6])]))
        n += 1
    counts['late_records'] = n

    w('commit;')
    w('-- ตรวจจำนวนแถวหลังนำเข้า (ต้องตรงกับค่าที่คาดไว้)')
    w('select ' + ', '.join("(select count(*) from %s) as %s" % (k, k) for k in counts) + ';')
    open(out_path, 'w', encoding='utf-8').write('\n'.join(L) + '\n')
    print(json.dumps(counts, ensure_ascii=False))


if __name__ == '__main__':
    main()
