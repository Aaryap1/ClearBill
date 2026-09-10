/* ClearBill — Cloud Run server.
 * Serves the static app AND proxies the Gemini call so the API key stays
 * server-side (set GEMINI_API_KEY as an env var / Secret Manager binding).
 * No dependencies — Node 18+ built-ins only.
 *
 * When GEMINI_API_KEY is set, the app's key field hides itself and POSTs the
 * image to /api/read-bill instead of calling Google directly.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash'; // confirmed working 9 Sep 2026 — see 06_app/index.html for the full story
const ROOT = __dirname;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'
};

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

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8' });
  res.end(body);
}

async function readBill(req, res) {
  if (!KEY) return send(res, 501, JSON.stringify({ error: 'Server has no GEMINI_API_KEY set.' }), TYPES['.json']);
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 20 * 1024 * 1024) req.destroy(); });
  req.on('end', async () => {
    try {
      const { mime_type, data } = JSON.parse(raw);
      if (!data) throw new Error('no image data');
      const body = {
        contents: [{ parts: [{ text: EXTRACT_PROMPT }, { inline_data: { mime_type: mime_type || 'image/jpeg', data } }] }],
        generationConfig: { temperature: 0, response_mime_type: 'application/json' }
      };
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) return send(res, r.status, JSON.stringify(j), TYPES['.json']);
      const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      send(res, 200, txt.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''), TYPES['.json']);
    } catch (e) {
      send(res, 400, JSON.stringify({ error: String(e.message || e) }), TYPES['.json']);
    }
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/api/read-bill') return readBill(req, res);
  if (url.pathname === '/api/config') return send(res, 200, JSON.stringify({ proxy: !!KEY }), TYPES['.json']);

  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) return send(res, 403, 'forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, buf, TYPES[path.extname(file)] || 'application/octet-stream');
  });
}).listen(PORT, () => console.log(`ClearBill on :${PORT} — Gemini proxy ${KEY ? 'ON' : 'OFF (client key)'}`));
