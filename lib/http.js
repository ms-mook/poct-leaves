// ตัวช่วยฝั่ง HTTP ที่ใช้ร่วมกันระหว่าง /api/rpc และ /api/exec
export async function readJson(req) {
  let b = req.body;
  if (b === undefined) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    b = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') {
    if (!b.trim()) return {};
    try { return JSON.parse(b); } catch (e) { return null; }
  }
  return b && typeof b === 'object' ? b : {};
}

export function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(obj));
}

export function queryOf(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  try { return Object.fromEntries(new URL(req.url, 'http://x').searchParams); } catch (e) { return {}; }
}
