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
 *    bodies to the browser.
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

const PORT = process.env.PORT || 8080;
const KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash'; // confirmed working 9 Sep 2026 — see 06_app/index.html for the full story
const GEMINI_BASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com';
const ROOT = __dirname;

// Limits. Generous on purpose: many phones share one carrier IP, and a
// 6-page bill is 6 calls. Kept at the previous 20 MB body limit until the app
// downscales photos before upload — tightening it earlier would start
// rejecting phone photos that work today.
const MAX_BODY = Number(process.env.MAX_BODY_BYTES) || 20 * 1024 * 1024;
const IP_MAX = Number(process.env.RATE_MAX_PER_IP) || 60;            // calls per window
const IP_WINDOW_MS = Number(process.env.RATE_WINDOW_MS) || 10 * 60 * 1000;
const DAILY_CAP = Number(process.env.DAILY_CAP) || 600;              // calls per UTC day, per instance
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 90 * 1000;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};
// The only files the app needs. Anything else — including this file — is a 404.
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/manifest.json': 'manifest.json', '/icon.svg': 'icon.svg' };
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

function send(res, code, body, type, extra) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', ...(extra || {}) });
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
const BUSY = { error: 'busy', message: 'The free reading service is busy right now. Try again in a few minutes, or use your own free Gemini key.' };

async function readBill(req, res) {
  if (!KEY) return sendJson(res, 501, { error: 'not_configured', message: 'Server has no GEMINI_API_KEY set.' });
  const gate = admit(req, false);
  if (!gate.ok) { console.log('[limit]', gate.why); return sendJson(res, 429, BUSY, { 'Retry-After': '300' }); }

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
      send(res, 200, cleaned, TYPES['.json']);
    } catch (e) {
      console.log('[error]', String(e.message || e));
      sendJson(res, 500, { error: 'server', message: 'Something went wrong. Please try again.' });
    }
  });
}

/* ---- static files: allowlist, gzip, ETag, always revalidate ---- */
const staticCache = new Map();
function loadStatic(name) {
  let e = staticCache.get(name);
  if (e) return e;
  const buf = fs.readFileSync(path.join(ROOT, name));
  e = { buf, gz: zlib.gzipSync(buf, { level: 9 }), etag: '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"', type: TYPES[path.extname(name)] || 'application/octet-stream' };
  staticCache.set(name, e);
  return e;
}
function serveStatic(req, res, name) {
  let e; try { e = loadStatic(name); } catch (err) { return send(res, 404, 'not found'); }
  // no-cache = the browser may keep a copy but must revalidate every time, so
  // a redeploy is seen on the very next load (this app once served stale pages).
  const h = { ETag: e.etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding', 'Content-Type': e.type };
  if (req.headers['if-none-match'] === e.etag) { res.writeHead(304, h); return res.end(); }
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) { res.writeHead(200, { ...h, 'Content-Encoding': 'gzip' }); return res.end(e.gz); }
  res.writeHead(200, h); res.end(e.buf);
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/api/read-bill') return readBill(req, res);
  if (url.pathname === '/api/config') return sendJson(res, 200, { proxy: !!KEY });
  if ((req.method === 'GET' || req.method === 'HEAD') && Object.prototype.hasOwnProperty.call(STATIC, url.pathname)) {
    return serveStatic(req, res, STATIC[url.pathname]);
  }
  send(res, 404, 'not found');
}).listen(PORT, () => console.log(`ClearBill on :${PORT} — Gemini proxy ${KEY ? 'ON' : 'OFF (client key)'}`));
