/* Screen-level tests for the reading flow: double tap, snapshot, report kept on
 * failure, cancel, cold-start race, empty-type files, Hindi errors.
 * Runs the REAL index.html in headless Chrome with fetch replaced by a stub, so
 * there is no network, no Gemini call and no cost.
 *    node --experimental-websocket lib/test_browser_reader.js
 * Skipped (loudly) when Chrome or Edge is not installed.
 */
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(fs.existsSync);
if (!chrome) { console.log('  SKIPPED - no Chrome/Edge found; the screen-level reading tests did not run'); process.exit(0); }
if (typeof WebSocket === 'undefined') { console.log('  SKIPPED - run with: node --experimental-websocket lib/test_browser_reader.js'); process.exit(0); }

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m + (extra ? '  -> ' + extra : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'));
const srv = http.createServer((q, r) => { if (q.url.split('?')[0] === '/') { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(HTML); } else { r.writeHead(404); r.end(); } }).listen(0);

// Installed before the app's own script runs.
const STUB = `
  window.__calls = []; window.__cfgDelay = 0; window.__mode = 'ok'; window.__delay = 0;
  const realFetch = window.fetch; const wait = ms => new Promise(r => setTimeout(r, ms));
  const GOOD = JSON.stringify({ is_hospital_bill: true, header: {}, line_items: [{ item: 'BED CHARGES', quantity: 1, rate: 100, total: 100 }] });
  window.fetch = async (u, o) => {
    u = String(u);
    if (u.includes('api/config')) { await wait(window.__cfgDelay); return new Response(JSON.stringify({ proxy: true }), { status: 200 }); }
    if (u.includes('api/read-bill')) {
      window.__calls.push(o && o.body ? JSON.parse(o.body).mime_type : '?');
      if (window.__delay) await wait(window.__delay);
      if (window.__mode === 'hang') return new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      if (window.__mode === '504') return new Response(JSON.stringify({ error: 'timeout' }), { status: 504 });
      return new Response(GOOD, { status: 200 });
    }
    return realFetch(u, o);
  };
  window.__mk = (name, type, lm) => new File([new Blob(['x'])], name, { type, lastModified: lm || 1 });
`;

(async () => {
  const port = srv.address().port;
  const p = spawn(chrome, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9341', '--user-data-dir=' + path.join(os.tmpdir(), 'reader_test_profile'), 'about:blank'], { stdio: 'ignore' });
  await sleep(3000);
  const tabs = await (await fetch('http://127.0.0.1:9341/json')).json();
  const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pend = {}; const errs = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m.result || m.error); delete pend[m.id]; } else if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async js => { const r = await send('Runtime.evaluate', { expression: '(async()=>{' + js + '})()', awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  const fresh = async () => { await send('Page.navigate', { url: `http://127.0.0.1:${port}/` }); await sleep(1200); await ev(`localStorage.clear(); sessionStorage.clear();`); };
  const status = () => ev(`return document.getElementById('status').textContent`);
  const btn = () => ev(`const b=document.getElementById('checkPhotosBtn'); return {text:b.textContent, disabled:b.disabled, hidden:b.classList.contains('hide')}`);

  try {
    console.log('== double tap and snapshot');
    await fresh();
    await ev(`window.__delay = 150; addFiles([__mk('a.jpg','image/jpeg',1), __mk('b.jpg','image/jpeg',2)]);`);
    await ev(`const b=document.getElementById('checkPhotosBtn'); b.click(); b.click(); b.click();`);
    await sleep(120);
    const midBtn = await btn();
    ok(midBtn.disabled && /Reading/.test(midBtn.text), 'while reading the button is disabled and says "Reading…"');
    await ev(`removeFile(0); addFiles([__mk('c.jpg','image/jpeg',3)]);`);
    ok(/wait/i.test(await status()), 'removing or adding a photo mid-read is refused with a plain message');
    await sleep(700);
    const calls1 = await ev(`return window.__calls.length`);
    ok(calls1 === 2, 'three taps on Check read the two pages once (' + calls1 + ' calls, not 6)');
    ok(await ev(`return _pendingFiles.length`) === 2, 'the queue was not changed during the read');
    ok(/Read 2 line items across 2 pages/.test(await status()), 'the read finishes and reports: "' + (await status()) + '"');

    console.log('== duplicates and file types');
    await fresh();
    await ev(`addFiles([__mk('a.jpg','image/jpeg',1)]); addFiles([__mk('a.jpg','image/jpeg',1)]);`);
    ok(await ev(`return _pendingFiles.length`) === 1 && /already in the list/.test(await status()), 'adding the same photo twice keeps one and says so');
    await fresh();
    await ev(`addFiles([__mk('IMG_9.HEIC','',5), __mk('bill.pdf','application/pdf',6), __mk('b.png','image/png',7)]);`);
    ok(await ev(`return _pendingFiles.map(f=>f.name).join()`) === 'IMG_9.HEIC,b.png' && /1 file skipped/.test(await status()), 'a photo with an empty type is kept, the PDF is skipped, the rest of the selection survives');
    await ev(`document.getElementById('checkPhotosBtn').click();`); await sleep(500);
    ok((await ev(`return window.__calls.join()`)) === 'image/heic,image/png', 'the empty-type photo is sent with a real image type');

    console.log('== a failed read never wipes the report');
    await fresh();
    await ev(`document.getElementById('egBtn').click();`); await sleep(400);
    const hadReport = await ev(`return document.getElementById('report').innerText.length`);
    await ev(`window.__mode='504'; addFiles([__mk('n1.jpg','image/jpeg',11), __mk('n2.jpg','image/jpeg',12), __mk('n3.jpg','image/jpeg',13)]); document.getElementById('checkPhotosBtn').click();`);
    await sleep(700);
    const st = await status(), rep = await ev(`return {len: document.getElementById('report').innerText.length, stale: document.getElementById('report').classList.contains('stale')}`);
    ok(hadReport > 500 && rep.len === hadReport && rep.stale, 'the earlier report is still there (dimmed) after every page fails');
    ok(/Pages 1, 2 could not be read/.test(st) && /not tried yet/.test(st) && /earlier results/.test(st), 'the message is plain and says the earlier results are still shown: "' + st.slice(0, 90) + '"');
    const b2 = await btn(); ok(/Try again/.test(b2.text) && !b2.disabled, 'the button now says "Try again (n pages)" (' + b2.text + ')');
    ok(await ev(`return window.__calls.length`) === 2, 'two failed pages in a row stopped the run: 2 calls, not 3');
    await ev(`window.__mode='ok'; document.getElementById('checkPhotosBtn').click();`); await sleep(700);
    ok(/Read \d+ line items/.test(await status()) && !(await ev(`return document.getElementById('report').classList.contains('stale')`)), 'the retry succeeds, the report is replaced and no longer dimmed');

    console.log('== cancel');
    await fresh();
    await ev(`window.__mode='hang'; addFiles([__mk('h1.jpg','image/jpeg',21), __mk('h2.jpg','image/jpeg',22)]); document.getElementById('checkPhotosBtn').click();`);
    await sleep(300);
    ok(!(await ev(`return document.getElementById('cancelReadBtn').classList.contains('hide')`)), 'a Cancel button appears while reading');
    await ev(`document.getElementById('cancelReadBtn').click();`); await sleep(300);
    ok(/Cancelled/.test(await status()) && (await btn()).disabled === false && await ev(`return window.__calls.length`) === 1, 'Cancel stops at once, sends no further page and frees the button');

    console.log('== cold start: config answers late');
    await send('Page.navigate', { url: 'about:blank' });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__cfgDelay = 600;' });
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` }); await sleep(900);
    await ev(`localStorage.clear(); addFiles([__mk('c1.jpg','image/jpeg',31)]); document.getElementById('checkPhotosBtn').click();`); await sleep(1300);
    ok(!/Gemini key/.test(await status()) && (await ev(`return window.__calls.length`)) === 1, 'tapping Check before /api/config answers waits for it and uses the free service (no "needs a key" prompt)');

    console.log('== report wording: not applicable / compared / sets / non-English lines');
    await fresh();
    const showReport = async (items) => { await ev(`window.__lastExtraction=${JSON.stringify({ header: {}, line_items: items })}; renderReport(window.__lastExtraction);`); return ev(`return document.getElementById('report').innerText`); };
    let txt = await showReport([{ item: 'Bed charges', quantity: 1, total: 100 }]);
    ok(/No stent or knee-implant line found/.test(txt) && /NOT APPLICABLE/i.test(txt), 'a bill with no implant line says "Not applicable", not a green "Clear"');
    txt = await showReport([{ item: 'Drug eluting stent', quantity: 1, rate: 39000, total: 39000 }]);
    ok(/1 implant line compared; none above the ceiling/.test(txt), 'a stent priced at its ceiling says it was compared and is not above it');
    txt = await showReport([{ item: 'TKR SET Femoral component + Tibial component + Insert', quantity: 1, rate: 85000, total: 85000 }]);
    ok(/looked like a set or package/.test(txt) && !/above the NPPA ceiling plus GST/.test(txt), 'a knee set is not flagged and the report says it was not compared');
    txt = await showReport([{ item: 'बेड शुल्क', quantity: 1, total: 100 }, { item: 'Bed', quantity: 1, total: 5 }]);
    ok(/1 line is not written in English/.test(txt), 'a line written only in Hindi is reported as not checked');
    txt = await showReport([{ item: 'Television charges', quantity: 1, total: 300 }]);
    ok(/matched by English item name only|TV|television/i.test(txt) && /This app cannot see which lines your insurer actually declined/.test(txt), 'the IRDAI card says the app cannot see what the insurer declined');
    ok(!/legitimate deduction|Nothing extra needed here/.test(txt), 'the old "a legitimate deduction, nothing extra needed" claim is gone');
    await ev(`setLang('hi');`); txt = await ev(`return document.getElementById('report').innerText`);
    ok(/नामंज़ूर/.test(txt), 'the same wording is in Hindi');

    console.log('== settlement: figures that cannot be true produce no result and never reach the report or letter');
    await fresh(); await ev(`setLang('en');`);
    const setF = (idd, v) => ev(`const e=document.getElementById('${idd}'); e.value='${v}'; e.dispatchEvent(new Event('input',{bubbles:true}));`);
    await setF('total', '1000'); await setF('counter', '1200'); await setF('discount', '0'); await setF('copay', '10');
    ok(await ev(`return document.getElementById('settleOut').classList.contains('inconsistent') && document.getElementById('mysteryAmt').offsetParent === null`), 'paid more than the bill: only the warning is shown, the "never itemised" amount is hidden');
    ok(await ev(`return settleOk() === null`), 'the inconsistent figures are not offered to the report or the letter');
    await ev(`window.__lastExtraction={header:{},line_items:[{item:'TV CHARGES',quantity:1,total:300}]}; renderReport(window.__lastExtraction); switchTab('letter'); document.getElementById('genLetterTab').click();`); await sleep(300);
    const bad = await ev(`return {rep: document.getElementById('report').textContent, letter: document.querySelector('.letter').textContent}`);
    ok(/don.t add up/.test(bad.rep) && !/UN-ITEMISED/i.test(bad.rep), 'the report says the figures do not add up and shows no "un-itemised" headline', JSON.stringify(bad.rep.slice(0, 260)));
    ok(!/By my calculation/.test(bad.letter) && !/not itemised/.test(bad.letter), 'the letter leaves the settlement figures out');
    await setF('counter', '9349'); await setF('total', '41396'); await setF('discount', '1572'); await setF('copay', '100');
    ok(await ev(`return document.getElementById('settleOut').classList.contains('inconsistent') && document.getElementById('rCounter').offsetParent === null`), '100% co-pay: no result panel (it used to show a counter payment the user never typed)');
    await ev(`document.getElementById('egBtn').click();`); await sleep(400);
    ok(await ev(`return !document.getElementById('settleOut').classList.contains('inconsistent') && settleOk() !== null`), 'the worked example figures are consistent and used');
    { const mn = await ev(`return document.getElementById('settleModelNote').textContent`); ok(/room-rent limits/.test(mn), 'the result says the amount can include room-rent limits, deductibles and other exclusions', JSON.stringify(mn)); }

    console.log('== letter: coherent requests and a checkable citation');
    await ev(`switchTab('letter'); document.getElementById('genLetterTab').click();`); await sleep(300);
    const lt = await ev(`return document.querySelector('.letter').innerText`);
    ok(/List I \(Optional Items\)/.test(lt) && /27 September 2019/.test(lt), 'the letter names the list the way IRDAI does, with the date of the guidelines');
    ok(/The items listed above total .1,992\.5\. The remaining .3,970\.39 of the amount recorded as non-payable is not accounted for by those items\./.test(lt), 'the letter states the arithmetic gap between the listed items and the deduction');
    ok(/with the policy clause relied on for each/.test(lt) && /whether my policy offers optional cover/.test(lt), 'the requests ask for the policy clause and for optional cover');
    ok(!/Reconsideration of any amount above that/.test(lt), 'the letter no longer asks for reconsideration of the items it has just listed');
    await ev(`document.querySelector('[data-inc=irdai]').checked=false; document.getElementById('genLetterTab').click();`); await sleep(300);
    const lt2 = await ev(`return document.querySelector('.letter').innerText`);
    ok(!/The items listed above total/.test(lt2) && /2\. Reconsideration of any amount that is not covered/.test(lt2), 'without the listed items the letter has neither the arithmetic sentence nor a reference to them');

    console.log('== guidance: photo guide, Start here, After you send it, letter summary, clear saved data');
    await fresh(); await ev(`setLang('en');`);
    ok(await ev(`return document.querySelectorAll('#photoGuideList li').length`) === 6, 'the photo guide has its six tips');
    await ev(`setLang('hi');`); ok(/[ऀ-ॿ]/.test(await ev(`return document.getElementById('photoGuideSum').textContent + document.querySelector('#photoGuideList li').textContent`)), 'the photo guide follows the language switch');
    await ev(`setLang('en'); document.getElementById('egBtn').click();`); await sleep(400);
    const sh = await ev(`return document.querySelector('.starthere') ? document.querySelector('.starthere').textContent : ''`);
    ok(/Ask the hospital/.test(sh) && /Ask your insurer/.test(sh) && sh.indexOf('Ask the hospital') < sh.indexOf('Ask your insurer'), '"Start here" lists what to ask the hospital first, then the insurer');
    ok(/appear more than once/.test(sh) && /List I/.test(sh) && !/refund|recover|owe/i.test(sh), '"Start here" names the findings and makes no promise of money back');
    { const t = await showReport([{ item: 'Bed charges', quantity: 1, total: 100 }]); ok(/Nothing in these checks needs a question/.test(t), 'a bill with nothing flagged says so and says the app cannot vouch for the rest'); }
    await ev(`document.getElementById('egBtn').click();`); await sleep(400);
    await ev(`switchTab('letter'); document.getElementById('genLetterTab').click();`); await sleep(300);
    const after = await ev(`const a=document.querySelector('.aftersend'); return a ? {t: a.textContent, links: [...a.querySelectorAll('a')].map(x=>x.href)} : null`);
    ok(after && /grievance officer/.test(after.t) && /registered post/.test(after.t) && /hospital's billing office/.test(after.t), '"After you send the letter" says where to send it, to keep proof, and to ask the hospital about its own charges');
    ok(after && after.links.some(l => /bimabharosa\.irdai\.gov\.in/.test(l)) && after.links.some(l => /cioins\.co\.in/.test(l)), 'it links to Bima Bharosa and the Insurance Ombudsman');
    ok(after && !/\b\d+\s*(days?|months?|years?|lakhs?)\b/i.test(after.t) && /time limits/.test(after.t), 'it states no time limits or amounts of its own; it sends people to the official rules');
    ok(await ev(`return document.querySelector('.lsum') === null`), 'in English there is no separate summary above the letter');
    await ev(`setLang('hi');`); await sleep(300);
    const hs = await ev(`window.__pr=null; const op=window.print; window.print=()=>{ window.__pr=document.getElementById('printArea').textContent; }; document.getElementById('printLetter').click(); window.print=op; const s=document.querySelector('.lsum'); return {sum: s?s.textContent:'', lettertext: document.querySelector('.letter').textContent, printed: window.__pr, order: s ? (s.compareDocumentPosition(document.querySelector('.letter')) & 4) : 0}`);
    ok(/[ऀ-ॿ]/.test(hs.sum) && /IRDAI/.test(hs.sum) && hs.order === 4, 'in Hindi a plain-language summary sits above the letter');
    ok(!/[ऀ-ॿ]/.test(hs.printed) && !/इस पत्र में क्या/.test(hs.printed), 'the summary is not part of the text that is printed');
    await ev(`setLang('en'); localStorage.setItem('clearbill_settlement_draft','{"total":"5"}'); localStorage.setItem('clearbill_gemini_key','KEY'); document.getElementById('ld_name').value='Someone'; document.getElementById('ld_remember').checked=true; document.getElementById('ld_name').dispatchEvent(new Event('input',{bubbles:true}));`);
    ok(await ev(`return !!localStorage.getItem('clearbill_letter_details')`), 'letter details are remembered when the box is ticked (setup for the next check)');
    await ev(`document.getElementById('clearSavedBtn').click();`);
    const cleared = await ev(`return {draft: localStorage.getItem('clearbill_settlement_draft'), key: localStorage.getItem('clearbill_gemini_key'), det: localStorage.getItem('clearbill_letter_details'), sdet: sessionStorage.getItem('clearbill_letter_details'), total: document.getElementById('total').value, name: document.getElementById('ld_name').value, apik: document.getElementById('apiKey').value, note: !document.getElementById('clearedNote').classList.contains('hide'), lang: localStorage.getItem('clearbill_lang')}`);
    ok(!cleared.draft && !cleared.key && !cleared.det && !cleared.sdet && cleared.total === '' && cleared.name === '' && cleared.apik === '', '"Clear what this app saved" removes the saved figures, letter details and key, and empties the fields');
    ok(cleared.note && cleared.lang === 'en', 'it confirms, and keeps only the language choice');

    console.log('== Hindi errors');
    await fresh();
    await ev(`setLang('hi'); window.__mode='504'; addFiles([__mk('k1.jpg','image/jpeg',41)]); document.getElementById('checkPhotosBtn').click();`); await sleep(700);
    const hi = await status(); ok(/[\u0900-\u097F]/.test(hi) && !/Failed to fetch|Server 5|took too long/.test(hi), 'in Hindi the error is Hindi, never a raw English message: "' + hi.slice(0, 60) + '"');
    ok(errs.length === 0, 'no uncaught page errors during any of this', errs.join(' | ').slice(0, 200));
  } finally { ws.close(); p.kill(); srv.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
