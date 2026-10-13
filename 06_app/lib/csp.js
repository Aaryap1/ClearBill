/* Content Security Policy for the page (R16; shared since R25).
 *
 * Only the page's own inline script may run, identified by its SHA-256 hash
 * (worked out from the exact file served, so it can never go stale after an
 * edit), plus Google's sign-in library. Anything injected into the page (say,
 * through a bill's text) cannot run. Other sources are those the page really
 * uses: Google Fonts, Google sign-in, and Gemini directly when a visitor uses
 * their own key. Inline style attributes are allowed: the page uses them, and
 * they cannot run code.
 *
 * server.js sends it as a header. lib/build_static.js puts the backup copy's
 * version in a <meta> tag (GitHub Pages cannot send headers): that copy has
 * no Google sign-in, so Google's sign-in sources are left out, and
 * frame-ancestors is left out because browsers ignore it in a <meta> tag.
 */
const crypto = require('crypto');

function cspFor(html, { backup = false } = {}) {
  // Browsers hash the script as parsed, after CRLF line endings become LF.
  const hashes = [...String(html).matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(m => `'sha256-${crypto.createHash('sha256').update(m[1].replace(/\r\n?/g, '\n'), 'utf8').digest('base64')}'`);
  const gsi = backup ? '' : ' https://accounts.google.com/gsi/';
  return [
    "default-src 'self'",
    `script-src ${hashes.join(' ')}${backup ? '' : ' https://accounts.google.com/gsi/client'}`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com${backup ? '' : ' https://accounts.google.com/gsi/style'}`,
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data: blob:",
    `connect-src 'self' https://generativelanguage.googleapis.com${gsi}`,
    ...(backup ? [] : ['frame-src https://accounts.google.com/gsi/']),
    "object-src 'none'", "base-uri 'none'", "form-action 'none'",
    ...(backup ? [] : ["frame-ancestors 'none'"]),
  ].join('; ');
}

module.exports = { cspFor };
