/* R25: the backup copy (lib/build_static.js), served the way GitHub Pages
 * serves it: plain files, no server behind them, so every /api/ request is a
 * 404. Runs in headless Chrome under the copy's own <meta> security policy and
 * fails on any policy violation or script error. No network, no Gemini call.
 *    node --experimental-websocket lib/test_static.js
 */
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const { build, MAIN } = require('./build_static.js');
const { cspFor } = require('./csp.js');

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m + (extra ? '  -> ' + extra : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('== the files');
const OUT = path.join(os.tmpdir(), 'clearbill_backup_test_site');
fs.rmSync(OUT, { recursive: true, force: true }); build(OUT);
const page = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8'), orig = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
ok(['index.html', 'manifest.json', 'icon.svg', 'og.png', 'robots.txt', '.nojekyll'].every(f => fs.existsSync(path.join(OUT, f))), 'the copy has the page, its manifest, icon, preview image, robots.txt and .nojekyll');
ok(page.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n|<meta name="clearbill-backup"[^>]*>\n|<meta name="robots"[^>]*>\n|<link rel="canonical"[^>]*>\n/g, '') === orig, 'the page is the same index.html, with only the four backup tags added');
const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(page)[1];
ok(meta === cspFor(orig, { backup: true }) && /script-src 'sha256-[^']+'(;|$)/.test(meta) && !/accounts\.google\.com/.test(meta), 'its security policy is the main site\'s, minus Google sign-in, as a <meta> tag');
ok(page.indexOf('http-equiv="Content-Security-Policy"') < page.indexOf('<script') && page.indexOf('http-equiv="Content-Security-Policy"') < page.indexOf('<style'), 'the policy comes before any script or style, so it covers them');
ok(/<meta name="robots" content="noindex" \/>/.test(page) && page.includes(`<link rel="canonical" href="${MAIN}" />`), 'search engines are told to send people to the main site, not the copy');

const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(fs.existsSync);
if (!chrome || typeof WebSocket === 'undefined') { console.log('  SKIPPED - the screen part needs Chrome and: node --experimental-websocket lib/test_static.js'); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }

// Like GitHub Pages: files from the folder, a 404 for anything else (including /api/...).
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain' };
const srv = http.createServer((q, r) => {
  const p = decodeURIComponent(q.url.split('?')[0]); q.resume();
  if (q.method === 'POST' || p.startsWith('/api/')) { srv.apiCalls = (srv.apiCalls || 0) + 1; r.writeHead(404); return r.end('Not Found'); }
  const f = path.join(OUT, p === '/' ? 'index.html' : p);
  if (f.startsWith(OUT) && fs.existsSync(f) && fs.statSync(f).isFile()) { r.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); return fs.createReadStream(f).pipe(r); }
  r.writeHead(404); r.end();
}).listen(0);
const WATCH = `window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); window.__gem = 0;
  const _f = window.fetch; window.fetch = (u, o) => { if (String(u).includes('generativelanguage')) window.__gem++; return _f(u, o); };`;

