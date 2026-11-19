// การเชื่อมต่อ Postgres (Supabase) + ตัวล็อกแทน LockService ของ Apps Script
process.env.TZ = 'Asia/Bangkok';   // ให้ new Date(y, m, d) ทำงานตามเวลาไทยเหมือน Apps Script (Vercel ใช้ UTC)

import postgres from 'postgres';
import { AsyncLocalStorage } from 'node:async_hooks';

let pool = null;
const txStore = new AsyncLocalStorage();

function root() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('ยังไม่ได้ตั้ง DATABASE_URL');
    pool = postgres(url, {
      prepare: false,                                   // จำเป็นสำหรับ Supabase pooler (transaction mode, พอร์ต 6543)
      max: Number(process.env.DB_POOL_MAX || 3),
      idle_timeout: 20,
      connect_timeout: 15,
      onnotice: () => {},
      types: { date: { to: 1082, from: [1082], serialize: x => x, parse: x => x } }   // คอลัมน์ date คืนเป็น 'YYYY-MM-DD'
    });
  }
  return pool;
}

/** ตัว query ปัจจุบัน: ถ้าอยู่ใน withLock_ จะใช้ transaction เดียวกัน */
export function db() { return txStore.getStore() || root(); }

/** แทน LockService.getScriptLock(): ทำทั้งก้อนใน transaction เดียว + advisory lock ทั้งระบบ (ทีละคำขอ)
 *  ถ้าผิดพลาดกลางทาง ทุกอย่างที่เขียนไปในก้อนนี้ถูกยกเลิก (ปลอดภัยกว่าชีตเดิม) */
export async function withTx(fn, timeoutMs = 15000) {
  if (txStore.getStore()) return fn();
  return root().begin(async tx => {
    await tx.unsafe(`set local lock_timeout = '${Math.floor(timeoutMs)}ms'`);
    await tx`select pg_advisory_xact_lock(771001)`;
    return txStore.run(tx, fn);
  });
}

export async function closeDb() { if (pool) { await pool.end({ timeout: 2 }); pool = null; } }
