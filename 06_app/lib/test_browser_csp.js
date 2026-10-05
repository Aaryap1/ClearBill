/* R16: the page under its real Content Security Policy. Starts the REAL
 * server.js (so the real headers are sent) in front of a mock Gemini, opens
 * the page in headless Chrome, uses every part of the app, and fails on any
 * CSP violation. Then checks that the policy actually stops injected script.
 * Google's sign-in library is answered locally with a stand-in, so there is
 * no network dependency, no Gemini call and no cost.
 *    node --experimental-websocket lib/test_browser_csp.js
 */
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(fs.existsSync);
if (!chrome) { console.log('  SKIPPED - no Chrome/Edge found; the CSP screen tests did not run'); process.exit(0); }
if (typeof WebSocket === 'undefined') { console.log('  SKIPPED - run with: node --experimental-websocket lib/test_browser_csp.js'); process.exit(0); }

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m + (extra ? '  -> ' + extra : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PAGE_JSON = JSON.stringify({ is_hospital_bill: true, header: { gross_amount: 300 }, line_items: [{ item: 'GLOVES EXAMINATION', quantity: 1, total: 200 }, { item: 'BED CHARGES', quantity: 1, total: 100 }] });
const gemini = http.createServer((q, r) => { q.resume(); q.on('end', () => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(q.method === 'GET' ? '{"name":"models/x"}' : JSON.stringify({ candidates: [{ content: { parts: [{ text: PAGE_JSON }] } }] })); }); });
const servers = [];
function startServer(port, env) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), ...env }, stdio: 'ignore' });
  servers.push(child);
  return (async () => { for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${port}/api/config`); return; } catch (e) { await sleep(100); } } throw new Error('server did not start'); })();
}
// Recorded before the page's own script runs (DevTools-injected, so the
// page's CSP does not apply to it).
const WATCH = `window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI + ' ' + (e.sample || '').slice(0, 40)));`;
const GSI_STAND_IN = `window.google = { accounts: { id: { initialize(o) { window.__gsiInit = o.client_id; }, renderButton() { window.__gsiButtons = (window.__gsiButtons || 0) + 1; }, disableAutoSelect() {} } } };`;

(async () => {
  await new Promise(r => gemini.listen(0, '127.0.0.1', r));
  const ON = 18611, OFF = 18612;
  await startServer(ON, { GEMINI_API_KEY: 'k', GEMINI_BASE: `http://127.0.0.1:${gemini.address().port}`, RATE_MAX_PER_IP: '1000', DAILY_CAP: '1000',
    GOOGLE_CLIENT_ID: 'csp-test.apps.googleusercontent.com', FIRESTORE_PROJECT_ID: 'csp-test', FIRESTORE_BASE: 'http://127.0.0.1:9', GOOGLE_ACCESS_TOKEN: 'fake' });
  await startServer(OFF, { GEMINI_API_KEY: '' });
  const p = spawn(chrome, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9348', '--user-data-dir=' + path.join(os.tmpdir(), 'csp_test_profile'), 'about:blank'], { stdio: 'ignore' });
  let tabs;
  for (let i = 0; i < 30 && !tabs; i++) { await sleep(300); try { tabs = await (await fetch('http://127.0.0.1:9348/json')).json(); } catch (e) {} }
  const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pend = {}; const errs = [], fonts = new Set(); let gsiFetches = 0;
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend[m.id]) { pend[m.id](m.result || m.error); delete pend[m.id]; return; }
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Network.requestWillBeSent' && /fonts\.gstatic\.com/.test(m.params.request.url)) fonts.add(m.params.request.url);
    if (m.method === 'Fetch.requestPaused') {
      gsiFetches++;
      send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }], body: Buffer.from(GSI_STAND_IN).toString('base64') });
    }
  };
  const ev = async js => { const r = await send('Runtime.evaluate', { expression: '(async()=>{' + js + '})()', awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: 'https://accounts.google.com/gsi/client*' }] });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: WATCH });
  const violations = () => ev('return window.__csp');

  try {
    console.log('== the whole app runs under the policy');
    const head = await fetch(`http://127.0.0.1:${ON}/`);
    ok(/sha256-/.test(head.headers.get('content-security-policy') || ''), 'the page is served with its hash-based CSP');
    ok(!/<script[^>]*src="https:\/\/accounts\.google\.com/.test(await head.text()),'the page itself no longer carries a script tag for Google sign-in');
    await send('Page.navigate', { url: `http://127.0.0.1:${ON}/` }); await sleep(2500);
    ok(await ev(`return typeof switchTab === 'function' && typeof analyse === 'function'`), "the page's own inline script ran (its hash matches)");
    ok(await ev(`return !!document.querySelector('script[src^="https://accounts.google.com/gsi/client"]') && window.__gsiInit === 'csp-test.apps.googleusercontent.com' && window.__gsiButtons >= 1`),
      'with sign-in switched on, the sign-in library is added after the page loads, allowed by the policy, and the button is drawn');
    ok(gsiFetches === 1, 'it is fetched once');
    await ev(`localStorage.clear(); setLang('en'); document.getElementById('egBtn').click();`); await sleep(500);
    for (const t of ['settlement', 'findings', 'letter', 'mybills', 'about']) { await ev(`switchTab('${t}')`); await sleep(150); }
    await ev(`switchTab('letter'); document.getElementById('genLetterTab').click();`); await sleep(300);
    await ev(`switchTab('mybills'); document.getElementById('saveLocalBtn').click();`); await sleep(200);
    for (const l of ['hi', 'mr', 'en']) { await ev(`setLang('${l}')`); await sleep(200); }
    await ev(`document.getElementById('modeReimbBtn').click(); document.getElementById('modeCashlessBtn').click();`);
    // A real photo through the real server: thumbnail (blob: image), resize (canvas), read (same-origin fetch)
    await ev(`resetUploadState(); switchTab('findings');
      const c = document.createElement('canvas'); c.width = 2600; c.height = 1900; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 2600, 1900); x.fillStyle = '#000'; x.font = '60px sans-serif'; x.fillText('TEST BILL', 40, 90);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9)); addFiles([new File([blob], 'page1.jpg', { type: 'image/jpeg', lastModified: 7 })]);`);
    await sleep(400);
    ok(await ev(`return [...document.querySelectorAll('img')].some(i => i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0)`), 'the photo thumbnail (a blob: image) is shown');
    await ev(`document.getElementById('checkPhotosBtn').click();`); await sleep(2500);
    ok(/GLOVES/i.test(await ev(`return document.getElementById('report').innerText`)), 'the photo is resized, sent to the server, read and reported');
    const v = await violations();
    ok(v.length === 0, 'no CSP violation anywhere in all of that', JSON.stringify(v).slice(0, 300));
    ok(errs.length === 0, 'no page errors', errs.join(' | ').slice(0, 300));

    console.log('== injected script cannot run');
    await ev(`document.body.insertAdjacentHTML('beforeend', '<img src="x-not-there" onerror="window.__pwned=1">');`); await sleep(400);
    ok(await ev(`return window.__pwned === undefined`), 'an injected onerror="..." attribute does not run');
    await ev(`const s = document.createElement('script'); s.textContent = 'window.__pwned2 = 1'; document.body.appendChild(s);`); await sleep(200);
    ok(await ev(`return window.__pwned2 === undefined`), 'an injected <script> element does not run');
    await ev(`const s = document.createElement('script'); s.src = 'https://example.com/evil.js'; document.body.appendChild(s);`); await sleep(300);
    const after = await violations();
    ok(after.some(x => /^script-src/.test(x)) && after.some(x => /example\.com/.test(x)), 'each attempt is refused by the policy (' + after.length + ' violations recorded)');

    console.log('== sign-in off: nothing from Google is loaded');
    const before = gsiFetches;
    await send('Page.navigate', { url: `http://127.0.0.1:${OFF}/` }); await sleep(2000);
    ok(await ev(`return !document.querySelector('script[src*="accounts.google.com"]')`) && gsiFetches === before, 'with sign-in switched off, the sign-in library is never requested');
    ok((await violations()).length === 0, 'and the page loads with no CSP violation');
    console.log(`  info: ${fonts.size} font files requested from fonts.gstatic.com`);
    if (process.env.FONT_LIST) fs.writeFileSync(process.env.FONT_LIST, [...fonts].join('\n'));
  } finally { ws.close(); p.kill(); servers.forEach(s => s.kill()); gemini.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); servers.forEach(s => s.kill()); process.exit(2); });
