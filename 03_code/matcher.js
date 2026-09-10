// ClearBill — bill matcher
// -----------------------------------------------------------------------------
// The architecture rule: the model reads, code judges.
// Gemini turns the photo into rows. Everything below is a table lookup or an
// arithmetic operation, so every flag can name the list entry or the sum it
// came from. No flag is produced without a source.
//
// Buckets are never merged:
//   exact  -> item is named in the published IRDAI non-payable list
//   review -> commonly deducted but NOT named in the list; needs a human
//   (unmatched) -> everything else
// -----------------------------------------------------------------------------

// Paste the contents of lookup_table_for_prompt.txt between the brackets.
const NON_PAYABLE = [
  // { tier: "exact", item: "...", category: "...", keywords: "a|b|c" },
];

const money = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Find the best lookup entry for one item string.
// All entries are tested. Ties broken by: exact beats review, then longest
// keyword (most specific wins), so the order of NON_PAYABLE does not matter.
function bestMatch(itemText, table = NON_PAYABLE) {
  const t = String(itemText || "").toLowerCase();
  let best = null;
  for (const entry of table) {
    const kws = String(entry.keywords).split("|").map((k) => k.trim().toLowerCase()).filter(Boolean);
    for (const kw of kws) {
      if (t.includes(kw)) {
        const cand = { entry, keyword: kw, tierRank: entry.tier === "exact" ? 2 : 1, len: kw.length };
        if (!best || cand.tierRank > best.tierRank || (cand.tierRank === best.tierRank && cand.len > best.len)) {
          best = cand;
        }
      }
    }
  }
  return best;
}

// lines: [{ item, quantity, rate, total, section }], printed_subtotal: number|null
// deduction: the "never itemised" figure from the settlement calculator (optional)
function analyseBill(lines, printed_subtotal = null, deduction = null, table = NON_PAYABLE) {
  const norm = lines.map((l) => {
    const total = l.total == null ? null : Number(l.total);
    let quantity = l.quantity == null ? null : Number(l.quantity);
    // normalise credit lines: trust the total's sign (Gemini is inconsistent)
    if (total != null && total < 0 && quantity != null && quantity > 0) quantity = -Math.abs(quantity);
    return { item: String(l.item || ""), unit: l.unit ?? null, quantity, rate: l.rate ?? null, total, section: l.section ?? l.category ?? null };
  });

  const exact = [], review = [], unmatched = [];
  for (const l of norm) {
    const m = bestMatch(l.item, table);
    if (!m) { unmatched.push(l); continue; }
    const row = { ...l, matched_entry: m.entry.item, matched_keyword: m.keyword, matched_category: m.entry.category };
    (m.entry.tier === "exact" ? exact : review).push(row);
  }

  const sum = (rows) => money(rows.reduce((a, r) => a + (r.total || 0), 0));
  const exactSum = sum(exact);
  const reviewSum = sum(review);

  // reconciliation: the bill's own printed total vs the sum of its own lines
  const lineSum = sum(norm);
  let reconciliation = null;
  if (printed_subtotal != null && !Number.isNaN(Number(printed_subtotal))) {
    const diff = money(Number(printed_subtotal) - lineSum);
    if (Math.abs(diff) >= 0.01) {
      reconciliation = {
        printed_subtotal: money(Number(printed_subtotal)),
        sum_of_lines: lineSum,
        difference: diff,
        note: `This bill's own printed total differs from the sum of its own lines by ₹${Math.abs(diff).toFixed(2)}.`,
      };
    }
  }

  // duplicate check: identical item name + identical amount, appearing more than once
  const seen = new Map();
  for (const l of norm) {
    const key = l.item.trim().toLowerCase() + "|" + (l.total == null ? "" : l.total.toFixed(2));
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  const duplicates = [];
  for (const l of norm) {
    const key = l.item.trim().toLowerCase() + "|" + (l.total == null ? "" : l.total.toFixed(2));
    if (seen.get(key) > 1 && !duplicates.find((d) => d.key === key)) {
      duplicates.push({ key, item: l.item, amount: l.total, count: seen.get(key),
        note: "This item appears more than once at the same amount. Worth asking about." });
    }
  }

  // coverage against the deduction figure, if we were given one
  let coverage = null;
  if (deduction != null && Number(deduction) > 0) {
    const d = Number(deduction);
    coverage = {
      deduction: money(d),
      exact_pct: money((exactSum / d) * 100),
      exact_plus_review_pct: money(((exactSum + reviewSum) / d) * 100),
    };
  }

  return {
    exact, review, unmatched,
    exact_total: exactSum,
    review_total: reviewSum,
    line_sum: lineSum,
    reconciliation,
    duplicates,
    coverage,
  };
}

if (typeof module !== "undefined") module.exports = { NON_PAYABLE, bestMatch, analyseBill, money };
