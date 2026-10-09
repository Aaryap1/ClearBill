/* ClearBill — Cloud Run server.
 * Serves the static app AND proxies the Gemini call so the API key stays
 * server-side (set GEMINI_API_KEY as an env var / Secret Manager binding).
 * No dependencies — Node 18+ built-ins only.
 *
 * When GEMINI_API_KEY is set, the app's key field hides itself and POSTs the
 * image to /api/read-bill instead of calling Google directly.
 *
 * This proxy is public and sits in front of a billed key, so it is defensive:
 *  - serves ONLY the three static files the app needs (never server.js,
 *    Dockerfile, deploy scripts, lib/...);
 *  - accepts images only, with a size limit that answers 413 instead of
 *    silently dropping the connection;
 *  - per-IP and per-day request caps that answer with an honest 429 "busy"
 *    (the app then offers "use your own free key") — never a silent failure;
 *  - a timeout on the upstream call, and it never forwards Google's raw error
 *    bodies to the browser;
 *  - (R16) at most READ_INFLIGHT_MAX photos are read at once per instance;
 *    later ones wait in a short queue with their upload not yet read, so a
 *    burst cannot fill the instance's 512 MiB with photo bodies;
 *  - (R16) every POST counts toward a per-IP attempts limit, including
 *    malformed and oversized ones that never reach the paid call;
 *  - (R16) a revoked key or retired model is detected (from real reads and
 *    from a free metadata check at /api/health) and reported as "broken", so
 *    the page can offer the own-key route and the uptime check can alert;
 *  - (R16) security headers on every response, and a hash-based Content
 *    Security Policy on the page, so only its own script can run.
 * The caps live in memory: each Cloud Run instance counts separately and the
 * counters reset when an instance restarts. They limit abuse; they are not an
 * exact quota. The hard backstop is the daily quota you can set on the key in
 * the Google Cloud console (free) — see DEPLOY.md.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { verifyGoogleIdToken } = require('./lib/google_auth');
const firestore = require('./lib/firestore_rest');
const { analyse } = require('./lib/checks'); // the app's own rules, generated from index.html (R14: impact counter)

const PORT = process.env.PORT || 8080;
const KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash'; // confirmed working 9 Sep 2026 — see 06_app/index.html for the full story
const GEMINI_BASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com';
const ROOT = __dirname;

// "My Bills" (R9): save a bill + letter to the signed-in user's own account so
// a dispute can be tracked after the letter is sent. GOOGLE_CLIENT_ID is the
// OAuth web client ID from Google Auth Platform (not secret — it is handed to
// the browser so it can show the Google Sign-In button); FIRESTORE_PROJECT_ID
// is the GCP project the Firestore database lives in. Both unset = the
// feature quietly stays off (see /api/config) rather than erroring.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const BILLS_ON = !!(GOOGLE_CLIENT_ID && process.env.FIRESTORE_PROJECT_ID);
// One saved bill is about 4 KB (the worked example's 63-line bill: a 3,317-
// character letter, 3.6 KB in all); 40 KB leaves room for a very long bill's
// letter while keeping each request small (R16 — it was 256 KB).
const BILLS_MAX_BODY = Number(process.env.BILLS_MAX_BODY_BYTES) || 40 * 1024;
const BILLS_IP_MAX = Number(process.env.BILLS_RATE_MAX_PER_IP) || 240; // free Firestore reads/writes, not a paid call; "delete all" of 100 bills is 100 requests
const BILLS_IP_WINDOW_MS = Number(process.env.BILLS_RATE_WINDOW_MS) || 10 * 60 * 1000;
const BILLS_MAX_PER_USER = Number(process.env.BILLS_MAX_PER_USER) || 100;    // saved bills per Google account
const UID_WRITE_MAX = Number(process.env.BILLS_WRITES_PER_USER) || 60;       // saves and edits per account per window

// Limits. Generous on purpose: many phones share one carrier IP, and a
// 6-page bill is 6 calls. The app now shrinks photos to at most 1900 px
// before upload (R10), so a page is typically well under 1 MB; 10 MB still
// fits a photo the browser could not shrink (R16 — it was 20 MB).
const MAX_BODY = Number(process.env.MAX_BODY_BYTES) || 10 * 1024 * 1024;
const IP_MAX = Number(process.env.RATE_MAX_PER_IP) || 60;            // calls per window
const IP_WINDOW_MS = Number(process.env.RATE_WINDOW_MS) || 10 * 60 * 1000;
const ATTEMPT_MAX = Number(process.env.ATTEMPT_MAX_PER_IP) || 120;   // every POST, valid or not, per window
const READ_INFLIGHT_MAX = Number(process.env.READ_INFLIGHT_MAX) || 4; // photos read at the same time, per instance
const READ_QUEUE_MAX = Number(process.env.READ_QUEUE_MAX) || 16;     // photos waiting for a turn
const READ_QUEUE_WAIT_MS = Number(process.env.READ_QUEUE_WAIT_MS) || 45 * 1000;
const DAILY_CAP = Number(process.env.DAILY_CAP) || 600;              // calls per UTC day, per instance
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 90 * 1000;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.txt': 'text/plain; charset=utf-8',
};
// The only files the app needs. Anything else — including this file — is a 404.
// og.png is the link-preview image (WhatsApp and others fetch it); robots.txt lets search engines in (R22).
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/manifest.json': 'manifest.json', '/icon.svg': 'icon.svg', '/og.png': 'og.png', '/robots.txt': 'robots.txt' };
const IMAGE_MIME = /^image\/(jpeg|jpg|png|webp|heic|heif)$/i;

// Kept identical to 06_app/index.html's EXTRACT_PROMPT — this file was a
// stale 15-field copy (from before the IS 19493 field expansion) until it
// was resynced here. Two copies of one prompt drifting apart is exactly the
// bug pattern this project keeps finding in its own reference data; don't
// let it happen here too.
const EXTRACT_PROMPT = `Look at this image. First decide: is it a page from an Indian hospital bill (an itemised statement of charges — admission, room, procedures, medicines, consumables) or a printed/handwritten total? If the image is unrelated to a hospital bill (a person, a landscape, a random document, a receipt from an unrelated business, a blank or unreadable page), set "is_hospital_bill" to false, leave "line_items" empty, and stop — do not invent bill content to fill the schema.
If it IS a hospital bill page, transcribe it. Return ONLY valid JSON, no markdown, no commentary.
Copy every value exactly as printed. Do not calculate, correct, round, or invent anything.
Use null for any field not present on the bill. Keep negative amounts negative.
{"is_hospital_bill":true,"header":{"hospital_name":null,"hospital_address":null,"hospital_gstin":null,"hospital_contact":null,"hospital_registration":null,"hospital_accreditation":null,"bill_number":null,"bill_datetime":null,"patient_name":null,"patient_age":null,"patient_gender":null,"patient_hospital_id":null,"patient_uhid":null,"patient_address":null,"patient_gstin":null,"admission_datetime":null,"discharge_datetime":null,"admission_type":null,"gross_amount":null,"discount_amount":null,"tax_amount":null,"net_payable":null,"payment_mode":null,"insurance_info":null,"patient_signature":false,"authorised_signature":false},"line_items":[{"item":"","unit":null,"quantity":0,"rate":0,"total":0,"section":""}],"printed_subtotals":{}}
Rules: one line_items object per charge row; "section" = the section heading it sits under; "unit" = null if the bill has no unit column; "printed_subtotals" = each "Total for <section>" figure printed on the bill, copied even if it does not match the sum of the lines. "patient_signature" / "authorised_signature" = true only if that signature block is visibly present on the page. A cover letter, TPA authorisation letter, or payment receipt that is NOT itself an itemised charge listing should also get "is_hospital_bill": false — those are valid hospital documents, just not the bill this tool checks. Numbers as numbers, no symbols, no commas.`;

// On every response (R16). nosniff: a JSON or text answer is never run as a
// script. DENY + frame-ancestors (in the CSP): the page cannot be framed by
// another site. The referrer sent to other sites is just this origin.
// same-origin-allow-popups keeps Google's sign-in popup working.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
};
function send(res, code, body, type, extra) {
  res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Type': type || 'text/plain; charset=utf-8', ...(extra || {}) });
  res.end(body);
}
function sendJson(res, code, obj, extra) { send(res, code, JSON.stringify(obj), TYPES['.json'], extra); }

/* ---- abuse limits (in-memory; see header comment for what that means) ---- */
const ipHits = new Map();
let day = new Date().toISOString().slice(0, 10), dayCount = 0;
// Cloud Run appends the real client address to the END of X-Forwarded-For, so
// the right-most entry is the one a caller cannot spoof by sending the header.
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : req.socket.remoteAddress || 'unknown';
}
// admit(req, false) only CHECKS the limits; admit(req, true) checks and counts.
// A request is checked first (so a capped caller is turned away before its body
// is read) but counted only just before the paid upstream call, so malformed,
// oversized or wrong-type requests never spend the daily cap or a caller's
// allowance. Requests that are in flight at the same moment can pass the check
// together, so the cap can be overshot by at most the number of concurrent
// requests; the recheck at count time keeps that bounded.
function admit(req, count) {
  const now = Date.now(), today = new Date(now).toISOString().slice(0, 10);
  if (today !== day) { day = today; dayCount = 0; }
  if (dayCount >= DAILY_CAP) return { ok: false, why: 'daily' };
  const ip = clientIp(req);
  const recent = (ipHits.get(ip) || []).filter(t => now - t < IP_WINDOW_MS);
  if (recent.length >= IP_MAX) { ipHits.set(ip, recent); return { ok: false, why: 'ip' }; }
  if (count) {
    recent.push(now); ipHits.set(ip, recent); dayCount++;
    if (ipHits.size > 5000) for (const [k, v] of ipHits) if (!v.some(t => now - t < IP_WINDOW_MS)) ipHits.delete(k);
  }
  return { ok: true };
}
// A sliding-window counter: records one hit for `key` and says whether it is
// still within `max` hits per `windowMs`.
function slide(map, key, max, windowMs) {
  const now = Date.now();
  const recent = (map.get(key) || []).filter(t => now - t < windowMs);
  if (recent.length >= max) { map.set(key, recent); return false; }
  recent.push(now); map.set(key, recent);
  if (map.size > 5000) for (const [k, v] of map) if (!v.some(t => now - t < windowMs)) map.delete(k);
  return true;
}
// Every POST to the reader counts here, before anything else is looked at:
// the main cap above only counts valid photos, so a flood of malformed or
// oversized uploads used to cost nothing to send and was never turned away.
const ipAttempts = new Map();
const admitAttempt = req => slide(ipAttempts, clientIp(req), ATTEMPT_MAX, IP_WINDOW_MS);

