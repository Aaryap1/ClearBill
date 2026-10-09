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
  // R18, the other direction. Every row the app cites to a user as "IRDAI List
  // I" must be one of these 68 items (the official wording matches it), or a
  // narrower case of one, named here with the official item it falls under.
  // Twelve rows failed this (TPA charges, medico-legal, needles and syringes,
  // home visits ...) and went into letters as List I items.
  const NARROWER = { 'Examination Gloves': 'gloves', 'Paper Gloves': 'gloves', 'Towel': 'creams powders lotions', 'Powder': 'creams powders lotions',
    'Moisturiser / Paste / Brush': 'creams powders lotions', 'Visco Belt Charges': 'belts/ braces',
    "Food Charges (Other than Patient's Diet)": "food charges (other than patient's diet provided by hospital)" };
  const backed = new Set(official.map(o => c.bestMatch(o)).filter(Boolean).map(m => m.e.item));
  const listI = c.NON_PAYABLE.filter(e => e.tier === 'exact' && (e.basis || 'list_i') === 'list_i');
  const unbacked = listI.filter(e => !backed.has(e.item) && !(NARROWER[e.item] && official.includes(NARROWER[e.item])));
  ok(unbacked.length === 0, `every one of the ${listI.length} rows cited as "IRDAI List I" is an official item or a named narrower case of one`, unbacked.map(e => e.item).join('; '));
  ok(Object.values(NARROWER).every(o => official.includes(o)), 'every "narrower case" names an item that really is on the official list');
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

console.log('== IRDAI Lists II-IV (items that should be in another charge, not billed separately)');
{
  // The official item names, exactly as read from irdai.gov.in (Modification Guidelines on
  // Standardization in Health Insurance, 27 Sep 2019) on 25 Sep 2026.
  const L2 = ['BABY CHARGES', 'HAND WASH', 'SHOE COVER', 'CAPS', 'CRADLE CHARGES', 'COMB', 'EAU-DE-COLOGNE / ROOM FRESHNERS', 'FOOT COVER', 'GOWN', 'SLIPPERS',
    'TISSUE PAPER', 'TOOTH PASTE', 'TOOTH BRUSH', 'BED PAN', 'FACE MASK', 'FLEXI MASK', 'HAND HOLDER', 'SPUTUM CUP', 'DISINFECTANT LOTIONS', 'LUXURY TAX', 'HVAC',
    'HOUSE KEEPING CHARGES', 'AIR CONDITIONER CHARGES', 'IM IV INJECTION CHARGES', 'CLEAN SHEET', 'BLANKET/WARMER BLANKET', 'ADMISSION KIT', 'DIABETIC CHART CHARGES',
    'DOCUMENTATION CHARGES / ADMINISTRATIVE EXPENSES', 'DISCHARGE PROCEDURE CHARGES', 'DAILY CHART CHARGES', 'ENTRANCE PASS / VISITORS PASS CHARGES',
    'EXPENSES RELATED TO PRESCRIPTION ON DISCHARGE', 'FILE OPENING CHARGES', 'INCIDENTAL EXPENSES / MISC. CHARGES', 'PATIENT IDENTIFICATION BAND / NAME TAG', 'PULSEOXYMETER CHARGES'];
  const L3 = ['HAIR REMOVAL CREAM', 'DISPOSABLES RAZORS CHARGES', 'EYE PAD', 'EYE SHEILD', 'CAMERA COVER', 'DVD, CD CHARGES', 'GAUSE SOFT', 'GAUZE',
    'WARD AND THEATRE BOOKING CHARGES', 'ARTHROSCOPY AND ENDOSCOPY INSTRUMENTS', 'MICROSCOPE COVER', 'SURGICAL BLADES, HARMONICSCALPEL, SHAVER', 'SURGICAL DRILL',
    'EYE KIT', 'EYE DRAPE', 'X-RAY FILM', 'BOYLES APPARATUS CHARGES', 'COTTON', 'COTTON BANDAGE', 'SURGICAL TAPE', 'APRON', 'TORNIQUET', 'ORTHOBUNDLE, GYNAEC BUNDLE'];
  const L4 = ['ADMISSION/REGISTRATION CHARGES', 'HOSPITALISATION FOR EVALUATION/ DIAGNOSTIC PURPOSE', 'URINE CONTAINER',
    'BLOOD RESERVATION CHARGES AND ANTE NATAL BOOKING CHARGES', 'BIPAP MACHINE', 'CPAP/ CAPD EQUIPMENTS', 'INFUSION PUMP– COST',
    'HYDROGEN PEROXIDE\\SPIRIT\\ DISINFECTANTS ETC', 'NUTRITION PLANNING CHARGES - DIETICIAN CHARGES- DIET CHARGES', 'HIV KIT', 'ANTISEPTIC MOUTHWASH', 'LOZENGES',
    'MOUTH PAINT', 'VACCINATION CHARGES', 'ALCOHOL SWABES', 'SCRUB SOLUTION/STERILLIUM', 'Glucometer& Strips', 'URINE BAG'];
  const ALL_78 = [].concat(L2, L3, L4);
  ok(L2.length === 37 && L3.length === 23 && L4.length === 18 && ALL_78.length === 78, 'Lists II/III/IV have 37/23/18 official items (78 total)');
  // Bare "Cotton" is deliberately NOT matched on its own: List I's own "Buds" row
  // (bare "cotton bud") must keep matching "COTTON BUDS" as a List I item, and a
  // bare "cotton" keyword here would intercept that line first (Subsumed is
  // matched before List I) and mis-cite it. "Cotton Roll"/"Absorbent Cotton" still
  // match under List III. Bare "Caps" is also deliberately not matched: "Cap" is a
  // common Indian medicine-label abbreviation for "Capsule" (e.g. "CAP D 800
  // TABLET"), so a bare "cap" keyword would misfire on real medicine lines;
  // "Surgical Cap"/"Theatre Cap" still match.
  const DELIBERATE_GAP = new Set(['COTTON', 'CAPS']);
  const unexpected = [];
  for (const it of ALL_78) {
    const m = c.bestMatchIn(it, c.SUBSUMED);
    if (DELIBERATE_GAP.has(it)) { if (m) unexpected.push(it + ' (expected no match, got ' + m.e.item + ')'); continue; }
    if (!m) unexpected.push(it + ' (no match)');
  }
  ok(unexpected.length === 0, 'all ' + (ALL_78.length - DELIBERATE_GAP.size) + ' of the ' + ALL_78.length + ' official Lists II-IV items match (the one deliberate gap is documented above)', unexpected.join('; '));
  // A line already caught by Subsumed must never also register as a List I match
  // when the same string is run through bestMatch() - analyse() relies on this
  // (it excludes Subsumed-matched lines before running the List I pass).
  const dual = ALL_78.filter(it => !DELIBERATE_GAP.has(it)).filter(it => { const m = c.bestMatch(it); return m && m.e.tier === 'exact'; });
  ok(dual.length === 0, 'none of the Lists II-IV items are ALSO a List I exact match', dual.join('; '));
}

