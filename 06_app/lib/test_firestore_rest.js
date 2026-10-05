/* Tests for lib/firestore_rest.js against a mock Firestore REST server (no
 * network, no real GCP project, no cost).      node lib/test_firestore_rest.js
 */
const http = require('http');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); } };

(async () => {
  // A tiny in-memory Firestore stand-in: just enough of the REST surface
  // (POST to create with an auto id, GET to list, PATCH with updateMask,
  // DELETE, and a Bearer-token check) for firestore_rest.js to talk to.
  const store = new Map(); // path "users/UID/bills/ID" -> {fields}
  let nextId = 1, lastAuthHeader = null, lastCommit = null;
  const PROJECT = 'test-project';
  const mock = http.createServer((req, res) => {
    lastAuthHeader = req.headers['authorization'];
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      // R14: documents:commit with increment transforms (the impact counter)
      if (req.method === 'POST' && req.url === `/v1/projects/${PROJECT}/databases/(default)/documents:commit`) {
        lastCommit = body;
        for (const w of body.writes) {
          const docPath = w.update.name.split('/documents/')[1];
          const fields = store.get(docPath) || {};
          for (const t of w.updateTransforms || []) {
            const cur = fields[t.fieldPath] ? Number(fields[t.fieldPath].integerValue) : 0;
            fields[t.fieldPath] = { integerValue: String(cur + Number(t.increment.integerValue)) };
          }
          store.set(docPath, fields);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{}');
      }
      const prefix = `/v1/projects/${PROJECT}/databases/(default)/documents/`;
      if (!req.url.startsWith(prefix)) { res.writeHead(404); return res.end('{}'); }
      const rest = req.url.slice(prefix.length); // "users/UID/bills" or "users/UID/bills/ID?query" or "users/UID/bills/ID"
      const [pathPart, query] = rest.split('?');
      if (req.method === 'POST') {
        const id = 'doc' + (nextId++);
        const full = pathPart + '/' + id;
        store.set(full, body.fields);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ name: `projects/${PROJECT}/databases/(default)/documents/${full}`, fields: body.fields }));
      }
      if (req.method === 'GET' && pathPart.split('/').length % 2 === 0) { // an even number of segments is a document, not a collection
        if (!store.has(pathPart)) { res.writeHead(404); return res.end(JSON.stringify({ error: { message: 'not found' } })); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ name: `projects/${PROJECT}/databases/(default)/documents/${pathPart}`, fields: store.get(pathPart) }));
      }
      if (req.method === 'GET') {
        const collPrefix = pathPart + '/';
        const docs = [...store.entries()].filter(([k]) => k.startsWith(collPrefix) && !k.slice(collPrefix.length).includes('/'))
          .map(([k, fields]) => ({ name: `projects/${PROJECT}/databases/(default)/documents/${k}`, fields }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ documents: docs }));
      }
      if (req.method === 'PATCH') {
        if (!store.has(pathPart)) { res.writeHead(404); return res.end(JSON.stringify({ error: { message: 'no document to update' } })); }
        const existing = store.get(pathPart);
        const mask = (query || '').split('&').filter(s => s.startsWith('updateMask.fieldPaths=')).map(s => decodeURIComponent(s.split('=')[1]));
        for (const k of mask) existing[k] = body.fields[k];
        store.set(pathPart, existing);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ name: `projects/${PROJECT}/databases/(default)/documents/${pathPart}`, fields: existing }));
      }
      if (req.method === 'DELETE') {
        if (!store.has(pathPart)) { res.writeHead(404); return res.end(JSON.stringify({ error: { message: 'not found' } })); }
        store.delete(pathPart);
        res.writeHead(204); return res.end();
      }
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  process.env.FIRESTORE_BASE = `http://127.0.0.1:${mock.address().port}`;
  process.env.FIRESTORE_PROJECT_ID = PROJECT;
  process.env.GOOGLE_ACCESS_TOKEN = 'fake-test-token'; // bypasses the real metadata-server fetch — see google_auth.js

  const firestore = require('./firestore_rest');

  console.log('== create / list / update / delete, round-trip through the typed-value format');
  const created = await firestore.createBill('uid-alice', { hospitalName: 'Test Hospital', netPayable: 41396, explainedPct: 22.0, status: 'sent', note: null });
  ok(!!created.id, 'createBill returns a generated id');
  ok(created.hospitalName === 'Test Hospital' && created.netPayable === 41396 && created.explainedPct === 22.0, 'string/integer/double fields round-trip');
  ok(created.status === 'sent' && created.note === null, 'string and explicit null round-trip');
  ok(lastAuthHeader === 'Bearer fake-test-token', 'the Firestore call carried the access token as a Bearer header');

  let list = await firestore.listBills('uid-alice');
  ok(list.length === 1 && list[0].id === created.id, "listBills returns alice's one bill");

  await firestore.createBill('uid-bob', { hospitalName: 'Other Hospital', netPayable: 500, status: 'sent' });
  list = await firestore.listBills('uid-alice');
  ok(list.length === 1, "a second user's bill does not show up in alice's list (per-user scoping works)");

  const updated = await firestore.updateBill('uid-alice', created.id, { status: 'insurer_responded', note: 'Refunded 1200' });
  ok(updated.status === 'insurer_responded' && updated.note === 'Refunded 1200', 'updateBill patches only the given fields');
  ok(updated.hospitalName === 'Test Hospital', 'fields not in the patch are left alone');

  await firestore.deleteBill('uid-alice', created.id);
  list = await firestore.listBills('uid-alice');
  ok(list.length === 0, 'deleteBill removes it — list is empty again');

  console.log('== bad ids are rejected before any network call');
  async function badId(fn, label) { try { await fn(); ok(false, label, 'did not throw'); } catch (e) { ok(e.code === 'bad_id', label, 'code was ' + e.code); } }
  await badId(() => firestore.listBills('../../etc/passwd'), 'a path-traversal-shaped uid is rejected');
  await badId(() => firestore.updateBill('uid-alice', 'has a space', { status: 'x' }), 'a bill id with a space is rejected');
  await badId(() => firestore.deleteBill('uid-alice', ''), 'an empty bill id is rejected');

  console.log('== nested / array values round-trip');
  const withNested = await firestore.createBill('uid-carol', { flagCounts: { listI: 3, listII: 1, duplicates: 2 }, tags: ['a', 'b'] });
  ok(withNested.flagCounts.listI === 3 && withNested.flagCounts.duplicates === 2, 'a nested object (mapValue) round-trips');
  ok(Array.isArray(withNested.tags) && withNested.tags[1] === 'b', 'an array (arrayValue) round-trips');

  console.log('== R14: the impact counter document');
  let imp = await firestore.readImpact();
  ok(imp.pages === 0 && imp.matchedPaise === 0, 'before anything is counted, the totals read as zero (a missing document is not an error)');
  await firestore.incrementImpact(1, 61000);
  await firestore.incrementImpact(1, 0);
  imp = await firestore.readImpact();
  ok(imp.pages === 2 && imp.matchedPaise === 61000, 'two increments add up: 2 pages, 61000 paise');
  const w = lastCommit.writes[0];
  ok(w.update.name.endsWith('/documents/stats/impact') && Array.isArray(w.updateMask.fieldPaths) && w.updateMask.fieldPaths.length === 0, 'the write is an upsert of stats/impact that touches no other field (empty update mask)');
  ok(w.updateTransforms.length === 2 && w.updateTransforms.every(t => t.increment && typeof t.increment.integerValue === 'string'), 'both totals use Firestore\'s server-side increment (no read-then-write race)');
  ok(Object.keys(store.get('stats/impact')).sort().join() === 'matchedPaise,pages', 'the counter document holds the two totals and nothing else');

  console.log('== updating a document that was never created');
  try { await firestore.updateBill('uid-alice', 'doc-does-not-exist', { status: 'x' }); ok(false, 'updating a missing document throws'); }
  catch (e) { ok(e.status === 404, 'updating a missing document throws a 404-coded error'); }

  mock.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