// At most READ_INFLIGHT_MAX reads at once. A request waiting for a turn has
// not had its upload read yet (the stream is paused), so waiting costs almost
// no memory; at 4 x 10 MB plus copies, reading stays well inside 512 MiB.
// Cloud Run accepts up to 80 requests per instance, so without this a burst
// of large uploads could exhaust the instance.
let inFlight = 0; const waiting = [];
function acquireSlot() {
  if (inFlight < READ_INFLIGHT_MAX) { inFlight++; return Promise.resolve(true); }
  if (waiting.length >= READ_QUEUE_MAX) return Promise.resolve(false);
  return new Promise(resolve => {
    const w = { resolve, timer: setTimeout(() => { const i = waiting.indexOf(w); if (i >= 0) waiting.splice(i, 1); resolve(false); }, READ_QUEUE_WAIT_MS) };
    waiting.push(w);
  });
}
function releaseSlot() {
  const w = waiting.shift();
  if (w) { clearTimeout(w.timer); w.resolve(true); } else inFlight = Math.max(0, inFlight - 1);
}

const BUSY = { error: 'busy', message:'The free reading service is busy right now. Try again in a few minutes, or use your own free Gemini key.' };

/* ---- Reader status (R14): what the upload area tells people BEFORE they
   try, instead of after a failed read. 'busy' = today's cap is used up;
   'overloaded' = Google's own service answered 503 in the last 15 minutes and
   has not succeeded since. Same in-memory, per-instance caveat as the caps:
   another instance may know better; it is a hint, not a guarantee. */
