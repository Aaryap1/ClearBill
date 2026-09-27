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
// Items now correctly cited under IRDAI Lists II-IV (Tooth Brush, Name Tag, Comb,
// Apron, Identification Band, Admission Kit, Gowns, Admission Services) moved out
// of this List-I list on 27 Sep 2026 - see the "Lists II-IV" section below.
const YES = ['MEDICO-LEGAL CASE CHARGES', 'AESTHETIC SURGERY', 'IVF TREATMENT CYCLE', 'INHALER SPACER'];
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

console.log('== NPPA: conservative-only');
const N = (item, rate, now) => checks.analyse({ header: {}, line_items: [{ item, quantity: 1, rate, total: rate }] }, now);
const before = new Date('2026-09-21'), after = new Date('2026-11-16');
ok(N('Drug eluting stent', 39186.03, before).nppa.length === 0 && N('Drug eluting stent', 39186.03, before).nppaGst.length === 0, 'a stent at exactly the ceiling is never flagged');
ok(N('Drug eluting stent', 30000, before).nppa.length === 0, 'a stent below the ceiling is never flagged');
{ const r = N('Drug eluting stent', 41000, before); ok(r.nppa.length === 0 && r.nppaGst.length === 1, 'just above the ceiling (within 5%) is only "check GST", not a finding'); }
{ const r = N('Drug eluting stent', 39186.03 * 1.05, before); ok(r.nppa.length === 0 && r.nppaGst.length === 1, 'exactly ceiling x 1.05 is still "check GST"'); }
{ const r = N('Drug eluting stent', 45000, before); ok(r.nppa.length === 1 && r.nppaGst.length === 0, 'well above ceiling plus GST is flagged'); }
ok(N('Hip femoral component', 90000, before).nppa.length === 0, 'a HIP femoral component never gets a knee ceiling');
ok(N('Bipolar femoral component', 90000, before).nppa.length === 0, 'a bipolar femoral component never gets a knee ceiling');
ok(N('Knee femoral component', 90000, before).nppa.length === 1, 'a knee femoral component is still checked');
ok(N('Knee femoral component', 90000, before).nppaStale === false, 'knee ceilings are not marked stale before 15 Nov 2026');
ok(N('Knee femoral component', 90000, after).nppaStale === true, 'knee ceilings are marked stale after 15 Nov 2026 (copy becomes more cautious)');
ok(N('Drug eluting stent', 45000, after).nppaStale === false, 'stent ceilings (open-ended from 1 Apr 2026) are not marked stale');

console.log('== recon: not compared is not clear');
ok(checks.analyse({ header: {}, line_items: [{ item: 'X', total: 10 }] }).reconCompared === false, 'no printed total => reconCompared is false');
ok(checks.analyse({ header: { gross_amount: 10 }, line_items: [{ item: 'X', total: 10 }] }).reconCompared === true, 'a printed total that matches => compared and no gap');
ok(checks.analyse({ header: { gross_amount: '(10)' }, line_items: [{ item: 'X', total: 10 }] }).reconCompared === false, 'an unreadable printed total => not compared');

console.log('== partial uploads');
ok(checks.analyse({ header: {}, line_items: [{ item: 'X', total: 1 }], _pageCount: 1 }).partial === true, 'one page uploaded is flagged partial');
ok(checks.analyse({ header: {}, line_items: [{ item: 'X', total: 1 }], _pageCount: 3, _rejected: 0 }).partial === false, 'three pages read is not partial');
ok(checks.analyse({ header: {}, line_items: [{ item: 'X', total: 1 }], _pageCount: 3, _rejected: 1 }).partial === true, 'a rejected page is flagged partial');

console.log('== mergePages: gross and section totals');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = src.match(/function mergePages\(pages\)\{[\s\S]*?\r?\n\}\r?\n/);
  const mergePages = new Function('parseAmount', m[0] + '; return mergePages;')(checks.parseAmount);
  const pg = (gross, rows, sub) => ({ header: { gross_amount: gross }, line_items: rows.map(t => ({ item: 'I', total: t })), printed_subtotals: sub || {} });
  ok(mergePages([pg(100, [40]), pg(100, [60])]).header.gross_amount === 100, 'the same gross on every page is kept');
  ok(mergePages([pg(40, [40]), pg(100, [60])]).header.gross_amount === 100, 'a gross that reconciles with all the lines beats the first page\'s figure');
  ok(mergePages([pg(55, [40]), pg(77, [60])]).header.gross_amount === null, 'conflicting grosses with none reconciling => none used (not compared)');
  ok(mergePages([pg(null, [40]), pg(100, [60])]).header.gross_amount === 100, 'a gross only on a later page is still found');
  const s = mergePages([pg(null, [1], { Room: 100 }), pg(null, [1], { Room: 200 })]).printed_subtotals;
  ok(!('Room' in s), 'two different printed subtotals for one section => neither is trusted');
  ok(mergePages([pg(null, [1], { Room: 100 }), pg(null, [1], { Room: 100 })]).printed_subtotals.Room === 100, 'identical repeats are kept');
}

