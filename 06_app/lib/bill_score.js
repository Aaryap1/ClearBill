/* Scores one bill read against its known ground truth (R31). A line-for-line
 * port of 05_synthetic_corpus/evaluate.py (that machine has no Python), so
 * the numbers are comparable with RESULTS.md (31 Aug 2026):
 *   line accuracy  = correct lines / truth lines; a line is correct only if
 *                    it is matched AND its total and quantity match
 *   hallucinations = read lines that match no truth line (counted, never
 *                    folded into the percentage)
 * Pure: no files, no network. selftest() repeats evaluate.py's own self-test.
 */
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\b\d{3,}\b/g, ' ').replace(/\s+/g, ' ').trim();
const toks = s => new Set(norm(s).split(' ').filter(Boolean));
const num = v => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const moneyEq = (a, b, tol = 0.5) => { a = num(a); b = num(b); return a === null || b === null ? a === b : Math.abs(a - b) <= tol; };
const numEq = (a, b, tol = 0.01) => { a = num(a); b = num(b); return a === null || b === null ? a === b : Math.abs(a - b) <= tol; };

// Greedy best match, as evaluate.py: token overlap plus a bonus for the same total.
function matchLines(truthLines, readLines) {
  const used = new Set(), pairs = [], missed = [];
  truthLines.forEach((t, ti) => {
    const tt = toks(t.item); let best = null, bestScore = 0;
    readLines.forEach((e, ei) => {
      if (used.has(ei)) return;
      const et = toks(e && e.item);
      if (!tt.size || !et.size) return;
      let inter = 0; for (const w of tt) if (et.has(w)) inter++;
      const jac = inter / (tt.size + et.size - inter);
      const score = jac + (moneyEq(t.total, e.total) ? 0.35 : 0);
      if (score > bestScore) { best = ei; bestScore = score; }
    });
    if (best !== null && bestScore >= 0.45) { used.add(best); pairs.push([ti, best]); } else missed.push(ti);
  });
  const halluc = readLines.map((_, i) => i).filter(i => !used.has(i));
  return { pairs, missed, halluc };
}

const HEADER_KEYS = ['hospital_name', 'hospital_gstin', 'bill_number', 'bill_datetime', 'patient_name', 'patient_age', 'patient_gender',
  'patient_hospital_id', 'patient_uhid', 'admission_datetime', 'discharge_datetime', 'admission_type', 'gross_amount', 'discount_amount', 'net_payable'];
const hnorm = v => (v === null || v === undefined ? null : String(v).toLowerCase().replace(/,/g, '').trim().replace(/\s+/g, ' '));

function scoreBill(truth, read) {
  const tl = truth.line_items || [], el = (read && Array.isArray(read.line_items)) ? read.line_items : [];
  const { pairs, missed, halluc } = matchLines(tl, el);
  let correct = 0, wrongValue = 0; const lines = [];
  for (const [ti, ei] of pairs) {
    const t = tl[ti], e = el[ei];
    if (moneyEq(t.total, e.total) && numEq(t.quantity, e.quantity)) { correct++; lines.push(['correct', t.item]); }
    else { wrongValue++; lines.push(['wrong_value', t.item, { truth_total: t.total, got_total: e.total, truth_qty: t.quantity, got_qty: e.quantity }]); }
  }
  missed.forEach(ti => lines.push(['missed', tl[ti].item]));
  halluc.forEach(ei => lines.push(['hallucination', (el[ei] && el[ei].item) || '?']));
  const n = tl.length;
  const th = truth.header || {}, eh = (read && read.header) || {};
  let hChecked = 0, hCorrect = 0; const hMiss = [];
  for (const k of HEADER_KEYS) {
    if (th[k] === null || th[k] === undefined || th[k] === '') continue;
    hChecked++;
    const good = ['gross_amount', 'discount_amount', 'net_payable'].includes(k) ? moneyEq(th[k], eh[k], 1) : hnorm(th[k]) === hnorm(eh[k]);
    if (good) hCorrect++; else hMiss.push({ field: k, truth: th[k], got: eh[k] === undefined ? null : eh[k] });
  }
  return {
    id: truth.id, truth_lines: n, read_lines: el.length, correct, wrong_value: wrongValue, missed: missed.length, hallucinations: halluc.length,
    line_accuracy: n ? Math.round(correct / n * 1e4) / 1e4 : 1,
    header_accuracy: hChecked ? Math.round(hCorrect / hChecked * 1e4) / 1e4 : null, header_checked: hChecked, header_correct: hCorrect,
    detail: { lines, header_misses: hMiss },
  };
}

function aggregate(results) {
  const s = k => results.reduce((a, r) => a + (r[k] || 0), 0);
  const lines = s('truth_lines'), correct = s('correct');
  return { bills: results.length, lines, correct, wrong_value: s('wrong_value'), missed: s('missed'), hallucinations: s('hallucinations'),
    line_accuracy: lines ? Math.round(correct / lines * 1e4) / 1e4 : null,
    header_accuracy: s('header_checked') ? Math.round(s('header_correct') / s('header_checked') * 1e4) / 1e4 : null };
}

// evaluate.py's self-test, unchanged in substance.
function selftest() {
  const truth = { id: 'TEST', header: { hospital_name: 'X Hospital', bill_number: 'B/1', gross_amount: 2000, patient_name: 'A B' },
    line_items: Array.from({ length: 20 }, (_, i) => ({ item: `ITEM ${i} 100${i}`, unit: 'nos', quantity: i % 3 + 1, rate: 100, total: (i % 3 + 1) * 100, section: 'S' })) };
  const out = [];
  let r = scoreBill(truth, { header: { ...truth.header }, line_items: truth.line_items.map(l => ({ ...l })) });
  out.push(['a perfect read scores 100% with no invented lines', r.line_accuracy === 1 && r.hallucinations === 0 && r.header_accuracy === 1]);
  const dmg = truth.line_items.slice(0, -3).map(l => ({ ...l })); dmg[0].total += 37;
  dmg.push({ item: 'GHOST CHARGE 9999', unit: 'nos', quantity: 1, rate: 500, total: 500, section: 'S' });
  r = scoreBill(truth, { line_items: dmg });
  out.push(['3 lines dropped, 1 misread, 1 invented: 16/20 = 80%, 1 invented', r.correct === 16 && r.line_accuracy === 0.8 && r.hallucinations === 1 && r.missed === 3 && r.wrong_value === 1]);
  r = scoreBill(truth, { line_items: truth.line_items.map(l => ({ ...l, item: l.item.replace(' 100', '  #').replace(/\b\w/g, c => c.toUpperCase()) })) });
  out.push(['reworded item text still matches', r.line_accuracy === 1]);
  return out;
}

module.exports = { scoreBill, aggregate, selftest, matchLines };