let lastUpstreamOkAt = 0, lastUpstreamOverloadAt = 0;
const OVERLOAD_WINDOW_MS = 15 * 60 * 1000;
// 'broken' (R16) = Google refused the KEY or the MODEL itself: the key was
// revoked or expired, the API was switched off, or the model was retired.
// Every read fails until someone fixes it, so the page should send people to
// the own-key route at once, and the owner should be told. A bad photo is a
// 400 too, so a 400 counts only when Google names the key as the reason.
// It stays 'broken' until a read or the key check below succeeds again.
let lastUpstreamBrokenAt = 0, lastKeyOkAt = 0;
function isBrokenAnswer(status, bodyText) {
  if (status === 401 || status === 403 || status === 404) return true;
  return status === 400 && /API_KEY_INVALID|API_KEY_EXPIRED|API key (not valid|expired)/i.test(bodyText || '');
}
// The key check: Google's model-metadata endpoint, which reads no photo and
// uses no generation quota. At most once per 5 minutes per instance; only
// /api/health (the uptime check) triggers it.
const PROBE_TTL_MS = 5 * 60 * 1000;
let probe = { at: 0, p: null };
function probeGemini() {
  if (!KEY) return Promise.resolve();
  if (probe.p && Date.now() - probe.at < PROBE_TTL_MS) return probe.p;
  probe.at = Date.now();
  probe.p = (async () => {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 8000);
    try {
      const r = await fetch(`${GEMINI_BASE}/v1beta/models/${MODEL}?key=${KEY}`, { signal: ac.signal });
      if (r.ok) { lastKeyOkAt = Date.now(); return; }
      const b = r.status === 400 ? await r.text().catch(() => '') : '';
      if (isBrokenAnswer(r.status, b)) { lastUpstreamBrokenAt = Date.now(); console.log('[probe] key/model refused', r.status); }
      else console.log('[probe] status', r.status);
    } catch (e) { console.log('[probe] network', e && e.name); } // Google unreachable is not proof of a broken key
    finally { clearTimeout(t); }
  })();
  return probe.p;
}
function readerState() {
  if (!KEY) return 'off';
  if (lastUpstreamBrokenAt > Math.max(lastUpstreamOkAt, lastKeyOkAt)) return 'broken';
  const today = new Date().toISOString().slice(0, 10);
  if (today === day && dayCount >= DAILY_CAP) return 'busy';
  if (lastUpstreamOverloadAt > lastUpstreamOkAt && Date.now() - lastUpstreamOverloadAt < OVERLOAD_WINDOW_MS) return 'overloaded';
  return 'ok';
}
// For the uptime check (R16): 200 while photos can be read (including 'busy'
// and 'overloaded', which pass on their own), 503 when the free reader is off
// or broken, so the owner gets the "site is down" email for those too.
async function healthHandler(req, res) {
  await probeGemini();
  const reader = readerState(), ok = reader !== 'off' && reader !== 'broken';
  sendJson(res, ok ? 200 : 503, { ok, reader }, { 'Cache-Control': 'no-store' });
}

