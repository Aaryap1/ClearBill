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
    await ev(`document.getElementById('egBtn').click();`); await sleep(400);
    ok(await ev(`return !document.getElementById('settleOut').classList.contains('inconsistent') && settleOk() !== null`), 'the worked example figures are consistent and used');
    { const mn = await ev(`return document.getElementById('settleModelNote').textContent`); ok(/room-rent limits/.test(mn), 'the result says the amount can include room-rent limits, deductibles and other exclusions', JSON.stringify(mn)); }

    console.log('== letter: coherent requests and a checkable citation');
    await ev(`switchTab('letter'); document.getElementById('genLetterTab').click();`); await sleep(300);
    const lt = await ev(`return document.querySelector('.letter').innerText`);
    ok(/List I \(Optional Items\)/.test(lt) && /27 September 2019/.test(lt), 'the letter names the list the way IRDAI does, with the date of the guidelines');
    ok(/The items listed above total .1,310\. The remaining .4,652\.89 of the amount recorded as non-payable is not accounted for by those items\./.test(lt), 'the letter states the arithmetic gap between the listed items and the deduction');
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
    ok(/should already be part of another charge/.test(rep2) && /IRDAI Lists II-IV/.test(rep2), 'the report has its own "should be in another charge" check card');
    ok(/should already be part of another charge, not billed on their own/.test(await ev(`return document.querySelector('.starthere').textContent`)), '"Start here" also lists it under "Ask the hospital"');
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
    ok(after && !/\b\d+\s*(days?|months?|years?|lakhs?)\b/i.test(after.t) && /time limits/.test(after.t), 'it states no time limits or amounts of its own; it sends people to the official rules');
    ok(await ev(`return document.querySelector('.lsum') === null`), 'in English there is no separate summary above the letter');
    await ev(`setLang('hi');`); await sleep(300);
    const hs = await ev(`window.__pr=null; const op=window.print; window.print=()=>{ window.__pr=document.getElementById('printArea').textContent; }; document.getElementById('printLetter').click(); window.print=op; const s=document.querySelector('.lsum'); return {sum: s?s.textContent:'', lettertext: document.querySelector('.letter').textContent, printed: window.__pr, order: s ? (s.compareDocumentPosition(document.querySelector('.letter')) & 4) : 0}`);
    ok(/[ऀ-ॿ]/.test(hs.sum) && /IRDAI/.test(hs.sum) && hs.order === 4, 'in Hindi a plain-language summary sits above the letter');
    ok(/किसी और चार्ज में शामिल होना चाहिए/.test(hs.sum), 'the Hindi summary also mentions the Lists II-IV items, not just IRDAI List I');
    ok(!/[ऀ-ॿ]/.test(hs.printed) && !/इस पत्र में क्या/.test(hs.printed), 'the summary is not part of the text that is printed');
    await ev(`setLang('en'); localStorage.setItem('clearbill_settlement_draft','{"total":"5"}'); localStorage.setItem('clearbill_gemini_key','KEY'); document.getElementById('ld_name').value='Someone'; document.getElementById('ld_remember').checked=true; document.getElementById('ld_name').dispatchEvent(new Event('input',{bubbles:true}));`);
    ok(await ev(`return !!localStorage.getItem('clearbill_letter_details')`), 'letter details are remembered when the box is ticked (setup for the next check)');
    await ev(`document.getElementById('clearSavedBtn').click();`);
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
    ok(/Explained: 22%/.test(loc.text), 'the saved row shows the explained share (22%)');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` }); await sleep(1200); // a reload that keeps storage
    await ev(`switchTab('mybills');`); await sleep(200);
    ok(await ev(`return document.querySelectorAll('#localList .billrow').length`) === 1, 'after closing and reopening the page, the saved check is still listed');
    await ev(`document.querySelector('#localList .lopen').click();`); await sleep(600);
    const reopened = await ev(`return {tab: document.getElementById('page-findings').classList.contains('on'), kpis: [...document.querySelectorAll('.kpi .v')].map(e=>e.textContent).join('|'), total: document.getElementById('total').value, counter: document.getElementById('counter').value, status: document.getElementById('status').textContent}`);
    ok(reopened.tab && reopened.kpis === '₹5,962.89|22%|6 / 6', 'Open restores the same report (₹5,962.89 deducted, 22% explained, 6 of 6 checks): ' + reopened.kpis);
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
    await ev(`switchTab('settlement'); document.getElementById('clearSavedBtn').click();`); await sleep(100);
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
    ok(!/\b\d+\s*(days?|months?|years?|lakhs?)\b/i.test(aft), 'the card still states no time limits of its own (addresses contain numbers, but no deadlines)');
    const letterOnly = await ev(`return document.querySelector('.letter').innerText`);
    ok(!/Ombudsman|oio\./.test(letterOnly), 'the Ombudsman is NOT put in the letter itself (a complaint goes to the insurer first)');
    await pickState('Maharashtra'); await sleep(300);
    aft = await ev(`return document.querySelector('.aftersend').innerText`);
    ok(/Mumbai/.test(aft) && /Pune/.test(aft) && /Thane/.test(aft) && (aft.match(/Covers:/g) || []).length === 3, 'Maharashtra (split) shows all three offices, each with the area it covers in its own words');
    ok(/depends on where you live/.test(aft), 'and says plainly that which office applies depends on where you live');
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
    ok(/₹56,789\.5 in charges matching IRDAI's published lists/.test(rs.impact || ''), 'and the matched amount: "₹56,789.5 in charges matching IRDAI\'s published lists"');
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

    console.log('== Hindi errors');
    await fresh();
    await ev(`setLang('hi'); window.__mode='504'; addFiles([__mk('k1.jpg','image/jpeg',41)]); document.getElementById('checkPhotosBtn').click();`); await sleep(700);
    const hi = await status(); ok(/[\u0900-\u097F]/.test(hi) && !/Failed to fetch|Server 5|took too long/.test(hi), 'in Hindi the error is Hindi, never a raw English message: "' + hi.slice(0, 60) + '"');
    ok(errs.length === 0, 'no uncaught page errors during any of this', errs.join(' | ').slice(0, 200));
  } finally { ws.close(); p.kill(); srv.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
