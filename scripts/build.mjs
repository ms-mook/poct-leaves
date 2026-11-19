// ประกอบหน้าเว็บจากไฟล์ HTML เดิมของ Apps Script (src/pages) -> public/
// - แทน <?!= include_('X'); ?> ด้วยเนื้อหาไฟล์ X.html (เหมือน HtmlService)
// - แทน <?= appUrl ?> ด้วย "/" (หน้า Admin เปิดผ่าน /?page=Admin เหมือนเดิม และ /admin)
// - เติม shim ให้ google.script.run เรียก /api/rpc แทน (โค้ดหน้าเว็บเดิมไม่ต้องแก้)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src', 'pages');
const out = join(root, 'public');
mkdirSync(out, { recursive: true });

const SHIM = `<script>
/* แทน google.script.run ของ Apps Script: ส่ง {fn,args} ไป /api/rpc แล้วเรียก successHandler / failureHandler เหมือนเดิม */
(function () {
  function runner(ok, bad) {
    return new Proxy({}, {
      get: function (_, name) {
        if (name === 'withSuccessHandler') return function (h) { return runner(h, bad); };
        if (name === 'withFailureHandler') return function (h) { return runner(ok, h); };
        if (name === 'withUserObject') return function () { return runner(ok, bad); };
        return function () {
          var args = Array.prototype.slice.call(arguments);
          fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fn: String(name), args: args }), credentials: 'same-origin' })
            .then(function (r) { if (!r.ok && r.status !== 400) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (v) { if (ok) ok(v); }, function (e) { if (bad) bad(e); });
        };
      }
    });
  }
  window.google = window.google || {};
  window.google.script = { run: runner(null, null) };
})();
</script>`;

function render(name) {
  let html = readFileSync(join(src, name + '.html'), 'utf8');
  html = html.replace(/<\?!=\s*include_\('([A-Za-z0-9_]+)'\);?\s*\?>/g, (_, f) => readFileSync(join(src, f + '.html'), 'utf8'));
  html = html.replace(/<\?=\s*appUrl\s*\?>/g, '/');
  if (/<\?/.test(html)) throw new Error(name + ': ยังมี scriptlet ของ Apps Script ที่ไม่รู้จัก');
  return html.replace(/<head>/i, '<head>\n' + SHIM);
}

writeFileSync(join(out, 'index.html'), render('Index'));
writeFileSync(join(out, 'admin.html'), render('Admin'));
console.log('build: public/index.html, public/admin.html');