console.log('== credit lines: a refund is not a charge to explain');
const L1 = (rows) => checks.analyse({ header: {}, line_items: rows.map(([item, total, extra]) => ({ item, quantity: 1, total, ...(extra || {}) })) });
ok(L1([['Gloves Examination', 200], ['Gloves Examination refund', -200]]).exact.length === 0, 'a charge and its equal refund are both left out of the flagged list');
ok(L1([['Gloves Examination', 200]]).exact.length === 1, 'the same charge without a refund is still flagged');
ok(L1([['Gloves Examination', 200], ['Gloves Examination refund', -100]]).exact.length === 1, 'a partial refund does not hide the charge');
{ const r = L1([['Discount on towel', -100]]); ok(r.exact.length === 0 && r.review.length === 0, 'a discount line (negative amount) is never listed as a List I charge'); }
ok(L1([['Gloves Examination', 200], ['Gloves Examination return', -200]]).lineSum === 0, 'the bill total arithmetic still uses every line, credits included');

console.log('== NPPA: sets, packages and mislabelled rates');
const NL = (item, quantity, rate, total) => checks.analyse({ header: {}, line_items: [{ item, quantity, rate, total }] }, new Date('2026-09-25'));
{ const r = NL('TKR SET Femoral component + Tibial component + Insert', 1, 85000, 85000); ok(r.nppa.length === 0 && r.nppaGst.length === 0 && r.nppaSkipped === 1, 'a knee set naming several parts is not compared with one part\'s ceiling (and is counted as skipped)'); }
{ const r = NL('Total Knee Replacement Implant Package (femoral component cobalt chrome)', 1, 60000, 60000); ok(r.nppa.length === 0 && r.nppaSkipped === 1, 'a package line is not compared with a single-part ceiling'); }
ok(NL('Knee femoral component', 1, 90000, 90000).nppa.length === 1, 'a single knee part above its ceiling is still flagged');
ok(NL('Drug eluting stent', 1, 0, 45000).nppa.length === 1, 'a rate of 0 (the extraction placeholder) falls back to total / quantity and the overcharge is still found');
{ const r = NL('Drug eluting stent', 2, 78372.06, 78372.06); ok(r.nppa.length === 0 && r.nppaGst.length === 0, 'a line total copied into the rate column of a 2-stent line does not create a flag'); }
ok(NL('Drug eluting stent', 1, 39000, 39000).nppaCompared === 1 && NL('Bed charges', 1, 100, 100).nppaCompared === 0, 'the report knows whether any implant line was actually compared');

console.log('== amounts and languages');
ok(checks.analyse({ header: {}, line_items: [{ item: 'X', quantity: '2 Nos', rate: 'Rs 10/-', total: 20 }] }).unreadable === 0, 'quantity and rate text ("2 Nos", "Rs 10/-") is not counted as an unreadable amount');
ok(checks.analyse({ header: {}, line_items: [{ item: 'X', quantity: 1, total: '(20)' }] }).unreadable === 1, 'an unreadable line TOTAL is still counted');
ok(checks.analyse({ header: {}, line_items: [{ item: 'बेड शुल्क', total: 100 }, { item: 'Bed', total: 5 }, { item: 'IV सेट', total: 5 }] }).nonLatin === 1, 'lines written only in Hindi or Marathi are counted (they cannot be matched against the English lists)');

