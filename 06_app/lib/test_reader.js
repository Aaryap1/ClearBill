/* Tests for the photo-reading logic (the "reader" region of index.html, copied to
 * lib/reader.js by build_checks.js). Everything is a mock: no network, no Gemini,
 * no cost.                                          node lib/test_reader.js
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const R = require('./reader.js');
let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m + (extra ? '  -> ' + extra : '')); } };

const file = (name, size = 100, lm = 1, type = 'image/jpeg') => ({ name, size, lastModified: lm, type });
const GOOD = JSON.stringify({ is_hospital_bill: true, header: {}, line_items: [{ item: 'X', total: 1 }] });
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) });
const geminiBody = t => JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] });

// A scripted fetch: each entry is a [status, body] pair, 'throw', or 'hang'.
function mockFetch(script) {
  const calls = []; let i = 0;
  const fn = (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    const step = script[Math.min(i++, script.length - 1)];
    if (step === 'throw') return Promise.reject(new TypeError('Failed to fetch'));
    if (step === 'hang') return new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    return Promise.resolve(resp(step[0], step[1]));
  };
  fn.calls = calls; return fn;
}
const base = (fetchFn, over = {}) => ({
  key: '', useProxy: true, proxyState: { busy: false }, fetchFn, toB64: async f => 'b64:' + f.name, stripFence: s => s.trim(),
  directRequest: (key, mime, b64) => ({ url: 'https://google/' + key, body: { mime, b64 } }), cache: new Map(), timeoutMs: 2000, ...over,
});

(async () => {
  console.log('== files: type, extension, duplicates');
  ok(R.fileMime(file('a.jpg', 1, 1, 'image/jpeg')) === 'image/jpeg', 'a JPEG is accepted');
  ok(R.fileMime(file('IMG_1.HEIC', 1, 1, '')) === 'image/heic', 'a photo with an empty type is accepted by its extension (some Android phones)');
  ok(R.fileMime(file('IMG_2.jpg', 1, 1, 'application/octet-stream')) === 'image/jpeg', 'a generic octet-stream type falls back to the extension');
  ok(R.fileMime(file('bill.pdf', 1, 1, 'application/pdf')) === null && !R.isPhoto(file('bill.pdf', 1, 1, 'application/pdf')), 'a PDF is not a photo');
  ok(R.fileMime(file('notes.jpg', 1, 1, 'text/plain')) === null, 'a stated non-image type is not overridden by the file name');
  ok(R.fileKey(file('a', 5, 9)) === R.fileKey(file('a', 5, 9)) && R.fileKey(file('a', 5, 9)) !== R.fileKey(file('a', 5, 10)), 'the same photo has the same key, a different one does not');

  console.log('== one page, dedupe, cache');
  let f = mockFetch([[200, GOOD]]);
  let res = await R.readPages([file('p1')], base(f));
  ok(res[0].status === 'ok' && res[0].page.is_hospital_bill === true && f.calls.length === 1 && f.calls[0].body.mime_type === 'image/jpeg', 'a good page is read with one call and the right mime type');
  f = mockFetch([[200, GOOD]]);
  res = await R.readPages([file('p1'), file('p1')], base(f));
  ok(f.calls.length === 1 && res[1].status === 'dup', 'the same photo twice is read once (no double call, no false duplicate charges)');
  f = mockFetch([[200, GOOD]]); const o1 = base(f);
  await R.readPages([file('p1'), file('p2')], o1); const before = f.calls.length;
  res = await R.readPages([file('p1'), file('p2')], o1);
  ok(f.calls.length === before && res.every(r => r.cached), 'reading the same set again sends nothing: every page comes from the cache');
  const prog = []; f = mockFetch([[200, GOOD]]);
  await R.readPages([file('p1'), file('p1'), file('p3')], base(f, { onProgress: (i, n) => prog.push(i + '/' + n) }));
  ok(prog.join() === '0/3,2/3', 'progress is reported only for pages actually read');

  console.log('== failures keep the pages that worked, and retry only what failed');
  f = mockFetch([[200, GOOD], [504, JSON.stringify({ error: 'timeout' })], [200, GOOD]]); const o2 = base(f);
  const three = [file('a'), file('b'), file('c')];
  res = await R.readPages(three, o2);
  ok(res.map(r => r.status).join() === 'ok,failed,ok' && res[1].kind === 'timeout', 'page 2 times out: pages 1 and 3 are still read');
  f = mockFetch([[200, GOOD]]); o2.fetchFn = f;
  res = await R.readPages(three, o2);
  ok(f.calls.length === 1 && f.calls[0].body.data === 'b64:b' && res.every(r => r.status === 'ok'), 'the retry sends only the failed page (' + f.calls.length + ' call)');
  f = mockFetch([[500, '{}']]);
  res = await R.readPages([file('a'), file('b'), file('c')], base(f));
  ok(f.calls.length === 2 && res[2].status === 'skipped', 'two server failures in a row stop the run (no waiting through every remaining page)');
  f = mockFetch([[200, 'not json at all'], [200, GOOD]]);
  res = await R.readPages([file('a'), file('b')], base(f));
  ok(res[0].kind === 'unreadable' && res[1].status === 'ok' && f.calls.length === 2, 'a page that cannot be understood does not stop the others');
  for (const bad of ['{"line_items": [{"item": "BED', '[1,2]', 'null', '']) {
    f = mockFetch([[200, bad]]); res = await R.readPages([file('a')], base(f));
    ok(res[0].status === 'failed' && res[0].kind === 'unreadable', 'an unusable answer (' + JSON.stringify(bad).slice(0, 24) + ') is "unreadable"');
  }

  console.log('== plain-language error kinds');
  const K = (status, code) => R.kindForStatus(status, false, code);
  ok(K(413) === 'toolarge' && K(415) === 'unsupported' && K(504) === 'timeout' && K(429) === 'busy', 'proxy statuses: 413 too large, 415 unsupported, 504 timeout, 429 busy');
  ok(K(502, 'empty') === 'unreadable' && K(502, 'unreadable') === 'unreadable' && K(502, 'upstream') === 'server' && K(500) === 'server', 'proxy 502s: an empty or unreadable answer is about the photo; anything else is the service');
  ok(R.kindForStatus(429, true) === 'quota' && R.kindForStatus(403, true) === 'key' && R.kindForStatus(400, true) === 'key' && R.kindForStatus(503, true) === 'server', 'direct-to-Google statuses: 429 quota, 400/403 key, 5xx server');
  f = mockFetch(['throw', [200, GOOD]]);
  res = await R.readPages([file('a'), file('b')], base(f));
  ok(res[0].kind === 'offline' && res[1].status === 'skipped' && f.calls.length === 1, 'a failed connection is "offline" and stops the run');
  f = mockFetch(['hang']);
  const t0 = Date.now(); res = await R.readPages([file('a')], base(f, { timeoutMs: 60 }));
  ok(res[0].kind === 'timeout' && Date.now() - t0 < 1500, 'a hanging request times out on the client instead of waiting forever');

  console.log('== cancel');
  f = mockFetch(['hang']); const ac = new AbortController();
  setTimeout(() => ac.abort(), 40);
  res = await R.readPages([file('a'), file('b')], base(f, { signal: ac.signal, timeoutMs: 5000 }));
  ok(res[0].kind === 'cancelled' && res[1].status === 'skipped' && f.calls.length === 1, 'Cancel stops the read in flight and sends no further page');
  f = mockFetch([[200, GOOD]]); const pre = new AbortController(); pre.abort();
  res = await R.readPages([file('a')], base(f, { signal: pre.signal }));
  ok(f.calls.length === 0 && res[0].status === 'skipped', 'already cancelled: no call at all');

  console.log('== busy free service -> own key');
  f = mockFetch([[429, JSON.stringify({ error: 'busy' })]]); const o3 = base(f);
  res = await R.readPages([file('a'), file('b')], o3);
  ok(res[0].kind === 'busy' && res[1].status === 'skipped' && o3.proxyState.busy === true && f.calls.length === 1, 'the free service says busy: the run stops and remembers it');
  f = mockFetch([[200, geminiBody(GOOD)]]); o3.fetchFn = f; o3.key = 'MYKEY';
  res = await R.readPages([file('a'), file('b')], o3);
  ok(res.every(r => r.status === 'ok') && f.calls.every(c => c.url === 'https://google/MYKEY'), "with the user's own key the pages go straight to Google");
  f = mockFetch([[403, '{}']]); res = await R.readPages([file('a')], base(f, { useProxy: false, key: 'BAD' }));
  ok(res[0].kind === 'key', 'a rejected key is reported as a key problem');
  f = mockFetch([[200, geminiBody('{"a":1}')]]); res = await R.readPages([file('a')], base(f, { useProxy: false, key: 'K' }));
  ok(res[0].status === 'ok' && res[0].page.a === 1, 'the direct-to-Google answer format is read');

  console.log('== the reader touches nothing but its inputs');
  const src = fs.readFileSync(path.join(__dirname, 'reader.js'), 'utf8').replace(/module\.exports[\s\S]*$/, '');
  let threw = null;
  try { vm.runInNewContext(src + '\nreadPages([], {});', { AbortController, setTimeout, clearTimeout, JSON, Error, Map, Promise }); } catch (e) { threw = e; }
  ok(!threw, 'it loads and runs with no page, storage or navigator objects available', threw && threw.message);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
