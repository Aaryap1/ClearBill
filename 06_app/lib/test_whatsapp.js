/* End-to-end test for the WhatsApp webhook — no Meta account, no Google key.
 * Runs the REAL server.js as a child process, points its Meta Graph and
 * Gemini base URLs at a local mock, and sends properly signed webhook
 * payloads. What it proves: routing, signature checking, message parsing,
 * media download, the Gemini call shape, the findings text, dedup, rate limit,
 * and graceful failure. What it cannot prove: that Meta really delivers to
 * your URL — that needs your credentials.   node lib/test_whatsapp.js
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const SECRET = 'test_app_secret', VERIFY = 'test_verify_token', PHONE = '555000111', TOKEN = 'test_token';
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const REAL_BILL = JSON.parse(html.match(/const WORKED_EXAMPLE_BILL = (\{[\s\S]*?\});\n/)[1]);
const KNEE_BILL = { is_hospital_bill: true, header: {}, line_items: [{ item: 'Tibial component cobalt chromium knee implant', quantity: 1, rate: 20000, total: 20000 }], printed_subtotals: {} };
const STENT_BILL = { is_hospital_bill: true, header: {}, line_items: [{ item: 'Drug eluting stent', quantity: 1, rate: 45000, total: 45000 }], printed_subtotals: {} };

const sent = [];      // messages the bot sent back via the mock Graph API
const geminiCalls = [];
const mediaBytes = { M_REAL: 'real', M_NOTBILL: 'notbill', M_KNEE: 'knee', M_STENT: 'stent', M_FAIL: 'fail' };

const mock = http.createServer((req, res) => {
  const chunks = []; req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    const u = req.url;
    let m;
    if (req.method === 'POST' && /\/messages$/.test(u)) {
      if (req.headers.authorization !== 'Bearer ' + TOKEN) { res.writeHead(401); return res.end(); }
      const j = JSON.parse(body); sent.push({ to: j.to, text: j.text.body });
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"messages":[{"id":"x"}]}');
    }
    if (req.method === 'GET' && (m = u.match(/\/v[\d.]+\/(M_[A-Z]+)$/))) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ url: `http://127.0.0.1:${mock.address().port}/media/${m[1]}`, mime_type: 'image/jpeg' }));
    }
    if (req.method === 'GET' && (m = u.match(/^\/media\/(M_[A-Z]+)$/))) {
      if (req.headers.authorization !== 'Bearer ' + TOKEN) { res.writeHead(401); return res.end(); }
      res.writeHead(200); return res.end(Buffer.from(mediaBytes[m[1]]));
    }
    if (req.method === 'POST' && /generateContent/.test(u)) {
      const j = JSON.parse(body);
      const img = Buffer.from(j.contents[0].parts[1].inline_data.data, 'base64').toString();
      geminiCalls.push({ img, hasPrompt: /is_hospital_bill/.test(j.contents[0].parts[0].text), temp: j.generationConfig.temperature });
      if (img === 'fail') { res.writeHead(500); return res.end('{"error":"boom"}'); }
      const out = img === 'notbill' ? { is_hospital_bill: false, header: {}, line_items: [] }
        : img === 'knee' ? KNEE_BILL : img === 'stent' ? STENT_BILL : { is_hospital_bill: true, ...REAL_BILL };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }));
    }
    res.writeHead(404); res.end();
  });
});

let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { if (pred()) return true; await sleep(30); } return false; }

function req(port, method, p, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => {
      const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
function payload(msg, phoneId = PHONE) {
  return JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneId }, messages: [msg] } }] }] });
}
const sign = raw => 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
const post = (port, raw, sig) => req(port, 'POST', '/webhook/whatsapp', { body: raw, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig === undefined ? sign(raw) : sig } });
const img = (id, media, from = '919800000001') => ({ from, id, type: 'image', image: { id: media, mime_type: 'image/jpeg' } });

function startServer(port, env) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), ...env }, stdio: 'ignore' });
  return child;
}

(async () => {
  console.log('== generated module is in sync with index.html');
  try { execFileSync(process.execPath, [path.join(__dirname, 'build_checks.js'), '--check'], { stdio: 'pipe' }); ok(true, 'lib/checks.js matches index.html'); }
  catch (e) { ok(false, 'lib/checks.js matches index.html', 'run: node lib/build_checks.js'); }

  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const mockBase = 'http://127.0.0.1:' + mock.address().port;
  // Secrets deliberately carry trailing newlines, as they do when piped in from a shell.
  const NL = '\r\n';
  const env = { WHATSAPP_APP_SECRET: SECRET + NL, WHATSAPP_VERIFY_TOKEN: VERIFY + NL, WHATSAPP_TOKEN: TOKEN + NL, WHATSAPP_PHONE_NUMBER_ID: PHONE + NL,
    GRAPH_BASE: mockBase, GEMINI_BASE: mockBase, GEMINI_API_KEY: 'k', PUBLIC_URL: 'https://example.test/' };
  const P = 18431, P2 = 18432, P3 = 18433;
  const srv = startServer(P, env), srvBare = startServer(P2, {}), srvOnly = startServer(P3, { ...env, WHATSAPP_ONLY: '1' });
  // wait for both to listen
  for (const p of [P, P2, P3]) { await waitFor(() => false, 0); for (let i = 0; i < 60; i++) { try { await req(p, 'GET', '/api/config'); break; } catch (e) { await sleep(100); } } }

  try {
    console.log('== handshake + security');
    let r = await req(P, 'GET', `/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=abc123`);
    ok(r.status === 200 && r.body === 'abc123', 'GET verify with right token echoes the challenge');
    r = await req(P, 'GET', '/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123');
    ok(r.status === 403, 'GET verify with wrong token is refused');
    const raw = payload({ from: '919800000001', id: 'w1', type: 'text', text: { body: 'hi' } });
    r = await post(P, raw, 'sha256=deadbeef');
    ok(r.status === 401, 'POST with a bad signature is refused');
    r = await post(P, raw, '');
    ok(r.status === 401, 'POST with no signature is refused');
    await sleep(150); ok(sent.length === 0, 'nothing was sent for rejected requests');
    r = await post(P2, raw);
    ok(r.status === 501, 'unconfigured server answers 501 and does nothing');
    r = await req(P, 'GET', '/api/config');
    ok(r.status === 200, 'existing web-app routes still work');

    r = await req(P3, 'GET', '/api/config');
    ok(r.status === 404, 'WHATSAPP_ONLY service does not serve the web app or /api/config');
    r = await req(P3, 'POST', '/api/read-bill', { body: '{}' });
    ok(r.status === 404, 'WHATSAPP_ONLY service is not a second door to the Gemini key');
    r = await req(P3, 'GET', `/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=z`);
    ok(r.status === 200 && r.body === 'z', 'WHATSAPP_ONLY service still answers the webhook handshake');

    console.log('== conversation');
    r = await post(P, raw);
    ok(r.status === 200, 'signed text message accepted');
    ok(await waitFor(() => sent.length >= 1), 'welcome reply sent');
    ok(/itemised/.test(sent[0].text) && /हिंदी/.test(sent[0].text) && sent[0].to === '919800000001', 'welcome is bilingual and addressed to the sender');

    sent.length = 0;
    r = await post(P, payload(img('w2', 'M_REAL')));
    ok(await waitFor(() => sent.length >= 2, 6000), 'photo -> "reading" ack then findings');
    ok(/reading your bill/i.test(sent[0].text), 'first message is the reading acknowledgement');
    const f = (sent[1] || {}).text || '';
    ok(/7 charges/.test(f) && /1,992\.5/.test(f), 'findings: 7 IRDAI matches worth 1,992.5 (same as the web app)', f.slice(0, 200));
    ok(/3 charges appear more than once/.test(f), 'findings: 3 duplicates (same as the web app)');
    ok(/Not checked here/.test(f) && /reconciliation|bill total/i.test(f), 'says what it did NOT check (total reconciliation) instead of implying it');
    ok(!/gap|off by/i.test(f.replace(/Not checked here[\s\S]*$/, '')), 'does not report a reconciliation gap from a single page');
    ok(/example\.test/.test(f) && /doesn't store it/.test(f), 'links the web app and states the data-handling line');
    ok(geminiCalls.length === 1 && geminiCalls[0].hasPrompt && geminiCalls[0].temp === 0, 'Gemini called once with the extraction prompt at temperature 0');

    sent.length = 0;
    await post(P, payload(img('w3', 'M_NOTBILL')));
    ok(await waitFor(() => sent.length >= 2), 'non-bill photo handled');
    ok(/doesn't look like a page from an itemised hospital bill/.test(sent[1].text), 'non-bill is rejected with a reason, no findings invented');

    sent.length = 0;
    await post(P, payload(img('w2', 'M_REAL')));           // same message id again (Meta retry)
    await sleep(400);
    ok(sent.length === 0, 'a retried delivery (same message id) is ignored — no double reply');

    sent.length = 0;
    await post(P, payload(img('w4', 'M_REAL'), 'WRONG_PHONE_ID'));
    await sleep(400);
    ok(sent.length === 0, 'payload for a different phone number id is ignored');

    sent.length = 0;
    await post(P, payload({ from: '919800000001', id: 'w5', type: 'document', document: { id: 'D1' } }));
    ok(await waitFor(() => sent.length >= 1), 'document handled');
    ok(/JPG or PNG/.test(sent[0].text), 'PDF/document gets a clear "send a photo" instruction');

    sent.length = 0;
    await post(P, payload(img('w6', 'M_KNEE')));
    ok(await waitFor(() => sent.length >= 2, 6000), 'knee implant photo handled');
    ok(/not independently re-confirmed/.test(sent[1].text) && !/legal price cap/.test(sent[1].text), 'unverified knee ceiling is NOT called a legal violation');

    sent.length = 0;
    await post(P, payload(img('w7', 'M_STENT')));
    ok(await waitFor(() => sent.length >= 2, 6000), 'stent photo handled');
    ok(/legal price cap/.test(sent[1].text), 'verified stent ceiling IS reported as the legal cap');

    sent.length = 0;
    await post(P, payload(img('w8', 'M_FAIL')));
    ok(await waitFor(() => sent.length >= 2, 6000), 'model failure handled');
    ok(/couldn't read that photo/.test(sent[1].text), 'Gemini error -> friendly retry message, no crash');

    console.log('== rate limit (per sender)');
    sent.length = 0;
    for (let i = 0; i < 6; i++) await post(P, payload(img('rl' + i, 'M_NOTBILL', '919811111111')));
    await waitFor(() => sent.length >= 12, 8000);
    sent.length = 0;
    await post(P, payload(img('rl_over', 'M_NOTBILL', '919811111111')));
    ok(await waitFor(() => sent.length >= 1), 'the 7th photo in the window gets a reply');
    ok(/several photos in a short time/.test(sent[0].text), 'over-limit sender is told to wait, not silently processed');
    sent.length = 0;
    await post(P, payload(img('other', 'M_NOTBILL', '919822222222')));
    ok(await waitFor(() => sent.length >= 2), 'a different sender is unaffected');
  } finally {
    srv.kill(); srvBare.kill(); srvOnly.kill(); mock.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