(async () => {
  const port = srv.address().port;
  const p = spawn(chrome, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9363', '--user-data-dir=' + path.join(os.tmpdir(), 'static_test_profile'), 'about:blank'], { stdio: 'ignore' });
  let tabs; for (let i = 0; i < 40 && !tabs; i++) { await sleep(300); try { tabs = await (await fetch('http://127.0.0.1:9363/json')).json(); } catch (e) {} }
  const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const pend = {}, errs = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m.result || m.error); delete pend[m.id]; } else if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async js => { const r = await send('Runtime.evaluate', { expression: '(async()=>{' + js + '})()', awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; };
  try {
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: WATCH });
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` }); await sleep(2500);

    console.log('== the copy in a browser, with no server behind it');
    const st = await ev(`return {app: typeof calc==='function', backup: IS_BACKUP, note: !document.getElementById('backupNote').classList.contains('hide') ? document.getElementById('backupNote').textContent : '', gc: document.getElementById('gcStrip').classList.contains('hide'), about: document.getElementById('backupAbout').classList.contains('hide'), main: document.getElementById('backupMainLink').href}`);
    ok(st.app && st.backup, 'the page\'s script runs under the copy\'s policy (its hash matches)');
    ok(/This is ClearBill's backup copy\. .*own free Gemini key.*main site/.test(st.note) && st.main === MAIN && st.gc && st.about, 'it says it is the backup copy and what differs, links to the main site, and drops "Runs on Google Cloud"');
    await ev(`document.getElementById('egBtn').click(); await new Promise(r=>setTimeout(r,600)); switchTab('findings');`);
    ok(await ev(`return [...document.querySelectorAll('.kpi .v')].map(e=>e.textContent).join('|')`) === '₹5,962.89|8%|6 / 6', 'the worked example gives the same figures as on the main site');
    await ev(`switchTab('letter'); document.getElementById('genLetterTab').click(); await new Promise(r=>setTimeout(r,300)); const c=document.getElementById('replyCard'); c.open=true; document.getElementById('rpNoBtn').click(); switchTab('about'); switchTab('mybills');`);
    ok(await ev(`return /Request for a line-by-line explanation/.test(document.querySelector('.letter').textContent) && !document.getElementById('replyCard').classList.contains('hide')`), 'the letter and the reply card work');
    await ev(`switchTab('settlement'); addFiles([new File([new Blob(['x'])],'a.jpg',{type:'image/jpeg',lastModified:1})]); document.getElementById('checkPhotosBtn').click();`); await sleep(1200);
    ok(await ev(`return !document.getElementById('keyRow').classList.contains('hide') && window.__gem===0`), 'reading a photo asks for the visitor\'s own key (there is no free reader), and nothing is sent to Gemini without one');
    await ev(`switchTab('letter'); document.getElementById('rpYesBtn').click(); rpReadPhotos([new File([new Blob(['x'])],'r.jpg',{type:'image/jpeg',lastModified:2})]);`); await sleep(800);
    ok(/needs the free reading service, which is not available right now, or your own free Gemini key/.test(await ev(`return document.getElementById('rpReadStatus').textContent`)), 'reading a photo of a reply says the same, and offers pasting');
    await ev(`const d=document.createElement('div'); d.innerHTML='<img src=x onerror="window.__xss=1">'; document.body.appendChild(d);`); await sleep(400);
    ok(await ev(`return !window.__xss`), 'injected script is blocked by the copy\'s policy, as on the main site');
    const v = await ev(`return window.__csp.filter(x=>!/^script-src-attr|^script-src-elem.*x$/.test(x) && !/inline/.test(x))`);
    ok(errs.length === 0, 'no script errors on the copy', errs.slice(0, 3).join(' | '));
    ok((await ev(`return window.__csp.filter(x=>!x.startsWith('script-src-attr')).length`)) === 0, 'no other security-policy violations while using it', JSON.stringify(v));

    console.log('== the main page points to the copy');
    const mainSrv = http.createServer((q, r) => { q.resume(); if (q.url.split('?')[0] === '/') { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(orig); } else { r.writeHead(404); r.end(); } }).listen(0);
    await send('Page.navigate', { url: `http://127.0.0.1:${mainSrv.address().port}/` }); await sleep(2000);
    const m = await ev(`return {backup: IS_BACKUP, note: document.getElementById('backupNote').classList.contains('hide'), about: document.getElementById('backupAbout').classList.contains('hide') ? '' : document.getElementById('backupAbout').textContent, href: document.querySelector('#backupAbout a').href}`);
    ok(!m.backup && m.note && /If this site is ever down, a backup copy runs free on GitHub/.test(m.about) && m.href === 'https://aaryap1.github.io/ClearBill/', 'the main site\'s About tab gives the backup copy\'s address, and shows no backup note');
    mainSrv.close();
  } catch (e) { fail++; console.log('  FAIL ' + e.message); }
  ws.close(); p.kill(); srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