/* ---- Impact counter (R14): "N bill pages read since <date>, ₹X matching
   IRDAI's published lists". Counted HERE, from pages this server actually
   read through Gemini — never from numbers a browser reports, which anyone
   could inflate with one request. The page is run through the app's own
   analyse() (lib/checks.js); the List I + Lists II-IV totals are added, in
   paise. Nothing about the bill is stored: just two running totals. A page
   claiming more than ₹1 lakh of matched charges still counts as a page read,
   but its amount is not added (a made-up photo could otherwise inflate the
   total by crores). Reads made with the user's own key go straight to Google
   and are not counted — the wording on the page says so. */
const IMPACT_ON = !!process.env.FIRESTORE_PROJECT_ID;
const IMPACT_SINCE = process.env.IMPACT_SINCE || '2026-10-05';
const IMPACT_PAGE_CAP_PAISE = 100000 * 100;
let impactCache = null; // {at, body} — one Firestore read per minute per instance at most
function countImpact(jsonText) {
  if (!IMPACT_ON) return;
  let page; try { page = JSON.parse(jsonText); } catch (e) { return; }
  if (!page || page.is_hospital_bill === false || !Array.isArray(page.line_items) || !page.line_items.length) return;
  let paise = 0;
  try { const a = analyse(page); paise = Math.round(((a.exactSum || 0) + (a.subsumedSum || 0)) * 100); } catch (e) { paise = 0; }
  if (!(paise >= 0) || paise > IMPACT_PAGE_CAP_PAISE) paise = 0;
  firestore.incrementImpact(1, paise).then(() => { impactCache = null; })
    .catch(e => console.log('[impact] count failed', String(e.message || e))); // never affects the read itself
}
async function impactHandler(req, res) {
  if (!IMPACT_ON) return sendJson(res, 200, { enabled: false });
  if (impactCache && Date.now() - impactCache.at < 60000) return sendJson(res, 200, impactCache.body);
  try {
    const d = await firestore.readImpact();
    const body = { enabled: true, pages: d.pages, matched: Math.round(d.matchedPaise) / 100, since: IMPACT_SINCE };
    impactCache = { at: Date.now(), body };
    sendJson(res, 200, body);
  } catch (e) { console.log('[impact] read failed', String(e.message || e)); sendJson(res, 200, { enabled: false }); }
}

/* ---- My Bills: auth + rate limit + body reading (separate counters from
   the Gemini proxy above — saving a bill costs nothing, so it gets its own,
   more generous limit rather than competing with photo-reads for the cap) */
