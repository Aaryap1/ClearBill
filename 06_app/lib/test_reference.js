/* The IRDAI table: the reference copies match the app, the official 68-item list
 * is covered (or its gaps are deliberate and named), and the newer keywords do not
 * over-match.                                          node lib/test_reference.js
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const c = require('./checks.js');
let pass = 0, fail = 0;
const ok = (cond, m, extra) => { if (cond) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m + (extra ? '  -> ' + extra : '')); } };

console.log('== the reference files match the app');
{
  const r = spawnSync(process.execPath, [path.join(__dirname, 'sync_reference.js'), '--check'], { encoding: 'utf8' });
  ok(r.status === 0, 'irdai_non_payables.csv and lookup_table_for_prompt.txt are generated from the app table', (r.stderr || '').trim());
}

console.log('== the official 68-item List I');
const py = path.join(__dirname, '..', '..', '02_reference_data', 'verify_against_official.py');
if (!fs.existsSync(py)) console.log('  skip (verify_against_official.py not present)');
else {
  const src = fs.readFileSync(py, 'utf8');
  const start = src.indexOf('OFFICIAL_68 = ['), block = src.slice(start, src.indexOf(']\n', start));
  const official = [...block.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  ok(official.length === 68, 'the list has 68 items (' + official.length + ')');
  // Gaps that are deliberate: the official word is too broad to flag on its own
  // (surgical gloves, implant slings, prescribed creams and masks are payable).
  const TOO_BROAD = new Set(['belts/ braces', 'slings', 'creams powders lotions', 'gloves', 'mask']);
  // Named in the list, but a policy can cover them, so they are "confirm with your insurer", not "exact".
  const REVIEW_ONLY = new Set(['service charges where nursing charge also charged', 'oxygen cylinder (for usage outside the hospital)', 'ecg electrodes',
    'any kit with no details mentioned', 'ambulance', "food charges (other than patient's diet provided by hospital)"]);
  const unexpected = [];
  for (const it of official) {
    const m = c.bestMatch(it), tier = m ? m.e.tier : 'none';
    const expected = TOO_BROAD.has(it) ? 'none' : REVIEW_ONLY.has(it) ? 'review' : 'exact';
    if (tier !== expected) unexpected.push(it + ' (expected ' + expected + ', got ' + tier + ')');
  }
  ok(unexpected.length === 0, 'every official item matches at the expected tier; the only gaps are the ' + TOO_BROAD.size + ' deliberately broad words', unexpected.join('; '));
}

console.log('== the newer keywords match real wording...');
const MUST = ['TV CHARGES', 'CABLE TV', 'TELEVISION CHARGES', 'MORTUARY CHARGES', 'EXTRA DIET', 'PRIVATE NURSING CHARGES', 'ABDOMINAL BINDER',
  'LUMBOSACRAL BELT', 'PELVIC TRACTION BELT', 'NIMBUS BED', 'AIR BED CHARGES', 'SPIROMETER', 'SUGAR FREE TABLETS', 'VASOFIX SAFETY 20G', 'LEGGINGS', 'PAN CAN',
  'CROSS MATCHING OF DONORS SAMPLES', 'ARMSLING', 'NEBULISATION KIT', 'COTTON BUDS'];
for (const s of MUST) { const m = c.bestMatch(s); ok(!!m && m.e.tier === 'exact', '"' + s + '" is matched as a List I item', m ? m.e.tier + ': ' + m.e.item : 'no match'); }
{ const m = c.bestMatch('AMBULANCE CHARGES'); ok(m && m.e.tier === 'review', '"AMBULANCE CHARGES" is "confirm with your insurer", not exact'); }
{ const m = c.bestMatch('AMBULANCE COLLAR'); ok(m && m.e.tier === 'exact', '"AMBULANCE COLLAR" stays an exact List I item (the longer name wins)'); }

console.log('== ...and do not match things that are payable');
const MUST_NOT = ['SPIROMETRY (PFT)', 'PRIVATE ROOM CHARGES', 'SPECIAL ROOM RENT', 'NURSING CHARGES', 'BLOOD GROUPING', 'CROSS MATCHING', 'VASOFIX 20G CANNULA',
  'IV SET', 'STV', 'EXTRA DAY ROOM RENT', 'WATER FOR INJECTION', 'BED CHARGES', 'AIR ENTRY CHECK', 'LEG CAST'];
for (const s of MUST_NOT) { const m = c.bestMatch(s); ok(!m || m.e.tier !== 'exact', '"' + s + '" is not flagged as a List I item', m ? m.e.tier + ': ' + m.e.item : ''); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
