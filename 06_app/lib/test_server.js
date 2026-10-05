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
let upstreamCalls = 0, upstreamClosed = false;
const mock = http.createServer((req, res) => {
  const c = []; req.on('data', d => c.push(d));
  req.on('end', () => {
    upstreamCalls++;
    const j = JSON.parse(Buffer.concat(c).toString());
    const img = Buffer.from(j.contents[0].parts[1].inline_data.data, 'base64').toString();
    if (img === 'hang') return; // never answer
    if (img === 'hang2') { req.socket.on('close', () => { upstreamClosed = true; }); return; } // never answers; records whether ClearBill hung up on us
    if (img === 'badjson' || img === 'notobject') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: img === 'badjson' ? '{"is_hospital_bill": true, "line_items": [{"item": "BED' : '[1,2,3]' }] } }] }));
    }
    if (img === 'secret') { res.writeHead(500); return res.end('SECRET_UPSTREAM_DETAIL key=AIzaFAKE'); }
    if (img === 'quota') { res.writeHead(429); return res.end('{"error":{"status":"RESOURCE_EXHAUSTED"}}'); }
    if (img === 'overload') { res.writeHead(503); return res.end('{"error":"high demand"}'); }
    // R14 impact-counter pages: one List I item (Rs 200) + one Lists II-IV item (Rs 410); an implausible page; a non-bill
    const PAGES = {
      impact: { is_hospital_bill: true, header: {}, line_items: [{ item: 'GLOVES EXAMINATION', quantity: 1, total: 200 }, { item: 'ADMISSION SERVICES 10003', quantity: 1, total: 410 }, { item: 'ROOM RENT', quantity: 1, total: 4500 }] },
      huge: { is_hospital_bill: true, header: {}, line_items: [{ item: 'GLOVES EXAMINATION', quantity: 1, total: 5000000 }] },
      notbill: { is_hospital_bill: false, header: {}, line_items: [] },
    };
    if (PAGES[img]) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(PAGES[img]) }] } }] })); }
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

    console.log('== R3a: invalid requests do not spend the cap');
    await start(P + 4, { ...common, RATE_MAX_PER_IP: '1000', DAILY_CAP: '2', MAX_BODY_BYTES: String(1024 * 1024) });
    const beforeInvalid = upstreamCalls;
    const bads = [];
    for (let i = 0; i < 2; i++) {
      bads.push((await req(P + 4, 'POST', '/api/read-bill', { body: 'not json', headers: { 'Content-Type': 'application/json' } })).status);
      bads.push((await req(P + 4, 'POST', '/api/read-bill', { body: JSON.stringify({ mime_type: 'application/pdf', data: 'aGk=' }), headers: { 'Content-Type': 'application/json' } })).status);
      bads.push((await req(P + 4, 'POST', '/api/read-bill', { body: JSON.stringify({ mime_type: 'image/jpeg' }), headers: { 'Content-Type': 'application/json' } })).status);
      bads.push((await req(P + 4, 'POST', '/api/read-bill', { body: JSON.stringify({ mime_type: 'image/jpeg', data: 'A'.repeat(2 * 1024 * 1024) }), headers: { 'Content-Type': 'application/json' } })).status);
    }
    ok(bads.join(',') === '400,415,400,413,400,415,400,413', 'eight malformed, wrong-type and oversized requests are refused with the right codes (' + bads.join(',') + ')');
    ok(upstreamCalls === beforeInvalid, 'none of them reached Google');
    ok((await post(P + 4, 'a photo')).status === 200 && (await post(P + 4, 'a photo')).status === 200, 'after eight invalid requests the two valid reads of a cap of 2 are still served');
    r = await post(P + 4, 'a photo'); ok(r.status === 429 && JSON.parse(text(r)).error === 'busy', 'the cap still holds: a third valid read is "busy"');

    console.log('== R3a: unreadable answers and disconnects');
    r = await post(P, 'badjson'); ok(r.status === 502 && JSON.parse(text(r)).error === 'unreadable' && !/BED/.test(text(r)), 'a cut-off Gemini answer becomes a plain 502, never a 200 with broken JSON');
    r = await post(P, 'notobject'); ok(r.status === 502 && JSON.parse(text(r)).error === 'unreadable', 'an answer that is JSON but not an object is also a 502');
    upstreamClosed = false;
    await start(P + 5, { ...common, RATE_MAX_PER_IP: '1000', DAILY_CAP: '100000', UPSTREAM_TIMEOUT_MS: '20000' });
    await new Promise(resolve => {
      const cr = http.request({ host: '127.0.0.1', port: P + 5, method: 'POST', path: '/api/read-bill', headers: { 'Content-Type': 'application/json' } });
      cr.on('error', () => {}); cr.on('response', () => {});
      cr.end(JSON.stringify({ mime_type: 'image/jpeg', data: Buffer.from('hang2').toString('base64') }));
      setTimeout(() => { cr.destroy(); resolve(); }, 500);
    });
    for (let i = 0; i < 20 && !upstreamClosed; i++) await sleep(100);
    ok(upstreamClosed, 'when the phone disconnects, ClearBill hangs up on Google too (it did not wait for the 20 s timeout)');

    console.log('== not configured');
    await start(P + 3, { GEMINI_API_KEY: '' });
    r = await post(P + 3, 'a photo'); ok(r.status === 501, 'no key: 501, and nothing is called');
    r = await req(P + 3, 'GET', '/api/config'); ok(JSON.parse(text(r)).proxy === false, '/api/config says proxy is off');

    console.log('== My Bills: not configured');
    r = await req(P + 3, 'GET', '/api/config'); ok(JSON.parse(text(r)).bills === false, '/api/config says bills is off when unset');
    r = await req(P + 3, 'GET', '/api/bills', { headers: { Authorization: 'Bearer whatever' } });
    ok(r.status === 501, 'GET /api/bills is 501 when Google sign-in is not configured');

    console.log('== My Bills: auth + CRUD against a mock Google + mock Firestore');
    const crypto2 = require('crypto');
    const b64url2 = buf => Buffer.from(buf).toString('base64url');
    const { publicKey: billsPub, privateKey: billsPriv } = crypto2.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const billsJwk = { ...billsPub.export({ format: 'jwk' }), kid: 'srv-test-key', alg: 'RS256', use: 'sig' };
    const BILLS_CLIENT_ID = 'bills-test-client.apps.googleusercontent.com';
    const certsSrv = http.createServer((req2, res2) => { res2.writeHead(200, { 'Content-Type': 'application/json' }); res2.end(JSON.stringify({ keys: [billsJwk] })); });
    await new Promise(r2 => certsSrv.listen(0, '127.0.0.1', r2));
    function mintToken(sub, extra) {
      const now2 = Math.floor(Date.now() / 1000);
      const header = { alg: 'RS256', typ: 'JWT', kid: 'srv-test-key' };
      const payload = { iss: 'https://accounts.google.com', aud: BILLS_CLIENT_ID, sub, email: sub + '@example.com', email_verified: true, iat: now2 - 5, exp: now2 + 3600, ...extra };
      const h = b64url2(JSON.stringify(header)), p = b64url2(JSON.stringify(payload));
      const sig = crypto2.sign('RSA-SHA256', Buffer.from(h + '.' + p), billsPriv);
      return h + '.' + p + '.' + b64url2(sig);
    }
    // Minimal mock Firestore REST server — same shape as lib/test_firestore_rest.js's.
    const fsStore = new Map(); let fsNextId = 1; const FS_PROJECT = 'bills-test-project';
    const fsSrv = http.createServer((req2, res2) => {
      const chunks = []; req2.on('data', c => chunks.push(c));
      req2.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
        const prefix = `/v1/projects/${FS_PROJECT}/databases/(default)/documents/`;
        if (!req2.url.startsWith(prefix)) { res2.writeHead(404); return res2.end('{}'); }
        const rest = req2.url.slice(prefix.length); const [pathPart, query] = rest.split('?');
        if (req2.method === 'POST') {
          const id = 'doc' + (fsNextId++); const full = pathPart + '/' + id;
          fsStore.set(full, body.fields);
          res2.writeHead(200, { 'Content-Type': 'application/json' });
          return res2.end(JSON.stringify({ name: `projects/${FS_PROJECT}/databases/(default)/documents/${full}`, fields: body.fields }));
        }
        if (req2.method === 'GET') {
          const collPrefix = pathPart + '/';
          const docs = [...fsStore.entries()].filter(([k]) => k.startsWith(collPrefix) && !k.slice(collPrefix.length).includes('/')).map(([k, fields]) => ({ name: `projects/${FS_PROJECT}/databases/(default)/documents/${k}`, fields }));
          res2.writeHead(200, { 'Content-Type': 'application/json' });
          return res2.end(JSON.stringify({ documents: docs }));
        }
        if (req2.method === 'PATCH') {
          if (!fsStore.has(pathPart)) { res2.writeHead(404); return res2.end(JSON.stringify({ error: { message: 'no doc' } })); }
          const existing = fsStore.get(pathPart);
          const mask = (query || '').split('&').filter(s => s.startsWith('updateMask.fieldPaths=')).map(s => decodeURIComponent(s.split('=')[1]));
          for (const k of mask) existing[k] = body.fields[k];
          fsStore.set(pathPart, existing);
          res2.writeHead(200, { 'Content-Type': 'application/json' });
          return res2.end(JSON.stringify({ name: `projects/${FS_PROJECT}/databases/(default)/documents/${pathPart}`, fields: existing }));
        }
        if (req2.method === 'DELETE') {
          if (!fsStore.has(pathPart)) { res2.writeHead(404); return res2.end(JSON.stringify({ error: { message: 'not found' } })); }
          fsStore.delete(pathPart); res2.writeHead(204); return res2.end();
        }
        res2.writeHead(404); res2.end('{}');
      });
    });
    await new Promise(r2 => fsSrv.listen(0, '127.0.0.1', r2));
    const billsEnv = {
      GOOGLE_CLIENT_ID: BILLS_CLIENT_ID, FIRESTORE_PROJECT_ID: FS_PROJECT,
      FIRESTORE_BASE: `http://127.0.0.1:${fsSrv.address().port}`,
      GOOGLE_CERTS_URL: `http://127.0.0.1:${certsSrv.address().port}/certs`,
      GOOGLE_ACCESS_TOKEN: 'fake-server-side-token', GEMINI_API_KEY: '',
    };
    await start(P + 6, billsEnv);
    r = await req(P + 6, 'GET', '/api/config'); ok(JSON.parse(text(r)).bills === true && JSON.parse(text(r)).googleClientId === BILLS_CLIENT_ID, '/api/config reports bills on, with the (non-secret) client id');

    r = await req(P + 6, 'GET', '/api/bills'); ok(r.status === 401, 'no Authorization header: 401');
    r = await req(P + 6, 'GET', '/api/bills', { headers: { Authorization: 'Bearer not-a-real-jwt' } }); ok(r.status === 401, 'a garbage bearer token: 401');
    r = await req(P + 6, 'GET', '/api/bills', { headers: { Authorization: 'Bearer ' + mintToken('alice', { aud: 'someone-else' }) } });
    ok(r.status === 401, "a token minted for a DIFFERENT app's client id: 401");

    const aliceAuth = { Authorization: 'Bearer ' + mintToken('alice-sub') };
    r = await req(P + 6, 'GET', '/api/bills', { headers: aliceAuth });
    ok(r.status === 200 && JSON.parse(text(r)).bills.length === 0, 'signed in with no saved bills yet: empty list');

    r = await req(P + 6, 'POST', '/api/bills', { headers: { ...aliceAuth, 'Content-Type': 'application/json' }, body: JSON.stringify({ hospitalName: 'Test Hospital', netPayable: 41396, explainedPct: 22, status: 'sent', ignoredField: 'should not be stored' }) });
    ok(r.status === 201, 'creating a bill while signed in: 201');
    const created = JSON.parse(text(r)).bill;
    ok(created.hospitalName === 'Test Hospital' && created.netPayable === 41396, 'the created bill has the fields we sent');
    ok(created.ignoredField === undefined, 'a field outside the allow-list is silently dropped, never stored');
    ok(typeof created.savedAt === 'string' && created.savedAt.length > 0, 'savedAt is set by the server');

    const bobAuth = { Authorization: 'Bearer ' + mintToken('bob-sub') };
    r = await req(P + 6, 'GET', '/api/bills', { headers: bobAuth });
    ok(r.status === 200 && JSON.parse(text(r)).bills.length === 0, "a different signed-in user (bob) does not see alice's bill");

    r = await req(P + 6, 'PATCH', '/api/bills/' + created.id, { headers: { ...bobAuth, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'resolved' }) });
    ok(r.status === 404, "bob cannot update alice's bill (scoped by uid in the Firestore path, so it's simply not found under bob's uid)");

    r = await req(P + 6, 'PATCH', '/api/bills/' + created.id, { headers: { ...aliceAuth, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'insurer_responded', note: 'Refunded ₹1,200', netPayable: 999999 }) });
    ok(r.status === 200, 'alice can update her own bill');
    const patched = JSON.parse(text(r)).bill;
    ok(patched.status === 'insurer_responded' && patched.note === 'Refunded ₹1,200', 'status and note were updated');
    ok(patched.netPayable === 41396, 'netPayable is NOT patchable (outside the allow-list) — the original saved amount is untouched even though it was sent in the request body');

    console.log('== My Bills (R13): the "sent on" date');
    const patchSent = v => req(P + 6, 'PATCH', '/api/bills/' + created.id, { headers: { ...aliceAuth, 'Content-Type': 'application/json' }, body: JSON.stringify({ sentOn: v }) });
    r = await patchSent('2026-09-20'); ok(r.status === 200 && JSON.parse(text(r)).bill.sentOn === '2026-09-20', 'a real past date is saved');
    r = await patchSent(null); ok(r.status === 200 && JSON.parse(text(r)).bill.sentOn === null, 'null clears it');
    const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    for (const [bad, why] of [['2026-02-30', 'an impossible date'], ['20/09/2026', 'a non-ISO format'], [future, 'a date in the future'], [12345, 'a number'], ['2026-09-20T10:00', 'a date with a time']]) {
      r = await patchSent(bad); ok(r.status === 400, why + ' is refused (400), not stored', 'status ' + r.status);
    }
    r = await req(P + 6, 'POST', '/api/bills', { headers: { ...aliceAuth, 'Content-Type': 'application/json' }, body: JSON.stringify({ hospitalName: 'X', sentOn: 'yesterday' }) });
    ok(r.status === 400, 'a bad sent-on date on a NEW bill is refused too');

    r = await req(P + 6, 'DELETE', '/api/bills/' + created.id, { headers: bobAuth });
    ok(r.status === 500 || r.status === 404, "bob deleting alice's bill id fails (not found under bob's own uid)");
    r = await req(P + 6, 'GET', '/api/bills', { headers: aliceAuth });
    ok(JSON.parse(text(r)).bills.length === 1, "...and alice's bill is still there");

    r = await req(P + 6, 'DELETE', '/api/bills/' + created.id, { headers: aliceAuth });
    ok(r.status === 200, 'alice deletes her own bill');
    r = await req(P + 6, 'GET', '/api/bills', { headers: aliceAuth });
    ok(JSON.parse(text(r)).bills.length === 0, 'it is gone');

    console.log('== My Bills: payload size limit');
    r = await req(P + 6, 'POST', '/api/bills', { headers: { ...aliceAuth, 'Content-Type': 'application/json' }, body: JSON.stringify({ letter: 'x'.repeat(300 * 1024) }) });
    ok(r.status === 413, 'an oversized bill record is refused with 413, not silently truncated or dropped');

    certsSrv.close(); fsSrv.close();

    console.log('== R14: impact counter (counted by the server from pages it read)');
    let commits = [];
    const impStore = { pages: 0, matchedPaise: 0 };
    const impSrv = http.createServer((req2, res2) => {
      const chunks = []; req2.on('data', c => chunks.push(c));
      req2.on('end', () => {
        if (req2.method === 'POST' && req2.url.endsWith('/documents:commit')) {
          const body = JSON.parse(Buffer.concat(chunks).toString()); commits.push(body);
          for (const t of body.writes[0].updateTransforms) impStore[t.fieldPath] += Number(t.increment.integerValue);
          res2.writeHead(200, { 'Content-Type': 'application/json' }); return res2.end('{}');
        }
        if (req2.method === 'GET' && req2.url.endsWith('/documents/stats/impact')) {
          res2.writeHead(200, { 'Content-Type': 'application/json' });
          return res2.end(JSON.stringify({ name: 'x', fields: { pages: { integerValue: String(impStore.pages) }, matchedPaise: { integerValue: String(impStore.matchedPaise) } } }));
        }
        res2.writeHead(404); res2.end('{}');
      });
    });
    await new Promise(r2 => impSrv.listen(0, '127.0.0.1', r2));
    const impEnv = { ...common, RATE_MAX_PER_IP: '1000', DAILY_CAP: '100000', FIRESTORE_PROJECT_ID: 'imp-test', FIRESTORE_BASE: `http://127.0.0.1:${impSrv.address().port}`, GOOGLE_ACCESS_TOKEN: 'fake-imp-token' };
    await start(P + 7, impEnv);
    r = await req(P + 7, 'GET', '/api/impact');
    ok(r.status === 200 && JSON.parse(text(r)).enabled === true && JSON.parse(text(r)).pages === 0, 'before any read: enabled, 0 pages');
    r = await post(P + 7, 'impact'); ok(r.status === 200, 'a real bill page is read');
    await sleep(300);
    ok(impStore.pages === 1 && impStore.matchedPaise === 61000, 'it is counted: 1 page, Rs 610 (Rs 200 List I + Rs 410 Lists II-IV; room rent not counted)', JSON.stringify(impStore));
    r = await post(P + 7, 'notbill'); await sleep(300);
    ok(impStore.pages === 1, 'a photo the model says is not a bill page is not counted');
    r = await post(P + 7, 'huge'); await sleep(300);
    ok(impStore.pages === 2 && impStore.matchedPaise === 61000, 'a page claiming over Rs 1 lakh of matched charges counts as a page, but its amount is not added');
    r = await post(P + 7, 'overload'); await sleep(300);
    ok(impStore.pages === 2, 'a failed read is not counted');
    ok(commits.every(c => JSON.stringify(c).length < 600 && !/GLOVES|ADMISSION|ROOM/i.test(JSON.stringify(c))), 'nothing from the bill itself is ever sent to the counter - only the two numbers');
    r = await req(P + 7, 'GET', '/api/impact'); const imp = JSON.parse(text(r));
    ok(imp.pages === 2 && imp.matched === 610 && imp.since === '2026-10-05', '/api/impact reports 2 pages, Rs 610, since 2026-10-05');
    r = await req(P + 7, 'POST', '/api/impact', { body: JSON.stringify({ pages: 999999 }), headers: { 'Content-Type': 'application/json' } });
    ok(r.status === 404 && impStore.pages === 2, 'there is no way to POST a number to the counter from outside');
    r = await req(P + 3, 'GET', '/api/impact'); ok(JSON.parse(text(r)).enabled === false, 'with no Firestore configured the counter is simply off');

    console.log('== R14: reader status in /api/config');
    r = await req(P + 7, 'GET', '/api/config'); ok(JSON.parse(text(r)).reader === 'overloaded', 'right after Google answered 503 (and nothing has succeeded since), the reader reports "overloaded"');
    await post(P + 7, 'impact'); await sleep(200);
    r = await req(P + 7, 'GET', '/api/config'); ok(JSON.parse(text(r)).reader === 'ok', 'a successful read clears it back to "ok"');
    await start(P + 8, { ...common, RATE_MAX_PER_IP: '1000', DAILY_CAP: '1' });
    r = await req(P + 8, 'GET', '/api/config'); ok(JSON.parse(text(r)).reader === 'ok', 'with reads left today: "ok"');
    await post(P + 8, 'a photo');
    r = await req(P + 8, 'GET', '/api/config'); ok(JSON.parse(text(r)).reader === 'busy', 'once today\'s cap is used: "busy", before anyone has to try and fail');
    r = await req(P + 3, 'GET', '/api/config'); ok(JSON.parse(text(r)).reader === 'off', 'with no server key: "off"');
    impSrv.close();
  } finally {
    servers.forEach(s => s.kill()); mock.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); servers.forEach(s => s.kill()); process.exit(2); });
