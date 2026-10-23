/* The reading bench (R31): how well does a model read bills, through the
 * app's REAL path? Each synthetic bill (05_synthetic_corpus) is handed to the
 * real page in headless Chrome, shrunk by the app's own downscaleImage(), sent
 * by the app's own readPages() to the real server.js, which asks Google with
 * one named model. The answer is scored against the known truth with
 * lib/bill_score.js (a port of evaluate.py).
 *
 *   node --experimental-websocket lib/photo_bench.js make-harsh
 *       writes pages/SYN-XX_harsh.jpg: a harder tier than SYN-XX_photo.png
 *       (smaller, tilted, blurred, shadowed, noisy, heavily compressed),
 *       because every model tried so far scored 100% on the photo tier, so
 *       that tier alone cannot tell models apart.
 *   GEMINI_API_KEY=... node --experimental-websocket lib/photo_bench.js run --model <id> --tier photo|harsh [--ids SYN-01,SYN-02] [--pace ms]
 *       reads the bills with that model and writes
 *       05_synthetic_corpus/bench/results/<model>__<tier>.json and the
 *       summary in 05_synthetic_corpus/bench/scores.json.
 *
 * Real calls on the free tier: one per bill. gemini-3.6-flash allows only 20
 * a day for the whole project, which the live site shares, so score it
 * sparingly. The key is read from the environment and never printed or saved.
 * Synthetic bills only: never put a real patient's bill through this, because
 * free-tier inputs may be read by Google's reviewers.
 *
 * A model may join the reading chain (lib/reader_quota.js, DIRECT_MODELS in
 * index.html) only if scores.json says it passed: see PASS below.
 */
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn } = require('child_process');
const { scoreBill, aggregate } = require('./bill_score');
const { analyse } = require('./checks');

const CORPUS = path.join(__dirname, '..', '..', '05_synthetic_corpus');
const BENCH = path.join(CORPUS, 'bench');
// The bar a model must clear on BOTH tiers to read for ClearBill. Set before
// any model was scored (22 Oct 2026); the photo tier is the one 2.5 Pro read
// perfectly, the harsh tier is meant to hurt.
const PASS = { photo: { line_accuracy: 0.95, hallucinations: 2 }, harsh: { line_accuracy: 0.85, hallucinations: 5 } };
const PACE = { 'gemini-3.6-flash': 13000, 'gemini-3.5-flash-lite': 4500 }; // under Google's per-minute limits (5 and 15)

const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(fs.existsSync);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const ids = () => fs.readdirSync(path.join(CORPUS, 'truth')).filter(f => /^SYN-\d+\.json$/.test(f)).map(f => f.slice(0, -5)).sort();

