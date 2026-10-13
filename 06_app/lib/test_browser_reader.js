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
  window.__calls = []; window.__dataLens = []; window.__cfgDelay = 0; window.__mode = 'ok'; window.__delay = 0;
  const realFetch = window.fetch; const wait = ms => new Promise(r => setTimeout(r, ms));
  const GOOD = JSON.stringify({ is_hospital_bill: true, header: {}, line_items: [{ item: 'BED CHARGES', quantity: 1, rate: 100, total: 100 }] });
  window.fetch = async (u, o) => {
    u = String(u);
    if (u.includes('api/config')) { await wait(window.__cfgDelay); let rd = 'ok'; try { rd = localStorage.getItem('__test_reader') || 'ok'; } catch (e) {} return new Response(JSON.stringify({ proxy: true, reader: rd }), { status: 200 }); }
    if (u.includes('api/impact')) { let b = '{"enabled":false}'; try { b = localStorage.getItem('__test_impact') || b; } catch (e) {} return new Response(b, { status: 200 }); }
    if (u.includes('api/read-reply')) { // R24: photo 1 is the insurer's letter, photo 2 is not a letter
      window.__replyCalls = (window.__replyCalls || 0) + 1;
      if (window.__mode === 'broken') return new Response(JSON.stringify({ error: 'broken' }), { status: 502 });
      return new Response(JSON.stringify(window.__replyCalls % 2 ? { is_insurer_letter: true, text: 'We regret that the deduction of Rs. 5,962 stands as per policy terms.', letter_date: '2 October 2026', reference: 'GRV-88' } : { is_insurer_letter: false, text: '', letter_date: null, reference: null }), { status: 200 });
    }
    if (u.includes('api/read-bill')) {
      const b = o && o.body ? JSON.parse(o.body) : null;
      window.__calls.push(b ? b.mime_type : '?');
      window.__dataLens.push(b ? b.data.length : 0); // base64 length actually sent — used by the downscale tests
      if (window.__delay) await wait(window.__delay);
      if (window.__mode === 'hang') return new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      if (window.__mode === '504') return new Response(JSON.stringify({ error: 'timeout' }), { status: 504 });
      if (window.__mode === 'broken') return new Response(JSON.stringify({ error: 'broken' }), { status: 502 });
      // Each photo reads as a different page (two identical pages are now read once, R15);
      // __mode 'same' returns the identical page every time, to test exactly that.
      if (window.__mode === 'same') return new Response(GOOD, { status: 200 });
      const n = window.__calls.length;
      return new Response(n > 1 ? JSON.stringify({ is_hospital_bill: true, header: {}, line_items: [{ item: 'BED CHARGES DAY ' + n, quantity: 1, rate: 100, total: 100 }] }) : GOOD, { status: 200 });
    }
    return realFetch(u, o);
  };
  window.__mk = (name, type, lm) => new File([new Blob(['x'])], name, { type, lastModified: lm || 1 });
  // A REAL, decodable JPEG at genuine pixel dimensions (unlike __mk's 1-byte
  // stub) — createImageBitmap can only be exercised against real image bytes,
  // so the downscale tests need this instead.
  window.__mkImg = (w, h, name, lm) => new Promise(resolve => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#000000'; ctx.font = (Math.round(h / 20)) + 'px sans-serif';
    ctx.fillText('TEST BILL ' + w + 'x' + h, 20, 40);
    c.toBlob(blob => resolve(new File([blob], name || 'big.jpg', { type: 'image/jpeg', lastModified: lm || 1 })), 'image/jpeg', 0.92);
  });
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
    // 400 ms a page: wide enough that a slow machine is still mid-read at the checks below.
    await ev(`window.__delay = 400; addFiles([__mk('a.jpg','image/jpeg',1), __mk('b.jpg','image/jpeg',2)]);`);
    await ev(`const b=document.getElementById('checkPhotosBtn'); b.click(); b.click(); b.click();`);
    await sleep(120);
    const midBtn = await btn();
    ok(midBtn.disabled && /Reading/.test(midBtn.text), 'while reading the button is disabled and says "Reading…"');
    await ev(`removeFile(0); addFiles([__mk('c.jpg','image/jpeg',3)]);`);
    ok(/wait/i.test(await status()), 'removing or adding a photo mid-read is refused with a plain message');
    await sleep(1300);
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
    ok(/looked like a set, package or procedure charge/.test(txt) && !/above the NPPA ceiling plus GST/.test(txt), 'a knee set is not flagged and the report says it was not compared');
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
    await ev(`document.getElementById('egBtn').click();`); await sleep(100);
    ok(await ev(`return !document.getElementById('egConfirm').classList.contains('hide') && window.__lastExtraction.line_items[0].item==='TV CHARGES'`), 'with a bill of your own on screen, "Load the worked example" asks first and replaces nothing yet (R20)');
    await ev(`document.getElementById('egYesBtn').click();`); await sleep(400);
    ok(await ev(`return !document.getElementById('settleOut').classList.contains('inconsistent') && settleOk() !== null`), 'the worked example figures are consistent and used');
    { const mn = await ev(`return document.getElementById('settleModelNote').textContent`); ok(/room-rent limits/.test(mn), 'the result says the amount can include room-rent limits, deductibles and other exclusions', JSON.stringify(mn)); }

    console.log('== letter: coherent requests and a checkable citation');
    await ev(`switchTab('letter'); document.getElementById('genLetterTab').click();`); await sleep(300);
    const lt = await ev(`return document.querySelector('.letter').innerText`);
    ok(/List I \("Optional Items"\)/.test(lt) && /22 July 2020/.test(lt) && /29 May 2024 superseded the 2020 circular/.test(lt) && /please confirm whether my policy still applies this list/.test(lt), 'the letter names the list as IRDAI does, says when it was issued and that the 2024 Master Circular superseded it, and asks the insurer to confirm (R18)');
    ok(/para 17\(b\)/.test(lt) && /along with full details giving reference to the specific terms and conditions of the policy document/.test(lt), 'request 1 quotes the rule in force today: the 2024 Master Circular, para 17(b) (R18)');
    ok(!/Copy to: IRDAI/.test(lt) && /^The patient was hospitalised/m.test(lt), 'no "Copy to: IRDAI" line, and with no name on the bill the letter says "The patient", not "I" (R18)');
    ok(!/recorded as non-payable/.test(lt), 'the letter never says the insurer "recorded" an amount the user only calculated (R18)');
    ok(/The guidelines asked insurers to ensure such items were not billed to policyholders in cashless claims/.test(lt), 'the Lists II-IV paragraph is worded for a cashless claim (the worked example is cashless)');
    ok(/The items listed above total .460\. The remaining .5,502\.89 of the amount I calculate as non-payable is not accounted for by those items\./.test(lt), 'the letter states the arithmetic gap between the listed items and the deduction');
    ok(/with the policy clause relied on for each/.test(lt) && /whether my policy offers optional cover/.test(lt), 'the requests ask for the policy clause and for optional cover');
    ok(!/Reconsideration of any amount above that/.test(lt), 'the letter no longer asks for reconsideration of the items it has just listed');
    await ev(`document.querySelector('[data-inc=irdai]').checked=false; document.getElementById('genLetterTab').click();`); await sleep(300);
    const lt2 = await ev(`return document.querySelector('.letter').innerText`);
    ok(!/The items listed above total/.test(lt2) && /2\. Reconsideration of any amount that is not covered/.test(lt2), 'without the listed items the letter has neither the arithmetic sentence nor a reference to them');

    console.log('== letter and report: IRDAI Lists II-IV (should be in another charge)');
    await ev(`document.querySelector('[data-inc=irdai]').checked=true; document.getElementById('genLetterTab').click();`); await sleep(300);
    const lt3 = await ev(`return document.querySelector('.letter').innerText`);
    ok(/Lists II-IV/.test(lt3) && /Should be part of Treatment cost \(List IV\)/.test(lt3) && /Admission\/Registration Charges/.test(lt3), 'the letter has its own Lists II-IV paragraph, grouped by which list, with the ADMISSION SERVICES line under Treatment cost');
    ok(/3\. Confirmation that each charge listed under IRDAI Lists II-IV was already included/.test(lt3), 'the Lists II-IV request is numbered after the IRDAI List I and NPPA requests (the worked example has no NPPA lines)');
    const rep2 = await ev(`switchTab('findings'); return document.getElementById('report').innerText`);
    ok(/listed by IRDAI \(2019–2020\) as part of another charge/.test(rep2) && /IRDAI Lists II-IV/.test(rep2) && await ev(`return /ask whether your policy still applies them/.test(document.getElementById('report').textContent)`), 'the report has its own "should be in another charge" card, naming the 2019-2020 guidelines and asking whether they still apply (R29)');
    ok(/IRDAI's 2019–2020 guidelines listed as part of another charge .*Ask whether (they were|it was) already included/.test(await ev(`return document.querySelector('.starthere').textContent`)), '"Start here" also lists it under "Ask the hospital", as a question (R29)');
    ok(/6 \/ 6/.test(await ev(`return document.querySelector('.kpis').textContent`)), 'Checks run now counts 6 checks, and all 6 ran on the worked example');
    ok(await ev(`return document.querySelector('[data-inc=subsumed]') !== null`), 'the letter checklist has its own row for this');
    { const nonOverlap = await ev(`const a=analyse(WORKED_EXAMPLE_BILL); return a.exact.some(l=>l.matched==='Admission/Registration Charges'||l.matched==='Alcohol Swabs'||l.matched==='Scrub Solution / Sterillium')`);
      ok(!nonOverlap, 'a line caught by Lists II-IV is never ALSO listed as a List I item (no double count)'); }

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
    ok(after && /does not reply within one month of receiving it/.test(after.t) && /Insurance Ombudsman Rules 2017, rule 14/.test(after.t) && /one-year limit/.test(after.t) && !/\blakhs?\b/i.test(after.t), 'it gives the Ombudsman route when there is no reply within one month, and the one-year limit, each with its rule (Insurance Ombudsman Rules 2017, rule 14), and still sends people to the current rules (R20)');
    ok(await ev(`return document.querySelector('.lsum') === null`), 'in English there is no separate summary above the letter');
    await ev(`setLang('hi');`); await sleep(300);
    const hs = await ev(`window.__pr=null; const op=window.print; window.print=()=>{ window.__pr=document.getElementById('printArea').textContent; }; document.getElementById('printLetter').click(); window.print=op; const s=document.querySelector('.lsum'); return {sum: s?s.textContent:'', lettertext: document.querySelector('.letter').textContent, printed: window.__pr, order: s ? (s.compareDocumentPosition(document.querySelector('.letter')) & 4) : 0}`);
    ok(/[ऀ-ॿ]/.test(hs.sum) && /IRDAI/.test(hs.sum) && hs.order === 4, 'in Hindi a plain-language summary sits above the letter');
    ok(/2019–2020 गाइडलाइंस ने किसी और चार्ज का हिस्सा बताया था/.test(hs.sum), 'the Hindi summary also mentions the Lists II-IV items, not just IRDAI List I');
    ok(!/[ऀ-ॿ]/.test(hs.printed) && !/इस पत्र में क्या/.test(hs.printed), 'the summary is not part of the text that is printed');
    await ev(`setLang('en'); localStorage.setItem('clearbill_settlement_draft','{"total":"5"}'); localStorage.setItem('clearbill_gemini_key','KEY'); document.getElementById('ld_name').value='Someone'; document.getElementById('ld_remember').checked=true; document.getElementById('ld_name').dispatchEvent(new Event('input',{bubbles:true}));`);
    ok(await ev(`return !!localStorage.getItem('clearbill_letter_details')`), 'letter details are remembered when the box is ticked (setup for the next check)');
    await ev(`document.getElementById('clearSavedBtn').click(); document.getElementById('clearYesBtn').click();`);
    const cleared = await ev(`return {draft: localStorage.getItem('clearbill_settlement_draft'), key: localStorage.getItem('clearbill_gemini_key'), det: localStorage.getItem('clearbill_letter_details'), sdet: sessionStorage.getItem('clearbill_letter_details'), total: document.getElementById('total').value, name: document.getElementById('ld_name').value, apik: document.getElementById('apiKey').value, note: !document.getElementById('clearedNote').classList.contains('hide'), lang: localStorage.getItem('clearbill_lang')}`);
    ok(!cleared.draft && !cleared.key && !cleared.det && !cleared.sdet && cleared.total === '' && cleared.name === '' && cleared.apik === '', '"Clear what this app saved" removes the saved figures, letter details and key, and empties the fields');
    ok(cleared.note && cleared.lang === 'en', 'it confirms, and keeps only the language choice');

    console.log('== implant lines that are found but not compared; the privacy notice');
    await fresh(); await ev(`setLang('en');`);
    const showDated = async (billDate) => { await ev(`window.__lastExtraction=${JSON.stringify({ header: { bill_datetime: billDate }, line_items: [{ item: 'Drug eluting stent', quantity: 1, rate: 45000, total: 45000 }] })}; renderReport(window.__lastExtraction);`); return ev(`return document.getElementById('report').textContent`); };
    let dt = await showDated('01/06/2025 11:13');
    ok(/An implant line was found but not compared/.test(dt) && /stent line was not compared: the bill's date is before/.test(dt), 'a stent on a bill dated before 1 April 2026 is reported as found but not compared, with the reason');
    ok(!/No stent or knee-implant line found/.test(dt) && !/above the NPPA ceiling plus GST/.test(dt), 'it is not called "not applicable" and not flagged');
    dt = await showDated('15/05/2026');
    ok(/above the NPPA ceiling plus GST/.test(dt) || /priced above/.test(dt), 'the same stent on a bill from May 2026 is compared and flagged');
    { const t = await showReport([{ item: 'TKR SET Femoral component + Tibial component + Insert', quantity: 1, rate: 85000, total: 85000 }]); ok(/An implant line was found but not compared/.test(t) && !/No stent or knee-implant line found/.test(t), 'a knee set is "found but not compared", no longer "no implant line found"'); }
    const lead = await ev(`return document.getElementById('billLead').textContent`);
    ok(/on its free plan, Google may use what is sent to improve its products and people may read it; on a paid plan it does not/.test(lead), 'the upload notice says what Google\'s free and paid plans do with a photo');
    ok(/cover or crop your name, address and ID numbers/.test(lead) && /list them as missing/.test(lead), 'it says the personal details can be covered, and what that does to the completeness check');
    await ev(`setLang('hi');`); ok(/मुफ़्त योजना/.test(await ev(`return document.getElementById('billLead').textContent`)), 'the notice is in Hindi too');
    await ev(`setLang('en');`);

    console.log('== R11: look-alike charges on screen and in the letter; a hyphenated stent is checked');
    await fresh(); await ev(`setLang('en');`);
    {
      const items = [{ item: 'IP - SPECIALTY - FIRST VISIT (Dr. X) 2417', quantity: 1, total: 1260 }, { item: 'IP - SPECIALTY - FIRST VISIT (Dr. X) 2419', quantity: 1, total: 1260 }];
      const t = await showReport(items);
      ok(/look alike apart from a reference number/i.test(t), 'the duplicate card says the two lines look alike apart from a reference number');
      ok(!/appear more than once/.test(t), 'it does NOT call them an exact repeat');
      ok(/Ask whether each is a separate service/.test(t), '"Start here" asks the hospital whether each is a separate service');
      await ev(`switchTab('letter'); document.getElementById('genLetterTab').click();`); await sleep(300);
      const L = await ev(`return document.getElementById('letterWrap').innerText`);
      ok(/identical apart from a reference number/.test(L) && /2417 \/ IP - SPECIALTY - FIRST VISIT \(Dr\. X\) 2419/.test(L), 'the letter lists both lines and asks the hospital to confirm');
      await ev(`setLang('hi');`); await sleep(200);
      ok(/रेफ़रेंस नंबर/.test(await ev(`return document.getElementById('report').innerText`)), 'the look-alike card is in Hindi too');
      await ev(`setLang('en');`);
    }
    {
      const t = await showReport([{ item: 'DRUG-ELUTING STENT', quantity: 1, rate: 45000, total: 45000 }]);
      ok(!/No stent or knee-implant line found/.test(t), 'a hyphenated "DRUG-ELUTING STENT" is no longer reported as "no stent found"');
    }

    console.log('== R12: save a check on this device (no sign-in), reopen it, file round trip');
    await fresh(); await ev(`setLang('en');`);
    await ev(`document.getElementById('egBtn').click();`); await sleep(500);
    await ev(`switchTab('mybills'); document.getElementById('saveLocalBtn').click();`); await sleep(200);
    let loc = await ev(`return {msg: document.getElementById('localSaveMsg').textContent, rows: document.querySelectorAll('#localList .billrow').length, text: document.getElementById('localList').innerText, stored: readLocalChecks().length}`);
    ok(loc.msg === 'Saved on this device.' && loc.rows === 1 && loc.stored === 1, 'the worked example is saved on this device without signing in');
    ok(/Explained: 8%/.test(loc.text), 'the saved row shows the explained share (8%)');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` }); await sleep(1200); // a reload that keeps storage
    await ev(`switchTab('mybills');`); await sleep(200);
    ok(await ev(`return document.querySelectorAll('#localList .billrow').length`) === 1, 'after closing and reopening the page, the saved check is still listed');
    await ev(`document.querySelector('#localList .lopen').click();`); await sleep(600);
    const reopened = await ev(`return {tab: document.getElementById('page-findings').classList.contains('on'), kpis: [...document.querySelectorAll('.kpi .v')].map(e=>e.textContent).join('|'), total: document.getElementById('total').value, counter: document.getElementById('counter').value, status: document.getElementById('status').textContent}`);
    ok(reopened.tab && reopened.kpis === '₹5,962.89|8%|6 / 6', 'Open restores the same report (₹5,962.89 deducted, 8% explained, 6 of 6 checks): ' + reopened.kpis);
    ok(reopened.total === '41396' && reopened.counter === '9349', 'the settlement figures are restored too');
    ok(/Opened the check saved on/.test(reopened.status), 'it says which saved check was opened');

    const exported = await ev(`return JSON.stringify(readLocalChecks()[0])`);
    ok(await ev(`return importLocalCheckText(${JSON.stringify(exported)})`) === 'ok', 'a downloaded file can be opened again (import)');
    const ids = await ev(`return readLocalChecks().map(r=>r.id)`);
    ok(ids.length === 2 && ids[0] !== ids[1], 'the imported copy gets a new id, never the one in the file');
    for (const [bad, why] of [['not json', 'not JSON'], [JSON.stringify({ v: 1 }), 'no extraction'], [JSON.stringify({ v: 1, extraction: { line_items: 'x' } }), 'line items not a list'], [JSON.stringify({ v: 2, extraction: { line_items: [{ item: 'X', total: 1 }] } }), 'an unknown version'], [JSON.stringify({ v: 1, extraction: { line_items: [] } }), 'no line items']]) {
      ok(await ev(`return importLocalCheckText(${JSON.stringify(bad)})`) === 'bad', 'a file with ' + why + ' is refused');
    }
    await ev(`importLocalCheckText(${JSON.stringify(JSON.stringify({ v: 1, name: '<img src=x onerror="window.__xss=1">', extraction: { line_items: [{ item: 'X', total: 1 }] } }))}); renderLocalList();`); await sleep(100);
    ok(await ev(`return !document.querySelector('#localList img') && !window.__xss && /&lt;img|<img/.test(document.getElementById('localList').innerHTML)`), 'text from an imported file is shown as text, never run as HTML');
    const before = await ev(`return readLocalChecks().length`);
    await ev(`document.querySelector('#localList .ldel').click();`); await sleep(100);
    ok(await ev(`return readLocalChecks().length`) === before - 1, 'Delete removes one saved check');
    await ev(`switchTab('settlement'); document.getElementById('clearSavedBtn').click(); document.getElementById('clearYesBtn').click();`); await sleep(100);
    ok(await ev(`return readLocalChecks().length === 0 && !document.getElementById('localEmpty').classList.contains('hide')`), '"Clear what this app saved" also removes checks saved on this device');
    await fresh();
    await ev(`switchTab('mybills'); document.getElementById('saveLocalBtn').click();`); await sleep(100);
    ok(/Check a bill first/.test(await ev(`return document.getElementById('localSaveMsg').textContent`)), 'with no bill checked yet, Save says so instead of saving an empty check');

    console.log('== R12: follow-up reminder (calendar file)');
    await fresh(); await ev(`setLang('en'); document.getElementById('egBtn').click();`); await sleep(500);
    await ev(`switchTab('letter'); document.getElementById('genLetterTab').click();`); await sleep(300);
    ok(await ev(`return buildBillPayload().flagCounts.duplicates`) === 3, 'a bill saved to My Bills records its 3 duplicate groups (it used to record 0: it read a.dup, not a.dups)');
    ok(await ev(`return !!document.getElementById('remindRow') && document.querySelectorAll('#remindRow [data-days]').length === 3`), 'the letter offers three reminder choices');
    ok(await ev(`return !document.querySelector('.aftersend #remindRow')`), 'the reminder sits outside the "After you send" card (which states no time limits of its own)');
    const ics = await ev(`return buildFollowUpIcs(14, new Date(2026, 9, 5, 15, 30), 'CLM/123,45; A')`);
    const icsLines = ics.split('\r\n');
    ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n'), 'a well-formed calendar file with CRLF line ends');
    ok(icsLines.includes('DTSTART:20261019T100000'), 'the reminder is 14 days later at 10:00 local time');
    ok(icsLines.every(l => Buffer.byteLength(l, 'utf8') <= 75), 'no line is longer than 75 bytes (folded)');
    const unfolded = ics.replace(/\r\n /g, '');
    ok(/CLM\/123\\,45\\; A/.test(unfolded), 'commas and semicolons in a claim number are escaped');
    ok(!/\b\d+\s*(days?|months?)\b/i.test(unfolded.match(/DESCRIPTION:[^\r]*/)[0]), 'the reminder text states no deadline of its own');
    await ev(`setLang('hi');`);
    const icsHi = await ev(`return buildFollowUpIcs(30, new Date(2026, 9, 5, 15, 30), '')`);
    ok(icsHi.split('\r\n').every(l => Buffer.byteLength(l, 'utf8') <= 75) && /अस्पताल के बिल/.test(icsHi.replace(/\r\n /g, '')) && !/�/.test(icsHi), 'in Hindi the lines are folded without breaking a character, and the text survives intact');
    await ev(`setLang('en');`);
    await ev(`document.querySelector('#remindRow [data-days="7"]').click();`); await sleep(100);
    ok(/Open the file to add the reminder/.test(await ev(`return document.getElementById('remindNote').textContent`)), 'tapping a choice downloads the file and says what to do with it');

    console.log('== R13: Insurance Ombudsman office by state (in the "After you send" card, never in the letter)');
    await fresh(); await ev(`setLang('en'); document.getElementById('egBtn').click();`); await sleep(500);
    await ev(`switchTab('letter'); document.getElementById('genLetterTab').click();`); await sleep(300);
    ok(await ev(`return document.getElementById('ld_state').options.length`) === 37, 'the state list offers 36 states/UTs plus "Choose your state"');
    ok(/Choose your state under/.test(await ev(`return document.querySelector('.aftersend').innerText`)), 'with no state chosen, the card says where to choose it');
    const pickState = st => ev(`const s=document.getElementById('ld_state'); s.value=${JSON.stringify(st)}; s.dispatchEvent(new Event('input',{bubbles:true}));`);
    await pickState('Karnataka'); await sleep(300);
    let aft = await ev(`return document.querySelector('.aftersend').innerText`);
    ok(/Office of the Insurance Ombudsman, Bengaluru/.test(aft) && /oio\.bengaluru@cioins\.co\.in/.test(aft) && /JP Nagar/.test(aft), 'Karnataka shows the Bengaluru office: address, phone, email');
    ok(/cioins\.co\.in, as read on 5 October 2026/.test(aft), 'it says where the address came from and when it was read');
    ok(/If you send it today/.test(aft) && /Insurance Ombudsman Rules 2017, rule 14\(3\)/.test(aft) && !/\blakhs?\b/i.test(aft), 'the dates it gives come with their rule (Insurance Ombudsman Rules 2017, rule 14(3)), and no amounts of its own (R21)');
    const letterOnly = await ev(`return document.querySelector('.letter').innerText`);
    ok(!/Ombudsman|oio\./.test(letterOnly), 'the Ombudsman is NOT put in the letter itself (a complaint goes to the insurer first)');
    await pickState('Maharashtra'); await sleep(300);
    aft = await ev(`return document.querySelector('.aftersend').innerText`);
    ok(/Mumbai/.test(aft) && /Pune/.test(aft) && /Thane/.test(aft) && (aft.match(/Covers:/g) || []).length === 3, 'Maharashtra (split) shows all three offices, each with the area it covers in its own words');
    ok(/different offices cover different areas/.test(aft) && /or to the one for the insurer.s branch or office you dealt with \(Insurance Ombudsman Rules 2017, rule 14\(1\)\)/.test(aft), 'and says the office can be the one for where you live or for the insurer\'s branch you dealt with, citing rule 14(1) (R20)');
    await ev(`setLang('hi');`); await sleep(200);
    ok(/बीमा लोकपाल/.test(await ev(`return document.querySelector('.aftersend').innerText`)), 'the office block is in Hindi too (the address stays as published)');
    await ev(`setLang('en'); document.getElementById('ld_remember').checked=true; document.getElementById('ld_remember').dispatchEvent(new Event('input',{bubbles:true}));`); await sleep(100);
    ok(/"state":"Maharashtra"/.test(await ev(`return localStorage.getItem('clearbill_letter_details')||''`)), 'the chosen state is remembered with the other details when "remember" is ticked');

    console.log('== R13: "sent on" date and how long ago');
    await fresh(); await ev(`setLang('en'); document.getElementById('egBtn').click();`); await sleep(500);
    await ev(`switchTab('mybills'); document.getElementById('saveLocalBtn').click();`); await sleep(200);
    ok(await ev(`return !!document.querySelector('#localList .bsentin')`), 'a check saved on this device has a "Sent on" date field');
    const ago = await ev(`const d=new Date(); d.setDate(d.getDate()-3); const p=x=>String(x).padStart(2,'0'); const v=d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());
      const i=document.querySelector('#localList .bsentin'); i.value=v; i.dispatchEvent(new Event('change',{bubbles:true}));
      return {txt: document.querySelector('#localList .bago').textContent, stored: readLocalChecks()[0].sentOn, v};`);
    ok(ago.txt === 'sent 3 days ago' && ago.stored === ago.v, 'choosing a date 3 days ago shows "sent 3 days ago" and is saved with the check');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` }); await sleep(1200);
    await ev(`switchTab('mybills');`); await sleep(200);
    ok(await ev(`return document.querySelector('#localList .bsentin').value`) === ago.v && await ev(`return document.querySelector('#localList .bago').textContent`) === 'sent 3 days ago', 'after reopening the page, the date and the count are still there');
    const sa = await ev(`const p=x=>String(x).padStart(2,'0'), f=d=>d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()), t=new Date(), y=new Date(); y.setDate(y.getDate()-1); const fu=new Date(); fu.setDate(fu.getDate()+5);
      return {today: sentAgo(f(t)), yest: sentAgo(f(y)), future: validSentOn(f(fu)), bad: validSentOn('2026-02-30'), none: sentAgo(null)};`);
    ok(sa.today === 'sent today' && sa.yest === 'sent yesterday', '"sent today" and "sent yesterday" read naturally');
    ok(sa.future === false && sa.bad === false && sa.none === '', 'a future or impossible date is not accepted, and no date shows nothing');
    ok(await ev(`return !/\\b\\d+\\s*days?\\b.*(limit|deadline|within)/i.test(document.getElementById('localList').innerText)`), 'the count states no deadline ("sent 3 days ago", nothing about what is due)');
    const acct = await ev(`renderMyBillsList([{id:'b1',status:'sent',note:'',sentOn:'2026-09-20',savedAt:'2026-09-20T10:00:00Z',explainedPct:22}]);
      return {v: document.querySelector('#mybillsList .bsentin').value, ago: document.querySelector('#mybillsList .bago').textContent};`);
    ok(acct.v === '2026-09-20' && /^sent \d+ days ago$/.test(acct.ago), 'a bill saved to a Google account shows its sent-on date and count the same way (' + acct.ago + ')');

    console.log('== R14: impact line (numbers come from the server) and reader status');
    const loadWith = async (reader, impact) => {
      await fresh();
      await ev(`localStorage.setItem('__test_reader', ${JSON.stringify(reader)}); localStorage.setItem('__test_impact', ${JSON.stringify(JSON.stringify(impact))});`);
      await send('Page.navigate', { url: `http://127.0.0.1:${port}/` }); await sleep(1300);
      return ev(`return {impact: document.getElementById('impactLine').classList.contains('hide') ? null : document.getElementById('impactLine').innerText,
        note: document.getElementById('readerNote').classList.contains('hide') ? null : document.getElementById('readerNote').textContent,
        keyRow: !document.getElementById('keyRow').classList.contains('hide'), busyFlag: _proxyState.busy}`);
    };
    let rs = await loadWith('ok', { enabled: false });
    ok(rs.impact === null && rs.note === null, 'counter off and reader ok: no impact line, no status note');
    rs = await loadWith('ok', { enabled: true, pages: 0, matched: 0, since: '2026-10-05' });
    ok(rs.impact === null, 'nothing counted yet: the line stays hidden rather than showing "0"');
    rs = await loadWith('ok', { enabled: true, pages: 1234, matched: 56789.5, since: '2026-10-05' });
    ok(/^1,234 bill pages read by the free reading service since 5 October 2026/.test(rs.impact || ''), 'the line says exactly what is counted: "1,234 bill pages read by the free reading service since 5 October 2026"');
    ok(/₹56,789\.50 in charges matching IRDAI's published lists/.test(rs.impact || ''), 'and the matched amount, with both paise digits: "₹56,789.50 in charges matching IRDAI\'s published lists"');
    rs = await loadWith('ok', { enabled: true, pages: 1, matched: 0, since: '2026-10-05' });
    ok(/^1 bill page read by/.test(rs.impact || '') && !/IRDAI/.test(rs.impact || ''), 'one page reads "1 bill page", and a zero amount is left out');
    rs = await loadWith('ok', { enabled: true, pages: 5, matched: 100, since: '<img src=x onerror="window.__xss2=1">' });
    ok(!(await ev(`return !!window.__xss2 || !!document.querySelector('#impactLine img')`)), 'text from the server is escaped, never run as HTML');
    rs = await loadWith('ok', { enabled: true, pages: 1234, matched: 56789.5, since: '2026-10-05' });
    await ev(`setLang('hi');`); await sleep(150);
    ok(/पेज़ पढ़े/.test(await ev(`return document.getElementById('impactLine').innerText`)), 'the line follows the language switch');
    await ev(`setLang('en');`);
    rs = await loadWith('busy', { enabled: false });
    ok(/today's limit/.test(rs.note || '') && rs.keyRow && rs.busyFlag === true, '"busy": the upload area says today\'s free reads are used up, opens the own-key box, and sends a pasted key straight to Google');
    rs = await loadWith('overloaded', { enabled: false });
    ok(/overloaded in the last few minutes/.test(rs.note || '') && !rs.keyRow, '"overloaded": it warns that a read may fail right now (no key box needed)');
    await ev(`setLang('mr');`); await sleep(150);
    ok(/भार/.test(await ev(`return document.getElementById('readerNote').textContent`)), 'the status note is in Marathi too');
    await ev(`setLang('en');`);

    console.log('== R16: the free reader is broken');
    rs = await loadWith('broken', { enabled: false });
    ok(/not working right now/.test(rs.note || '') && rs.keyRow && rs.busyFlag === true, '"broken": the upload area says the free service is not working, opens the own-key box, and a pasted key goes straight to Google');
    await ev(`setLang('hi');`); await sleep(150);
    ok(/काम नहीं कर रही/.test(await ev(`return document.getElementById('readerNote').textContent`)), 'the "broken" note is in Hindi too');
    await ev(`setLang('en');`);
    await fresh(); await ev(`setLang('en');`);
    await ev(`window.__mode='broken'; addFiles([__mk('b1.jpg','image/jpeg',71), __mk('b2.jpg','image/jpeg',72)]); document.getElementById('checkPhotosBtn').click();`); await sleep(800);
    const bst = await status();
    ok(/not working right now/.test(bst) && await ev(`return !document.getElementById('keyRow').classList.contains('hide') && _proxyState.busy===true && window.__calls.length===1`), 'a read answered "broken" stops at once, says so, and opens the own-key box: "' + bst.slice(0, 80) + '"');

    console.log('== R16: My Bills - a full account, and values the server accepts');
    await fresh(); await ev(`setLang('en');`);
    const lim = await ev(`BILLS_ON=true; ID_TOKEN='h.eyJuYW1lIjoiVCJ9.s'; const of=window.fetch;
      window.fetch=async(u,o)=>{ u=String(u); if(u.includes('api/bills')&&o&&o.method==='POST') return new Response('{"error":"limit","max":100}',{status:409});
        if(u.includes('api/bills')) return new Response('{}',{status:503}); return of(u,o); };
      document.getElementById('egBtn').click(); await new Promise(r=>setTimeout(r,400)); renderAuthUI(); switchTab('mybills');
      document.getElementById('saveBillBtn').click(); await new Promise(r=>setTimeout(r,300));
      return document.getElementById('mybillsSaveMsg').textContent;`);
    ok(/You have 100 saved bills, the most an account can keep/.test(lim), 'a full account is told plainly what to do (not "could not save"): "' + lim.slice(0, 70) + '"');
    const pl = await ev(`window.__lastExtraction={header:{net_payable:'41,396.00', hospital_name:'H'.repeat(260), bill_datetime:20250601},line_items:[{item:'BED',quantity:1,total:100}]}; renderReport(window.__lastExtraction);
      const p=buildBillPayload(); return {np:p.netPayable, hn:p.hospitalName.length, bd:p.billDate};`);
    ok(pl.np === 41396 && pl.hn === 200 && pl.bd === '20250601', 'an amount read as text ("41,396.00") is saved as a number, a long name is cut to 200 characters, and a date read as a number is saved as text');

    console.log('== downscale: large photos are resized before upload (R10)');
    await fresh();
    const dimsOf = async (fileExpr) => ev(`const bmp = await createImageBitmap(${fileExpr}); const d = {w: bmp.width, h: bmp.height}; bmp.close && bmp.close(); return d;`);
    await ev(`window.__big = await __mkImg(3000, 2000, 'orig.jpg', 101);`);
    const bigSize = await ev(`return window.__big.size`);
    const bigDims = await dimsOf('window.__big');
    ok(bigDims.w === 3000 && bigDims.h === 2000, 'sanity: the synthetic test photo really is 3000x2000');
    await ev(`window.__small_out = await downscaleImage(window.__big);`);
    const smallOut = await dimsOf('window.__small_out');
    const smallOutMeta = await ev(`return {type: window.__small_out.type, name: window.__small_out.name, lm: window.__small_out.lastModified, size: window.__small_out.size, sameRef: window.__small_out === window.__big}`);
    ok(Math.max(smallOut.w, smallOut.h) <= 1900, `a photo over the cap is resized so its long side is <= 1900px (got ${smallOut.w}x${smallOut.h})`);
    ok(Math.abs(smallOut.w / smallOut.h - 3000 / 2000) < 0.01, 'the aspect ratio is preserved');
    ok(smallOutMeta.type === 'image/jpeg' && !smallOutMeta.sameRef, 'the result is a new JPEG file, not the original reference');
    ok(smallOutMeta.size < bigSize, `the resized file is smaller (${smallOutMeta.size} vs ${bigSize} bytes)`);
    ok(smallOutMeta.name === 'orig.jpg' && smallOutMeta.lm === 101, "the original file's name and lastModified are kept (so fileKey/dedup still work across a retry)");

    await ev(`window.__sm = await __mkImg(800, 600, 'small.jpg', 202);`);
    const untouched = await ev(`window.__sm_out = await downscaleImage(window.__sm); return window.__sm_out === window.__sm;`);
    ok(untouched === true, 'a photo already under the cap is returned completely untouched (no needless re-encoding)');

    console.log('== downscale: actually wired into the real upload (not just the standalone function)');
    await fresh();
    await ev(`window.__big2 = await __mkImg(3200, 2400, 'phone_photo.jpg', 303);`);
    const origB64Len = await ev(`const r = await toB64(window.__big2); return r.length;`);
    await ev(`addFiles([window.__big2]); document.getElementById('checkPhotosBtn').click();`);
    await sleep(600);
    const sentMime = await ev(`return window.__calls[0]`);
    const sentLen = await ev(`return window.__dataLens[0]`);
    ok(sentMime === 'image/jpeg', 'the real upload path sends image/jpeg for the (downscaled) photo');
    ok(sentLen < origB64Len * 0.8, `the real upload sends meaningfully less data than the undownscaled original (${sentLen} vs ${origB64Len} base64 chars)`);

    console.log('== R15: reimbursement claims');
    await fresh(); await ev(`setLang('en');`);
    const setV = (idd, v) => ev(`const e=document.getElementById('${idd}'); e.value='${v}'; e.dispatchEvent(new Event('input',{bubbles:true}));`);
    // The live repro: a reimbursement typed into the cashless fields.
    await setV('total', '41396'); await setV('counter', '41396'); await setV('discount', '0'); await setV('copay', '0');
    const paidAll = await ev(`return {warn: document.getElementById('settleWarn').textContent, hidden: document.getElementById('settleWarn').classList.contains('hide'), ok: settleOk()}`);
    ok(!paidAll.hidden && /I paid and claimed it back/.test(paidAll.warn) && paidAll.ok === null, 'cashless: paying the whole bill at the counter is flagged and points to the reimbursement option (it used to say the insurer approved ₹0 and the whole bill was never explained)');
    await ev(`document.getElementById('modeReimbBtn').click();`); await sleep(100);
    const vis = await ev(`const h=id=>document.getElementById(id).classList.contains('hide'); return {counter: h('counterBox'), discount: h('discountBox'), reimb: h('reimbBox'), pressed: document.getElementById('modeReimbBtn').getAttribute('aria-pressed')}`);
    ok(vis.counter && vis.discount && !vis.reimb && vis.pressed === 'true', 'choosing "I paid and claimed it back" swaps the counter and discount fields for "Amount the insurer paid you"');
    await setV('reimb', '30000'); await setV('copay', '10');
    const rs15 = await ev(`const s=settleOk(); return s && {mode:s.mode, insurer:s.insurer, ded:s.deduction, copay:s.copayAmt, gap:s.counter, sub: document.getElementById('mysterySub').textContent, lbl: document.getElementById('counterPaymentLbl').textContent, ins: document.getElementById('insurerApprovedLbl').textContent}`);
    ok(rs15 && rs15.mode === 'reimb' && rs15.insurer === 30000 && rs15.ded === 8062.67 && rs15.copay === 3333.33 && rs15.gap === 11396, 'bill ₹41,396, paid back ₹30,000, 10% co-pay: ₹3,333.33 co-pay and ₹8,062.67 never explained (' + JSON.stringify(rs15 && [rs15.ded, rs15.copay]) + ')');
    ok(rs15 && /did not pay back/.test(rs15.sub) && rs15.lbl === 'Not paid back to you' && rs15.ins === 'Insurer paid you', 'the result is worded for a reimbursement, not a counter payment');
    await ev(`window.__lastExtraction={header:{},line_items:[{item:'TV CHARGES',quantity:1,total:300}]}; renderReport(window.__lastExtraction); switchTab('letter'); document.getElementById('genLetterTab').click();`); await sleep(300);
    const rl = await ev(`return document.querySelector('.letter').textContent`);
    ok(/reimbursement settlement was as follows/.test(rl) && /Reimbursed by insurer/.test(rl) && /Not reimbursed/.test(rl) && !/Paid at discharge|cashless/.test(rl), 'the letter describes a reimbursement settlement, not a cashless one');
    await setV('reimb', '50000');
    ok(await ev(`return settleOk()===null && /more than the total bill/.test(document.getElementById('settleWarn').textContent)`), 'paid back more than the bill: flagged, and kept out of the report and letter');
    await setV('reimb', '30000');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` }); await sleep(1200);
    ok(await ev(`return SETTLE_MODE==='reimb' && document.getElementById('reimb').value==='30000' && !document.getElementById('reimbBox').classList.contains('hide')`), 'after reopening the page, the reimbursement figures and the choice are still there');
    await ev(`setLang('hi');`);
    ok(await ev(`return /[ऀ-ॿ]/.test(document.getElementById('modeReimbBtn').textContent + document.getElementById('counterPaymentLbl').textContent + document.getElementById('lblReimb').textContent)`), 'the switch, the new field and the result labels are in Hindi');
    await ev(`setLang('mr');`);
    ok(await ev(`return /परत/.test(document.getElementById('counterPaymentLbl').textContent)`), '...and in Marathi');
    await ev(`setLang('en'); document.getElementById('egBtn').click();`); await sleep(400);
    ok(await ev(`return SETTLE_MODE==='cashless' && !document.getElementById('counterBox').classList.contains('hide') && settleOk() && settleOk().mode==='cashless'`), 'the worked example (a cashless claim) switches back to cashless');

    console.log('== R15: the same page photographed twice');
    await fresh(); await ev(`setLang('en');`);
    await ev(`window.__mode='same'; addFiles([__mk('s1.jpg','image/jpeg',61), __mk('s2.jpg','image/jpeg',62)]); document.getElementById('checkPhotosBtn').click();`); await sleep(900);
    const same = await ev(`return document.getElementById('report').innerText`);
    ok(/1 photo was an exact copy of a page already read/.test(same) && !/appear(s)? more than once/.test(same), 'two photos of one page: read once, said so, and not reported as a repeated charge');

    console.log('== R15: "Delete all my saved bills" only reports what was deleted');
    const delRun = async (codes, confirmAns) => {
      await fresh(); await ev(`setLang('en');`);
      return ev(`BILLS_ON=true; ID_TOKEN='h.eyJuYW1lIjoiVCJ9.s'; window.confirm=()=>${confirmAns}; window.__del=0; const codes=${JSON.stringify(codes)}; const of=window.fetch;
        window.fetch=async(u,o)=>{ u=String(u); if(u.includes('api/bills/')&&o&&o.method==='DELETE'){ return new Response('{}',{status:codes[window.__del++]}); }
          if(u.includes('api/bills')) return new Response('{}',{status:503}); return of(u,o); }; // a failed refresh keeps the list on screen
        _myBills=[{id:'a',status:'sent'},{id:'b',status:'sent'},{id:'c',status:'sent'}]; renderAuthUI(); renderMyBillsList(_myBills); switchTab('mybills');
        document.getElementById('mybillsDeleteAllBtn').click(); await new Promise(r=>setTimeout(r,300));
        const m=document.getElementById('mybillsDelMsg');
        return {calls:window.__del, msg:m.classList.contains('hide')?'':m.textContent, signedIn:!!ID_TOKEN, left:_myBills.map(b=>b.id).join(''), rows:document.querySelectorAll('#mybillsList .billrow').length};`);
    };
    let dr = await delRun([200, 401, 401], 'true');
    ok(dr.calls === 2 && !dr.signedIn && /expired/.test(dr.msg) && /only 1 of 3/.test(dr.msg), 'an expired sign-in stops the run, signs out and says only 1 of 3 was deleted (it used to show the list as empty): "' + dr.msg + '"');
    dr = await delRun([200, 500, 200], 'true');
    ok(dr.left === 'b' && dr.rows === 1 && /Deleted 2 of 3/.test(dr.msg) && /could not be deleted/.test(dr.msg), 'a bill the server failed to delete stays on the list, and the message says 2 of 3');
    dr = await delRun([200, 200, 200], 'false');
    ok(dr.calls === 0 && dr.left === 'abc', 'saying no to "Delete all … cannot be undone" deletes nothing');
    dr = await delRun([200, 404, 200], 'true');
    ok(dr.left === '' && /Deleted 3 of 3/.test(dr.msg), 'a bill already gone (404) counts as deleted');

    console.log('== R18: what the screens say');
    await fresh(); await ev(`setLang('en'); document.getElementById('egBtn').click();`); await sleep(500);
    const rep18 = await ev(`switchTab('findings'); return document.getElementById('report').innerText`);
    ok(/About these lists: IRDAI published List I and Lists II.IV in its 2019.2020 standardization guidelines/.test(rep18) && /superseded the 2020 circular/.test(rep18), 'the report says when the lists were published and that the 2024 Master Circular superseded them');
    ok(!/You were told/.test(rep18) && /By the settlement figures/.test(rep18), 'the report no longer says "You were told" an amount was never itemised: the app worked it out');
    ok(await ev(`switchTab('settlement'); return /the settlement figures don.t say what this was for/.test(document.getElementById('neverItemisedLbl').textContent)`), 'the Settlement headline says the figures don\'t explain the amount, not "you were not told"');
    ok(await ev(`switchTab('letter'); const v=[...document.querySelectorAll('.inclrow.static .v')].map(x=>x.textContent).join('|'); return /grievance officer/.test(v) && !/IRDAI/.test(v)`), 'the letter is "Sent to" the insurer\'s grievance officer, not "Insurer / IRDAI"');
    const about18 = await ev(`switchTab('about'); return document.getElementById('page-about').innerText`);
    ok(/Optional Items/.test(about18) && !/the official list of hospital charges insurers don.t have to pay/.test(about18) && /knee-implant ceilings shown have not been independently re-confirmed/.test(about18), 'About describes List I as IRDAI does and says which NPPA ceilings are confirmed');
    for (const l of ['hi', 'mr']) { await ev(`setLang('${l}'); switchTab('findings');`); await sleep(150);
      ok(/2019.2020/.test(await ev(`return document.getElementById('report').innerText`)) && await ev(`return !/undefined/.test(document.getElementById('report').innerText)`), 'the note about the lists is shown in ' + l.toUpperCase() + ' too'); }
    await ev(`setLang('en');`);
    const imp18 = await ev(`window.__lastExtraction={header:{},line_items:[{item:'RESOLUTE ONYX STENT',quantity:1,rate:45000,total:45000}]}; renderReport(window.__lastExtraction); return document.getElementById('report').innerText;`);
    ok(/An implant line was found but not compared/.test(imp18) && /names a stent or knee implant without saying which kind/.test(imp18) && !/No stent or knee-implant line found/.test(imp18), 'a stent line without its type is "found but not compared", with the reason (it used to say no stent was on the bill)');

    console.log('== R20: ticks you removed stay removed');
    await fresh(); await ev(`setLang('en'); document.getElementById('egBtn').click();`); await sleep(500);
    await ev(`switchTab('letter'); document.querySelector('[data-inc=dup]').click(); document.querySelector('[data-inc=recon]').click();`);
    await ev(`switchTab('settlement'); const e=document.getElementById('copay'); e.value='10'; e.dispatchEvent(new Event('input',{bubbles:true}));`); await sleep(100);
    await ev(`setLang('hi'); setLang('en'); switchTab('letter');`); await sleep(150);
    const ticks = await ev(`return ['dup','recon','irdai'].map(k=>k+':'+document.querySelector('[data-inc='+k+']').checked).join(',')`);
    ok(ticks === 'dup:false,recon:false,irdai:true', 'after editing a settlement figure and switching language, the boxes you unticked stay unticked (they used to come back): ' + ticks);
    await ev(`document.getElementById('genLetterTab').click();`); await sleep(300);
    const lt20 = await ev(`return document.querySelector('.letter').innerText`);
    ok(!/appear more than once at the same amount/.test(lt20) && !/differs from the sum of its own printed lines/.test(lt20) && /List I/.test(lt20), 'so the letter leaves out the repeats and the arithmetic gap you removed');
    ok(/reply within 14 days, the time IRDAI.s Master Circular on Protection of Policyholders. Interests \(5 September 2024, Part B, VI\.2\(i\)\) gives insurers to resolve a complaint/.test(lt20) && /Part B, V\.3\(iii\)\(5\)\) says the same/.test(lt20) && /IRDAI\/PP&GR\/CIR\/MISC\/117\/9\/2024/.test(lt20) && /IRDAI\/HLT\/CIR\/PRO\/84\/5\/2024/.test(lt20), 'the letter asks for a reply within the 14 days IRDAI sets, cites the exact paragraphs, and gives both circulars\' reference numbers (R29)');
    await ev(`localStorage.clear(); window.__lastExtraction={header:{},line_items:[{item:'TV CHARGES',quantity:1,total:300}]}; renderReport(window.__lastExtraction); switchTab('letter');`); await sleep(150);
    ok(await ev(`return document.querySelector('[data-inc=irdai]') && document.querySelector('[data-inc=irdai]').checked`), 'a different bill starts with every box ticked again');

    console.log('== R20: nothing is wiped without asking');
    await fresh(); await ev(`setLang('en'); localStorage.setItem('clearbill_local_checks', JSON.stringify([{v:1,id:'cx',savedAt:'2026-10-01T00:00:00Z',extraction:{header:{},line_items:[{item:'BED',total:100}]}}]));`);
    await ev(`document.getElementById('clearSavedBtn').click();`); await sleep(100);
    ok(await ev(`return !document.getElementById('clearConfirm').classList.contains('hide') && !!localStorage.getItem('clearbill_local_checks')`), '"Clear what this app saved" asks first, and nothing is deleted yet');
    await ev(`document.getElementById('clearCancelBtn').click();`);
    ok(await ev(`return document.getElementById('clearConfirm').classList.contains('hide') && !!localStorage.getItem('clearbill_local_checks')`), 'Cancel keeps everything');
    await ev(`document.getElementById('clearSavedBtn').click(); document.getElementById('clearYesBtn').click();`); await sleep(100);
    ok(await ev(`return !localStorage.getItem('clearbill_local_checks')`), '"Yes, clear it all" clears it');
    // The worked example and a bill of your own
    await fresh(); await ev(`setLang('en');`);
    await ev(`addFiles([__mk('own1.jpg','image/jpeg',81)]); document.getElementById('checkPhotosBtn').click();`); await sleep(900);
    const own = await ev(`return {lines: window.__lastExtraction && window.__lastExtraction.line_items.length, cache: _pageCache.size}`);
    await ev(`document.getElementById('egBtn').click();`); await sleep(100);
    ok(await ev(`return !document.getElementById('egConfirm').classList.contains('hide') && !_usingWorkedExample`), 'with your own bill on screen, "Load the worked example" asks first (it used to replace it at once)');
    await ev(`document.getElementById('egKeepBtn').click();`); await sleep(100);
    ok(await ev(`return !_usingWorkedExample && window.__lastExtraction.line_items[0].item==='BED CHARGES'`), '"Keep my bill" keeps it');
    await ev(`document.getElementById('egBtn').click(); document.getElementById('egYesBtn').click();`); await sleep(400);
    ok(await ev(`return _usingWorkedExample && _pageCache.size`) === own.cache && own.cache >= 1, 'after loading the example, the pages already read stay cached, so adding the same photos again costs no free reads');
    // Typed figures can be brought back
    await fresh(); await ev(`setLang('en'); for(const [id,v] of [['total','230000'],['counter','40000']]){ const e=document.getElementById(id); e.value=v; e.dispatchEvent(new Event('input',{bubbles:true})); }`);
    await ev(`document.getElementById('egBtn').click();`); await sleep(400);
    ok(await ev(`return !document.getElementById('egUndo').classList.contains('hide') && document.getElementById('total').value==='41396'`), 'loading the example over figures you typed says so, with Undo');
    await ev(`document.getElementById('egUndoBtn').click();`); await sleep(150);
    ok(await ev(`return document.getElementById('total').value==='230000' && document.getElementById('counter').value==='40000' && document.getElementById('egUndo').classList.contains('hide')`), 'Undo brings your figures back');
    // Figures from a last visit say so
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` }); await sleep(1200);
    ok(await ev(`return !document.getElementById('restoredNote').classList.contains('hide') && document.getElementById('total').value==='230000' && /from your last visit/.test(document.getElementById('restoredNote').textContent)`), 'figures restored from your last visit are labelled as such');
    await ev(`document.getElementById('restoredClearBtn').click();`); await sleep(100);
    ok(await ev(`return document.getElementById('total').value==='' && document.getElementById('restoredNote').classList.contains('hide') && !localStorage.getItem('clearbill_settlement_draft')`), '"Clear them" clears just those figures');

    console.log('== R20: what goes out in public');
    await fresh(); await ev(`setLang('en'); document.getElementById('egBtn').click();`); await sleep(500);
    const share = await ev(`switchTab('findings'); const a=analyseFor(window.__lastExtraction), s=settleOk(); return S().share_findings_text(a.exact.length, inr.format(a.exactSum), a.nppa.length, a.dups.length, '', 'https://x', inr.format(s.deduction));`);
    ok(/By the settlement figures, ₹5,962\.89 of what I paid is not itemised/.test(share) && /List I \("Optional Items"\)/.test(share) && /appear more than once/.test(share) && !/non-payable|duplicate/i.test(share), 'the share text leads with the un-itemised amount and uses the on-screen wording (List I, "appear more than once"): ' + share.slice(0, 120));
    ok(/What the settlement says/i.test(await ev(`return document.getElementById('report').innerText`)), 'the report heading says what the settlement says, not "what you were told"');
    ok(/not money recovered/.test(await ev(`return S().impact_line('1','1','₹5','5 October 2026')`)), 'the public counter says its amount is on bills, not money recovered');

    console.log('== R20: typing stays quick on a long bill');
    await ev(`const items=[]; for(let i=0;i<500;i++) items.push({item:(i%7===0?'GLOVES EXAMINATION ':'ITEM ')+i, quantity:1, rate:100+i, total:100+i}); window.__lastExtraction={header:{},line_items:items}; calc();`);
    await send('Emulation.setCPUThrottlingRate', { rate: 4 }); await sleep(200);
    const keys = await ev(`const out=[]; for(let i=0;i<7;i++){ const t0=performance.now(); const e=document.getElementById('copay'); e.value=String(10+(i%2)); e.dispatchEvent(new Event('input',{bubbles:true})); out.push(performance.now()-t0); await new Promise(r=>setTimeout(r,40)); } return out.sort((a,b)=>a-b)[3];`);
    await send('Emulation.setCPUThrottlingRate', { rate: 1 });
    ok(keys < 250, `a keystroke in Settlement with a 500-line bill on a 4x slower CPU takes ${Math.round(keys)} ms (it was about 500-900 ms)`);

    console.log('== R21: co-pay not entered');
    await fresh(); await ev(`setLang('en'); for(const [id,v] of [['total','120000'],['counter','18500'],['discount',''],['copay','']]){ const e=document.getElementById(id); e.value=v; e.dispatchEvent(new Event('input',{bubbles:true})); }`); await sleep(150);
    const cp = await ev(`return {unk: settleOk() && settleOk().copayUnknown, sub: document.getElementById('mysterySub').textContent, rc: document.getElementById('rCopay').textContent, ded: document.getElementById('rDed').textContent, note: document.getElementById('settleModelNote').textContent, chip: document.getElementById('copayNotSure').classList.contains('on')}`);
    ok(cp.unk === true && /haven't entered a co-pay/.test(cp.sub) && /up to ₹18,500/.test(cp.sub) && cp.rc === 'not entered' && cp.chip && cp.ded === 'up to ₹18,500' && /may include your co-pay/.test(cp.note), 'a blank co-pay is "not entered": up to ₹18,500 not explained, part of it may be co-pay; "Not sure" is shown as chosen (it used to count as 0): ' + cp.sub.slice(0, 90));
    await ev(`document.querySelector('#copayChips .chip[data-v="10"]').click();`); await sleep(100);
    ok(await ev(`return settleOk().copayUnknown===false && !document.getElementById('copayNotSure').classList.contains('on')`), 'choosing 10% makes it known again');
    await ev(`document.getElementById('copayNotSure').click();`); await sleep(100);
    ok(await ev(`return document.getElementById('copay').value==='' && settleOk().copayUnknown===true`), '"Not sure" clears the co-pay field');

    console.log('== R21: a letter from the settlement figures alone');
    const lt21 = await ev(`switchTab('letter'); const vis=!document.getElementById('letterConfirm').classList.contains('hide'); const rows=[...document.querySelectorAll('#letterIncludes [data-inc]')].map(x=>x.dataset.inc).join(',');
      const note=/No itemised bill checked yet/.test(document.getElementById('letterIncludes').innerText);
      document.getElementById('genLetterTab').click(); await new Promise(r=>setTimeout(r,300)); return {vis, rows, note, text: document.querySelector('.letter') ? document.querySelector('.letter').innerText : ''};`);
    ok(lt21.vis && lt21.rows === 'settlement' && lt21.note, 'with settlement figures and no bill, the Letter tab offers a letter (it used to be a dead end), with a note that no bill was checked');
    ok(/Paid at discharge\s+₹18,500/.test(lt21.text) && /I do not know how much of the ₹18,500 I paid was co-payment under my policy\. Please show how much of it was co-payment and how much was deducted, line by line\./.test(lt21.text) && /para 17\(b\)/.test(lt21.text), 'the letter asks the insurer to split co-pay from deduction, and cites para 17(b)');
    ok(!/of which co-pay|that I calculate as non-payable|List I/.test(lt21.text), 'it never calls the whole payment "non-payable", and has no bill paragraphs');
    await ev(`switchTab('mybills'); document.getElementById('saveLocalBtn').click();`); await sleep(200);
    ok(await ev(`return readLocalChecks().length===1 && readLocalChecks()[0].extraction.line_items.length===0`), 'a figures-only check can be saved on this device');
    await ev(`openLocalCheck(readLocalChecks()[0]); switchTab('letter');`); await sleep(300);
    ok(await ev(`return !document.getElementById('letterConfirm').classList.contains('hide') && document.getElementById('total').value==='120000' && !window.__lastExtraction`), '... and reopened, with the letter still available');
    await ev(`localStorage.clear(); for(const id of ['total','counter','copay']){ const e=document.getElementById(id); e.value=''; e.dispatchEvent(new Event('input',{bubbles:true})); } switchTab('letter');`); await sleep(150);
    ok(await ev(`return !document.getElementById('letterEmpty').classList.contains('hide') && /Enter your settlement figures, or check your itemised bill/.test(document.getElementById('letterEmpty').textContent)`), 'with neither figures nor a bill, it says what to do');

    console.log('== R21: rows to check against the paper bill');
    await fresh(); await ev(`setLang('en'); document.getElementById('egBtn').click();`); await sleep(500);
    const rc = await ev(`switchTab('findings'); const d=document.getElementById('readChecks'); return d ? {sum: d.querySelector('summary').textContent, body: d.textContent, open: d.open} : null;`);
    ok(rc && /Check 1 row against your paper bill/.test(rc.sum) && /RL 500ML/.test(rc.body) && /1 × ₹63\.27 = ₹63\.27, but the amount reads ₹53\.27/.test(rc.body) && !rc.open, 'the worked example lists exactly one row to check, the one behind the ₹10 gap, folded: ' + (rc && rc.sum));
    ok(/never put in the letter/.test(rc.body) && !/amount reads/.test(await ev(`switchTab('letter'); document.getElementById('genLetterTab').click(); await new Promise(r=>setTimeout(r,300)); return document.querySelector('.letter').innerText`)), 'it says these are reading checks and never go in the letter, and they don\'t');

    console.log('== R21: Ombudsman dates');
    const dm = await ev(`return [addMonthsYmd('2027-01-31',1), addMonthsYmd('2028-01-31',1), addMonthsYmd('2026-12-31',1), addDaysYmd('2026-12-25',14), JSON.stringify(ombDates('2026-10-09')), JSON.stringify(ombDates('2027-01-31'))].join(' | ')`);
    ok(dm === '2027-02-28 | 2028-02-29 | 2027-01-31 | 2027-01-08 | {"reply":"2026-10-23","opens":"2026-11-09","deadline":"2027-11-09"} | {"reply":"2027-02-14","opens":"2027-02-28","deadline":"2028-02-28"}', 'calendar months clamp to the month\'s end (31 Jan + 1 month = 28 Feb, or 29 Feb in a leap year), across a year end too: ' + dm);
    const as21 = await ev(`return document.querySelector('.aftersend').innerText`);
    ok(/If you send it today \(/.test(as21) && /a reply is due around/.test(as21) && /a month has passed after the insurer receives your letter: about .* if you email it today, a little later by post/.test(as21) && /counts from one month after the day you send it/.test(as21) && /rule 14\(3\)/.test(as21) && /the year counts from its reply/.test(as21), 'after the letter: the dates if you send it today, each with its rule');
    await ev(`switchTab('mybills'); document.getElementById('saveLocalBtn').click();`); await sleep(200);
    const sd = await ev(`const i=document.querySelector('#localList .bsentin'); i.value='2026-10-01'; i.dispatchEvent(new Event('change',{bubbles:true})); return document.querySelector('#localList .bdates').textContent;`);
    ok(/Reply due around 15 October 2026\. No reply: the Ombudsman route opens a month after the insurer receives your letter \(about 1 November 2026 if emailed\), until 1 November 2027\./.test(sd), 'a saved check with a "sent on" date shows its own dates: ' + sd);

    console.log('== R22: the first screen');
    await fresh(); await send('Page.navigate', { url: `http://127.0.0.1:${port}/` }); await sleep(1200); await ev(`setLang('en');`);
    ok(await ev(`return !document.getElementById('beforeStart').classList.contains('hide') && /final bill, and its itemised/.test(document.getElementById('beforeStart').innerText)`), 'an empty screen starts with "Before you start": the three papers to have');
    await ev(`const e=document.getElementById('total'); e.value='5000'; e.dispatchEvent(new Event('input',{bubbles:true}));`); await sleep(100);
    ok(await ev(`return document.getElementById('beforeStart').classList.contains('hide')`), 'it steps aside as soon as you type a figure');
    await ev(`const e=document.getElementById('total'); e.value=''; e.dispatchEvent(new Event('input',{bubbles:true}));`); await sleep(100);
    await ev(`document.getElementById('bysExampleBtn').click();`); await sleep(500);
    ok(await ev(`return _usingWorkedExample && document.getElementById('total').value==='41396'`), '"See the worked example" from the first screen loads it');
    await fresh(); await send('Page.navigate', { url: `http://127.0.0.1:${port}/#example` }); await sleep(1500);
    ok(await ev(`return _usingWorkedExample && document.getElementById('page-findings').classList.contains('on') && !!document.querySelector('#report .checks')`), 'a link ending in #example opens the worked example straight on Findings');

    console.log('== R22: how we know, and something wrong?');
    await fresh(); await ev(`setLang('en'); switchTab('about');`); await sleep(150);
    const hk = await ev(`return {items: document.querySelectorAll('#howList li').length, text: document.getElementById('howKnow').innerText, gh: document.getElementById('fbGithub').href, em: document.getElementById('fbEmail').href, gc: document.querySelector('details.gcdet').open}`);
    ok(hk.items === 5 && /^How we know/i.test(hk.text) && /25 September 2026/.test(hk.text) && /29 May 2024/.test(hk.text) && /not independently re-confirmed/.test(hk.text) && /rule 14/.test(hk.text), 'About lists each source, when it was checked, and how far to trust it');
    ok(/tested on one real bill/.test(hk.text) && /machine translations/.test(hk.text) && /not legal advice/.test(hk.text) && /github\.com\/Aaryap1\/ClearBill/.test(hk.text), 'and its limits, plainly, and who made it');
    ok(hk.gh.startsWith('https://github.com/Aaryap1/ClearBill/issues/new?title=') && hk.em.startsWith('mailto:aaryap2024@gmail.com?subject='), '"Something wrong?" opens a pre-filled GitHub issue or email');
    await ev(`document.getElementById('egBtn').click();`); await sleep(400);
    const fbAfter = await ev(`return decodeURIComponent(document.getElementById('fbGithub').href+' '+document.getElementById('fbEmail').href)`);
    ok(!/5,?962|41,?396|RL 500ML|GLOVES|BED CHARGES/i.test(fbAfter), 'nothing from the bill on screen is ever put in the report link');
    ok(hk.gc === false, 'the Google Cloud list is folded away under "Built on Google Cloud"');

    console.log('== R22: Hindi and Marathi say they are machine-translated');
    await fresh(); await ev(`setLang('hi');`); await sleep(150);
    ok(await ev(`return !document.getElementById('langNote').classList.contains('hide') && /मशीन से अनुवादित/.test(document.getElementById('langNote').textContent)`), 'in Hindi, a note says the text is machine-translated and not yet reviewed');
    await ev(`document.getElementById('langNoteOk').click();`); await sleep(100);
    ok(await ev(`return document.getElementById('langNote').classList.contains('hide')`), 'it can be dismissed');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` }); await sleep(1200);
    ok(await ev(`setLang('hi'); return document.getElementById('langNote').classList.contains('hide')`), '... and stays dismissed on this device');
    ok(await ev(`setLang('mr'); return !document.getElementById('langNote').classList.contains('hide') && /मशीनने अनुवादित/.test(document.getElementById('langNote').textContent)`), 'Marathi has its own note');
    ok(await ev(`setLang('en'); return document.getElementById('langNote').classList.contains('hide')`), 'English shows no such note');

    console.log('== R23: correct a misread row against the paper bill');
    await fresh(); await ev(`setLang('en'); document.getElementById('egBtn').click();`); await sleep(500);
    await ev(`switchTab('findings'); document.getElementById('readChecks').open=true; document.querySelector('#readChecks .rcfix').click();`); await sleep(100);
    const f23 = await ev(`const t=document.activeElement; return {id: t.id, val: t.value, label: document.querySelector('label[for="'+t.id+'"]').textContent, hint: document.querySelector('.rcform').textContent, exp: document.querySelector('#readChecks .rcfix').getAttribute('aria-expanded')}`);
    ok(/^rc_t_\d+$/.test(f23.id) && f23.val === '53.27' && f23.label === 'Amount (₹)' && f23.exp === 'true', '"Correct this row" opens a small labelled form on that row, with the amount as read, and moves to it');
    ok(/Change it only if your paper bill shows something different/.test(f23.hint) && /leave it as printed/.test(f23.hint), 'it says to change a figure only if the paper differs, and to leave a misprint as printed');
    await ev(`document.activeElement.value='abc'; document.querySelector('.rcsave').click();`); await sleep(100);
    ok(await ev(`const e=document.querySelector('.rcerr'); return !e.classList.contains('hide') && /as a number/.test(e.textContent) && !window.__lastExtraction._edits`), 'an amount that is not a number is refused with a message, and nothing changes');
    await ev(`document.querySelector('.rcform input[id^="rc_t_"]').value='63.27'; document.querySelector('.rcsave').click();`); await sleep(300);
    const c23 = await ev(`const d=document.getElementById('readChecks'); return {open: d.open, sum: d.querySelector('summary').textContent, body: d.textContent, focus: document.activeElement===d.querySelector('summary'), live: document.getElementById('srLive').textContent, starts: document.querySelector('.starthere').textContent, ex: WORKED_EXAMPLE_BILL.line_items.find(l=>/RL 500ML/.test(l.item)).total, kpis: [...document.querySelectorAll('.kpi .v')].map(e=>e.textContent).join('|')}`);
    ok(c23.open && /You corrected 1 row/.test(c23.sum) && /Your corrections \(1\)/.test(c23.body) && /read as 1 × ₹63\.27 = ₹53\.27, corrected to 1 × ₹63\.27 = ₹63\.27/.test(c23.body), 'after saving, the panel stays open and lists the correction, before and after: ' + c23.sum);
    ok(c23.focus && /Row corrected\. The checks have run again\./.test(c23.live), 'focus returns to the panel and a screen reader hears that the checks ran again');
    ok(!/does not match/i.test(c23.starts) && !/₹10/.test(c23.starts) && c23.kpis === '₹5,962.89|8%|6 / 6', 'the checks run on the corrected row: the ₹10 total gap is gone, the rest is unchanged: ' + c23.kpis);
    ok(c23.ex === 53.27 || c23.ex === '53.27', 'the worked example itself is never changed (a corrected copy is used)');
    await ev(`switchTab('letter'); document.getElementById('genLetterTab').click();`); await sleep(300);
    ok(await ev(`const h=document.getElementById('hospNoteText'); return !h || !/differs from the sum/.test(h.textContent)`), 'the hospital note no longer asks about a total gap that was only a misreading');
    await ev(`switchTab('findings'); document.querySelector('#readChecks .rcundo').click();`); await sleep(300);
    const u23 = await ev(`const d=document.getElementById('readChecks'); return {sum: d.querySelector('summary').textContent, edits: !!window.__lastExtraction._edits, live: document.getElementById('srLive').textContent, starts: document.querySelector('.starthere').textContent}`);
    ok(/Check 1 row against your paper bill/.test(u23.sum) && !u23.edits && /Correction undone/.test(u23.live) && /₹10/.test(u23.starts), 'Undo puts the row back as read, and the ₹10 gap returns');

    console.log('== R23: leave out a carried-forward total; saved and reopened');
    await fresh(); await ev(`setLang('en'); window.__lastExtraction={header:{},line_items:[{item:'ROOM RENT',quantity:2,rate:3000,total:6000},{item:'BALANCE BROUGHT FORWARD',quantity:null,rate:null,total:6000},{item:'PHARMACY',quantity:1,rate:900,total:900}]}; calc(); switchTab('findings');`); await sleep(300);
    ok(await ev(`return !!document.querySelector('#readChecks .rcdrop') && document.querySelectorAll('#readChecks .rcdrop').length===1`), '"Leave it out" is offered only for a carried-forward total');
    await ev(`document.querySelector('#readChecks .rcdrop').click();`); await sleep(300);
    const d23 = await ev(`return {n: window.__lastExtraction.line_items.length, orig: window.__lastExtraction._orig.length, body: document.getElementById('readChecks').textContent}`);
    ok(d23.n === 2 && d23.orig === 3 && /BALANCE BROUGHT FORWARD/.test(d23.body) && /left out: not a charge/.test(d23.body), 'the row is left out of the checks and listed as "left out", with the reading kept');
    await ev(`switchTab('mybills'); document.getElementById('saveLocalBtn').click();`); await sleep(200);
    await ev(`window.__lastExtraction=null; calc(); document.querySelector('#localList .lopen').click();`); await sleep(500);
    ok(await ev(`return window.__lastExtraction.line_items.length===2 && /You corrected 1 row/.test(document.querySelector('#readChecks summary').textContent)`), 'a check saved on this device keeps its corrections when reopened');
    await ev(`document.getElementById('readChecks').open=true; document.querySelector('#readChecks .rcundo').click();`); await sleep(300);
    ok(await ev(`return window.__lastExtraction.line_items.length===3 && window.__lastExtraction.line_items[1].item==='BALANCE BROUGHT FORWARD' && !window.__lastExtraction._orig`), 'Undo puts the left-out row back in its place');
    await ev(`window.__lastExtraction={header:{},line_items:[{item:'X',total:5}],_orig:[{item:'<img src=x onerror="window.__xss23=1">',total:5}],_edits:{'0':{total:'<b>bad</b>',quantity:'<i>'},'7':{drop:true},'__proto__':{drop:true}}}; calc(); switchTab('findings'); document.getElementById('readChecks').open=true;`); await sleep(300);
    ok(await ev(`return !document.querySelector('#readChecks img') && !window.__xss23 && !document.querySelector('#readChecks b, #readChecks i') && /You corrected 1 row/.test(document.querySelector('#readChecks summary').textContent)`), 'corrections from a file are re-checked: text shown as text, out-of-range rows ignored, values read as numbers only');

    console.log('== R24: no reply from the insurer: reminder, then the Ombudsman');
    await fresh(); await ev(`setLang('en'); document.getElementById('egBtn').click();`); await sleep(500);
    await ev(`switchTab('letter');`); await sleep(150);
    ok(await ev(`const c=document.getElementById('replyCard'); return !c.classList.contains('hide') && !c.open && /The insurer replied, or hasn't/.test(c.querySelector('summary').textContent)`), 'the Letter tab has a folded "The insurer replied, or hasn\'t" card once there is a check');
    await ev(`const c=document.getElementById('replyCard'); c.open=true; const s=document.getElementById('rp_sent'); s.value=addDaysYmd(todayYmd(),-5); s.dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('rpNoBtn').click();`); await sleep(150);
    const nr1 = await ev(`return {t: document.getElementById('rpResult').textContent, complaintBtn: !!document.querySelector('#rpResult [data-rpact="complaint"]'), pressed: document.getElementById('rpNoBtn').getAttribute('aria-pressed')}`);
    ok(nr1.pressed === 'true' && /A reply is due around .* If none comes, you can go to the Insurance Ombudsman once a month has passed after the insurer receives your letter: about/.test(nr1.t) && !nr1.complaintBtn, 'sent 5 days ago: it gives the reply date and when the Ombudsman route opens, and offers no complaint yet');
    await ev(`const s=document.getElementById('rp_sent'); s.value=addDaysYmd(todayYmd(),-40); s.dispatchEvent(new Event('input',{bubbles:true}));`); await sleep(150);
    const nr2 = await ev(`return {t: document.getElementById('rpResult').textContent, dl: fmtYmd(ombDates(addDaysYmd(todayYmd(),-40)).deadline)}`);
    ok(nr2.t.includes('More than a month has passed with no reply. You can take this to the Insurance Ombudsman until ' + nr2.dl), 'sent 40 days ago: the Ombudsman route is open, with its last day (rule 14(3)): ' + nr2.dl);
    await ev(`document.querySelector('#rpResult [data-rpact="follow"]').click();`); await sleep(200);
    const rem = await ev(`return document.getElementById('rpFollowText').textContent`);
    ok(/Subject: Reminder: request for a line-by-line explanation of deductions/.test(rem) && /I have not received a reply/.test(rem) && /"should provide resolution to the complaint within 14 days"/.test(rem) && !/[\[\]]|undefined|null/.test(rem), 'the reminder says no reply came, quotes the 14 days, and has no blanks');
    await ev(`document.querySelector('#rpResult [data-rpact="complaint"]').click();`); await sleep(200);
    const c0 = await ev(`return {box: !document.getElementById('rpComplaintBox').classList.contains('hide'), follow: document.getElementById('rpFollowBox').classList.contains('hide'), amt: document.getElementById('rp_amount').value, out: document.getElementById('rpCOut').textContent, draft: !!document.getElementById('rpComplaintText'), note: document.getElementById('rpAmountNote').textContent}`);
    ok(c0.box && c0.follow && c0.amt === '5962.89' && /₹5,962\.89 not itemised/.test(c0.note), 'the complaint form opens with the amount not itemised filled in (₹5,962.89), and says where it came from');
    ok(!c0.draft && /Tick the box above .*\(rule 14\(5\)\)/.test(c0.out), 'no complaint is drafted until the user confirms the matter is not before a court, consumer commission or arbitrator (rule 14(5))');
    await ev(`const b=document.getElementById('rp_court'); b.checked=true; b.dispatchEvent(new Event('change',{bubbles:true}));`); await sleep(150);
    let ct = await ev(`return {t: document.getElementById('rpComplaintText').textContent, out: document.getElementById('rpCOut').textContent}`);
    ok(/Subject: Complaint under rule 14 of the Insurance Ombudsman Rules, 2017/.test(ct.t) && /I sent my letter on \d+ \w+ \d{4} and have not received a reply; more than one month has passed since then\./.test(ct.t) && /within one year after one month from the date I sent it \(rule 14\(3\)\(b\)\(iii\)\)/.test(ct.t) && /not pending before, and has not been decided by, any court, consumer forum or arbitrator \(rule 14\(5\)\)/.test(ct.t), 'the complaint states the no-reply route and both time limits only because the dates show them, and the rule 14(5) declaration');
    ok(/Nature and extent of the loss\n   ₹5,962\.89, deducted from my claim/.test(ct.t) && /direct the insurer to pay ₹5,962\.89, with interest as provided in rule 17\(7\)/.test(ct.t) && /Documents attached/.test(ct.t) && /The hospital's final bill and itemised bill/.test(ct.t), 'it has the parts rule 14(2) asks for: facts, documents, the loss and the relief sought');
    ok(/Add these before you file: your name, your address, the insurer's name, the policy number, the insurer's branch or office, your state/.test(ct.out) && !/[\[\]]|undefined|null/.test(ct.t), 'missing details are listed on screen, never left as blanks in the text');
    const st1 = await ev(`return INDIA_STATES.find(s=>ombudsmanFor(s).length===1)`);
    await ev(`for(const [id,v] of [['ld_name','Asha Rao'],['ld_address','12 Lake Road'],['ld_insurer','Star Health and Allied'],['ld_policy','P-991']]){ const e=document.getElementById(id); e.value=v; e.dispatchEvent(new Event('input',{bubbles:true})); }
      const st=document.getElementById('ld_state'); st.value=${JSON.stringify(st1)}; st.dispatchEvent(new Event('input',{bubbles:true}));
      const br=document.getElementById('rp_branch'); br.value='Pune branch'; br.dispatchEvent(new Event('input',{bubbles:true}));`); await sleep(200);
    ct = await ev(`const o=ombudsmanFor(${JSON.stringify(st1)})[0]; return {t: document.getElementById('rpComplaintText').textContent, out: document.getElementById('rpCOut').textContent, office: o.office, email: o.email}`);
    ok(new RegExp('To: The Insurance Ombudsman, ' + ct.office).test(ct.t) && ct.t.includes(ct.email) && /Star Health and Allied, Pune branch\n   Policy no\. P-991/.test(ct.t) && /^Asha Rao\n12 Lake Road/.test(ct.t) && !/Add these before you file/.test(ct.out), 'typing the details completes it: addressed to the state\'s office, insurer with branch, no list of missing details: ' + ct.office);
    ok(/cioins\.co\.in/.test(ct.out) && /Free\./.test(ct.out) && /not legal advice/.test(ct.out), 'it says where to file (free, online or by email or post) and that it is a draft, not legal advice');
    await ev(`const a=document.getElementById('rp_amount'); a.value='6000000'; a.dispatchEvent(new Event('input',{bubbles:true}));`); await sleep(100);
    ok(/up to ₹50 lakh \(IRDAI's policyholder circular, Part B, VI\.3\(i\)\), and cannot award more than that \(rule 17\(3\)\)/.test(await ev(`return document.getElementById('rpCOut').textContent`)), 'above ₹50 lakh it warns that the Ombudsman cannot award that much');

    console.log('== R24: the insurer replied: check it, follow up');
    await ev(`document.getElementById('rpYesBtn').click(); document.getElementById('rpCheckBtn').click();`); await sleep(150);
    ok(await ev(`return document.getElementById('rpComplaintBox').classList.contains('hide') && /Paste the reply, or read a photo of it, first\./.test(document.getElementById('rpResult').textContent)`), 'checking an empty reply asks for the reply first, and closes the drafts');
    await ev(`const t=document.getElementById('rp_text'); t.value='Dear Sir, with reference to your complaint, we regret to inform you that the deduction of Rs. 5,962/- stands valid as per policy terms and conditions. Thanking you.';
      const d=document.getElementById('rp_date'); d.value=addDaysYmd(todayYmd(),-20); const r=document.getElementById('rp_ref'); r.value='GRV-77'; document.getElementById('rpCheckBtn').click();`); await sleep(200);
    const ck = await ev(`return {boxes: [...document.querySelectorAll('#rpChecks input[data-rpk]')].map(b=>b.dataset.rpk+':'+b.checked).join(','), t: document.getElementById('rpResult').textContent, focus: document.activeElement===document.querySelector('#rpChecks legend'), acts: [...document.querySelectorAll('#rpActs [data-rpact]')].map(b=>b.dataset.rpact).join(',')}`);
    ok(ck.boxes === 'reasons:false,breakdown:false,omb:false' && /Not found: the reply names no clause, section or exclusion/.test(ck.t) && /"As per policy terms" alone is not a specific reference/.test(ck.t), 'a vague reply: none of the three is found, and "as per policy terms" is explained as not specific');
    ok(/The reply says: “.*we regret to inform you/.test(ck.t) && /The reply is dated 20 days after you sent your letter\. IRDAI's circular says insurers should resolve a complaint within 14 days\./.test(ck.t) && ck.focus, 'it quotes what the reply decided, gives the days it took against the 14 days (no accusation), and moves focus to the checklist');
    ok(ck.acts === 'follow,complaint', 'with gaps, both a follow-up and a complaint are offered');
    await ev(`document.querySelector('#rpActs [data-rpact="follow"]').click();`); await sleep(150);
    const fu = await ev(`return document.getElementById('rpFollowText').textContent`);
    ok(/Subject: Follow-up: request for a line-by-line explanation of deductions \(your reference GRV-77\)/.test(fu) && /  1\. The reasons for not accepting my request/.test(fu) && /  2\. A line-by-line statement/.test(fu) && /  3\. The name and address of the Insurance Ombudsman/.test(fu), 'the follow-up asks for exactly the three missing things, with the reply\'s reference');
    ok(/"along with the reasons for not accepting the complaint with specific reference to the relevant terms and conditions of the policy"/.test(fu) && /"shall also be provided in the resolution letter given by the insurer"/.test(fu) && /para 17\(b\)/.test(fu), 'each is quoted from IRDAI\'s circulars (Part B; para 17(b))');
    await ev(`const b=document.querySelector('#rpChecks input[data-rpk="omb"]'); b.checked=true; b.dispatchEvent(new Event('change',{bubbles:true})); const d=document.getElementById('rpDocs'); d.checked=true; d.dispatchEvent(new Event('change',{bubbles:true}));`); await sleep(150);
    const fu2 = await ev(`return document.getElementById('rpFollowText').textContent`);
    ok(!/Insurance Ombudsman of competent jurisdiction/.test(fu2) && /para 17\(c\)\) provides that insurers and TPAs "shall collect the required documents from the Hospitals"/.test(fu2), 'ticking an item takes it out of the follow-up at once; "asks me to get documents" adds para 17(c)');
    await ev(`const t=document.getElementById('rp_text'); t.value='As per Clause 4.2 and Code-Excl01 of your policy, items under List I are not payable. Break-up of deductions: Rs 300, Rs 160, Rs. 1,260, INR 850. You may approach the Insurance Ombudsman.'; document.getElementById('rpCheckBtn').click();`); await sleep(150);
    const ck2 = await ev(`return {boxes: [...document.querySelectorAll('#rpChecks input[data-rpk]')].map(b=>b.dataset.rpk+':'+b.checked).join(','), t: document.getElementById('rpResult').textContent, follow: document.getElementById('rpFollowBox').classList.contains('hide')}`);
    ok(ck2.boxes === 'reasons:true,breakdown:true,omb:true' && /Found: “As per Clause 4\.2/.test(ck2.t) && /Break-up of deductions/.test(ck2.t) && /A law or an IRDAI circular is not/.test(ck2.t) && ck2.follow, 'a full reply: all three found and quoted, with "is this a term of your policy?" (a new check closes the old draft)');
    await ev(`document.querySelector('#rpResult [data-rpo="pay"]').click();`); await sleep(100);
    ok(await ev(`return document.querySelector('#rpResult [data-rpo="pay"]').getAttribute('aria-pressed')==='true' && /Keep the reply\. If the payment does not arrive/.test(document.getElementById('rpActs').textContent) && !document.querySelector('#rpActs [data-rpact]')`), '"It will pay more" with everything answered: keep the reply, nothing to draft');
    await ev(`document.querySelector('#rpResult [data-rpo="keep"]').click(); document.querySelector('#rpActs [data-rpact="complaint"]').click();`); await sleep(150);
    ct = await ev(`return document.getElementById('rpComplaintText').textContent`);
    ok(/The insurer replied on .* \(reference GRV-77\) and did not withdraw the deduction\./.test(ct) && /within one year of the insurer's reply \(rule 14\(3\)\(b\)\)/.test(ct) && /The insurer's reply dated/.test(ct) && !/The reply does not/.test(ct), 'a complaint after a reply: the reply\'s date and reference, the one-year rule from the reply, the reply among the documents');

    console.log('== R24: a photo of the reply');
    await ev(`document.getElementById('rp_text').value=''; document.getElementById('rp_ref').value=''; document.getElementById('rp_date').value=''; rpReadPhotos([__mk('r1.jpg','image/jpeg',91), __mk('r2.jpg','image/jpeg',92)]);`); await sleep(700);
    const ph = await ev(`return {text: document.getElementById('rp_text').value, ref: document.getElementById('rp_ref').value, date: document.getElementById('rp_date').value, st: document.getElementById('rpReadStatus').textContent, calls: window.__replyCalls}`);
    ok(ph.calls === 2 && /We regret that the deduction/.test(ph.text) && ph.ref === 'GRV-88' && ph.date === '2026-10-02', 'a photo is read through api/read-reply: its text, reference and date (2 October 2026) are filled in for the user to check');
    ok(/Read 1 photo\. Check the text against the letter/.test(ph.st) && /1 photo did not look like a letter from an insurer and was left out/.test(ph.st), 'a photo that is not an insurer\'s letter is left out, and the status says so');
    ok(await ev(`return rpDate('05/06/2026')===null && rpDate('15/06/2026')==='2026-06-15' && rpDate('June 5, 2026')==='2026-06-05' && rpDate('5th Jun 2026')==='2026-06-05' && rpDate('2099-01-01')===null`), 'a printed date is used only when it cannot be misread (05/06 could be May or June) and is not in the future');
    await ev(`window.__mode='broken'; document.getElementById('rp_text').value=''; rpReadPhotos([__mk('r3.jpg','image/jpeg',93)]);`); await sleep(500);
    ok(/The free reading service is busy\. Paste the text instead/.test(await ev(`return document.getElementById('rpReadStatus').textContent`)), 'when the free reader is busy or broken, it says to paste the text (or use one\'s own key)');

    console.log('== R25: the reply work is kept with a check saved on this device');
    await fresh(); await ev(`setLang('en'); document.getElementById('egBtn').click();`); await sleep(500);
    await ev(`switchTab('letter'); document.getElementById('replyCard').open=true; const s=document.getElementById('rp_sent'); s.value=addDaysYmd(todayYmd(),-40); s.dispatchEvent(new Event('input',{bubbles:true}));`);
    ok(await ev(`return document.getElementById('rpSaveRow').classList.contains('hide')`), 'no save button until the card is in use');
    await ev(`document.getElementById('rpYesBtn').click(); document.getElementById('rp_text').value='Dear Sir, we regret that the deduction of Rs. 5,962/- stands as per policy terms and conditions.'; document.getElementById('rp_date').value=addDaysYmd(todayYmd(),-20); document.getElementById('rp_ref').value='GRV-5';
      document.getElementById('rpCheckBtn').click(); await new Promise(r=>setTimeout(r,150));
      document.querySelector('#rpResult [data-rpo="keep"]').click(); document.querySelector('#rpActs [data-rpact="complaint"]').click();
      const b=document.getElementById('rp_branch'); b.value='Pune branch'; b.dispatchEvent(new Event('input',{bubbles:true})); const k=document.getElementById('rp_court'); k.checked=true; k.dispatchEvent(new Event('change',{bubbles:true}));
      document.getElementById('rpSaveBtn').click();`); await sleep(200);
    const sv = await ev(`const l=readLocalChecks(); return {n: l.length, msg: document.getElementById('rpSaveMsg').textContent, r: l[0]&&l[0].reply, sentOn: l[0]&&l[0].sentOn, want: addDaysYmd(todayYmd(),-40)}`);
    ok(sv.n === 1 && /Saved on this device as a new check, with your reply work/.test(sv.msg) && sv.r.status === 'yes' && /we regret/.test(sv.r.text) && sv.r.ref === 'GRV-5' && sv.r.outcome === 'keep' && sv.r.branch === 'Pune branch' && sv.r.court === true && sv.r.checked === true && sv.sentOn === sv.want, 'with no check open, "Save on this device" saves a new check with the reply, the decision, the complaint details and the sent-on date');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` }); await sleep(1200);
    ok(await ev(`return document.getElementById('rp_text').value==='' && !RP.status`), 'after a reload the card starts empty');
    await ev(`switchTab('mybills'); document.querySelector('#localList .lopen').click();`); await sleep(600);
    const rs25 = await ev(`switchTab('letter'); return {open: document.getElementById('replyCard').open, text: document.getElementById('rp_text').value, sent: document.getElementById('rp_sent').value, ref: document.getElementById('rp_ref').value, keep: document.querySelector('#rpResult [data-rpo="keep"]').getAttribute('aria-pressed'), boxes: [...document.querySelectorAll('#rpChecks input[data-rpk]')].map(b=>b.checked).join(','), branch: document.getElementById('rp_branch').value, court: document.getElementById('rp_court').checked, yes: document.getElementById('rpYesBtn').getAttribute('aria-pressed')}`);
    ok(rs25.open && /we regret/.test(rs25.text) && rs25.ref === 'GRV-5' && rs25.yes === 'true' && rs25.keep === 'true' && rs25.boxes === 'false,false,false' && rs25.branch === 'Pune branch' && rs25.court, 'opening the saved check brings the reply card back as it was: open, the reply, its checklist, the decision and the complaint details');
    await ev(`const b=document.querySelector('#rpChecks input[data-rpk="omb"]'); b.checked=true; b.dispatchEvent(new Event('change',{bubbles:true})); document.getElementById('rpSaveBtn').click();`); await sleep(200);
    const up = await ev(`const l=readLocalChecks(); return {n: l.length, omb: l[0].reply.ans.omb, msg: document.getElementById('rpSaveMsg').textContent}`);
    ok(up.n === 1 && up.omb === true && /Saved with the check you opened/.test(up.msg), 'saving again updates the check that was opened, instead of adding another');
    await ev(`switchTab('settlement'); document.getElementById('clearSavedBtn').click(); document.getElementById('clearYesBtn').click();`); await sleep(200);
    ok(await ev(`return !RP.status && document.getElementById('rp_text').value==='' && document.getElementById('rp_branch').value==='' && readLocalChecks().length===0`), '"Clear what this app saved" clears the reply card too');
    const bad25 = JSON.stringify({ v: 1, extraction: { line_items: [{ item: 'X', total: 5 }] }, reply: { status: 'yes', text: '<img src=x onerror="window.__x25=1"> we regret', checked: true, ans: { reasons: 'yes', omb: true }, outcome: 'evil', sent: '2099-01-01', date: 'not a date', branch: 123, court: 'true' } });
    ok(await ev(`return importLocalCheckText(${JSON.stringify(bad25)})`) === 'ok', 'a file with odd reply fields is still opened (the bill is fine)');
    await ev(`switchTab('mybills'); renderLocalList(); document.querySelector('#localList .lopen').click();`); await sleep(500);
    const im = await ev(`return {x: !!window.__x25 || !!document.querySelector('#replyCard img'), out: RP.outcome, reasons: RP.ans.reasons, omb: RP.ans.omb, sent: document.getElementById('rp_sent').value, date: document.getElementById('rp_date').value, branch: document.getElementById('rp_branch').value, court: document.getElementById('rp_court').checked, text: /we regret/.test(document.getElementById('rp_text').value)}`);
    ok(!im.x && im.out === null && im.reasons === false && im.omb === true && im.sent === '' && im.date === '' && im.branch === '' && !im.court && im.text, 'its reply fields are checked again: text stays text, only true/false ticks, known decisions, real past dates');

    console.log('== R26: room rent above the policy limit');
    await fresh(); await ev(`setLang('en'); document.getElementById('egBtn').click();`); await sleep(500);
    const rr0 = await ev(`return {open: document.getElementById('rrDet').open, out: document.getElementById('rrOut').textContent, ph: document.getElementById('rr_rate').placeholder+'/'+document.getElementById('rr_days').placeholder, rows: [...document.querySelectorAll('#letterIncludes input[data-inc]')].map(b=>b.dataset.inc).join(',')}`);
    ok(!rr0.open && /Your bill shows a room at ₹4,500 a day for 1 day\./.test(rr0.out) && rr0.ph === '4500/1' && !/room/.test(rr0.rows), 'folded and optional; with no limit entered it only notes the room on the bill (₹4,500 a day for 1 day), and the letter has no room item');
    await ev(`document.getElementById('rrDet').open=true; const e=document.getElementById('rr_limit'); e.value='3000'; e.dispatchEvent(new Event('input',{bubbles:true}));`); await sleep(200);
    const rr1 = await ev(`return document.getElementById('rrOut').textContent`);
    ok(/Room rent above your limit: ₹1,500 \(₹4,500 a day against ₹3,000, for 1 day\)\. Under a room-rent limit, the insurer usually does not pay this part: check your policy\./.test(rr1) && !/yours to pay/.test(rr1) && /Your policy covers 67% of the room's daily rate/.test(rr1), 'limit ₹3,000: the room rent above the limit (₹1,500) and the share the policy covers (67%)');
    ok(/If your policy's wording follows IRDAI's 2020 norms, that cut could apply only to 10 of your charges .* at most ₹8,770\./.test(rr1) && /Medicines and consumables: ₹/.test(rr1) && /Diagnostics \(tests and scans\): ₹6,265/.test(rr1), 'the most a 2020-norms cut could be (₹8,770, on 10 charges), and what such a wording could not cut');
    ok(/could account for up to ₹5,962\.89 of the ₹5,962\.89 not itemised/.test(rr1) && /withdrawn in May 2024, so whether they apply depends on your policy's wording/.test(rr1), 'it says how much of the unexplained amount these could account for, and that the 2020 norms were withdrawn and depend on the policy wording');
    await ev(`switchTab('letter');`); await sleep(100);
    ok(await ev(`return /Room above your policy's limit: ask for the clause and the charges cut/.test(document.getElementById('letterIncludes').textContent)`), 'the letter checklist gains "Room above your policy\'s limit"');
    await ev(`document.getElementById('genLetterTab').click();`); await sleep(300);
    const rl26 = await ev(`return {l: document.querySelector('.letter').textContent, h: document.getElementById('hospNoteText') ? document.getElementById('hospNoteText').textContent : ''}`);
    ok(/My room was charged at ₹4,500 a day for 1 day, above the room-rent limit of ₹3,000 a day in my policy\.\n/.test(rl26.l) && !/mine to pay|I understand that/.test(rl26.l), 'the letter states the room against the limit, and concedes nothing about the room rent above it (R29)');
    ok(/Schedule-C, para 3\.1\(ix\)\) requires a health insurance policy to state "The sub-limits, Proportionate Deductions and the existence of Package rates if any, with cross reference to the concerned policy section"/.test(rl26.l) && /please state the clause of my policy that provides for it, its definition of 'associated medical expenses', and the charges it was applied to/.test(rl26.l), 'it quotes the 2024 rule word for word and asks for the clause, the definition and the charges');
    ok(/Policies filed under IRDAI's norms on proportionate deductions of 11 June 2020 could not include .* Please confirm whether my policy follows these terms\./.test(rl26.l) && !/(prohibit|not permitted|illegal|IRDAI does not allow)/i.test(rl26.l), 'the 2020 norms are described as what policies filed under them say, and asked about, never claimed as current law');
    ok(/vary with the room category, and which are the same whatever the room/.test(rl26.h), 'the hospital note asks which charges vary with the room category');
    await ev(`switchTab('settlement'); const e=document.getElementById('rr_limit'); e.value='5000'; e.dispatchEvent(new Event('input',{bubbles:true}));`); await sleep(300);
    const rw = await ev(`return {out: document.getElementById('rrOut').textContent, l: document.querySelector('.letter').textContent}`);
    ok(/Your room \(₹4,500 a day\) is within your policy's limit \(₹5,000 a day\)/.test(rw.out) && /within the room-rent limit of ₹5,000 a day in my policy, so no proportionate deduction for the room category should apply/.test(rw.l), 'a room within the limit: the screen says so, and the letter (updated as you type) asks the reason for any proportionate deduction');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` }); await sleep(1200);
    ok(await ev(`return document.getElementById('rr_limit').value==='5000' && document.getElementById('rrDet').open`), 'the limit is kept with the other figures on this device, and the section opens with it');
    await ev(`setLang('hi'); calc();`); await sleep(200);
    ok(await ev(`return /कमरे के किराए की सीमा/.test(document.getElementById('rrHead').textContent) && /अपनी सीमा से मिलाने के लिए कमरे का रोज़ का चार्ज डालें/.test(document.getElementById('rrOut').textContent)`), 'in Hindi (after a reload there is no bill, so it asks for the room rate)');
    await fresh(); await ev(`setLang('en'); for(const [id,v] of [['total','120000'],['counter','18500'],['copay','10'],['rr_limit','4000'],['rr_rate','6000'],['rr_days','3']]){ const e=document.getElementById(id); e.value=v; e.dispatchEvent(new Event('input',{bubbles:true})); }`); await sleep(300);
    const nb26 = await ev(`return document.getElementById('rrOut').textContent`);
    ok(/Room rent above your limit: ₹6,000/.test(nb26) && /With the itemised bill checked, ClearBill can show which charges such a cut could apply to\./.test(nb26), 'with settlement figures only: the room rent above the limit from typed figures, and a note that the bill is needed for the rest');
    await ev(`switchTab('mybills'); document.getElementById('saveLocalBtn').click();`); await sleep(200);
    ok(await ev(`const r=readLocalChecks()[0]; return r.settle.rrLimit==='4000' && r.settle.rrRate==='6000' && r.settle.rrDays==='3'`), 'a check saved on this device keeps the room figures');

    console.log('== R27: still in hospital (time limits for cashless approval)');
    await fresh(); await ev(`setLang('en');`);
    const hsAgo = m => `const d=new Date(Date.now()-${m}*60000), p=x=>String(x).padStart(2,'0'); const e=document.getElementById('hs_when'); e.value=d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes()); e.dispatchEvent(new Event('input',{bubbles:true}));`;
    const h0 = await ev(`const c=document.getElementById('hospCard'); return {exists: !!c, open: c.open, before: !!(c.compareDocumentPosition(document.getElementById('settleMode')) & Node.DOCUMENT_POSITION_FOLLOWING), head: c.querySelector('summary').textContent}`);
    ok(h0.exists && !h0.open && h0.before && /Still in hospital\? Time limits for cashless approval/.test(h0.head), 'a folded "Still in hospital?" card sits above the settlement form');
    await ev(`document.getElementById('hospCard').open=true; document.getElementById('hsAdmitBtn').click();`); await sleep(100);
    ok(await ev(`return !document.getElementById('hsForm').classList.contains('hide') && document.getElementById('hsAdmitBtn').getAttribute('aria-pressed')==='true' && /press Now/.test(document.getElementById('hsOut').textContent)`), 'choosing "Approval to start treatment" asks when the request was sent');
    await ev(hsAgo(30)); await sleep(100);
    const a1 = await ev(`return {out: document.getElementById('hsOut').textContent, msg: document.getElementById('hsMsg').textContent}`);
    ok(/The insurer should decide by .*: within one hour of the request\. (29|30) min left\./.test(a1.out), 'sent 30 minutes ago: the deadline (one hour) and the time left');
    ok(/The hospital sent the request for cashless authorisation at .* on .*\./.test(a1.msg) && /para 15\(b\)\) provides: "Insurer shall decide on the request for cashless authorization immediately but not more than one hour of receipt of request\."/.test(a1.msg) && !/More than an hour/.test(a1.msg) && !/[\[\]]|undefined|null/.test(a1.msg), 'the message gives the time and quotes para 15(b) word for word, with no blanks');
    await ev(hsAgo(125)); await sleep(100);
    const a2 = await ev(`return {out: document.getElementById('hsOut').textContent, msg: document.getElementById('hsMsg').textContent, red: !!document.querySelector('#hsOut .hsover')}`);
    ok(/That time passed 1 h (5|6) min ago\./.test(a2.out) && a2.red && /More than an hour has passed and there is no decision yet\./.test(a2.msg), 'sent over two hours ago: it says the time passed, and the message says so');
    await ev(`document.getElementById('hsDischargeBtn').click();` + hsAgo(200)); await sleep(100);
    const d1 = await ev(`return {out: document.getElementById('hsOut').textContent, msg: document.getElementById('hsMsg').textContent}`);
    ok(/final approval by .*: within three hours of the request\. That time passed (20|21) min ago\./.test(d1.out) && /should be borne by the insurer, not you/.test(d1.out), 'discharge: the three-hour limit, passed, and who should bear charges for the wait');
    ok(/para 16\) provides: "Insurer shall grant final authorization within three hours of the receipt of discharge authorization request from the hospital\. In no case, the policyholder shall be made to wait to be discharged from the Hospital\."/.test(d1.msg) && /"the additional amount if any charged by the hospital shall be borne by the insurer"/.test(d1.msg) && /More than three hours have passed/.test(d1.msg), 'the discharge message quotes para 16 word for word');
    await ev(`for(const [id,v] of [['hs_patient','Asha Rao'],['hs_hospital','City Hospital'],['hs_ref','PA-77']]){ const e=document.getElementById(id); e.value=v; e.dispatchEvent(new Event('input',{bubbles:true})); } document.getElementById('hsDeathBtn').click();`); await sleep(100);
    const hsDt = await ev(`return {hidden: document.getElementById('hsWhenRow').classList.contains('hide'), out: document.getElementById('hsOut').textContent, msg: document.getElementById('hsMsg').textContent}`);
    ok(hsDt.hidden && /must process the claim and have the body released from the hospital immediately/.test(hsDt.out) && /^To: The insurance \(TPA\) desk, City Hospital\nRe: Death of the patient during treatment - ref\. PA-77/.test(hsDt.msg) && /Asha Rao died during treatment at City Hospital\./.test(hsDt.msg) && /para 16\(c\)\) provides that in such a case the insurer shall "immediately process the request for claim settlement" and "get the mortal remains \(dead body\) released from the hospital immediately"/.test(hsDt.msg), 'if the patient has died: no time to enter, and a plain message quoting para 16(c) with the details typed');
    await ev(`document.getElementById('hsAdmitBtn').click(); const d=new Date(Date.now()+60*60000), p=x=>String(x).padStart(2,'0'); const e=document.getElementById('hs_when'); e.value=d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes()); e.dispatchEvent(new Event('input',{bubbles:true}));`); await sleep(100);
    ok(/That time is in the future/.test(await ev(`return document.getElementById('hsOut').textContent`)), 'a time in the future is questioned, not counted');
    await ev(`const s=document.getElementById('hs_ins'); s.value='Star Health and Allied'; s.dispatchEvent(new Event('change',{bubbles:true}));`); await sleep(100);
    ok(await ev(`return /gro@starhealth\\.in/.test(document.getElementById('hsOut').textContent) && document.getElementById('hs_ins').options.length===35`), 'choosing the insurer shows its grievance email from IRDAI\'s list');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/#hospital` }); await sleep(1300);
    const rl27 = await ev(`return {open: document.getElementById('hospCard').open, kind: HS.kind, p: document.getElementById('hs_patient').value, ins: document.getElementById('hs_ins').value}`);
    ok(rl27.open && rl27.kind === 'admit' && rl27.p === 'Asha Rao' && rl27.ins === 'Star Health and Allied', 'a link ending in #hospital opens the card, and what was entered is kept for this browser session');
    await ev(`setLang('hi');`); await sleep(100);
    ok(await ev(`return /कैशलेस मंज़ूरी की समय-सीमा/.test(document.getElementById('hsHead').textContent) && /इलाज शुरू करने की मंज़ूरी/.test(document.getElementById('hsAdmitBtn').textContent)`), 'in Hindi');
    await ev(`setLang('en'); document.getElementById('clearSavedBtn').click(); document.getElementById('clearYesBtn').click();`); await sleep(200);
    ok(await ev(`return !HS.kind && document.getElementById('hs_patient').value==='' && !sessionStorage.getItem('clearbill_hospital')`), '"Clear what this app saved" clears it too');

    console.log('== R28: the whole claim was rejected');
    await fresh(); await ev(`setLang('en');`);
    ok(await ev(`return /The insurer rejected the whole claim/.test(document.getElementById('bysRejectedBtn').textContent)`), 'the first screen has a way in: "The insurer rejected the whole claim" (R30: in "What happened?")');
    await ev(`document.getElementById('bysRejectedBtn').click();`); await sleep(300);
    const r0 = await ev(`return {tab: document.getElementById('page-letter').classList.contains('on'), open: document.getElementById('rejCard').open, empty: !document.getElementById('letterEmpty').classList.contains('hide'), reply: document.getElementById('replyCard').classList.contains('hide')}`);
    ok(r0.tab && r0.open && r0.empty && r0.reply, 'it opens the card on the Letter tab, with no bill or figures needed');
    await ev(`const t=document.getElementById('rj_text'); t.value='Dear Sir, your claim is repudiated due to non-disclosure of pre-existing diabetes under clause 4.1.'; t.dispatchEvent(new Event('input',{bubbles:true}));`); await sleep(150);
    const r1 = await ev(`return {kind: RJ.kind, sug: document.getElementById('rjSuggest').textContent, pressed: document.getElementById('rjRped').getAttribute('aria-pressed'), form: !document.getElementById('rjForm').classList.contains('hide'), out: document.getElementById('rjOut').textContent,
      empty: document.getElementById('letterEmpty').classList.contains('hide'), confirm: !document.getElementById('letterConfirm').classList.contains('hide'), incl: document.getElementById('letterInclCard').classList.contains('hide'), gen: document.getElementById('genLetterTab').classList.contains('hide'), reply: !document.getElementById('replyCard').classList.contains('hide')}`);
    ok(r1.kind === null && /From the letter's words, the reason looks like: "A pre-existing illness, or something not disclosed"\./.test(r1.sug) && /Use this reason/.test(r1.sug) && r1.pressed === 'false' && !r1.form, 'pasting the letter only suggests the reason (pre-existing illness / not disclosed); nothing is chosen for the user (R29)');
    await ev(`document.getElementById('rjUseBtn').click();`); await sleep(150);
    const r1b = await ev(`return {kind: RJ.kind, pressed: document.getElementById('rjRped').getAttribute('aria-pressed'), form: !document.getElementById('rjForm').classList.contains('hide'), out: document.getElementById('rjOut').textContent, sug: document.getElementById('rjSuggest').classList.contains('hide'),
      empty: document.getElementById('letterEmpty').classList.contains('hide'), confirm: !document.getElementById('letterConfirm').classList.contains('hide'), incl: document.getElementById('letterInclCard').classList.contains('hide'), gen: document.getElementById('genLetterTab').classList.contains('hide'), reply: !document.getElementById('replyCard').classList.contains('hide')}`);
    ok(r1b.kind === 'ped' && r1b.pressed === 'true' && r1b.form && r1b.sug, '"Use this reason" chooses it');
    ok(/Enter when your cover began to check the five-year rule\. Your policy schedule must show the date your continuous cover began/.test(r1b.out), 'it asks when the cover began, and says the policy schedule must show that date (Schedule-C 3.1(vii))');
    ok(r1b.empty && r1b.confirm && r1b.incl && r1b.gen && r1b.reply, '"Your details" and the reply card become available; the bill checklist and its Generate button stay hidden');
    await ev(`for(const [id,v] of [['rj_since','2019-04-01'],['rj_date',addDaysYmd(todayYmd(),-12)],['rj_ref','RJ-501'],['rj_amount','120000']]){ const e=document.getElementById(id); e.value=v; e.dispatchEvent(new Event('input',{bubbles:true})); }`); await sleep(150);
    const r2 = await ev(`return {out: document.getElementById('rjOut').textContent, l: document.getElementById('rjLetter').textContent}`);
    ok(/\d+ months of continuous cover\. After 60 months, IRDAI's rules say a claim cannot be contested/.test(r2.out), 'more than 60 months of cover: the five-year rule is explained');
    ok(/"No policy and claim of health insurance shall be contestable on any grounds of non-disclosure and\/or misrepresentation except for established fraud, after the completion of the Moratorium Period, i\.e\. 60 months of continuous coverage"/.test(r2.l) && /whether you allege established fraud\. If you do not, please withdraw the rejection and settle the claim\./.test(r2.l), 'the letter quotes the five-year rule word for word and asks whether established fraud is alleged');
    ok(/Subject: Request to review the rejection of my claim \(your reference RJ-501\)/.test(r2.l) && /My claim was rejected by your letter dated .* on the ground of a pre-existing disease or non-disclosure\. I ask you to review this decision\. I attach a copy of your letter\./.test(r2.l), 'it states the rejection, its date, reference and reason');
    ok(/para 17\(b\)\) requires that where a claim is repudiated, details are conveyed to the claimant "along with full details giving reference to the specific terms and conditions of the policy document"/.test(r2.l) && /"No claim shall be repudiated without the approval of PMC or a three-member sub-group of PMC called the Claims Review Committee \(CRC\)"/.test(r2.l) && /para 19 of the same Master Circular requires your response to include/.test(r2.l) && /settlement of my claim of ₹1,20,000/.test(r2.l), 'it asks for the policy terms (17(b)), the committee approval (17(a)), the Ombudsman details (para 19) and settlement of ₹1,20,000');
    ok(!/[\[\]]|undefined|null|legally tenable/.test(r2.l), 'no blanks, and nothing from the life-insurance part of the circular');
    await ev(`const e=document.getElementById('rj_since'); e.value='2024-01-01'; e.dispatchEvent(new Event('input',{bubbles:true}));`); await sleep(100);
    const r3 = await ev(`return {out: document.getElementById('rjOut').textContent, l: document.getElementById('rjLetter').textContent}`);
    ok(/months of continuous cover: the five-year rule \(60 months\) does not apply yet/.test(r3.out) && !/Moratorium Period/.test(r3.l) && /Please send the evidence that the condition existed before my cover began/.test(r3.l), 'under 60 months: no five-year claim; it asks for the evidence and the waiting period instead');
    await ev(`document.getElementById('rjRdocs').click();`); await sleep(100);
    const r4 = await ev(`return document.getElementById('rjLetter').textContent`);
    ok(/"No claim shall be rejected or closed for want of documents or for delayed intimation of claim"/.test(r4) && /"shall collect the required documents from the Hospitals"/.test(r4) && !/Suggested/.test(await ev(`return document.getElementById('rjSuggest').classList.contains('hide')?'':'Suggested'`)), 'missing documents or late intimation: both rules quoted; choosing a reason by hand clears the suggestion');
    await ev(`document.getElementById('rjRgroup').click(); const c=document.getElementById('rj_cashless'); c.checked=true; c.dispatchEvent(new Event('change',{bubbles:true}));`); await sleep(100);
    const r5 = await ev(`return document.getElementById('rjLetter').textContent`);
    ok(/"No claim shall be denied for non-availability of details of members of the group"/.test(r5) && /Subject: Request to review the rejection of my cashless request/.test(r5) && /My request for cashless treatment was rejected/.test(r5), 'group policy: the members\' details rule; a refused cashless request is worded as such');
    await ev(`document.getElementById('rjRped').click(); const c=document.getElementById('rj_cashless'); c.checked=false; c.dispatchEvent(new Event('change',{bubbles:true}));
      for(const [id,v] of [['ld_name','Ravi Kumar'],['ld_insurer','Star Health and Allied'],['ld_policy','P-77']]){ const e=document.getElementById(id); e.value=v; e.dispatchEvent(new Event('input',{bubbles:true})); }`); await sleep(150);
    ok(await ev(`return /^Ravi Kumar\\n/.test(document.getElementById('rjLetter').textContent) && /Star Health and Allied/.test(document.getElementById('rjLetter').textContent) && !/Add these in Your details/.test(document.getElementById('rjOut').textContent)`), 'typing "Your details" fills the letter at once, and the list of missing details goes');

    console.log('== R28: the reply card, worded for a rejection');
    await ev(`const c=document.getElementById('replyCard'); c.open=true; const s=document.getElementById('rp_sent'); s.value=addDaysYmd(todayYmd(),-40); s.dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('rpNoBtn').click();
      document.querySelector('#rpResult [data-rpact="follow"]').click();`); await sleep(150);
    ok(/Subject: Reminder: request to review the rejection of my claim/.test(await ev(`return document.getElementById('rpFollowText').textContent`)), 'the reminder is about reviewing the rejection');
    await ev(`document.querySelector('#rpResult [data-rpact="complaint"]').click(); const k=document.getElementById('rp_court'); k.checked=true; k.dispatchEvent(new Event('change',{bubbles:true}));`); await sleep(200);
    const rcj = await ev(`return {t: document.getElementById('rpComplaintText').textContent, amt: document.getElementById('rp_amount').value}`);
    ok(rcj.amt === '120000' && /The insurer rejected the claim by its letter dated .* \(reference RJ-501\), on the ground of a pre-existing disease or non-disclosure\./.test(rcj.t) && /asking it to review the rejection, with the policy terms relied on \(copy attached\)/.test(rcj.t), 'the Ombudsman complaint states the rejection and the request to review it');
    ok(/The insurer's rejection letter dated/.test(rcj.t) && /₹1,20,000, the amount of the claim that was rejected/.test(rcj.t) && !/deducted without an itemised explanation|line-by-line explanation of the deductions/.test(rcj.t), 'it lists the rejection letter as a document, the claimed amount as the loss, and nothing about deductions');
    await ev(`document.getElementById('rpYesBtn').click(); document.getElementById('rp_text').value='We regret that the rejection stands as per policy terms and conditions.'; document.getElementById('rpCheckBtn').click();`); await sleep(150);
    ok(await ev(`return [...document.querySelectorAll('#rpChecks input[data-rpk]')].map(b=>b.dataset.rpk).join(',')==='reasons,omb'`), 'checking the insurer\'s reply: no line-by-line breakdown is asked for after a full rejection');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/#rejected` }); await sleep(1300);
    ok(await ev(`return document.getElementById('page-letter').classList.contains('on') && document.getElementById('rejCard').open && RJ.kind==='ped' && document.getElementById('rj_ref').value==='RJ-501'`), 'a link ending in #rejected opens it; what was entered is kept for this browser session');
    await ev(`setLang('mr');`); await sleep(100);
    ok(await ev(`return /संपूर्ण दावा नाकारला गेला का/.test(document.getElementById('rjHead').textContent) && /आधीपासूनचा आजार/.test(document.getElementById('rjRped').textContent)`), 'in Marathi');
    await ev(`setLang('en'); switchTab('settlement'); document.getElementById('clearSavedBtn').click(); document.getElementById('clearYesBtn').click();`); await sleep(200);
    ok(await ev(`return !RJ.kind && document.getElementById('rj_ref').value==='' && !sessionStorage.getItem('clearbill_rejection') && document.getElementById('replyCard').classList.contains('hide')`), '"Clear what this app saved" clears it too');

    console.log('== R29: one case at a time (council round 5)');
    await fresh(); await ev(`setLang('en'); switchTab('letter'); document.getElementById('rejCard').open=true; document.getElementById('rjRped').click(); const r=document.getElementById('rj_ref'); r.value='RJ-9'; r.dispatchEvent(new Event('input',{bubbles:true}));`); await sleep(150);
    ok(await ev(`return RJ.kind==='ped'`), 'a rejection is being drafted');
    await ev(`switchTab('settlement'); document.getElementById('egBtn').click();`); await sleep(500);
    const c29 = await ev(`switchTab('letter'); return {kind: RJ.kind, ref: document.getElementById('rj_ref').value, incl: document.getElementById('letterInclCard').classList.contains('hide')}`);
    ok(c29.kind === null && c29.ref === 'RJ-9' && !c29.incl, 'loading another bill switches the rejection off (keeping what was typed), so its letters can never say "rejected"');
    await ev(`const c=document.getElementById('replyCard'); c.open=true; const s=document.getElementById('rp_sent'); s.value=addDaysYmd(todayYmd(),-40); s.dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('rpNoBtn').click();
      document.querySelector('#rpResult [data-rpact="complaint"]').click(); const k=document.getElementById('rp_court'); k.checked=true; k.dispatchEvent(new Event('change',{bubbles:true}));`); await sleep(200);
    ok(await ev(`const t=document.getElementById('rpComplaintText').textContent; return !/rejected/.test(t) && /deducted without an itemised explanation/.test(t)`), 'the complaint for that bill is about the deduction, not a rejection');
    await ev(`document.getElementById('rpSaveBtn').click();`); await sleep(150);
    await ev(`switchTab('settlement'); document.getElementById('egBtn').click(); document.getElementById('egYesBtn')&&document.getElementById('egYesBtn').click();`); await sleep(500);
    ok(await ev(`return _openedLocalId===null && !RP.status && document.getElementById('rp_sent').value===''`), 'loading a new bill starts a new case: the reply card is empty and nothing will be saved into the earlier check');

    console.log('== R29: a corrected row keeps the letter as the user set it');
    await fresh(); await ev(`setLang('en'); document.getElementById('egBtn').click();`); await sleep(500);
    await ev(`switchTab('letter'); const cb=document.querySelector('#letterIncludes input[data-inc="dup"]'); cb.checked=false; cb.dispatchEvent(new Event('change',{bubbles:true}));
      switchTab('findings'); document.getElementById('readChecks').open=true; document.querySelector('#readChecks .rcfix').click(); document.querySelector('.rcform input[id^="rc_t_"]').value='63.27'; document.querySelector('.rcsave').click();`); await sleep(300);
    ok(await ev(`switchTab('letter'); return document.querySelector('#letterIncludes input[data-inc="dup"]').checked===false`), 'an item removed from the letter stays removed after a row is corrected (E36 promise kept)');

    console.log('== R29: what the complaint and the rejection letter say');
    await fresh(); await ev(`setLang('en'); document.getElementById('egBtn').click();`); await sleep(500);
    await ev(`switchTab('letter'); const c=document.getElementById('replyCard'); c.open=true; const s=document.getElementById('rp_sent'); s.value=addDaysYmd(todayYmd(),-30); s.dispatchEvent(new Event('input',{bubbles:true}));
      document.getElementById('rpYesBtn').click(); document.getElementById('rp_text').value='As per Clause 4.2 of your policy the deduction stands. You may approach the Insurance Ombudsman.'; document.getElementById('rpCheckBtn').click();
      await new Promise(r=>setTimeout(r,150)); document.querySelector('#rpResult [data-rpo="keep"]').click(); document.querySelector('#rpActs [data-rpact="complaint"]').click();
      const k=document.getElementById('rp_court'); k.checked=true; k.dispatchEvent(new Event('change',{bubbles:true}));`); await sleep(200);
    const ct29 = await ev(`return document.getElementById('rpComplaintText').textContent`);
    ok(/deducted from my claim, which I dispute\./.test(ct29) && !/without an explanation with reference/.test(ct29), 'when the reply gave its reasons, the complaint says the loss is disputed, not that no explanation was given');
    await fresh(); await ev(`setLang('en'); switchTab('letter'); document.getElementById('rejCard').open=true; document.getElementById('rjRped').click();
      for(const [id,v] of [['rj_since','2021-06-01'],['rj_date','2026-10-01']]){ const e=document.getElementById(id); e.value=v; e.dispatchEvent(new Event('input',{bubbles:true})); }`); await sleep(150);
    const m1 = await ev(`return {out: document.getElementById('rjOut').textContent, l: document.getElementById('rjLetter').textContent}`);
    ok(/64 months of continuous cover/.test(m1.out) && /Counted to the date of the rejection letter: enter the admission date/.test(m1.out), 'without an admission date it counts to the rejection letter and says so');
    await ev(`const e=document.getElementById('rj_admit'); e.value='2026-05-01'; e.dispatchEvent(new Event('input',{bubbles:true}));`); await sleep(150);
    const m2 = await ev(`return {out: document.getElementById('rjOut').textContent, l: document.getElementById('rjLetter').textContent}`);
    ok(/59 months of continuous cover: the five-year rule \(60 months\) does not apply yet/.test(m2.out) && !/Moratorium Period/.test(m2.l), 'admitted at 59 months: the five-year rule is not claimed, even though the rejection came after 60 months');
    await ev(`const e=document.getElementById('rj_admit'); e.value='2026-06-05'; e.dispatchEvent(new Event('input',{bubbles:true}));`); await sleep(150);
    ok(/The patient was admitted on 5 June 2026\. IRDAI's Master Circular on Protection of Policyholders' Interests \(IRDAI\/PP&GR\/CIR\/MISC\/117\/9\/2024, 5 September 2024, Part B, IV\.8\) provides that "No policy and claim/.test(await ev(`return document.getElementById('rjLetter').textContent`)), 'admitted after 60 months: the five-year rule, with the admission date, the exact paragraph and the circular\'s reference number');

    console.log('== R29: a rejected claim can be saved on its own, and cleared');
    await ev(`document.getElementById('rjRdocs').click(); document.getElementById('rjSaveBtn').click();`); await sleep(200);
    ok(await ev(`const l=readLocalChecks(); return l.length===1 && l[0].rejection && l[0].rejection.kind==='docs' && l[0].rejection.admit==='2026-06-05' && /Saved on this device as a new check/.test(document.getElementById('rjSaveMsg').textContent)`), 'with no bill or figures, the rejection is saved on this device');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` }); await sleep(1200);
    await ev(`sessionStorage.clear(); switchTab('mybills'); renderLocalList(); document.querySelector('#localList .lopen').click();`); await sleep(500);
    ok(await ev(`return document.getElementById('page-letter').classList.contains('on') && RJ.kind==='docs' && document.getElementById('rj_admit').value==='2026-06-05' && document.getElementById('rejCard').open`), 'opening it brings the rejection back, on the Letter tab');
    await ev(`document.getElementById('rjRnone').click();`); await sleep(150);
    ok(await ev(`return RJ.kind===null && document.getElementById('rjForm').classList.contains('hide') && document.getElementById('replyCard').classList.contains('hide')`), '"Not a full rejection" switches the rejection off');

    console.log('== R29: honest wording');
    ok(await ev(`setLang('en'); return /Saved with your Google sign-in/.test(document.getElementById('accountHead').textContent) && /ClearBill's server \\(Google Firestore\\)/.test(S().mybills_signin_prompt) && /except a photo you choose to read, which goes to Google's Gemini/.test(S().rp_intro)`), 'My Bills says where saved bills really are, and the reply card says a photo goes to Gemini');
    ok(await ev(`return /दावे की प्रक्रिया तुरंत करनी चाहिए/.test(STRINGS.hi.hs_death_note) && /दाव्याची प्रक्रिया तात्काळ करायला हवी/.test(STRINGS.mr.hs_death_note)`), 'the Hindi and Marathi death note says "process", as para 16(c) does');

    console.log('== R30: "What happened?" - the ways in');
    await fresh(); await ev(`setLang('en');`);
    const w0 = await ev(`return {head: document.getElementById('whHead').textContent, btns: [...document.querySelectorAll('#beforeStart .whbtn')].map(b=>b.textContent).join(' | '), note: document.getElementById('whNote').textContent}`);
    ok(w0.head === 'What happened?' && w0.btns === "Still in hospital, waiting for the insurer's approval | The insurer paid only part of the bill | The insurer rejected the whole claim | I wrote to the insurer, and it replied or hasn't | I only have the itemised bill" && /Any one of these is enough to start/.test(w0.note), 'the first screen asks "What happened?" with five plain choices');
    await ev(`document.getElementById('whHospital').click();`); await sleep(300);
    ok(await ev(`return document.getElementById('hospCard').open && document.activeElement===document.querySelector('#hospCard summary')`), '"Still in hospital" opens the hospital card and moves to it');
    await ev(`document.getElementById('whCut').click();`); await sleep(300);
    ok(await ev(`return document.activeElement===document.getElementById('total')`), '"The insurer paid only part" goes to the settlement figures');
    await ev(`document.getElementById('whReply').click();`); await sleep(300);
    const w1 = await ev(`return {tab: document.getElementById('page-letter').classList.contains('on'), card: !document.getElementById('replyCard').classList.contains('hide') && document.getElementById('replyCard').open, details: !document.getElementById('letterConfirm').classList.contains('hide'), incl: document.getElementById('letterInclCard').classList.contains('hide'), empty: document.getElementById('letterEmpty').classList.contains('hide')}`);
    ok(w1.tab && w1.card && w1.details && w1.incl && w1.empty, '"I wrote to the insurer" opens the reply card on its own, with "Your details", even with no bill or figures');
    await fresh(); await send('Page.navigate', { url: `http://127.0.0.1:${port}/#reply` }); await sleep(1300);
    ok(await ev(`return document.getElementById('page-letter').classList.contains('on') && !document.getElementById('replyCard').classList.contains('hide') && document.getElementById('replyCard').open`), 'a link ending in #reply opens it directly');
    await fresh(); await ev(`setLang('en'); document.getElementById('whBill').click();`); await sleep(300);
    ok(await ev(`return document.getElementById('page-findings').classList.contains('on')`), '"I only have the itemised bill" goes to the bill check');
    await ev(`setLang('hi');`); await sleep(100);
    ok(await ev(`return document.getElementById('whHead').textContent==='क्या हुआ?' && /पूरा दावा ठुकरा दिया/.test(document.getElementById('bysRejectedBtn').textContent)`), 'in Hindi');

    console.log('== R30: the grievance officer in the rejection card; a copy of My Bills');
    await fresh(); await ev(`setLang('en'); switchTab('letter'); document.getElementById('rejCard').open=true; document.getElementById('rjRexcl').click(); const g=document.getElementById('ld_gro'); g.value='Star Health and Allied'; g.dispatchEvent(new Event('input',{bubbles:true}));`); await sleep(200);
    ok(await ev(`const o=document.getElementById('rjOut'); return /gro@starhealth\\.in/.test(o.textContent) && !!document.getElementById('rjMailBtn') && /Copy the letter and open email/.test(o.textContent)`), 'choosing the insurer shows its grievance officer\'s email in the rejection card, as the card promises, with "copy and open email"');
    await ev(`window.__dl=null; window.downloadText=(t,n,ty)=>{ window.__dl={t,n,ty}; }; _myBills=[{id:'b1',hospitalName:'City Hospital',savedAt:'2026-10-01T10:00:00Z',status:'sent',note:'',letter:'Dear Sir'}]; renderMyBillsList(_myBills);`); await sleep(100);
    const ex = await ev(`const b=document.getElementById('mybillsExportBtn'); const vis=b.style.display!=='none'; b.click(); return {vis, label: b.textContent, dl: window.__dl}`);
    ok(ex.vis && ex.label === 'Download my saved bills' && ex.dl && /^clearbill-my-bills-\d{4}-\d{2}-\d{2}\.json$/.test(ex.dl.n) && JSON.parse(ex.dl.t).bills[0].hospitalName === 'City Hospital' && /Dear Sir/.test(ex.dl.t), 'signed-in users can download all their saved bills, letters included, as a file');
    ok(await ev(`renderMyBillsList([]); return document.getElementById('mybillsExportBtn').style.display==='none'`), 'with nothing saved, there is nothing to download');

    console.log('== R22: grievance officer, documents and delay lines');
    await fresh(); await ev(`setLang('en'); document.getElementById('egBtn').click();`); await sleep(500);
    await ev(`switchTab('letter'); const g=document.getElementById('ld_gro'); g.value='Star Health and Allied'; g.dispatchEvent(new Event('input',{bubbles:true}));
      const d=document.getElementById('ld_docs'); d.checked=true; d.dispatchEvent(new Event('input',{bubbles:true}));
      document.getElementById('genLetterTab').click();`); await sleep(300);
    const lg = await ev(`return {letter: document.querySelector('.letter').innerText, after: document.querySelector('.aftersend').innerText, opts: document.getElementById('ld_gro').options.length}`);
    ok(lg.opts === 35 && /^\s*Star Health and Allied$/m.test(lg.letter), 'the insurer picker lists IRDAI\'s 34 insurers, and the chosen name heads the letter');
    ok(/Grievance officer: Star Health and Allied/.test(lg.after) && /gro@starhealth\.in/.test(lg.after) && /last updated 6 October 2026\), as read on 9 October 2026/.test(lg.after) && /Check it on the insurer's own website/.test(lg.after), 'after the letter: its grievance officer\'s email from IRDAI\'s list, with the dates, and "check it first"');
    ok(/para 17\(c\)\) provides that insurers and TPAs "shall collect the required documents from the Hospitals"/.test(lg.letter) && /"No claim shall be rejected or closed for want of documents"/.test(lg.letter), 'the documents line quotes para 17(c) and the policyholder-protection circular');
    await ev(`const s=document.getElementById('ld_submitted'); s.value='2026-09-01'; s.dispatchEvent(new Event('input',{bubbles:true}));`); await sleep(200);
    ok(!/I submitted my claim on/.test(await ev(`return document.querySelector('.letter').innerText`)), 'a submission date is not used for a cashless claim');
    await ev(`switchTab('settlement'); document.getElementById('modeReimbBtn').click(); for(const [id,v] of [['total','41396'],['reimb','30000'],['copay','10']]){ const e=document.getElementById(id); e.value=v; e.dispatchEvent(new Event('input',{bubbles:true})); } switchTab('letter'); document.getElementById('genLetterTab').click();`); await sleep(300);
    const rl22 = await ev(`return document.querySelector('.letter').innerText`);
    ok(/I submitted my claim on 1 September 2026\./.test(rl22) && /"shall be settled within fifteen days from submission of claim"/.test(rl22) && /Please confirm the date you treat my claim as submitted, and whether interest is due on it\./.test(rl22), 'for a reimbursement, the letter quotes the 15 days and the interest rule, and ASKS (it does not say the insurer is late)');
    ok(!/you are late|overdue|breach/i.test(rl22), 'it never says the insurer is late or in breach');

    console.log('== R22: a note for the hospital billing desk');
    await fresh(); await ev(`setLang('en'); document.getElementById('egBtn').click();`); await sleep(500);
    await ev(`switchTab('letter'); document.getElementById('genLetterTab').click();`); await sleep(300);
    const hn = await ev(`const d=document.querySelector('details.hospnote'); return d ? {open:d.open, text: document.getElementById('hospNoteText').textContent} : null;`);
    ok(hn && !hn.open && /To: The Billing Department/.test(hn.text) && /appear more than once at the same amount/.test(hn.text) && /differs from the sum of its own lines/.test(hn.text) && /already included in another charge/.test(hn.text), 'with a bill, a short note for the billing desk asks about the repeats, the total and the Lists II-IV items (folded)');
    ok(!/ClearBill/.test(hn.text) && !/List I \(/.test(hn.text) && !/para 17/.test(hn.text), 'it is written from the user, carries no ClearBill heading, and leaves out what only the insurer answers');
    await fresh(); await ev(`setLang('en'); for(const [id,v] of [['total','120000'],['counter','18500'],['discount',''],['copay','']]){ const e=document.getElementById(id); e.value=v; e.dispatchEvent(new Event('input',{bubbles:true})); } switchTab('letter'); document.getElementById('genLetterTab').click();`); await sleep(300);
    const hn2 = await ev(`return document.getElementById('hospNoteText') ? document.getElementById('hospNoteText').textContent : ''`);
    ok(/Subject: Request for an itemised bill/.test(hn2) && /lists the right "To access a copy of the case papers, patient records, investigation reports and detailed bill \(itemized\)"/.test(hn2) && !/law|Act requires|legally/i.test(hn2), 'with no bill, it asks the hospital for the itemised bill, quoting the Charter of Patients\' Rights as a right it lists, never as law');
    await ev(`window.__lastExtraction={header:{},line_items:[{item:'TV CHARGES',quantity:1,total:300}]}; renderReport(window.__lastExtraction); switchTab('letter'); document.getElementById('genLetterTab').click();`); await sleep(300);
    ok(await ev(`return !document.querySelector('details.hospnote')`), 'a bill with nothing for the hospital to answer gets no note');

    console.log('== Hindi errors');
    await fresh();
    await ev(`setLang('hi'); window.__mode='504'; addFiles([__mk('k1.jpg','image/jpeg',41)]); document.getElementById('checkPhotosBtn').click();`); await sleep(700);
    const hi = await status(); ok(/[\u0900-\u097F]/.test(hi) && !/Failed to fetch|Server 5|took too long/.test(hi), 'in Hindi the error is Hindi, never a raw English message: "' + hi.slice(0, 60) + '"');
    ok(errs.length === 0, 'no uncaught page errors during any of this', errs.join(' | ').slice(0, 200));
  } finally { ws.close(); p.kill(); srv.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
