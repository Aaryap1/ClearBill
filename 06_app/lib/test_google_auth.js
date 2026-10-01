/* Tests for lib/google_auth.js's ID-token verification — a real RSA keypair,
 * a hand-signed JWT, and a mock "Google certs" server (no network, no real
 * Google account needed).      node lib/test_google_auth.js
 */
const http = require('http');
const crypto = require('crypto');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); } };
const b64url = buf => Buffer.from(buf).toString('base64url');

(async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key-1', alg: 'RS256', use: 'sig' };
  const CLIENT_ID = '12345-test.apps.googleusercontent.com';

  function sign(claims, { kid = 'test-key-1', alg = 'RS256', key = privateKey } = {}) {
    const header = { alg, typ: 'JWT', kid };
    const h = b64url(JSON.stringify(header)), p = b64url(JSON.stringify(claims));
    const sig = crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), key);
    return h + '.' + p + '.' + b64url(sig);
  }
  const now = Math.floor(Date.now() / 1000);
  function claims(extra) { return { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'user-sub-42', email: 'person@example.com', email_verified: true, name: 'Test Person', iat: now - 5, exp: now + 3600, ...extra }; }

  const certsServer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise(r => certsServer.listen(0, '127.0.0.1', r));
  process.env.GOOGLE_CERTS_URL = `http://127.0.0.1:${certsServer.address().port}/certs`;

  const { verifyGoogleIdToken, _resetCaches } = require('./google_auth');
  _resetCaches();

  console.log('== valid token');
  let c = await verifyGoogleIdToken(sign(claims()), CLIENT_ID);
  ok(c.sub === 'user-sub-42' && c.email === 'person@example.com' && c.emailVerified === true && c.name === 'Test Person', 'a correctly signed, current token verifies and returns the right claims');

  console.log('== rejections');
  async function rejects(token, cid, codeExpect, label) {
    try { await verifyGoogleIdToken(token, cid); ok(false, label, 'did not throw'); }
    catch (e) { ok(e.code === codeExpect, label, `code was ${e.code}, expected ${codeExpect}`); }
  }
  await rejects(sign(claims({ aud: 'someone-else.apps.googleusercontent.com' })), CLIENT_ID, 'bad_audience', 'wrong audience is rejected');
  await rejects(sign(claims({ iss: 'https://evil.example.com' })), CLIENT_ID, 'bad_issuer', 'wrong issuer is rejected');
  await rejects(sign(claims({ exp: now - 10 })), CLIENT_ID, 'expired', 'an expired token is rejected');
  await rejects(sign(claims({ iat: now + 10000 })), CLIENT_ID, 'bad_iat', 'a token issued in the future is rejected');
  await rejects('not.a.jwt'.split('.').map(s => Buffer.from(s).toString('base64url')).join('.'), CLIENT_ID, 'malformed', 'garbage segments are rejected');
  await rejects('only.two', CLIENT_ID, 'malformed', 'a token with the wrong number of segments is rejected');
  await rejects(null, CLIENT_ID, 'no_token', 'a missing token is rejected');
  await rejects(sign(claims({ sub: undefined })), CLIENT_ID, 'no_sub', 'a token with no sub claim is rejected');

  // Tampered payload: take a genuinely signed token and change one character
  // of the (base64url) payload segment without re-signing — the signature
  // must then fail to verify against the altered bytes.
  const good = sign(claims());
  const [h, p, s] = good.split('.');
  const alteredClaims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  alteredClaims.sub = 'attacker-controlled-sub'; // same valid JSON shape, different content, NOT re-signed
  const tamperedPayload = b64url(JSON.stringify(alteredClaims));
  await rejects(h + '.' + tamperedPayload + '.' + s, CLIENT_ID, 'bad_signature', 'a tampered payload fails signature verification');

  // Signed with a DIFFERENT key than the one Google's certs endpoint serves —
  // simulates someone forging a token with their own keypair.
  const forgedKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  await rejects(sign(claims(), { key: forgedKeys.privateKey }), CLIENT_ID, 'bad_signature', "a token signed with a key that isn't Google's is rejected");

  // Unknown kid — forces a cache-refetch path, then still fails (no matching key).
  await rejects(sign(claims(), { kid: 'nonexistent-kid' }), CLIENT_ID, 'unknown_key', 'an unknown key id is rejected');

  await rejects(sign(claims()), '', 'bad_audience', 'no configured client id rejects every token (server misconfiguration is not an open door)');

  console.log('== key rotation: a key added after the first fetch is still found');
  const { publicKey: pk2, privateKey: sk2 } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk2 = { ...pk2.export({ format: 'jwk' }), kid: 'test-key-2', alg: 'RS256', use: 'sig' };
  let servedKeys = [jwk];
  certsServer.removeAllListeners('request');
  certsServer.on('request', (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ keys: servedKeys })); });
  _resetCaches(); // simulate a fresh server process that hasn't cached anything
  await verifyGoogleIdToken(sign(claims()), CLIENT_ID); // populates the cache with just jwk
  servedKeys = [jwk, jwk2]; // Google adds a second key
  const tokenWithNewKey = sign(claims(), { kid: 'test-key-2', key: sk2 });
  const c2 = await verifyGoogleIdToken(tokenWithNewKey, CLIENT_ID);
  ok(c2.sub === 'user-sub-42', 'a key not in the cached set triggers one re-fetch and then verifies');

  certsServer.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
