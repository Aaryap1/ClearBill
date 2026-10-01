/* Google sign-in verification + GCP access tokens — zero dependencies,
 * Node 18+ built-ins only (same rule as server.js: no npm, no node_modules,
 * no "npm install" step in the Docker build).
 *
 * Two jobs:
 *  1. verifyGoogleIdToken(idToken, clientId) — checks a Google Identity
 *     Services ID token the BROWSER sends us (RS256, signed by Google),
 *     without any library: fetch Google's public keys, verify the
 *     signature with Node's own crypto, check aud/iss/exp by hand.
 *  2. getAccessToken() — the access token OUR SERVER uses to call the
 *     Firestore REST API, fetched from the Cloud Run instance's attached
 *     service account via the metadata server (no key file, no secret to
 *     leak — this only works because the service account already has
 *     roles/datastore.user on the project; see 02_reference_data or the
 *     R9 change-log entry for how that was granted).
 *
 * Both are deliberately hand-rolled rather than pulling in
 * google-auth-library / firebase-admin: this app has stayed dependency-free
 * since R0 (see server.js's header comment), and the two things an OAuth
 * library gives you — JWK verification and a metadata-server token fetch —
 * are each under 60 lines of built-in crypto/fetch once written out.
 */
const crypto = require('crypto');

const CERTS_URL = process.env.GOOGLE_CERTS_URL || 'https://www.googleapis.com/oauth2/v3/certs';
const METADATA_BASE = process.env.GCE_METADATA_BASE || 'http://metadata.google.internal';
const ALLOWED_ISS = new Set(['accounts.google.com', 'https://accounts.google.com']);

function b64urlToBuf(s) { return Buffer.from(s, 'base64url'); }
function jsonFromB64url(s) { return JSON.parse(b64urlToBuf(s).toString('utf8')); }

/* ---- Google's public signing keys, cached in memory ---- */
let certsCache = null; // { byKid: Map<kid, KeyObject>, fetchedAt }
const CERTS_TTL_MS = 60 * 60 * 1000; // Google rotates these every few weeks; an hour is plenty fresh

async function getCerts(force) {
  if (!force && certsCache && Date.now() - certsCache.fetchedAt < CERTS_TTL_MS) return certsCache;
  const r = await fetch(CERTS_URL);
  if (!r.ok) throw Object.assign(new Error('could not fetch Google signing keys'), { status: 502, code: 'certs_unavailable' });
  const j = await r.json();
  const byKid = new Map();
  for (const jwk of j.keys || []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    try { byKid.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })); } catch (e) { /* skip a key we can't parse */ }
  }
  certsCache = { byKid, fetchedAt: Date.now() };
  return certsCache;
}

/* Verifies a Google Identity Services ID token. Throws { status, code,
 * message } on any failure (bad signature, wrong audience, expired, wrong
 * issuer, malformed). On success returns { sub, email, emailVerified, name }
 * — sub is Google's stable per-account ID; that's what we key saved bills on,
 * never the email (an email can be reused or changed; sub cannot). */
async function verifyGoogleIdToken(idToken, clientId) {
  const bad = (code, message, status) => { throw Object.assign(new Error(message), { status: status || 401, code }); };
  if (!idToken || typeof idToken !== 'string') bad('no_token', 'No sign-in token.');
  const parts = idToken.split('.');
  if (parts.length !== 3) bad('malformed', 'That sign-in token is not valid.');
  const [headerB64, payloadB64, sigB64] = parts;
  let header, payload;
  try { header = jsonFromB64url(headerB64); payload = jsonFromB64url(payloadB64); }
  catch (e) { bad('malformed', 'That sign-in token is not valid.'); }
  if (header.alg !== 'RS256') bad('bad_alg', 'Unexpected sign-in token algorithm.');

  let certs = await getCerts(false);
  let key = certs.byKid.get(header.kid);
  if (!key) { certs = await getCerts(true); key = certs.byKid.get(header.kid); } // key rotated since our last fetch
  if (!key) bad('unknown_key', 'Could not verify that sign-in token (unknown signing key).');

  const signingInput = Buffer.from(headerB64 + '.' + payloadB64, 'utf8');
  let sigOk = false;
  try { sigOk = crypto.verify('RSA-SHA256', signingInput, key, b64urlToBuf(sigB64)); } catch (e) { sigOk = false; }
  if (!sigOk) bad('bad_signature', 'That sign-in token failed verification.');

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) bad('expired', 'That sign-in has expired. Please sign in again.');
  if (payload.iat && payload.iat > now + 300) bad('bad_iat', 'That sign-in token is not valid yet.');
  if (!ALLOWED_ISS.has(payload.iss)) bad('bad_issuer', 'That sign-in token is not from Google.');
  if (!clientId || payload.aud !== clientId) bad('bad_audience', 'That sign-in token was not issued for this app.');
  if (!payload.sub) bad('no_sub', 'That sign-in token has no account ID.');

  return { sub: payload.sub, email: payload.email || null, emailVerified: !!payload.email_verified, name: payload.name || null };
}

/* ---- access token for OUR server to call Firestore ---- */
let tokenCache = null; // { token, expiresAt }

async function getAccessToken() {
  if (process.env.GOOGLE_ACCESS_TOKEN) return process.env.GOOGLE_ACCESS_TOKEN; // test/dev override — see lib/test_firestore_rest.js
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.token;
  const r = await fetch(METADATA_BASE + '/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } });
  if (!r.ok) throw Object.assign(new Error('could not get a GCP access token from the metadata server'), { status: 500, code: 'no_metadata_token' });
  const j = await r.json();
  if (!j.access_token) throw Object.assign(new Error('metadata server returned no access token'), { status: 500, code: 'no_metadata_token' });
  tokenCache = { token: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return tokenCache.token;
}

// exported for tests only, to force a re-fetch between cases
function _resetCaches() { certsCache = null; tokenCache = null; }

module.exports = { verifyGoogleIdToken, getAccessToken, _resetCaches };
