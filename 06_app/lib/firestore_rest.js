/* Minimal Firestore REST client — zero dependencies (see google_auth.js for
 * why). Scoped to exactly what ClearBill's "My Bills" feature needs: each
 * signed-in user gets documents under users/{uid}/bills/{billId}. The uid
 * comes from a verified Google ID token (google_auth.js), never from the
 * client, so one user can never read or write another's documents — that
 * check happens here, server-side, on every call, not as a Firestore
 * security rule (there are none; nothing reaches Firestore directly from
 * the browser).
 *
 * Firestore's REST API represents every field as a typed {stringValue:...}
 * / {integerValue:...} / {mapValue:{fields:{...}}} wrapper. toFirestore()/
 * fromFirestore() convert plain JS objects to and from that shape; they
 * only need to cover the few types a bill record actually has (string,
 * number, boolean, null, array, nested object).
 */
const { getAccessToken } = require('./google_auth');

const PROJECT_ID = process.env.FIRESTORE_PROJECT_ID || '';
const FIRESTORE_BASE = process.env.FIRESTORE_BASE || 'https://firestore.googleapis.com';
const DB = '(default)';

function docsUrl(path) { return `${FIRESTORE_BASE}/v1/projects/${PROJECT_ID}/databases/${DB}/documents${path ? '/' + path : ''}`; }

function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === 'object') return { mapValue: { fields: toFirestoreFields(v) } };
  return { stringValue: String(v) };
}
function toFirestoreFields(obj) {
  const fields = {};
  for (const k of Object.keys(obj || {})) if (obj[k] !== undefined) fields[k] = toFirestoreValue(obj[k]);
  return fields;
}
function fromFirestoreValue(v) {
  if (!v) return null;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in v) return fromFirestoreFields(v.mapValue.fields || {});
  if ('timestampValue' in v) return v.timestampValue;
  return null;
}
function fromFirestoreFields(fields) {
  const obj = {};
  for (const k of Object.keys(fields || {})) obj[k] = fromFirestoreValue(fields[k]);
  return obj;
}

async function fsFetch(path, opts) {
  const token = await getAccessToken();
  const r = await fetch(docsUrl(path), { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts && opts.headers) } });
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).error?.message || ''; } catch (e) { /* ignore */ }
    throw Object.assign(new Error('Firestore request failed: ' + r.status + (detail ? ' — ' + detail : '')), { status: r.status === 404 ? 404 : 502, code: 'firestore_error' });
  }
  return r.status === 204 ? null : r.json();
}

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
function assertId(id, label) { if (!ID_RE.test(id)) throw Object.assign(new Error('bad ' + label), { status: 400, code: 'bad_id' }); }

function billPath(uid, billId) { return `users/${uid}/bills${billId ? '/' + billId : ''}`; }

async function listBills(uid) {
  assertId(uid, 'uid');
  // documents are returned newest-first by the caller (server.js sorts on savedAt — Firestore's
  // REST "list" endpoint doesn't accept an orderBy without a composite index, and this collection
  // is small per user, so sorting the already-small page in Node keeps this index-free and free-tier-simple).
  const j = await fsFetch(billPath(uid) + '?pageSize=200', { method: 'GET' });
  const docs = j.documents || [];
  return docs.map(d => ({ id: d.name.split('/').pop(), ...fromFirestoreFields(d.fields) }));
}

async function createBill(uid, data) {
  assertId(uid, 'uid');
  const j = await fsFetch(billPath(uid), { method: 'POST', body: JSON.stringify({ fields: toFirestoreFields(data) }) });
  return { id: j.name.split('/').pop(), ...fromFirestoreFields(j.fields) };
}

async function updateBill(uid, billId, patch) {
  assertId(uid, 'uid'); assertId(billId, 'bill id');
  const fieldPaths = Object.keys(patch).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const j = await fsFetch(billPath(uid, billId) + '?' + fieldPaths, { method: 'PATCH', body: JSON.stringify({ fields: toFirestoreFields(patch) }) });
  return { id: j.name.split('/').pop(), ...fromFirestoreFields(j.fields) };
}

async function deleteBill(uid, billId) {
  assertId(uid, 'uid'); assertId(billId, 'bill id');
  await fsFetch(billPath(uid, billId), { method: 'DELETE' });
  return { ok: true };
}

/* ---- The public impact counter (R14): ONE document, stats/impact, holding
   two running totals and nothing else — no bill content, no user, no time
   series. Incremented with Firestore's own server-side `increment` transform
   inside a commit, so two pages read at the same moment can never overwrite
   each other's count (no read-modify-write, no Cloud Function needed). The
   empty update + empty mask makes the write an upsert: it creates the
   document the first time and never touches any other field. */
const IMPACT_DOC = 'stats/impact';
async function incrementImpact(pages, paise) {
  const token = await getAccessToken();
  const name = `projects/${PROJECT_ID}/databases/${DB}/documents/${IMPACT_DOC}`;
  const body = { writes: [{ update: { name, fields: {} }, updateMask: { fieldPaths: [] }, updateTransforms: [
    { fieldPath: 'pages', increment: { integerValue: String(pages) } },
    { fieldPath: 'matchedPaise', increment: { integerValue: String(paise) } },
  ] }] };
  const r = await fetch(`${FIRESTORE_BASE}/v1/projects/${PROJECT_ID}/databases/${DB}/documents:commit`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw Object.assign(new Error('Firestore commit failed: ' + r.status), { status: 502, code: 'firestore_error' });
}
async function readImpact() {
  try {
    const j = await fsFetch(IMPACT_DOC, { method: 'GET' });
    const f = fromFirestoreFields(j.fields || {});
    return { pages: Number(f.pages) || 0, matchedPaise: Number(f.matchedPaise) || 0 };
  } catch (e) {
    if (e.status === 404) return { pages: 0, matchedPaise: 0 }; // nothing counted yet
    throw e;
  }
}

module.exports = { listBills, createBill, updateBill, deleteBill, toFirestoreFields, fromFirestoreFields, incrementImpact, readImpact };
