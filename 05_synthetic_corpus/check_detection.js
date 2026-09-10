// check_detection.js — does the checker catch the planted defects?
//
//   node check_detection.js
//
// Runs matcher.js + completeness.js + a per-section reconciliation against each
// bill's GROUND TRUTH (i.e. a perfect extraction). This measures the CHECKS,
// not the OCR — detection rate should be read on clean input. Run the same
// checks on real Gemini output separately to see how photo noise erodes them.
//
// Scored: recall over the 6 defective bills, false positives over the 4 clean.

const fs = require("fs");
const path = require("path");
const { analyseBill } = require("../03_code/matcher.js");
const { checkCompleteness } = require("../03_code/completeness.js");
const { NON_PAYABLE } = (() => {
  const raw = fs.readFileSync(path.join(__dirname, "../03_code/lookup_table_for_prompt.txt"), "utf8");
  return { NON_PAYABLE: eval("[" + raw.replace(/^\/\/.*$/gm, "") + "]") };
})();

const TRUTH = path.join(__dirname, "truth");

// per-section reconciliation: printed section total vs sum of that section's lines
function sectionReconciliation(truth) {
  const bySec = {};
  for (const l of truth.line_items) {
    const s = l.section || "?";
    bySec[s] = (bySec[s] || 0) + (l.total || 0);
  }
  const hits = [];
  for (const [sec, printed] of Object.entries(truth.printed_subtotals || {})) {
    const summed = Math.round((bySec[sec] || 0) * 100) / 100;
    const diff = Math.round((printed - summed) * 100) / 100;
    if (Math.abs(diff) >= 0.01) hits.push({ section: sec, printed, summed, diff });
  }
  return hits;
}

// what the checker flags on one bill
function runChecks(truth) {
  const bill = { header: truth.header, line_items: truth.line_items };
  const m = analyseBill(truth.line_items, truth.printed_grand_total, null, NON_PAYABLE);
  const c = checkCompleteness(bill);
  const secRecon = sectionReconciliation(truth);

  const flags = new Set();
  if (m.reconciliation || secRecon.length) flags.add("subtotal_mismatch");
  if (m.duplicates.length) flags.add("duplicate");
  for (const row of c.header_rows)
    if (row.status === "missing" && row.sev === "mandatory") flags.add(`missing_field:${row.key}`);
  for (const [k, v] of Object.entries(c.line_field_report))
    if (k === "unit" && v.missing === v.total && v.total > 0) flags.add("missing_unit_column");

  return { flags, matcher: m, completeness: c, secRecon };
}

// map a planted defect record -> the flag string we expect
function expectedFlag(d) {
  if (d.type === "subtotal_mismatch") return "subtotal_mismatch";
  if (d.type === "duplicate") return "duplicate";
  if (d.type === "missing_unit_column") return "missing_unit_column";
  if (d.type === "missing_field") return `missing_field:${d.field}`;
  return d.type;
}

let planted = 0, caught = 0, falsePos = 0;
const rows = [];
for (const fn of fs.readdirSync(TRUTH).filter((f) => f.endsWith(".json")).sort()) {
  const truth = JSON.parse(fs.readFileSync(path.join(TRUTH, fn), "utf8"));
  const { flags } = runChecks(truth);

  // this harness scores only the defect classes it plants
  const IN_SCOPE = new Set([
    "subtotal_mismatch", "duplicate", "missing_unit_column",
    "missing_field:hospital_gstin", "missing_field:bill_number",
  ]);

  const want = (truth.defects || []).map(expectedFlag);
  const missed = want.filter((w) => !flags.has(w));
  planted += want.length;
  caught += want.length - missed.length;

  // false positive = an in-scope flag the bill was not given
  const spurious = [...flags].filter((f) => IN_SCOPE.has(f) && !want.includes(f));
  if (spurious.length) falsePos += spurious.length;

  rows.push({
    id: truth.id, clean: truth.is_clean,
    want, caught: want.filter((w) => flags.has(w)), missed, spurious,
  });
}

console.log("bill    clean  planted defects                         caught?   spurious flags");
console.log("-".repeat(92));
for (const r of rows) {
  const w = r.clean ? "—" : r.want.join(", ");
  const status = r.clean ? (r.spurious.length ? "FALSE POS" : "ok (quiet)")
                         : (r.missed.length ? `MISSED ${r.missed.join(",")}` : "all caught");
  console.log(`${r.id}  ${r.clean ? "yes " : "no  "}   ${w.slice(0, 38).padEnd(38)}  ${status.padEnd(18)}  ${r.spurious.join(", ")}`);
}
console.log("-".repeat(92));
console.log(`\nDEFECT DETECTION (checks run on clean ground truth)`);
console.log(`  recall          ${caught}/${planted} planted defects caught   ${(caught / planted * 100).toFixed(0)}%`);
console.log(`  false positives ${falsePos} on the 4 clean bills`);
console.log(`\nNext: run these same checks on real Gemini extractions of *_photo.png to see`);
console.log(`how much photo noise erodes the small-rupee subtotal check.`);

process.exit(caught === planted && falsePos === 0 ? 0 : 1);
