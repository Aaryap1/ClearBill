/* ClearBill on WhatsApp — v1: send a photo of an itemised bill page, get a
 * plain-text summary of the checks that are safe to run on a single page.
 *
 * Same principle as the web app: Gemini only READS the photo into rows; every
 * flag is deterministic code (lib/checks.js, generated from index.html) that
 * names its source. Nothing here judges a bill by asking a model.
 *
 * Deliberately NOT in v1 (and the reply says so, rather than implying it):
 *  - bill-total reconciliation and IS 19493 completeness — both need every
 *    page of the bill together; on one page they'd produce false findings.
 *  - the settlement calculator and the letter builder — multi-turn flows that
 *    need per-user state; they stay in the web app.
 *
 * Node built-ins only, like the rest of the server. All I/O goes through
 * injected deps so the whole flow is testable without Meta or Google.
 */
const crypto = require('crypto');
const checks = require('./checks.js');

const inr = n => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });

/* ---- Meta protocol helpers ---- */

// X-Hub-Signature-256: "sha256=" + HMAC-SHA256(raw body, app secret).
function verifySignature(rawBody, header, appSecret) {
  if (!appSecret || !header || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const got = header.slice(7);
  const a = Buffer.from(expected, 'utf8'), b = Buffer.from(got, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// GET handshake when you register the webhook in the Meta dashboard.
function handleVerify(query, verifyToken) {
  if (query.get('hub.mode') === 'subscribe' && verifyToken && query.get('hub.verify_token') === verifyToken) {
    return { status: 200, body: query.get('hub.challenge') || '' };
  }
  return { status: 403, body: 'forbidden' };
}

// Flatten entry[].changes[].value.messages[] (ignore delivery/read statuses).
function extractMessages(payload) {
  const out = [];
  if (!payload || payload.object !== 'whatsapp_business_account') return out;
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      if (change.field !== 'messages' || !Array.isArray(v.messages)) continue;
      for (const m of v.messages) {
        out.push({
          phoneNumberId: v.metadata && v.metadata.phone_number_id,
          from: m.from, id: m.id, type: m.type,
          text: m.text && m.text.body,
          mediaId: m.image && m.image.id,
          mime: m.image && m.image.mime_type,
        });
      }
    }
  }
  return out;
}

/* ---- Reply text ---- */

const WELCOME =
  '*ClearBill* checks a hospital bill against India\'s published rules.\n\n' +
  'Send me a clear photo of a page of your *itemised* bill (the page listing each charge) and I\'ll reply with what I find.\n\n' +
  'हिंदी: अपने अस्पताल के बिल के चार्ज वाले पन्ने की साफ़ फ़ोटो भेजें।\n' +
  'मराठी: तुमच्या रुग्णालयाच्या बिलाच्या चार्जेस असलेल्या पानाचा स्पष्ट फोटो पाठवा.\n\n' +
  'Your photo is sent to Google\'s Gemini API to be read, once. ClearBill doesn\'t store it.';

const READING = 'Got it — reading your bill now. This takes about 30 seconds.';
const NOT_A_BILL = 'That doesn\'t look like a page from an itemised hospital bill. Please send a clear photo of the page that lists each charge — not a cover letter or a receipt.';
const NOT_AN_IMAGE = 'Please send a photo (JPG or PNG). For a PDF, screenshot each page and send those.';
const FAILED = 'Sorry — I couldn\'t read that photo. Please try again with a clearer, well-lit photo of one page.';
const BUSY = 'You\'ve sent several photos in a short time. Please wait a few minutes and try again.';

function formatFindings(a, nLines, webUrl) {
  const L = ['*ClearBill — bill check*', `Read ${nLines} line item${nLines === 1 ? '' : 's'} from this page.`, ''];
  let flagged = false;

  if (a.exact.length) {
    flagged = true;
    L.push(`• *${a.exact.length} charge${a.exact.length > 1 ? 's' : ''}* match the published non-payable lists — ${inr(a.exactSum)}`);
  }
  if (a.review.length) {
    flagged = true;
    L.push(`• ${a.review.length} charge${a.review.length > 1 ? 's' : ''} commonly deducted but *not named* in the list — ${inr(a.reviewSum)}. Confirm with your insurer; this is not a finding.`);
  }
  if (a.nppa.length) {
    flagged = true;
    const allVerified = a.nppa.every(n => n.grade === 'verified');
    L.push(allVerified
      ? `• *${a.nppa.length} implant${a.nppa.length > 1 ? 's' : ''}* priced above the NPPA ceiling (a legal price cap).`
      : `• ${a.nppa.length} implant${a.nppa.length > 1 ? 's' : ''} priced above a published NPPA ceiling — not independently re-confirmed by ClearBill, so confirm it is still current before relying on it.`);
  }
  if (a.dups.length) {
    flagged = true;
    L.push(`• ${a.dups.length} charge${a.dups.length > 1 ? 's' : ''} appear more than once at the same amount.`);
  }
  if (!flagged) {
    L.push('Nothing flagged on this page. That is not a clean bill of health for the whole bill — other pages, and the checks below, still matter.');
  }

  const top = a.exact.slice().sort((x, y) => (y.total || 0) - (x.total || 0)).slice(0, 5);
  if (top.length) {
    L.push('', '*Largest matches:*');
    top.forEach((l, i) => L.push(`${i + 1}. ${l.item} — ${inr(l.total)} (${l.basis === 'policy_exclusion' ? 'policy exclusion' : 'IRDAI List I'}: ${l.matched})`));
  }
  const twice = a.dups.slice(0, 3);
  if (twice.length) {
    L.push('', '*Charged more than once:*');
    twice.forEach(d => L.push(`• ${d.item} — ${inr(d.amount)}, ${d.n} times`));
  }

  L.push('', '_Not checked here:_ the bill total against its lines, and bill-format completeness — those need every page together. For the full report, the settlement breakdown and a complaint letter, open ' + webUrl);
  L.push('', 'Your photo was sent to Google\'s Gemini API to be read, once. ClearBill doesn\'t store it.');
  return L.join('\n');
}

/* ---- The bot ---- */

function createBot(opts) {
  const {
    env, fetchImpl = fetch, extractPrompt, webUrl,
    graphBase = 'https://graph.facebook.com', graphVersion = env.WHATSAPP_GRAPH_VERSION || 'v22.0',
    geminiBase = 'https://generativelanguage.googleapis.com', log = () => {},
    now = () => Date.now(),
  } = opts;

  const seen = new Map();      // message id -> ts (Meta retries; best-effort per instance)
  const perSender = new Map(); // from -> [timestamps] of accepted photos
  const MAX_PHOTOS = 6, WINDOW_MS = 10 * 60 * 1000;
  const mask = n => '***' + String(n || '').slice(-4);

  async function graph(pathAndQuery, init) {
    return fetchImpl(`${graphBase}/${graphVersion}/${pathAndQuery}`, {
      ...init, headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, ...(init && init.headers) },
    });
  }
  async function sendText(to, body) {
    const r = await graph(`${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: body.slice(0, 4000) } }),
    });
    if (!r.ok) log('send failed', r.status);
  }
  async function downloadMedia(mediaId) {
    const meta = await graph(mediaId);
    if (!meta.ok) throw new Error('media lookup ' + meta.status);
    const { url, mime_type } = await meta.json();
    const bin = await fetchImpl(url, { headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` } });
    if (!bin.ok) throw new Error('media download ' + bin.status);
    return { mime: mime_type || 'image/jpeg', b64: Buffer.from(await bin.arrayBuffer()).toString('base64') };
  }
  async function extract(mime, b64) {
    const body = {
      contents: [{ parts: [{ text: extractPrompt }, { inline_data: { mime_type: mime, data: b64 } }] }],
      generationConfig: { temperature: 0, response_mime_type: 'application/json' },
    };
    const r = await fetchImpl(`${geminiBase}/v1beta/models/${env.GEMINI_MODEL || 'gemini-3.6-flash'}:generateContent?key=${env.GEMINI_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('gemini ' + r.status);
    const j = await r.json();
    const txt = (j.candidates && j.candidates[0] && j.candidates[0].content.parts[0].text) || '';
    return JSON.parse(txt.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  }

  function allowed(from) {
    const t = now();
    const recent = (perSender.get(from) || []).filter(x => t - x < WINDOW_MS);
    if (recent.length >= MAX_PHOTOS) { perSender.set(from, recent); return false; }
    recent.push(t); perSender.set(from, recent); return true;
  }

  async function handleMessage(m) {
    if (env.WHATSAPP_PHONE_NUMBER_ID && m.phoneNumberId && m.phoneNumberId !== env.WHATSAPP_PHONE_NUMBER_ID) return;
    const t = now();
    if (seen.has(m.id)) return;
    seen.set(m.id, t);
    for (const [k, ts] of seen) if (t - ts > WINDOW_MS) seen.delete(k);

    if (m.type === 'text') return sendText(m.from, WELCOME);
    if (m.type !== 'image') return sendText(m.from, NOT_AN_IMAGE);
    if (!allowed(m.from)) return sendText(m.from, BUSY);

    await sendText(m.from, READING);
    try {
      const { mime, b64 } = await downloadMedia(m.mediaId);
      const data = await extract(mime, b64);
      if (data.is_hospital_bill === false || !Array.isArray(data.line_items) || !data.line_items.length) {
        return sendText(m.from, NOT_A_BILL);
      }
      const a = checks.analyse(data);
      await sendText(m.from, formatFindings(a, a.lines.length, webUrl));
      log('replied', mask(m.from), a.lines.length + ' lines');
    } catch (e) {
      log('failed', mask(m.from), String(e.message || e)); // status only — never message content
      await sendText(m.from, FAILED);
    }
  }

  async function handlePayload(payload) {
    for (const m of extractMessages(payload)) {
      try { await handleMessage(m); } catch (e) { log('handler error', String(e.message || e)); }
    }
  }
  return { handlePayload, handleMessage };
}

module.exports = { verifySignature, handleVerify, extractMessages, formatFindings, createBot, WELCOME, NOT_A_BILL, NOT_AN_IMAGE, FAILED, BUSY };
