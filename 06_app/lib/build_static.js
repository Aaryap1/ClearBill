/* The backup copy of ClearBill (R25), served free by GitHub Pages from this
 * public repository, so the app stays usable if the Cloud Run site is down
 * (for example if the Google Cloud trial ends without an upgrade).
 *
 *   node lib/build_static.js [outDir]      default: ../_site (repo root)
 *
 * It is the same index.html, with three tags added at the top of <head>:
 *   - the page's Content Security Policy as a <meta> tag (GitHub Pages cannot
 *     send headers), from lib/csp.js, without Google sign-in;
 *   - <meta name="clearbill-backup">, which makes the page say it is the
 *     backup copy (photo reading needs the visitor's own free Gemini key;
 *     saving to a Google account needs the main site);
 *   - noindex and a canonical link, so search engines send people to the
 *     main site, not the copy.
 * With no server behind it, /api/config fails, so the page already falls back
 * to the visitor's own key; nothing else changes. Run by
 * .github/workflows/pages.yml on every push to main that touches 06_app.
 */
const fs = require('fs');
const path = require('path');
const { cspFor } = require('./csp.js');

const APP = path.join(__dirname, '..');
const MAIN = 'https://clearbill-e7sodufiva-el.a.run.app/';
const FILES = ['manifest.json', 'icon.svg', 'og.png', 'robots.txt'];

function buildBackupHtml(html) {
  const anchor = '<meta charset="UTF-8" />';
  if (!html.includes(anchor)) throw new Error('index.html has no <meta charset="UTF-8" /> to anchor the backup tags');
  const tags = [
    `<meta http-equiv="Content-Security-Policy" content="${cspFor(html, { backup: true })}" />`,
    '<meta name="clearbill-backup" content="1" />',
    '<meta name="robots" content="noindex" />',
    `<link rel="canonical" href="${MAIN}" />`,
  ].join('\n');
  return html.replace(anchor, anchor + '\n' + tags);
}

function build(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(outDir, 'index.html'), buildBackupHtml(html));
  for (const f of FILES) fs.copyFileSync(path.join(APP, f), path.join(outDir, f));
  fs.writeFileSync(path.join(outDir, '.nojekyll'), ''); // serve files as they are
  return outDir;
}

if (require.main === module) {
  const out = path.resolve(process.argv[2] || path.join(APP, '..', '_site'));
  build(out);
  console.log('backup copy written to ' + out);
}
module.exports = { build, buildBackupHtml, MAIN };
