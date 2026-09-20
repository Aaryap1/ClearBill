/* Tests for server.js's protections (release R0). Runs the REAL server.js as a
 * child process against a mock Gemini that can misbehave on demand — no key,
 * no network, no cost.        node lib/test_server.js
 */
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const OK_JSON = JSON.stringify({ is_hospital_bill: true, header: {}, line_items: [{ item: 'X', total: 1 }] });
let upstreamCalls = 0;
const mock = http.createServer((req, res) => {
  const c = []; req.on('data', d => c.push(d));
  req.on('end', () => {
    upstreamCalls++;
    const j = JSON.parse(Buffer.concat(c).toString());
    const img = Buffer.from(j.contents[0].parts[1].inline_data.data, 'base64').toString();
    if (img === 'hang') return; // never answer
    if (img === 'secret') { res.writeHead(500); return res.end('SECRET_UPSTREAM_DETAIL key=AIzaFAKE'); }
    if (img === 'quota') { res.writeHead(429); return res.end('{"error":{"status":"RESOURCE_EXHAUSTED"}}'); }
    if (img === 'overload') { res.writeHead(503); return res.end('{"error":"high demand"}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: img === 'empty' ? '' : '```json\n' + OK_JSON + '\n```' }] } }] }));
  });
});

let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function req(port, method, p, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(c) }));
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
const text = r => r.raw.toString('utf8');
const post = (port, image, extra = {}) => req(port, 'POST', '/api/read-bill', {
  body: JSON.stringify({ mime_type: 'image/jpeg', data: Buffer.from(image).toString('base64'), ...extra }),
  headers: { 'Content-Type': 'application/json', ...(extra._h || {}) },
});
const postH = (port, image, h) => req(port, 'POST', '/api/read-bill', {
  body: JSON.stringify({ mime_type: 'image/jpeg', data: Buffer.from(image).toString('base64') }),
  headers: { 'Content-Type': 'application/json', ...h },
});

const servers = [];
async function start(port, env) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), ...env }, stdio: 'ignore' });
  servers.push(child);
  for (let i = 0; i < 60; i++) { try { await req(port, 'GET', '/api/config'); return; } catch (e) { await sleep(100); } }
  throw new Error('server did not start on ' + port);
}

