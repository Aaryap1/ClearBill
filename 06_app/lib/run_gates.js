/* Release gate — run before every deploy:   node lib/run_gates.js
 *
 *  1. lib/checks.js is in sync with index.html
 *  2. analyse() over frozen fixtures matches lib/baseline.json EXACTLY
 *     (the worked example, the 10-bill synthetic corpus, and — if present on
 *     this machine — the private real bill). Any difference fails the gate.
 *     A change you INTEND (e.g. a new finding) is accepted deliberately with
 *       node lib/run_gates.js --update-baseline
 *     and the diff must be explained in the commit message.
 *  3. the Node suites in 03_code (skipped, loudly, if the private fixture is absent)
 *  4. lib/test_server.js (server protections)
 *
 * The baseline stores aggregates and item names only — never patient data.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const APP = path.join(__dirname, '..');
const REPO = path.join(APP, '..');
const BASELINE = path.join(__dirname, 'baseline.json');
const UPDATE = process.argv.includes('--update-baseline');

let failed = 0;
const ok = (c, m, extra) => { if (c) console.log('  ok   ' + m); else { failed++; console.log('  FAIL ' + m + (extra ? '\n         ' + extra : '')); } };
const run = (file, args, cwd) => spawnSync(process.execPath, [file, ...args], { cwd, encoding: 'utf8' });

function fixtures() {
  const out = {};
  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  const m = html.match(/const WORKED_EXAMPLE_BILL = (\{[\s\S]*?\});\r?\n/);
  if (!m) throw new Error('worked example not found in index.html');
  out['worked_example'] = JSON.parse(m[1]);
  const corpus = path.join(REPO, '05_synthetic_corpus');
  if (fs.existsSync(corpus)) {
    for (const f of fs.readdirSync(corpus).filter(f => /^SYN-\d+_extraction\.json$/.test(f)).sort()) {
      out[f.replace('_extraction.json', '')] = JSON.parse(fs.readFileSync(path.join(corpus, f), 'utf8'));
    }
  }
  const priv = path.join(REPO, '04_test_bills', 'bill_01_extracted.json');
  if (fs.existsSync(priv)) out['private_bill_01'] = JSON.parse(fs.readFileSync(priv, 'utf8'));
  return out;
}

function snapshot(a) {
  return {
    lines: a.lines.length,
    exactSum: a.exactSum, reviewSum: a.reviewSum,
    exact: a.exact.map(l => l.matched + '|' + (l.basis || '')).sort(),
    review: a.review.map(l => l.matched).sort(),
    recon: a.recon ? a.recon.diff : null,
    dupGroups: a.dups.map(d => d.item.trim().toLowerCase() + ' x' + d.n).sort(),
    redacted: a.redacted.length,
    missing: a.missing.slice().sort(),
    malformed: a.malformed.slice().sort(),
    noUnit: !!a.noUnit,
    nppa: a.nppa.map(n => n.ref + '|' + n.grade).sort(),
    nppaGst: a.nppaGst.map(n => n.ref).sort(),
    reconCompared: a.reconCompared,
  };
}

console.log('== 1. generated module in sync');
{
  const r = run(path.join(__dirname, 'build_checks.js'), ['--check'], APP);
  ok(r.status === 0, 'lib/checks.js matches index.html', (r.stderr || '').trim());
}

console.log('== 2. analysis regression (frozen fixtures)');
{
  delete require.cache[require.resolve('./checks.js')];
  const checks = require('./checks.js');
  const fx = fixtures();
  const now = {};
  for (const [name, bill] of Object.entries(fx)) now[name] = snapshot(checks.analyse(JSON.parse(JSON.stringify(bill))));
  const priv = now['private_bill_01'];
  const publicNow = { ...now }; delete publicNow['private_bill_01'];
  if (UPDATE) {
    fs.writeFileSync(BASELINE, JSON.stringify(publicNow, null, 1) + '\n');
    console.log('  baseline UPDATED (' + Object.keys(publicNow).length + ' fixtures) — explain the diff in your commit message');
  } else {
    const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    for (const name of new Set([...Object.keys(base), ...Object.keys(publicNow)])) {
      const a = JSON.stringify(base[name]), b = JSON.stringify(publicNow[name]);
      ok(a === b, name + ' unchanged', a === b ? '' : 'baseline: ' + a + '\n         now:      ' + b);
    }
  }
  const we = now['worked_example'];
  ok(we.exactSum === 1992.5 && we.recon === 10 && we.dupGroups.length === 3 && we.redacted === 12,
    'worked example: IRDAI exact 1,992.50 / gap 10 / 3 duplicate groups / 12 redacted (hard-coded floor)');
  if (priv) ok(priv.exactSum === 1992.5 && priv.recon === 10 && priv.dupGroups.length === 3, 'private real bill: same headline numbers');
  else console.log('  skip private_bill_01 (04_test_bills not on this machine)');
}

console.log('== 2b. matching / duplicate / amount rules');
{
  const r = run(path.join(__dirname, 'test_analysis.js'), [], APP);
  const last = (r.stdout || '').trim().split('\n').pop();
  ok(r.status === 0, 'test_analysis.js — ' + last, r.status === 0 ? '' : ((r.stdout || '').split('\n').filter(l => /FAIL/.test(l)).join('\n') || r.stderr).slice(-800));
}

console.log('== 3. Node suites (03_code)');
{
  const fixture = path.join(REPO, '04_test_bills', 'bill_01_extracted.json');
  if (!fs.existsSync(fixture)) console.log('  SKIPPED — private fixture 04_test_bills/bill_01_extracted.json not present on this machine');
  else for (const t of ['test_matcher.js', 'test_completeness.js']) {
    const r = run(path.join(REPO, '03_code', t), [], path.join(REPO, '03_code'));
    const bad = /(^|\n)\s*(FAIL|not ok)/i.test(r.stdout || '') || r.status !== 0;
    const n = ((r.stdout || '').match(/^\s+ok\s/gm) || []).length;
    ok(!bad, t + ' (' + n + ' assertions)', bad ? (r.stdout || r.stderr).slice(-400) : '');
  }
}

console.log('== 4. server protections');
{
  const r = run(path.join(__dirname, 'test_server.js'), [], APP);
  const last = (r.stdout || '').trim().split('\n').pop();
  ok(r.status === 0, 'test_server.js — ' + last, r.status === 0 ? '' : (r.stdout || '').slice(-600));
}

console.log(failed ? `\nGATE FAILED (${failed})` : '\nGATE PASSED');
process.exit(failed ? 1 : 0);