console.log('== Lists II-IV: real wording matches, payable look-alikes do not');
const SUB_MUST = ['TOOTH-BRUSH', 'NAME-TAG', 'COMB', 'APRON', 'IDENTIFICATION BAND', 'ADMISSION KIT', 'GOWNS', 'ADMISSION SERVICES 10003', 'CAMERA COVER',
  'X-RAY FILM', 'SURGICAL BLADE NO.15', 'EYE PAD', 'EYE SHIELD', 'GLUCOMETER STRIPS', 'HIV KIT', 'INFUSION PUMP'];
for (const s of SUB_MUST) { const m = c.bestMatchIn(s, c.SUBSUMED); ok(!!m, '"' + s + '" matches a Lists II-IV item', m ? '' : 'no match'); }
const SUB_MUST_NOT = ['CAP D 800 TABLET', 'CAP AMOXICLAV 625MG', 'HANDICAP RAMP CHARGE', 'BEDSIDE MONITOR', 'X-RAY CHEST PA VIEW', 'BLOOD GROUPING OF PATIENT',
  'IV SET VENTED NOVOFUSION', 'ROOM RENT', 'PULSE RATE MONITORING'];
for (const s of SUB_MUST_NOT) { const m = c.bestMatchIn(s, c.SUBSUMED); ok(!m, '"' + s + '" does not match a Lists II-IV item', m ? m.e.item : ''); }

console.log('== Insurance Ombudsman offices (R13): every state and UT has an office, splits are honest');
ok(c.OMBUDSMAN.length === 18, 'all 18 offices on the Council for Insurance Ombudsmen list are present (' + c.OMBUDSMAN.length + ')');
ok(c.INDIA_STATES.length === 36 && new Set(c.INDIA_STATES).size === 36, 'the form offers all 28 states and 8 union territories, once each');
{ const none = c.INDIA_STATES.filter(st => c.ombudsmanFor(st).length === 0); ok(none.length === 0, 'every state and UT resolves to at least one office', none.join(', ')); }
{ const twice = c.INDIA_STATES.filter(st => c.OMBUDSMAN.filter(o => o.states.includes(st)).length > 1); ok(twice.length === 0, 'no state is claimed IN FULL by two offices', twice.join(', ')); }
{ const unknown = c.OMBUDSMAN.flatMap(o => [...o.states, ...o.part]).filter(st => !c.INDIA_STATES.includes(st)); ok(unknown.length === 0, 'every state named in the table is a real entry in the form list', unknown.join(', ')); }
{ const both = c.INDIA_STATES.filter(st => c.OMBUDSMAN.some(o => o.states.includes(st)) && c.OMBUDSMAN.some(o => o.part.includes(st))); ok(both.length === 0, 'a state is either covered in full by one office or split between several, never both', both.join(', ')); }
const SPLIT = { 'Haryana': ['Chandigarh', 'Delhi'], 'Maharashtra': ['Mumbai', 'Pune', 'Thane'], 'Puducherry': ['Chennai', 'Hyderabad', 'Kochi'], 'Uttar Pradesh': ['Lucknow', 'Noida'] };
for (const [st, offices] of Object.entries(SPLIT)) ok(c.ombudsmanFor(st).map(o => o.office).join() === offices.join(), st + ' is split between ' + offices.join(', ') + ' (each shown with its own jurisdiction wording)');
ok(c.INDIA_STATES.filter(st => c.ombudsmanFor(st).length > 1).length === 4, 'exactly those four states are split');
for (const [st, office] of [['Karnataka', 'Bengaluru'], ['Goa', 'Pune'], ['Uttarakhand', 'Noida'], ['Ladakh', 'Chandigarh'], ['Dadra and Nagar Haveli and Daman and Diu', 'Ahmedabad'], ['Lakshadweep', 'Kochi'], ['Andaman and Nicobar Islands', 'Kolkata']])
  ok(c.ombudsmanFor(st).map(o => o.office).join() === office, st + ' -> ' + office);
