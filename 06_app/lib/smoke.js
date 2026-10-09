/* After every deploy (R16): checks the LIVE site answers the way the tests
 * say it should. Reads no photo and saves nothing, so it costs nothing and
 * uses none of the day's free reads.
 *    node lib/smoke.js https://clearbill-e7sodufiva-el.a.run.app
 * Exits non-zero if anything is wrong.
 */
const zlib = require('zlib');
const BASE = (process.argv[2] || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(BASE)) { console.log('usage: node lib/smoke.js <site url>'); process.exit(2); }

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m + (extra ? '  -> ' + extra : '')); } };
const get = (p, h) => fetch(BASE + p, { headers: h || {}, redirect: 'manual' });

(async () => {
  console.log('== ' + BASE);
  let r = await get('/');
  const html = await r.text(), csp = r.headers.get('content-security-policy') || '';
  ok(r.status === 200 && /<title>ClearBill/.test(html), 'the page loads');
  ok(/script-src 'sha256-[A-Za-z0-9+/=]+'/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp) && /frame-ancestors 'none'/.test(csp), 'it is served with the hash-based security policy');
  const hash = require('crypto').createHash('sha256').update(([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0] || [])[1].replace(/\r\n?/g, '\n')).digest('base64');
  ok(csp.includes(`'sha256-${hash}'`), "the policy's hash matches the script actually served (the app will run)");
  ok(r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('x-frame-options') === 'DENY' && !!r.headers.get('strict-transport-security'), 'security headers are present');
  // Node's fetch decompresses for us; ask for brotli and confirm it was used.
  r = await get('/', { 'Accept-Encoding': 'br' });
  ok(r.headers.get('content-encoding') === 'br', 'brotli is served to browsers that accept it');

  r = await get('/api/config'); const cfg = await r.json();
  ok(r.status === 200 && cfg.proxy === true, 'the free reading service is switched on');
  ok(['ok', 'busy', 'overloaded'].includes(cfg.reader), 'the reader reports a working state ("' + cfg.reader + '")');
  if (cfg.reader !== 'ok') console.log('  note: "' + cfg.reader + '" passes on its own; nothing to fix');
  ok(cfg.bills === true && /apps\.googleusercontent\.com$/.test(cfg.googleClientId || ''), 'My Bills sign-in is switched on');

  r = await get('/api/health'); const h = await r.json();
  ok(r.status === 200 && h.ok === true, 'the health check passes (Google accepts the key and the model exists)', JSON.stringify(h));

  r = await get('/api/impact'); const imp = await r.json();
  ok(r.status === 200 && imp.enabled === true && imp.pages >= 0, 'the impact counter answers (' + imp.pages + ' pages so far)');

  r = await get('/og.png');
  ok(r.status === 200 && r.headers.get('content-type') === 'image/png' && (await r.arrayBuffer()).byteLength < 300 * 1024, 'the link-preview image is served (PNG, under 300 KB)');
  ok(/property="og:image" content="https:\/\/[^"]+\/og\.png"/.test(html), 'the page names it as its preview image');

  for (const p of ['/server.js', '/lib/checks.js', '/Dockerfile', '/DEPLOY.md']) { r = await get(p); ok(r.status === 404, p + ' is not served'); }

  r = await fetch(BASE + '/api/read-bill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"not":"a photo"}' });
  ok(r.status === 400, 'a request with no photo is refused before any paid call (400)');
  r = await get('/api/bills');
  ok(r.status === 401, 'saved bills need a Google sign-in (401)');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('smoke test could not run:', e.message); process.exit(2); });
