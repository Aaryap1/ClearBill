/* Monthly check that the official lists copied into the app are still current (R23).
 *
 * The app holds copies of pages that change without notice:
 *   - IRDAI's list of insurers' grievance officers (GRO, read 9 Oct 2026)
 *   - the Council for Insurance Ombudsmen's office list (OMBUDSMAN)
 * and two dated price rules:
 *   - NPPA's knee-implant ceilings, published as valid until 15 Nov 2026
 *   - the stent ceilings, which have been revised each 1 April.
 *
 * For each page it reads every email address on it and compares the set with
 * the one saved in 02_reference_data/freshness_baseline.json when the app's
 * copy was last checked; it also confirms every address the app shows is still
 * on the page. The dated rules are reminders by date (nppa.gov.in serves an
 * incomplete certificate chain, so it is not fetched).
 *
 *   node lib/freshness.js                  print the report (exit 0 either way)
 *   node lib/freshness.js --out report.md  also write it, and "changed=true|false"
 *                                          to $GITHUB_OUTPUT when run by Actions
 *   node lib/freshness.js --update-baseline  after re-reading a list into the app
 *
 * Run monthly by .github/workflows/reference-check.yml, which opens (or adds to)
 * a GitHub issue when anything needs a person to look. It never edits the app:
 * a changed list is re-read by hand, as R13 and R22 did.
 */
const fs = require('fs');
const path = require('path');
const c = require('./checks.js');

const BASELINE = path.join(__dirname, '..', '..', '02_reference_data', 'freshness_baseline.json');
const SOURCES = [
  { key: 'gro', name: "IRDAI's list of insurers' grievance officers", url: 'https://irdai.gov.in/list-of-gros',
    ours: () => c.GRO.map(g => g.email), where: 'GRO in 06_app/index.html (and GRO_LIST_UPDATED / GRO_READ_ON)' },
  { key: 'ombudsman', name: 'Insurance Ombudsman offices (Council for Insurance Ombudsmen)', url: 'https://www.cioins.co.in/Ombudsman',
    ours: () => c.OMBUDSMAN.map(o => o.email), where: 'OMBUDSMAN in 06_app/index.html (and OMBUDSMAN_READ_ON)' },
];
const DAY = 86400000;

// Every email address in a page, lower-cased, de-duplicated and sorted. Pages
// sometimes write them as "name[at]domain[dot]in"; those are read too.
function extractEmails(html) {
  const t = String(html).replace(/<[^>]+>/g, ' ').replace(/&#64;|&commat;/g, '@')
    .replace(/\s*[\[(]\s*at\s*[\])]\s*/gi, '@').replace(/\s*[\[(]\s*dot\s*[\])]\s*/gi, '.');
  const set = new Set((t.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []).map(e => e.toLowerCase().replace(/\.+$/, '')));
  return [...set].sort();
}

// What changed on one page: addresses added or removed since the baseline,
// and any address the app shows that the page no longer has.
function compare(baseline, now, ours) {
  const b = new Set(baseline || []), n = new Set(now);
  return {
    added: now.filter(e => !b.has(e)),
    removed: (baseline || []).filter(e => !n.has(e)),
    oursMissing: [...new Set(ours.map(e => String(e).toLowerCase()))].filter(e => e && !n.has(e)).sort(),
  };
}

// Reminders that depend only on today's date.
function dateReminders(today) {
  const t = +today, out = [];
  const fmt = ms => new Date(ms).toISOString().slice(0, 10);
  if (t >= c.NPPA_KNEE_VALID_TO - 31 * DAY) out.push(t > c.NPPA_KNEE_VALID_TO
    ? `NPPA's knee-implant ceilings were published as valid until ${fmt(c.NPPA_KNEE_VALID_TO)}. Since then the app does not compare knee implants on bills dated after it (or undated). Check nppa.gov.in for an order extending or revising them; if there is one, update NPPA and NPPA_KNEE_VALID_TO in 06_app/index.html and 02_reference_data/nppa_ceilings.csv.`
    : `NPPA's knee-implant ceilings are published as valid until ${fmt(c.NPPA_KNEE_VALID_TO)}. Check nppa.gov.in for an order extending or revising them before then.`);
  if (t >= c.NPPA_STENT_REVIEW_FROM - 31 * DAY) out.push(
    `The coronary stent ceilings in the app took effect on 1 April 2026 and have been revised each 1 April. From ${fmt(c.NPPA_STENT_REVIEW_FROM)} the app asks users to check for a newer notification; check nppa.gov.in and update NPPA in 06_app/index.html if there is one.`);
  return out;
}

async function fetchText(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (ClearBill monthly reference check; +https://github.com/Aaryap1/ClearBill)' }, signal: AbortSignal.timeout(45000) });
      if (r.ok) return await r.text();
      last = 'HTTP ' + r.status;
    } catch (e) { last = (e.cause && e.cause.code) || e.message; }
    if (i < tries - 1) await new Promise(r => setTimeout(r, 15000));
  }
  throw new Error(last);
}