(async () => {
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + mock.address().port;
  const common = { GEMINI_API_KEY: 'k', GEMINI_BASE: base };
  const P = 18521;
  try {
    await start(P, { ...common, RATE_MAX_PER_IP: '1000', DAILY_CAP: '100000', MAX_BODY_BYTES: String(1024 * 1024), UPSTREAM_TIMEOUT_MS: '500' });

    console.log('== static files: allowlist only');
    let r = await req(P, 'GET', '/');
    ok(r.status === 200 && /<title>ClearBill/.test(text(r)), 'GET / serves the app');
    for (const f of ['/manifest.json', '/icon.svg', '/index.html']) { r = await req(P, 'GET', f); ok(r.status === 200, 'GET ' + f + ' is served'); }
    for (const f of ['/server.js', '/Dockerfile', '/deploy.sh', '/DEPLOY.md', '/README.md', '/firebase.json', '/lib/checks.js', '/lib/build_checks.js', '/../server.js', '/%2e%2e/server.js', '/lib/', '/webhook/whatsapp']) {
      r = await req(P, 'GET', f); ok(r.status === 404, 'GET ' + f + ' is 404');
    }
    r = await req(P, 'GET', '/api/config'); ok(r.status === 200 && JSON.parse(text(r)).proxy === true, '/api/config still reports the proxy');

    console.log('== transfer: gzip, ETag, always-revalidate');
    const plain = await req(P, 'GET', '/');
    const gz = await req(P, 'GET', '/', { headers: { 'Accept-Encoding': 'gzip' } });
    ok(gz.headers['content-encoding'] === 'gzip' && zlib.gunzipSync(gz.raw).equals(plain.raw), 'gzip body decompresses to exactly the plain body');
    ok(gz.raw.length < plain.raw.length / 2, 'gzip is less than half the size (' + gz.raw.length + ' vs ' + plain.raw.length + ')');
    ok(/no-cache/.test(plain.headers['cache-control']), 'Cache-Control: no-cache (a redeploy shows on the next load)');
    r = await req(P, 'GET', '/', { headers: { 'If-None-Match': plain.headers.etag } });
    ok(r.status === 304 && r.raw.length === 0, 'matching ETag answers 304 with no body');
    r = await req(P, 'GET', '/', { headers: { 'If-None-Match': '"stale"' } });
    ok(r.status === 200, 'a stale ETag gets the full page');
    ok(plain.raw.equals(fs.readFileSync(path.join(__dirname, '..', 'index.html'))), 'the served page is byte-identical to index.html');

    console.log('== proxy: input validation');
    r = await post(P, 'a photo'); ok(r.status === 200 && JSON.parse(text(r)).is_hospital_bill === true, 'a photo is read and the code fence stripped');
    r = await req(P, 'POST', '/api/read-bill', { body: JSON.stringify({ mime_type: 'text/plain', data: 'aGk=' }), headers: { 'Content-Type': 'application/json' } });
    ok(r.status === 415, 'non-image mime type is refused (415)');
    r = await req(P, 'POST', '/api/read-bill', { body: JSON.stringify({ mime_type: 'application/pdf', data: 'aGk=' }), headers: { 'Content-Type': 'application/json' } });
    ok(r.status === 415, 'PDF is refused (415) rather than sent to a paid call');
    r = await req(P, 'POST', '/api/read-bill', { body: JSON.stringify({ mime_type: 'image/jpeg' }), headers: { 'Content-Type': 'application/json' } });
    ok(r.status === 400, 'missing image data is 400');
    r = await req(P, 'POST', '/api/read-bill', { body: 'not json', headers: { 'Content-Type': 'application/json' } });
    ok(r.status === 400, 'malformed JSON is 400');
    const before = upstreamCalls;
    r = await req(P, 'POST', '/api/read-bill', { body: JSON.stringify({ mime_type: 'image/jpeg', data: 'A'.repeat(2 * 1024 * 1024) }), headers: { 'Content-Type': 'application/json' } });
    ok(r.status === 413 && JSON.parse(text(r)).error === 'too_large', 'an oversized body gets a proper 413 (not a dropped connection)', 'status ' + r.status);
    ok(upstreamCalls === before, 'the oversized body never reached Google');

    console.log('== proxy: upstream failures are sanitised');
    r = await post(P, 'secret');
    ok(r.status === 502 && !/SECRET_UPSTREAM|AIzaFAKE/.test(text(r)), "Google's raw error body (and any key in it) is never forwarded");
    r = await post(P, 'quota'); ok(r.status === 429 && JSON.parse(text(r)).error === 'busy', 'upstream quota exhaustion becomes an honest 429 "busy"');
    r = await post(P, 'overload'); ok(r.status === 503, 'upstream 503 stays a 503 with a plain message');
    r = await post(P, 'empty'); ok(r.status === 502 && JSON.parse(text(r)).error === 'empty', 'an empty model answer is a clear 502, not a 200 with an empty body');
    const t0 = Date.now(); r = await post(P, 'hang');
    ok(r.status === 504 && Date.now() - t0 < 3000, 'a hanging upstream times out with 504 instead of waiting forever');

    console.log('== abuse limits: per IP');
    await start(P + 1, { ...common, RATE_MAX_PER_IP: '3', DAILY_CAP: '100000' });
    const a = ip => postH(P + 1, 'a photo', { 'X-Forwarded-For': ip });
    ok((await a('9.9.9.9')).status === 200 && (await a('9.9.9.9')).status === 200 && (await a('9.9.9.9')).status === 200, 'first 3 calls from one IP are served');
    r = await a('9.9.9.9');
    ok(r.status === 429 && JSON.parse(text(r)).error === 'busy' && r.headers['retry-after'], 'the 4th is refused with an honest 429 + Retry-After');
    r = await a('8.8.8.8'); ok(r.status === 200, 'a different IP is unaffected');
    r = await postH(P + 1, 'a photo', { 'X-Forwarded-For': '1.1.1.1, 9.9.9.9' });
    ok(r.status === 429, 'a spoofed left-most X-Forwarded-For entry does not bypass the limit');
    r = await postH(P + 1, 'a photo', { 'X-Forwarded-For': '2.2.2.2, 9.9.9.9' });
    ok(r.status === 429, '...even when it is rotated');

    console.log('== abuse limits: daily cap');
    await start(P + 2, { ...common, RATE_MAX_PER_IP: '1000', DAILY_CAP: '2' });
    ok((await postH(P + 2, 'a photo', { 'X-Forwarded-For': '3.3.3.3' })).status === 200 && (await postH(P + 2, 'a photo', { 'X-Forwarded-For': '4.4.4.4' })).status === 200, 'calls under the daily cap are served');
    r = await postH(P + 2, 'a photo', { 'X-Forwarded-For': '5.5.5.5' });
    ok(r.status === 429 && /busy/i.test(text(r)), 'over the daily cap: an honest "busy" message, from any IP');
    r = await req(P + 2, 'GET', '/'); ok(r.status === 200, 'the static app still loads when the proxy is capped');

    console.log('== not configured');
    await start(P + 3, { GEMINI_API_KEY: '' });
    r = await post(P + 3, 'a photo'); ok(r.status === 501, 'no key: 501, and nothing is called');
    r = await req(P + 3, 'GET', '/api/config'); ok(JSON.parse(text(r)).proxy === false, '/api/config says proxy is off');
  } finally {
    servers.forEach(s => s.kill()); mock.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); servers.forEach(s => s.kill()); process.exit(2); });