async function openChrome(port, url) {
  try { fs.rmSync(path.join(os.tmpdir(), 'clearbill_bench_profile'), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) {} // a leftover from an earlier, interrupted run
  const p = spawn(chrome, ['--headless=new', '--disable-gpu', '--remote-debugging-port=' + port, '--user-data-dir=' + path.join(os.tmpdir(), 'clearbill_bench_profile'), url], { stdio: 'ignore' });
  let tabs;
  for (let i = 0; i < 40 && !tabs; i++) { await sleep(300); try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch (e) {} }
  const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pend = {};
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m.result || m.error); delete pend[m.id]; } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async js => { const r = await send('Runtime.evaluate', { expression: '(async()=>{' + js + '})()', awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; };
  await send('Runtime.enable');
  await send('Page.setDownloadBehavior', { behavior: 'deny' }); // never into the owner's Downloads folder
  // close() also removes the test browser's profile once Chrome has exited.
  return { ev, send, close: async () => { try { ws.close(); } catch (e) {} p.kill(); await new Promise(r => { p.once('exit', r); setTimeout(r, 3000); }); try { fs.rmSync(path.join(os.tmpdir(), 'clearbill_bench_profile'), { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch (e) {} } };
}

// A seeded, repeatable degradation drawn on a canvas (no image library needed).
const HARSH_JS = `
  const rnd=(()=>{ let a=SEED>>>0; return ()=>{ a=(a+0x6D2B79F5)>>>0; let t=a; t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; }; })();
  const img=new Image(); img.src='data:image/png;base64,'+B64; await img.decode();
  const sc=0.8+rnd()*0.06, W=Math.round(img.width*sc), H=Math.round(img.height*sc);
  const c=document.createElement('canvas'); c.width=W; c.height=H; const x=c.getContext('2d');
  x.fillStyle='rgb(176,170,160)'; x.fillRect(0,0,W,H);
  x.save(); x.translate(W/2,H/2); x.rotate((rnd()<0.5?-1:1)*(1.5+rnd()*1.5)*Math.PI/180); x.transform(1,0,(rnd()-0.5)*0.04,1,0,0);
  x.filter='blur('+(0.45+rnd()*0.3).toFixed(2)+'px) contrast('+(0.8+rnd()*0.08).toFixed(2)+') brightness('+(0.88+rnd()*0.06).toFixed(2)+')';
  x.drawImage(img,-W/2*0.97,-H/2*0.97,W*0.97,H*0.97); x.restore(); x.filter='none';
  const corner=Math.floor(rnd()*4), gx=corner%2?W:0, gy=corner>1?H:0;
  const g=x.createRadialGradient(gx,gy,0,gx,gy,Math.max(W,H)*0.75); g.addColorStop(0,'rgba(20,15,10,0.38)'); g.addColorStop(1,'rgba(20,15,10,0)');
  x.fillStyle=g; x.fillRect(0,0,W,H);
  const cy=H*(0.3+rnd()*0.4); x.fillStyle='rgba(255,255,255,0.22)'; x.fillRect(0,cy,W,2); x.fillStyle='rgba(0,0,0,0.12)'; x.fillRect(0,cy+2,W,2);
  const d=x.getImageData(0,0,W,H), p=d.data; for(let i=0;i<p.length;i+=4){ const n=(rnd()-0.5)*28; p[i]+=n; p[i+1]+=n; p[i+2]+=n; } x.putImageData(d,0,0);
  return c.toDataURL('image/jpeg',0.45).split(',')[1];`;

async function makeHarsh() {
  const b = await openChrome(9362, 'about:blank');
  try {
    for (const id of ids()) {
      const B64 = fs.readFileSync(path.join(CORPUS, 'pages', id + '_clean.png')).toString('base64');
      const out = await b.ev(`const B64=${JSON.stringify(B64)}, SEED=${Number(id.slice(4)) * 7919};` + HARSH_JS);
      fs.writeFileSync(path.join(CORPUS, 'pages', id + '_harsh.jpg'), Buffer.from(out, 'base64'));
      console.log('wrote pages/' + id + '_harsh.jpg');
    }
  } finally { await b.close(); }
}

async function run() {
  const model = arg('model'), tier = arg('tier', 'photo');
  if (!model || !['photo', 'harsh', 'clean'].includes(tier)) throw new Error('give --model <id> --tier photo|harsh|clean');
  if (!process.env.GEMINI_API_KEY) throw new Error('set GEMINI_API_KEY in the environment (it is never printed or saved)');
  const list = (arg('ids') || ids().join(',')).split(',').map(s => s.trim()).filter(Boolean);
  const pace = Number(arg('pace', PACE[model] || 2500));
  const PORT = 18731;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { stdio: 'ignore', env: { ...process.env, PORT: String(PORT),
    GEMINI_MODELS: model, GEMINI_MODEL_CAPS: model + ':100000', DAILY_CAP: '100000', RATE_MAX_PER_IP: '1000', ATTEMPT_MAX_PER_IP: '1000', UPSTREAM_TIMEOUT_MS: '110000', FIRESTORE_PROJECT_ID: '', GOOGLE_CLIENT_ID: '' } });
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/config`); break; } catch (e) { await sleep(150); } }
  const b = await openChrome(9361, `http://127.0.0.1:${PORT}/`);
  const results = [], raw = []; let aborted = false;
  try {
    let ready=false; for (let i = 0; i < 60 && !ready; i++) { await sleep(500); try { ready = await b.ev('return typeof readPages==="function" && typeof configReady!=="undefined"'); } catch (e) {} }
    if (!ready) throw new Error('the app did not load in Chrome');
    if (!(await b.ev('await configReady; return USE_PROXY'))) throw new Error('the local server reports no reader (key not passed?)');
    for (let k = 0; k < list.length; k++) {
      const id = list[k], file = path.join(CORPUS, 'pages', id + '_' + tier + (tier === 'harsh' ? '.jpg' : '.png'));
      const truth = JSON.parse(fs.readFileSync(path.join(CORPUS, 'truth', id + '.json'), 'utf8'));
      const mime = tier === 'harsh' ? 'image/jpeg' : 'image/png';
      const out = await b.ev(`const bin=atob(${JSON.stringify(fs.readFileSync(file).toString('base64'))}); const u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i);
        const f=new File([u],${JSON.stringify(path.basename(file))},{type:${JSON.stringify(mime)},lastModified:1}); const small=await downscaleImage(f); const t0=performance.now();
        const r=await readPages([small],{key:'',useProxy:true,proxyState:{busy:false},fetchFn:(u,o)=>fetch(u,o),toB64,stripFence,directRequest,directModels:DIRECT_MODELS,timeoutMs:120000});
        return {r:r[0],ms:Math.round(performance.now()-t0),sent:small.size,type:small.type};`);
      if (out.r.status !== 'ok') {
        console.log(`  ${id}  not read: ${out.r.kind}`);
        raw.push({ id, status: out.r.kind });
        // Only an answer that could not be understood counts against the model. Anything about
        // the service (refused key, 402, quota, timeout, network) stops the run and records no score.
        if (out.r.kind !== 'unreadable') { console.log('  stopping: the service failed (' + out.r.kind + '), not the model; nothing is scored'); aborted = true; break; }
        results.push(scoreBill(truth, { line_items: [] }));
      } else {
        const sc = scoreBill(truth, out.r.page);
        // Would the app's own total check (bill total vs its lines) have warned about this read?
        let guard = null, truthGuard = null;
        try { guard = !!analyse(out.r.page).recon; truthGuard = !!analyse(truth).recon; } catch (e) {}
        sc.guard = { warned: guard, warns_on_truth: truthGuard };
        results.push(sc); raw.push({ id, status: 'ok', ms: out.ms, sent_bytes: out.sent, sent_type: out.type, page: out.r.page });
        console.log(`  ${id}  line ${(sc.line_accuracy * 100).toFixed(1)}%  (${sc.correct}/${sc.truth_lines})  miss ${sc.missed}  wrong ${sc.wrong_value}  invented ${sc.hallucinations}  total-check ${guard ? 'warned' : 'quiet'}  ${out.ms} ms`);
      }
      if (k < list.length - 1) await sleep(pace);
    }
  } finally { await b.close(); srv.kill(); }
  if (aborted) { console.log('no score written'); process.exitCode = 1; return; }
  const agg = aggregate(results);
  const errBills = results.filter(r => r.correct < r.truth_lines);
  agg.total_check_warned_on_bad_reads = errBills.filter(r => r.guard && r.guard.warned && !r.guard.warns_on_truth).length + ' of ' + errBills.length;
  const date = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.join(BENCH, 'results'), { recursive: true });
  fs.writeFileSync(path.join(BENCH, 'results', `${model}__${tier}.json`), JSON.stringify({ model, tier, date, path: 'app downscaleImage + readPages -> server.js -> Google', summary: agg, bills: results.map(r => ({ ...r, detail: undefined, misses: r.detail.lines.filter(l => l[0] !== 'correct') })), raw }, null, 1) + '\n');
  const SP = path.join(BENCH, 'scores.json');
  const scores = fs.existsSync(SP) ? JSON.parse(fs.readFileSync(SP, 'utf8')) : { pass_rule: PASS, models: {} };
  scores.pass_rule = PASS;
  const m = scores.models[model] = scores.models[model] || {};
  m[tier] = { date, bills: agg.bills, lines: agg.lines, correct: agg.correct, line_accuracy: agg.line_accuracy, hallucinations: agg.hallucinations, missed: agg.missed, wrong_value: agg.wrong_value, complete: agg.bills === ids().length };
  const ok = t => m[t] && m[t].complete && m[t].line_accuracy >= PASS[t].line_accuracy && m[t].hallucinations <= PASS[t].hallucinations;
  m.pass = ok('photo') && ok('harsh');
  fs.writeFileSync(SP, JSON.stringify(scores, null, 1) + '\n');
  console.log(`\n${model} / ${tier}: line accuracy ${agg.line_accuracy == null ? '-' : (agg.line_accuracy * 100).toFixed(1) + '%'} (${agg.correct}/${agg.lines}), invented ${agg.hallucinations}, missed ${agg.missed}; total check warned on ${agg.total_check_warned_on_bad_reads} imperfect reads. Model passes: ${m.pass}`);
}

(async () => {
  if (!chrome) throw new Error('no Chrome/Edge found');
  if (typeof WebSocket === 'undefined') throw new Error('run with: node --experimental-websocket lib/photo_bench.js ...');
  const cmd = process.argv[2];
  if (cmd === 'make-harsh') await makeHarsh();
  else if (cmd === 'run') await run();
  else console.log('usage: make-harsh | run --model <id> --tier photo|harsh [--ids ...] [--pace ms]');
})().catch(e => { console.error(String(e.message || e)); process.exit(1); });