console.log('== IRDAI Lists II-IV: should be in another charge, not a List I match, credit lines skipped');
const S1 = (rows) => checks.analyse({ header: {}, line_items: rows.map(([item, total]) => ({ item, quantity: 1, total })) });
{ const r = S1([['ADMISSION SERVICES 10003', 410]]); ok(r.subsumed.length === 1 && r.subsumed[0].list === 'IV' && r.exact.length === 0, 'an admission-service line is Subsumed (List IV), not List I'); }
{ const r = S1([['SURGICAL BLADE NO.15', 7.1]]); ok(r.subsumed.length === 1 && r.subsumed[0].list === 'III', 'a surgical blade line is Subsumed (List III)'); }
{ const r = S1([['TOOTH BRUSH', 5], ['MEDICAL RECORDS CHARGES', 300]]); ok(r.subsumed.length === 1 && r.exact.length === 1 && r.exact[0].matched === 'Medical Records', 'a Lists-II-IV item and a genuine List I item on the same bill are each reported once, under the right card'); }
{ const r = S1([['ADMISSION KIT', 200], ['ADMISSION KIT refund', -200]]); ok(r.subsumed.length === 0, 'a refunded Subsumed item is left out, the same as a refunded List I item'); }
ok(checks.SUBSUMED.length > 0, 'the Subsumed table is exported');
ok(!checks.bestMatch('ADMISSION SERVICES 10003'), 'raw bestMatch() (List I only) no longer matches an item that moved to Lists II-IV');
ok(checks.bestMatchIn('ADMISSION SERVICES 10003', checks.SUBSUMED).e.list === 'IV', 'bestMatchIn() finds it in the Subsumed table');

console.log('== implant ceilings and the bill date');
const D = (item, price, billDate, now, qty = 1) => checks.analyse({ header: billDate ? { bill_datetime: billDate } : {}, line_items: [{ item, quantity: qty, rate: price, total: price * qty }] }, now || new Date('2026-09-25'));
ok(D('Drug eluting stent', 45000, '01/06/2025').nppa.length === 0 && D('Drug eluting stent', 45000, '01/06/2025').nppaDated === 1, 'a stent on a bill dated before 1 April 2026 is not compared with the current ceiling (it was priced under an earlier one)');
ok(D('Drug eluting stent', 45000, '15/05/2026').nppa.length === 1, 'the same stent on a bill dated 15 May 2026 (unambiguous) is compared and flagged');
ok(D('Drug eluting stent', 45000, '2026-05-10').nppa.length === 1, 'an ISO date (2026-05-10) is read');
{ const r = D('Drug eluting stent', 45000, '02/04/2026'); ok(r.nppa.length === 0 && r.nppaDated === 1, '02/04/2026 could be 2 April or 4 February, so it is treated as possibly before the change and not compared'); }
{ const r = D('Drug eluting stent', 45000, '03/05/2026'); ok(r.nppa.length === 0 && r.nppaDated === 1, '03/05/2026 could be 3 May or 5 March; one reading is before the change, so it is not compared'); }
ok(D('Drug eluting stent', 45000, null).nppa.length === 1, 'no bill date: the stent is compared as before');
ok(D('Drug eluting stent', 45000, 'sometime in May').nppa.length === 1, 'an unreadable date is ignored, not guessed');
ok(D('Knee femoral component', 90000, '10/10/2026', new Date('2027-01-01')).nppaStale === false, 'a knee bill dated inside the validity period is not "stale" just because today is later');
ok(D('Knee femoral component', 90000, '20/11/2026', new Date('2026-09-25')).nppaStale === true, 'a knee bill dated after 15 Nov 2026 is stale even if today is earlier');
ok(D('Knee femoral component', 90000, null, new Date('2027-01-01')).nppaStale === true, 'with no bill date the old behaviour holds (judged by today)');
ok(D('Drug eluting stent', 45000, '05/05/2027', new Date('2027-05-06')).nppaStale === true, 'a stent bill from after 1 April 2027 asks the user to check for a newer notification');
ok(D('Drug eluting stent', 45000, '05/05/2026', new Date('2026-09-25')).nppaStale === false, 'a stent bill from May 2026 is not stale');
ok(checks.billDateRange({ bill_datetime: '01/06/2025 11:13' }) && checks.billDateRange({}) === null, 'the date reader reads DD/MM/YYYY with a time and returns nothing when there is no date');

if (old) {
  console.log('== matcher.js duplicate parity');
  const rows = (r) => r.map(([item, total]) => ({ item, quantity: 1, total }));
  for (const c of [[['X', 0], ['X', 0]], [['I', 100], ['I', 100]], [['I', 100], ['I', 100], ['I', -100]], [['D', -50], ['D', -50]]]) {
    ok(old.analyseBill(rows(c), null, null, oldTable).duplicates.length === A(c).dups.length, 'matcher.js and the app agree on ' + JSON.stringify(c));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