function readBaseline() { try { return JSON.parse(fs.readFileSync(BASELINE, 'utf8')); } catch (e) { return {}; } }

async function run(argv) {
  const today = new Date(), base = readBaseline(), lines = [], update = argv.includes('--update-baseline');
  let changed = false;
  const next = { note: 'Email addresses on each page when the app\'s copy was last checked. Written by: node 06_app/lib/freshness.js --update-baseline', checked_on: today.toISOString().slice(0, 10) };
  for (const s of SOURCES) {
    let html;
    try { html = await fetchText(s.url); }
    catch (e) {
      changed = true; next[s.key] = base[s.key] || [];
      lines.push(`### ${s.name}\nCould not be read automatically (${e.message}). Check it by hand: ${s.url}\n`);
      continue;
    }
    const now = extractEmails(html); next[s.key] = now;
    if (update) continue;
    const d = compare(base[s.key], now, s.ours());
    if (!now.length) { changed = true; lines.push(`### ${s.name}\nThe page was read but no email address was found on it; its layout may have changed. Check it by hand: ${s.url}\n`); continue; }
    if (d.added.length || d.removed.length || d.oursMissing.length) {
      changed = true;
      lines.push(`### ${s.name}\n${s.url}\n` +
        (d.oursMissing.length ? `\n**Shown by the app but no longer on the page:**\n${d.oursMissing.map(e => '- ' + e).join('\n')}\n` : '') +
        (d.added.length ? `\nNew on the page since the last check:\n${d.added.map(e => '- ' + e).join('\n')}\n` : '') +
        (d.removed.length ? `\nGone from the page since the last check:\n${d.removed.map(e => '- ' + e).join('\n')}\n` : '') +
        `\nRe-read the page, update ${s.where}, run \`node lib/sync_reference.js\`, then \`node lib/freshness.js --update-baseline\`.\n`);
    }
  }
  if (update) {
    if (Object.keys(next).length !== 2 + SOURCES.length) { console.error('baseline NOT written: a page could not be read'); process.exit(1); }
    fs.writeFileSync(BASELINE, JSON.stringify(next, null, 1) + '\n');
    console.log('baseline written: ' + SOURCES.map(s => s.key + ' ' + next[s.key].length).join(', '));
    return;
  }
  const rem = dateReminders(today);
  if (rem.length) { changed = true; lines.push('### Dated price ceilings\n' + rem.map(r => '- ' + r).join('\n') + '\n'); }
  const report = changed
    ? `ClearBill's monthly reference check (${today.toISOString().slice(0, 10)}) found something for a person to look at.\n\n${lines.join('\n')}\nThis check never changes the app. Nothing here is a confirmed error until the official page is read.`
    : `ClearBill's monthly reference check (${today.toISOString().slice(0, 10)}): every list matches the last check, and no dated ceiling is due.`;
  console.log(report);
  const oi = argv.indexOf('--out');
  if (oi >= 0 && argv[oi + 1]) fs.writeFileSync(argv[oi + 1], report + '\n');
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}

if (require.main === module) run(process.argv.slice(2)).catch(e => { console.error(e); process.exit(1); });
module.exports = { extractEmails, compare, dateReminders, SOURCES, BASELINE };