for (const o of c.OMBUDSMAN) {
  ok(/@cioins\.co\.in$/.test(o.email) && o.address.length > 10 && o.jurisdiction.length > 3 && /\d/.test(o.tel), o.office + ' has an address, phone, cioins.co.in email and its published jurisdiction');
}
ok(/^\d{4}-\d{2}-\d{2}$/.test(c.OMBUDSMAN_READ_ON), 'the date the list was read is recorded (' + c.OMBUDSMAN_READ_ON + ')');
ok(c.ombudsmanFor('') .length === 0 && c.ombudsmanFor('Atlantis').length === 0, 'no state chosen (or an unknown one) gives no office, not a guess');

console.log("== R22: insurers' grievance officers (IRDAI's list)");
ok(c.GRO.length === 34, 'the 34 non-life insurers on IRDAI\'s list that give an email (' + c.GRO.length + ')');
ok(c.GRO.every(g => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(g.email)), 'every row has a well-formed email');
ok(new Set(c.GRO.map(g => g.name)).size === c.GRO.length, 'no insurer appears twice');
ok(c.GRO.every(g => !/E\+/i.test(g.tel) && (!g.tel || /^[\d\s\-\/+]+$/.test(g.tel))), 'no phone number is a spreadsheet artefact ("1.80043E+11" is left blank, never guessed)');
ok(c.GRO.every(g => !g.web || /^https?:\/\//.test(g.web)), 'every grievance page is a web address');
ok(/^\d{4}-\d{2}-\d{2}$/.test(c.GRO_READ_ON) && /^\d{4}-\d{2}-\d{2}$/.test(c.GRO_LIST_UPDATED), 'when the list was last updated and when it was read are both recorded');
{
  console.log('== R23: the monthly reference check (offline: the comparison only)');
  const fr = require('./freshness.js');
  const em = fr.extractEmails('<td>gro@starhealth.in</td><td>GRO@NewIndia.co.in.</td> grievance[at]acko[dot]com <a href="mailto:gro@starhealth.in">x</a>');
  ok(JSON.stringify(em) === '["grievance@acko.com","gro@newindia.co.in","gro@starhealth.in"]', 'emails are read from a page: lower-cased, de-duplicated, "[at]"/"[dot]" spellings too: ' + JSON.stringify(em));
  const d = fr.compare(['a@x.in', 'b@x.in'], ['b@x.in', 'c@x.in'], ['A@x.in', 'b@x.in']);
  ok(d.added.join() === 'c@x.in' && d.removed.join() === 'a@x.in' && d.oursMissing.join() === 'a@x.in', 'a change is reported both ways, and an address the app shows that left the page is named');
  ok(fr.dateReminders(new Date('2026-10-01')).length === 0 && /valid until 2026-11-15/.test(fr.dateReminders(new Date('2026-11-01'))[0]) && /does not compare knee implants/.test(fr.dateReminders(new Date('2026-12-01'))[0]), 'the knee-implant reminder starts a month before 15 Nov 2026 and changes wording once it has passed');
  ok(fr.dateReminders(new Date('2027-03-15')).some(r => /stent/.test(r)), 'the stent reminder starts a month before 1 April 2027');
  const bl = JSON.parse(require('fs').readFileSync(fr.BASELINE, 'utf8'));
  ok(c.GRO.every(g => bl.gro.includes(g.email.toLowerCase())) && c.OMBUDSMAN.every(o => bl.ombudsman.includes(o.email.toLowerCase())), 'the saved baseline has every address the app shows (so a first run reports nothing false)');
}
ok(c.GRO.some(g => g.name === 'Star Health and Allied' && g.email === 'gro@starhealth.in') && c.GRO.some(g => g.name === 'The New India Assurance' && g.email === 'gro@newindia.co.in'), 'spot check against the published list: Star Health and New India Assurance');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
