/* Regression tests for the matching / duplicate / amount-parsing rules.
 * Uses only synthetic strings — no patient data.      node lib/test_analysis.js
 *
 * Also checks that the older 03_code/matcher.js agrees with the app on the
 * same strings, so the two implementations cannot drift apart silently.
 */
const fs = require('fs');
const path = require('path');
const checks = require('./checks.js');

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m + (extra ? '  -> ' + extra : '')); } };

// matcher.js with the table from lookup_table_for_prompt.txt
const matcherPath = path.join(__dirname, '..', '..', '03_code', 'matcher.js');
const tablePath = path.join(__dirname, '..', '..', '03_code', 'lookup_table_for_prompt.txt');
let old = null, oldTable = null;
if (fs.existsSync(matcherPath) && fs.existsSync(tablePath)) {
  old = require(matcherPath);
  oldTable = eval('[' + fs.readFileSync(tablePath, 'utf8').replace(/^\/\/.*$/gm, '') + ']');
}

console.log('== matching: look-alike words must NOT match');
const NO = ['COMBIFLAM', 'COMBIVENT', 'COMBINED SPINAL EPIDURAL', 'APRONAX', 'LOCAL ANAESTHETIC INJECTION',
  'ANAESTHETIC CHARGES', 'LIQUID BANDAGE SPRAY', 'KITCHEN DIET', 'SKIT', 'IVF NS 500ML',
  'LUMBAR INTERBODY SPACER CAGE', 'ANTIBIOTIC CEMENT SPACER KNEE'];
for (const s of NO) {
  const m = checks.bestMatch(s);
  ok(!m, '"' + s + '" is not flagged', m ? 'matched ' + m.e.item : '');
  if (old) { const o = old.bestMatch(s, oldTable); ok(!o, '  matcher.js agrees for "' + s + '"', o ? 'matched ' + o.entry.item : ''); }
}

console.log('== matching: real non-payable items still match');
const YES = ['TOOTH-BRUSH', 'NAME-TAG', 'MEDICO-LEGAL CASE CHARGES', 'COMB', 'APRON', 'AESTHETIC SURGERY',
  'IDENTIFICATION BAND', 'ADMISSION KIT', 'IVF TREATMENT CYCLE', 'INHALER SPACER', 'GOWNS', 'ADMISSION SERVICES'];
for (const s of YES) {
  const m = checks.bestMatch(s);
  ok(!!m, '"' + s + '" is flagged', m ? '' : 'no match');
  if (old) { const o = old.bestMatch(s, oldTable); ok(!!o && (!m || o.entry.item === m.e.item), '  matcher.js agrees for "' + s + '"', o ? o.entry.item + ' vs ' + (m && m.e.item) : 'no match'); }
}

console.log('== amounts: parsing');
const P = (v) => checks.parseAmount ? checks.parseAmount(v) : null;
ok(P('1,260.00').n === 1260, '"1,260.00" reads as 1260');
ok(P('₹ 500').n === 500, '"₹ 500" reads as 500');
ok(P('Rs. 75.5').n === 75.5, '"Rs. 75.5" reads as 75.5');
ok(P(42).n === 42 && !P(42).bad, 'a plain number is kept');
ok(P(null).n === null && !P(null).bad && P('').n === null && !P('').bad, 'blank/null is missing, not unreadable');
ok(P('(63.27)').bad && P('63.27 CR').bad && P('abc').bad, 'ambiguous text ("(63.27)", "63.27 CR") is counted unreadable, not guessed');

console.log('== duplicates: zero rows, reversals, real repeats');
const A = (rows) => checks.analyse({ header: {}, line_items: rows.map(([item, total]) => ({ item, quantity: 1, total })) });
ok(A([['X', 0], ['X', 0]]).dups.length === 0, 'two zero rows are layout, not a duplicate');
ok(A([['X', null], ['X', null]]).dups.length === 0, 'two missing amounts are not a duplicate');
ok(A([['', 50], ['', 50]]).dups.length === 0, 'blank item names are not a duplicate');
ok(A([['Injection', 100], ['Injection', 100]]).dups.length === 1, 'same item, same amount twice is flagged');
ok(A([['Injection', 100], ['Injection', 100]]).dups[0].n === 2, '...with a count of 2');
ok(A([['Injection', 100], ['Injection', 100], ['Injection', -100]]).dups.length === 0, 'a charge reversed by a matching negative line is netted out');
ok(A([['Injection', 100], ['Injection', 100], ['Injection', 100], ['Injection', -100]]).dups.length === 1, 'three charges and one reversal still leave a repeat');
ok(A([['Discount', -50], ['Discount', -50]]).dups.length === 0, 'two identical credit lines are not a duplicate charge');
ok(A([['Injection', 100], ['Injection', 101]]).dups.length === 0, 'different amounts are not a duplicate');
ok(A([['Injection', '1,260.00'], ['injection ', 1260]]).dups.length === 1, 'formatted and plain amounts of the same charge are one group');

console.log('== unreadable amounts are counted, not treated as 0');
{
  const r = A([['Bed', '(63.27)'], ['Drug', 40]]);
  ok(r.unreadable === 1, 'one unreadable amount is reported');
  ok(r.lineSum === 40, 'the unreadable amount is left out of the sum rather than guessed');
  ok(A([['Bed', 10], ['Drug', 40]]).unreadable === 0, 'clean bills report zero unreadable');
}

if (old) {
  console.log('== matcher.js duplicate parity');
  const rows = (r) => r.map(([item, total]) => ({ item, quantity: 1, total }));
  for (const c of [[['X', 0], ['X', 0]], [['I', 100], ['I', 100]], [['I', 100], ['I', 100], ['I', -100]], [['D', -50], ['D', -50]]]) {
    ok(old.analyseBill(rows(c), null, null, oldTable).duplicates.length === A(c).dups.length, 'matcher.js and the app agree on ' + JSON.stringify(c));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