const billHits = new Map(), uidWrites = new Map();
const admitBills = req => slide(billHits, clientIp(req), BILLS_IP_MAX, BILLS_IP_WINDOW_MS);
// Saves and edits per Google account (R16): one account cannot fill
// Firestore's free daily writes from many addresses. Deleting is not limited
// here, so "delete all" always works.
const admitUidWrite = uid => slide(uidWrites, uid, UID_WRITE_MAX, BILLS_IP_WINDOW_MS);
const TOO_MANY = { error: 'busy', message: 'Too many changes in a short time. Try again in a few minutes.' };
// Verifies the Authorization: Bearer <Google ID token> header and returns the
// caller's stable Google account id (uid). Sends the error response itself
// and returns null on any failure, so callers can just `if (!uid) return;`.
async function requireUid(req, res) {
  if (!BILLS_ON) { sendJson(res, 501, { error: 'not_configured', message: 'This server has no Google sign-in configured.' }); return null; }
  if (!admitBills(req)) { sendJson(res, 429, { error: 'busy', message: 'Too many requests. Try again in a few minutes.' }, { 'Retry-After': '300' }); return null; }
  const h = String(req.headers['authorization'] || '');
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) { sendJson(res, 401, { error: 'unauthorized', message: 'Sign in with Google to use My Bills.' }); return null; }
  try {
    const claims = await verifyGoogleIdToken(m[1], GOOGLE_CLIENT_ID);
    return claims.sub;
  } catch (e) {
    sendJson(res, e.status === 502 ? 502 : 401, { error: e.code || 'unauthorized', message: e.status === 502 ? 'Could not verify your sign-in right now. Please try again.' : 'Your sign-in has expired. Please sign in again.' });
    return null;
  }
}
function readJsonBody(req, res, maxBytes, onBody) {
  const chunks = []; let size = 0, tooBig = false;
  req.on('data', c => {
    if (tooBig) return;
    size += c.length;
    if (size > maxBytes) { tooBig = true; chunks.length = 0; sendJson(res, 413, { error: 'too_large', message: 'That is too large to save.' }, { Connection: 'close' }); req.resume(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (tooBig) return;
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch (e) { return sendJson(res, 400, { error: 'bad_request', message: 'Request was not valid JSON.' }); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return sendJson(res, 400, { error: 'bad_request', message: 'Request body must be an object.' });
    onBody(parsed);
  });
}
// Only these fields are ever written. savedAt is set by the server, never
// trusted from the client, so bills always sort by when THIS server saved
// them. summary/letter/flags are free-form strings/numbers the browser
// builds from its own (already-tested) analyse() output — the server does
// not interpret them, only stores and returns them for this same uid.
const BILL_CREATE_FIELDS = ['hospitalName', 'billDate', 'netPayable', 'explainedPct', 'explainedAmt', 'deduction', 'flagCounts', 'letter', 'status', 'note', 'sentOn'];
const BILL_PATCH_FIELDS = ['status', 'note', 'sentOn'];
function pick(obj, allowed) { const o = {}; for (const k of allowed) if (Object.prototype.hasOwnProperty.call(obj, k)) o[k] = obj[k]; return o; }
// sentOn (R13): the date the user says they sent the letter — YYYY-MM-DD, a
// real calendar date, not in the future (a day's slack for time zones), or
// null to clear it. Anything else is refused rather than stored.
function validSentOn(v) {
  if (v === null) return true;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const y = +v.slice(0, 4), m = +v.slice(5, 7), d = +v.slice(8, 10), t = Date.UTC(y, m - 1, d), dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return false;
  return t <= Date.now() + 86400000;
}
const BAD_SENT_ON = { error: 'bad_request', message: 'The sent-on date must be a real date (YYYY-MM-DD), not in the future.' };
// What each stored field may hold (R16). They used to be stored as sent, so
// one request could save any type or length of value up to the body limit.
// Every field may be null except status. Sizes are far above what the app
// sends (a 63-line bill's letter is 3,317 characters).
const strOrNull = max => v => v === null || (typeof v === 'string' && v.length <= max);
const numOrNull = (min, max) => v => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max);
const BILL_STATUSES = ['sent', 'insurer_responded', 'resolved', 'no_response'];
const BILL_RULES = {
  hospitalName: strOrNull(200), billDate: strOrNull(60), letter: strOrNull(30000), note: strOrNull(2000),
  netPayable: numOrNull(0, 1e9), explainedAmt: numOrNull(0, 1e9), deduction: numOrNull(0, 1e9), explainedPct: numOrNull(0, 100),
  flagCounts: v => v === null || (!!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 8
    && Object.entries(v).every(([k, n]) => /^[A-Za-z]{1,20}$/.test(k) && Number.isInteger(n) && n >= 0 && n <= 100000)),
  status: v => BILL_STATUSES.includes(v),
  sentOn: validSentOn,
};
const badField = data => Object.keys(data).find(k => !BILL_RULES[k](data[k])) || null;
const badFieldMsg = k => ({ error: 'bad_request', field: k, message: k === 'sentOn' ? BAD_SENT_ON.message : `The field "${k}" has a value that cannot be saved.` });

async function listBillsHandler(req, res) {
  const uid = await requireUid(req, res); if (!uid) return;
  try {
    const bills = await firestore.listBills(uid);
    bills.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
    sendJson(res, 200, { bills });
  } catch (e) { console.log('[bills] list error', String(e.message || e)); sendJson(res, e.status || 500, { error: 'server', message: 'Could not load your saved bills right now.' }); }
}
async function createBillHandler(req, res) {
  const uid = await requireUid(req, res); if (!uid) return;
  readJsonBody(req, res, BILLS_MAX_BODY, async (body) => {
    const data = pick(body, BILL_CREATE_FIELDS);
    if (!data.status) data.status = 'sent';
    const bad = badField(data); if (bad) return sendJson(res, 400, badFieldMsg(bad));
    if (!admitUidWrite(uid)) return sendJson(res, 429, TOO_MANY, { 'Retry-After': '300' });
    data.savedAt = new Date().toISOString();
    try {
      // One count query (Firestore bills it as a single read) keeps each
      // account to BILLS_MAX_PER_USER saved bills.
      if (await firestore.countBills(uid, BILLS_MAX_PER_USER + 1) >= BILLS_MAX_PER_USER)
        return sendJson(res, 409, { error: 'limit', max: BILLS_MAX_PER_USER, message: `You have ${BILLS_MAX_PER_USER} saved bills, the most an account can keep. Delete some before saving more.` });
      const bill = await firestore.createBill(uid, data); sendJson(res, 201, { bill });
    }
    catch (e) { console.log('[bills] create error', String(e.message || e)); sendJson(res, e.status || 500, { error: 'server', message: 'Could not save that bill right now.' }); }
  });
}
async function patchBillHandler(req, res, billId) {
  const uid = await requireUid(req, res); if (!uid) return;
  readJsonBody(req, res, BILLS_MAX_BODY, async (body) => {
    const patch = pick(body, BILL_PATCH_FIELDS);
    if (!Object.keys(patch).length) return sendJson(res, 400, { error: 'bad_request', message: 'Nothing to update.' });
    const bad = badField(patch); if (bad) return sendJson(res, 400, badFieldMsg(bad));
    if (!admitUidWrite(uid)) return sendJson(res, 429, TOO_MANY, { 'Retry-After': '300' });
    try { const bill = await firestore.updateBill(uid, billId, patch); sendJson(res, 200, { bill }); }
    catch (e) { console.log('[bills] update error', String(e.message || e)); sendJson(res, e.status || 500, { error: e.status === 404 ? 'not_found' : 'server', message: e.status === 404 ? 'That saved bill was not found.' : 'Could not update that bill right now.' }); }
  });
}
async function deleteBillHandler(req, res, billId) {
  const uid = await requireUid(req, res); if (!uid) return;
  try { await firestore.deleteBill(uid, billId); sendJson(res, 200, { ok: true }); }
  catch (e) { console.log('[bills] delete error', String(e.message || e)); sendJson(res, e.status || 500, { error: 'server', message: 'Could not delete that bill right now.' }); }
}

async function readBill(req, res) {
  if (!KEY) return sendJson(res, 501, { error: 'not_configured', message: 'Server has no GEMINI_API_KEY set.' });
  if (!admitAttempt(req)) { console.log('[limit] attempts'); req.resume(); return sendJson(res, 429, BUSY, { 'Retry-After': '300', Connection: 'close' }); }
  const gate = admit(req, false);
  if (!gate.ok) { console.log('[limit]', gate.why); return sendJson(res, 429, BUSY, { 'Retry-After': '300' }); }

  // Wait for a turn with the upload not yet read (see acquireSlot).
  req.pause();
  if (!await acquireSlot()) {
    console.log('[limit] queue full');
    req.resume(); // discard the upload instead of dropping the connection
    return sendJson(res, 503, { error: 'overloaded', message: 'Many photos are being read right now. Please try again in a moment.' }, { 'Retry-After': '30', Connection: 'close' });
  }
  let released = false;
  const release = () => { if (!released) { released = true; releaseSlot(); } };
  res.on('close', release); res.on('finish', release);
  if (req.destroyed || res.destroyed) return release(); // the phone left while waiting

  const chunks = []; let size = 0, tooBig = false;
  req.on('data', c => {
    if (tooBig) return;
    size += c.length;
    if (size > MAX_BODY) {
      tooBig = true; chunks.length = 0;
      sendJson(res, 413, { error: 'too_large', message: 'That photo is too large. Try a smaller photo or a screenshot.' }, { Connection: 'close' });
      req.resume(); // discard the rest instead of dropping the connection
      return;
    }
    chunks.push(c);
  });
  req.resume();
  req.on('end', async () => {
    if (tooBig) return;
    try {
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (e) { return sendJson(res, 400, { error: 'bad_request', message: 'Request was not valid JSON.' }); }
      const { mime_type, data } = parsed || {};
      if (!data || typeof data !== 'string') return sendJson(res, 400, { error: 'bad_request', message: 'No image data.' });
      const mime = mime_type ? String(mime_type) : 'image/jpeg';
      if (!IMAGE_MIME.test(mime)) return sendJson(res, 415, { error: 'unsupported', message: 'Only photos (JPG, PNG, WebP) can be read.' });

      const body = {
        contents: [{ parts: [{ text: EXTRACT_PROMPT }, { inline_data: { mime_type: mime, data } }] }],
        generationConfig: { temperature: 0, response_mime_type: 'application/json' }
      };
      // The request is valid: count it now (see admit()).
      const paid = admit(req, true);
      if (!paid.ok) { console.log('[limit]', paid.why); return sendJson(res, 429, BUSY, { 'Retry-After': '300' }); }

      // Stop the upstream call if the phone goes away (dropped signal, Cancel
      // pressed) or the timeout passes, so an abandoned read does not keep an
      // instance busy for the full timeout.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
      let clientGone = false;
      res.on('close', () => { clearTimeout(timer); if (!res.writableEnded) { clientGone = true; ac.abort(); } });
      let r;
      try {
        r = await fetch(`${GEMINI_BASE}/v1beta/models/${MODEL}:generateContent?key=${KEY}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
      } catch (e) {
        if (clientGone) { console.log('[upstream] client left, call aborted'); return; }
        console.log('[upstream] timeout/network', e && e.name);
        return sendJson(res, 504, { error: 'timeout', message: 'Reading the photo took too long. Please try again.' });
      }
      if (!r.ok) {
        console.log('[upstream] status', r.status); // status only — never log or forward Google's body
        // Google's answer is read here only to tell a refused key from a bad photo.
        const b = r.status === 400 ? await r.text().catch(() => '') : '';
        if (isBrokenAnswer(r.status, b)) {
          lastUpstreamBrokenAt = Date.now(); console.log('[upstream] key/model refused');
          return sendJson(res, 502, { error: 'broken', message: 'The free reading service is not working right now. You can still read your bill with your own free Gemini key.' });
        }
        if (r.status === 503) lastUpstreamOverloadAt = Date.now();
        if (r.status === 429) return sendJson(res, 429, BUSY, { 'Retry-After': '300' });
        if (r.status === 503) return sendJson(res, 503, { error: 'overloaded', message: 'The reading service is overloaded. Please try again in a moment.' });
        return sendJson(res, 502, { error: 'upstream', message: 'The reading service could not read that photo. Please try again.' });
      }
      let j;
      try { j = await r.json(); }
      catch (e) {
        if (clientGone) return;
        console.log('[upstream] body', e && e.name);
        return sendJson(res, ac.signal.aborted ? 504 : 502, ac.signal.aborted ? { error: 'timeout', message: 'Reading the photo took too long. Please try again.' } : { error: 'unreadable', message: 'The photo could not be read (unreadable answer). Try a clearer photo.' });
      }
      const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!txt.trim()) return sendJson(res, 502, { error: 'empty', message: 'The photo could not be read (empty answer). Try a clearer photo.' });
      const cleaned = txt.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      // A cut-off or non-JSON answer would otherwise reach the browser as a 200
      // and show up as a parser error. Answer with a plain 502 instead.
      let ok = false;
      try { const v = JSON.parse(cleaned); ok = !!v && typeof v === 'object' && !Array.isArray(v); } catch (e) { ok = false; }
      if (!ok) return sendJson(res, 502, { error: 'unreadable', message: 'The photo could not be read (unreadable answer). Try a clearer photo.' });
      lastUpstreamOkAt = Date.now();
      send(res, 200, cleaned, TYPES['.json']);
      countImpact(cleaned); // after the answer is sent: counting can never slow down or break a read
    } catch (e) {
      console.log('[error]', String(e.message || e));
      sendJson(res, 500, { error: 'server', message: 'Something went wrong. Please try again.' });
    }
  });
}

/* ---- Content Security Policy (R16) for the page. Only the page's own
   inline script may run, identified by its SHA-256 hash (worked out here from
   the exact file served, so it can never go stale after an edit), plus
   Google's sign-in library. Anything injected into the page (say, through a
   bill's text) cannot run. Other sources are those the page really uses:
   Google Fonts, Google sign-in, and Gemini directly when a visitor uses their
   own key. Inline style attributes are allowed: the page uses them, and they
   cannot run code. */
function cspFor(html) {
  // Browsers hash the script as parsed, after CRLF line endings become LF.
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(m => `'sha256-${crypto.createHash('sha256').update(m[1].replace(/\r\n?/g, '\n'), 'utf8').digest('base64')}'`);
  return [
    "default-src 'self'",
    `script-src ${hashes.join(' ')} https://accounts.google.com/gsi/client`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data: blob:",
    "connect-src 'self' https://generativelanguage.googleapis.com https://accounts.google.com/gsi/",
    'frame-src https://accounts.google.com/gsi/',
    "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join('; ');
}

/* ---- static files: allowlist, brotli/gzip, ETag, always revalidate ---- */
const staticCache = new Map();
function loadStatic(name) {
  let e = staticCache.get(name);
  if (e) return e;
  const buf = fs.readFileSync(path.join(ROOT, name)), type = TYPES[path.extname(name)] || 'application/octet-stream';
  e = { buf, gz: zlib.gzipSync(buf, { level: 9 }),
    br: zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }),
    etag: '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"', type,
    csp: /^text\/html/.test(type) ? cspFor(buf.toString('utf8')) : null, textual: !/^image\/png/.test(type) };
  staticCache.set(name, e);
  return e;
}
function serveStatic(req, res, name) {
  let e; try { e = loadStatic(name); } catch (err) { return send(res, 404, 'not found'); }
  // no-cache = the browser may keep a copy but must revalidate every time, so
  // a redeploy is seen on the very next load (this app once served stale pages).
  const h = { ...SECURITY_HEADERS, ETag: e.etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding', 'Content-Type': e.type, ...(e.csp ? { 'Content-Security-Policy': e.csp } : {}) };
  if (req.headers['if-none-match'] === e.etag) { res.writeHead(304, h); return res.end(); }
  // Brotli (R16) is about a fifth smaller than gzip for this page; every
  // current browser asks for it over HTTPS.
  const ae = e.textual ? String(req.headers['accept-encoding'] || '') : ''; // a PNG is already compressed
  if (/\bbr\b/.test(ae)) { res.writeHead(200, { ...h, 'Content-Encoding': 'br' }); return res.end(req.method === 'HEAD' ? undefined : e.br); }
  if (/\bgzip\b/.test(ae)) { res.writeHead(200, { ...h, 'Content-Encoding': 'gzip' }); return res.end(req.method === 'HEAD' ? undefined : e.gz); }
  res.writeHead(200, h); res.end(req.method === 'HEAD' ? undefined : e.buf);
}

const BILL_ID_PATH = /^\/api\/bills\/([A-Za-z0-9_-]{1,80})$/;

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/api/read-bill') return readBill(req, res);
  if (url.pathname === '/api/config') return sendJson(res, 200, { proxy: !!KEY, reader: readerState(), bills: BILLS_ON, googleClientId: BILLS_ON ? GOOGLE_CLIENT_ID : null });
  if (req.method === 'GET' && url.pathname === '/api/impact') return impactHandler(req, res);
  if (req.method === 'GET' && url.pathname === '/api/health') return healthHandler(req, res);
  if (req.method === 'GET' && url.pathname === '/api/bills') return listBillsHandler(req, res);
  if (req.method === 'POST' && url.pathname === '/api/bills') return createBillHandler(req, res);
  { const m = BILL_ID_PATH.exec(url.pathname);
    if (m && req.method === 'PATCH') return patchBillHandler(req, res, m[1]);
    if (m && req.method === 'DELETE') return deleteBillHandler(req, res, m[1]); }
  if ((req.method === 'GET' || req.method === 'HEAD') && Object.prototype.hasOwnProperty.call(STATIC, url.pathname)) {
    return serveStatic(req, res, STATIC[url.pathname]);
  }
  send(res, 404, 'not found');
}).listen(PORT, () => console.log(`ClearBill on :${PORT} — Gemini proxy ${KEY ? 'ON' : 'OFF (client key)'} — My Bills ${BILLS_ON ? 'ON' : 'OFF'}`));
