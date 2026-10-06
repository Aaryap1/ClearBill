/* R19: accessibility and layout, measured in a real browser. Starts the REAL
 * server.js (no Gemini key, nothing sent anywhere), opens the page in
 * headless Chrome at phone sizes and checks: every language has every string,
 * headings and landmarks, the language buttons, messages announced to screen
 * readers, a real keyboard Tab walk where no focused control may hide behind
 * the tab bar, colour contrast in both themes, and the R19 visual fixes.
 *    node --experimental-websocket lib/test_browser_a11y.js
 */
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(fs.existsSync);
if (!chrome) { console.log('  SKIPPED - no Chrome/Edge found; the accessibility tests did not run'); process.exit(0); }
if (typeof WebSocket === 'undefined') { console.log('  SKIPPED - run with: node --experimental-websocket lib/test_browser_a11y.js'); process.exit(0); }

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m + (extra ? '  -> ' + extra : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = 18621;

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), GEMINI_API_KEY: '' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/config`); break; } catch (e) { await sleep(100); } }
  const p = spawn(chrome, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9353', '--user-data-dir=' + path.join(os.tmpdir(), 'a11y_test_profile'), 'about:blank'], { stdio: 'ignore' });
  let tabs; for (let i = 0; i < 30 && !tabs; i++) { await sleep(300); try { tabs = await (await fetch('http://127.0.0.1:9353/json')).json(); } catch (e) {} }
  const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const pend = {}; const errs = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m.result || m.error); delete pend[m.id]; } else if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async js => { const r = await send('Runtime.evaluate', { expression: '(async()=>{' + js + '})()', awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; };
  const size = (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true });
  const theme = t => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: t }] });
  const load = async () => { await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }); await sleep(1800); await ev(`localStorage.clear(); sessionStorage.clear(); setLang('en');`); };
  const tab = async () => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); };
  await send('Page.enable'); await send('Runtime.enable');

  try {
    await size(390, 844); await theme('light'); await load();

    console.log('== every language has every string');
    const parity = await ev(`const keys=(o,p='')=>Object.entries(o).flatMap(([k,v])=>v&&typeof v==='object'&&!Array.isArray(v)?keys(v,p+k+'.'):[p+k]);
      const en=new Set(keys(STRINGS.en)); const out={};
      for(const l of ['hi','mr']){ const o=new Set(keys(STRINGS[l])); out[l]={missing:[...en].filter(k=>!o.has(k)), extra:[...o].filter(k=>!en.has(k))}; }
      out.n=en.size; return out;`);
    for (const l of ['hi', 'mr']) ok(parity[l].missing.length === 0 && parity[l].extra.length === 0, `${l.toUpperCase()} has exactly the ${parity.n} strings English has`, JSON.stringify(parity[l]).slice(0, 300));

    console.log('== headings, landmarks, language buttons');
    const st = await ev(`return {h1:document.querySelectorAll('h1').length, h2:[...document.querySelectorAll('h2')].map(h=>h.id), main:!!document.querySelector('main #page-findings'), nav:document.getElementById('tabbar').tagName}`);
    ok(st.h1 === 1 && st.h2.join() === 'secSettlement,secBill,secLetter,secMybills,secAbout' && st.main && st.nav === 'NAV', 'one h1, a real h2 for each of the five sections, the tabs inside <main>, the tab bar a <nav>');
    await ev(`setLang('hi')`); await sleep(150);
    const lg = await ev(`return {pressed:[...document.querySelectorAll('#langsw button')].map(b=>b.lang+':'+b.getAttribute('aria-pressed')).join(','), group:document.getElementById('langsw').getAttribute('aria-label'), nav:document.getElementById('tabbar').getAttribute('aria-label')}`);
    ok(lg.pressed === 'en:false,hi:true,mr:false', 'each language button says which language it is (lang) and whether it is selected (aria-pressed)', lg.pressed);
    ok(lg.group === 'भाषा' && /[ऀ-ॿ]/.test(lg.nav), 'the language group and the tab bar are labelled in Hindi when the page is in Hindi');
    await ev(`setLang('en')`);
    ok(await ev(`return ['status','localSaveMsg','mybillsSaveMsg','srLive','readerNote','clearedNote'].every(id=>{const e=document.getElementById(id); return e && e.getAttribute('role')==='status';})`), 'status messages are announced to screen readers (role="status"), including the save messages');

    console.log('== focus');
    await ev(`switchTab('findings')`); await sleep(100);
    ok(await ev(`return document.activeElement && document.activeElement.id==='secBill'`), 'switching tab moves focus to the new tab\'s heading');
    await ev(`switchTab('settlement')`);
    // A real keyboard walk, on a small phone: no focused control may sit under the fixed tab bar.
    await size(360, 740); await sleep(300);
    const hidden = [];
    for (const t of ['settlement', 'findings', 'letter', 'mybills', 'about']) {
      await ev(`localStorage.clear(); document.getElementById('egBtn').click();`); await sleep(400);
      await ev(`switchTab('${t}'); ${t === 'letter' ? "document.getElementById('genLetterTab').click();" : ''} window.scrollTo(0,0); document.activeElement.blur && document.activeElement.blur(); document.body.focus();`); await sleep(250);
      for (let i = 0; i < 60; i++) {
        await tab(); await sleep(35);
        const r = await ev(`const a=document.activeElement; if(!a||a===document.body) return null; if(a.closest('#tabbar')) return {inbar:true};
          const b=a.getBoundingClientRect(), bar=document.getElementById('tabbar').getBoundingClientRect();
          return {inbar:false, covered:b.height>0 && b.bottom>bar.top+1 && b.top<bar.bottom, what:(a.id||a.tagName)+' '+(a.textContent||'').trim().slice(0,30)}`);
        if (r && r.covered) hidden.push(t + ': ' + r.what);
        if (r && r.inbar) break;
      }
    }
    ok(hidden.length === 0, 'Tab through every tab on a 360x740 phone: no focused control is hidden behind the tab bar (WCAG 2.4.11)', hidden.slice(0, 6).join(' | '));

    console.log('== contrast, both themes (WCAG 1.4.3: 4.5:1 for this size of text)');
    for (const th of ['light', 'dark']) {
      await size(390, 844); await theme(th); await load();
      const c = await ev(`
        const rgb=s=>{const m=s.match(/[\\d.]+/g).map(Number); return m.slice(0,3);};
        const lum=([r,g,b])=>{const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)}; return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b);};
        const cr=(a,b)=>{const x=lum(rgb(a)),y=lum(rgb(b)); return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);};
        const probe=(cls,parentCls)=>{ const w=document.createElement('div'); if(parentCls) w.className=parentCls; const e=document.createElement('span'); e.className=cls; e.textContent='X'; w.appendChild(e); document.getElementById('main').appendChild(w);
          let bg=getComputedStyle(e).backgroundColor, n=e; while((/rgba\\(.*, 0\\)/.test(bg)||bg==='transparent')&&n.parentElement){ n=n.parentElement; bg=getComputedStyle(n).backgroundColor; }
          const r=cr(getComputedStyle(e).color,bg); w.remove(); return Math.round(r*100)/100; };
        return { stampRed:probe('st red','chk'), stampOchre:probe('st ochre','chk'), stampGreen:probe('st green','chk'), stampGrey:probe('st grey','chk'),
          rejBadge:probe('rejbadge','fthumb'), gcLive:probe('gclive on','gcrow'), soft:probe('k'), body:probe('') };`);
      const low = Object.entries(c).filter(([, v]) => v < 4.5);
      ok(low.length === 0, `${th}: every badge, stamp and text colour is at least 4.5:1 (${Object.entries(c).map(([k, v]) => k + ' ' + v).join(', ')})`, low.map(([k, v]) => k + ' ' + v).join(', '));
    }
    await theme('light');

    console.log('== R19 visual fixes');
    for (const w of [320, 360, 390]) {
      await size(w, 800); await load(); await ev(`document.getElementById('egBtn').click();`); await sleep(400);
      await ev(`switchTab('findings')`); await sleep(200);
      const k = await ev(`return [...document.querySelectorAll('.kpi')].map(t=>{const v=t.querySelector('.v'),l=t.querySelector('.l'); return v.textContent+'|'+(v.scrollWidth<=v.clientWidth&&l.scrollWidth<=l.clientWidth);})`);
      ok(k.length === 3 && k.every(x => x.endsWith('|true')) && k[0].startsWith('₹5,962.89'), `${w}px: the three summary figures and their labels fit, including "₹5,962.89" (it was cut off)`, k.join(' '));
      const over = [];
      for (const t of ['settlement', 'findings', 'letter', 'mybills', 'about']) {
        await ev(`switchTab('${t}'); ${t === 'letter' ? "document.getElementById('genLetterTab').click();" : ''}`); await sleep(150);
        if (await ev(`return document.documentElement.scrollWidth > window.innerWidth`)) over.push(t);
      }
      ok(over.length === 0, `${w}px: no tab scrolls sideways`, over.join(','));
    }
    await size(390, 844); await load(); await ev(`document.getElementById('egBtn').click();`); await sleep(400);
    await ev(`switchTab('letter')`); await sleep(150);
    const form = await ev(`const s=document.getElementById('ld_state').getBoundingClientRect(), i=document.getElementById('ld_claim').getBoundingClientRect();
      const cb=document.getElementById('ld_asked').getBoundingClientRect(), sp=document.getElementById('ldLblAsked').getBoundingClientRect();
      return {sameWidth:Math.abs(s.width-i.width)<2, tall:s.height>=40, cbBeside: sp.left>cb.right && Math.abs(sp.top-cb.top)<8}`);
    ok(form.sameWidth && form.tall, 'the state list is as wide and as tall as the other fields (it was an unstyled browser default)');
    ok(form.cbBeside, 'the "already asked" tick box sits beside its words, like "Remember these details" (the text used to drop below the box)');
    ok(await ev(`return [...document.querySelectorAll('.tabbtn .dot')].every(d=>d.querySelector('svg'))`), 'all five tabs have a drawn icon (Findings was a plain dash, My Bills a colour emoji)');

    console.log('== compact Findings');
    await ev(`switchTab('findings')`); await sleep(200);
    const cf = await ev(`const c=document.getElementById('uploadCard'); return {compact:c.classList.contains('compact'), drop:document.getElementById('drop').offsetParent!==null, sum:document.getElementById('uploadSummaryText').textContent,
      whys:document.querySelectorAll('#report .finding details.why').length, open:document.querySelectorAll('#report .finding details.why[open]').length, h:document.documentElement.scrollHeight,
      paise:(document.getElementById('report').innerText.match(/₹[\\d,]+\\.\\d(?!\\d)/g)||[])}`);
    ok(cf.compact && !cf.drop && /Worked example . 63 lines read/.test(cf.sum), 'with a report on screen, the upload card is one line: "Worked example · 63 lines read" and "Change photos"', cf.sum);
    ok(cf.whys >= 5 && cf.open === 0, `each finding's explanation is folded under "What this means and what to do" (${cf.whys} findings)`);
    ok(cf.h < 4200, `the Findings tab is much shorter: ${cf.h}px at 390px wide (it was 5,559px)`);
    ok(cf.paise.length === 0, 'every amount with paise shows two digits (₹689.60, not ₹689.6)', cf.paise.join(' '));
    await ev(`document.querySelector('#report .finding details.why summary').click();`); await sleep(100);
    ok(await ev(`return /WHAT YOU CAN DO|What you can do/i.test(document.querySelector('#report .finding details.why[open]').innerText)`), 'tapping it opens the explanation and what to do');
    await ev(`document.querySelector('#report .seelines').click();`); await sleep(700);
    const sl = await ev(`const d=document.querySelector('#report details[id]'); const tgt=document.getElementById(document.querySelector('#report .seelines').dataset.goto); const r=tgt.getBoundingClientRect(); return {open:tgt.open, visible:r.top>=0&&r.top<window.innerHeight, focus:document.activeElement===tgt.querySelector('summary')}`);
    ok(sl.open && sl.visible && sl.focus, '"See the lines" opens that finding\'s own list, scrolls to it and moves focus there');
    await ev(`document.getElementById('changePhotosBtn').click();`); await sleep(100);
    ok(await ev(`return !document.getElementById('uploadCard').classList.contains('compact') && document.activeElement.id==='drop'`), '"Change photos" opens the upload card again, with focus on the photo picker');
    ok(errs.length === 0, 'no page errors', errs.join(' | ').slice(0, 300));
  } finally { ws.close(); p.kill(); srv.kill(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
