AI STUDIO BUILD PROMPT — ClearBill
===========================================
HOW TO USE
1. In AI Studio, open your working app and DUPLICATE it (⋮ → Duplicate). Work on the copy.
2. Paste everything below the line into the prompt box.
3. Where it says <<PASTE LOOKUP TABLE>>, paste the full contents of
   03_code/lookup_table_for_prompt.txt (129 rows).
4. Run. Test on 05_synthetic_corpus/pages/SYN-07_photo.jpg, then the real bill's
   page_4.png. Deploy the copy only when it works.

────────────────────────────────────────────────────────────────────────────────

Extend this app. Keep everything that already works — the settlement calculator
(total bill, counter amount, hospital discount, co-pay rate → the never-itemised
deduction) stays exactly as it is. Everything below is ADDED beneath it.

ARCHITECTURE RULE (do not break this)
The model reads. Code judges. Gemini's only job is turning a bill photo into
structured rows. Every flag after that is a table lookup or an arithmetic
comparison in app code, so each flag names the list entry or the sum it came
from. Never produce a flag without a source. Never let Gemini decide whether
something is an overcharge.

──────────────────────────────  1. BILL UPLOAD  ──────────────────────────────
Add an optional step below the calculator: "Add your itemised bill (optional)".
Accept a photo (jpg/png) or a single PDF page. Show a plain text status while
Gemini works ("Reading your bill…"), not a spinner.

Send the image to Gemini with EXACTLY this instruction:

  Transcribe this Indian hospital bill. Return ONLY valid JSON, no markdown.
  Copy every value exactly as printed. Do not calculate, correct, round or
  invent anything. Use null for any field not present. Keep negative amounts
  negative.
  {
    "header": { "hospital_name": null, "hospital_gstin": null,
      "bill_number": null, "bill_datetime": null, "patient_name": null,
      "patient_age": null, "patient_gender": null, "patient_hospital_id": null,
      "patient_uhid": null, "admission_datetime": null,
      "discharge_datetime": null, "admission_type": null, "gross_amount": null,
      "discount_amount": null, "net_payable": null },
    "line_items": [ { "item": "", "unit": null, "quantity": 0, "rate": 0,
      "total": 0, "section": "" } ],
    "printed_subtotals": { }
  }
  Rules: one line_items object per charge row; "section" = the section heading
  it sits under; "unit" = null if the bill has no unit column;
  "printed_subtotals" = each "Total for <section>" figure printed on the bill,
  copied even if it does not match the sum of the lines. Numbers as numbers,
  no symbols, no commas.

──────────────────────────  2. MATCH (embed in app)  ─────────────────────────
const NON_PAYABLE = [
<<PASTE LOOKUP TABLE>>
];

For each extracted line: lowercase the item text, test against every entry's
pipe-separated keywords. If several entries match, pick the one whose matched
keyword is longest, and prefer tier "exact" over "review". Bucket the result:
  • exact   → item is named in the published IRDAI non-payable list
  • review  → commonly deducted but NOT named in the list; needs a human
  • (unmatched) → everything else
NEVER merge exact and review. NEVER auto-flag a review item as a finding.

────────────────────────  3. RECONCILIATION CHECK  ──────────────────────────
Compute sum(all line_items totals). Compare with header.gross_amount (the
printed Gross / Total Bill Amount — NOT the re-summed section subtotals; Gemini
sometimes "fixes" a wrong section subtotal, so trust the printed grand total).
If they differ by ≥ ₹1, show a neutral notice:
  "This bill's printed total differs from the sum of its own lines by ₹X.
   This may be the hospital's arithmetic, not an extraction error."

──────────────────────────────  4. DUPLICATE CHECK  ─────────────────────────
Flag any two lines with identical item text AND identical amount:
  "This item appears more than once at the same amount. Worth asking about."

──────────────────────  5. IS 19493 COMPLETENESS CHECK  ─────────────────────
IS 19493:2025 is the Bureau of Indian Standards bill format. It is VOLUNTARY —
report what it EXPECTS, never call a gap illegal. Check and list what is missing:
  Header (should appear once): hospital name, address, 15-digit GSTIN,
    registration/licence no., unique bill number, bill date+time, patient name,
    age, gender, hospital patient ID, UHID, admission date+time, discharge
    date+time, admission type, gross amount, discount, tax, net payable,
    patient signature block, authorised signatory block.
  Every charge line should show: description, unit, quantity, price per unit,
    total. If any column is absent on all lines, say so
    ("Every charge line is missing the Unit column that IS 19493 expects").
  If GSTIN is present but not in the 15-char format 27ABCDE1234F1Z5, mark it
    malformed, not missing.

──────────────────────  6. NPPA CEILING CHECK (statutory)  ──────────────────
const NPPA = [
  { item: 'Coronary stent - Bare Metal Stent (BMS)', ceiling: 10762.15, gst: 'exclusive of GST' },
  { item: 'Coronary stent - Drug Eluting Stent (DES)', ceiling: 39186.03, gst: 'exclusive of GST' },
  { item: 'Knee - Femoral component, Titanium alloy / Oxidised Zirconium', ceiling: 38740, gst: 'plus 5% GST' },
  { item: 'Knee - Femoral component, High Flex', ceiling: 25860, gst: 'plus 5% GST' },
  { item: 'Knee - Femoral component, Cobalt Chromium', ceiling: 24090, gst: 'plus 5% GST' },
  { item: 'Knee - Tibial component, Titanium alloy / Oxidised Zirconium', ceiling: 24280, gst: 'plus 5% GST' },
  { item: 'Knee - Tibial component, Cobalt Chromium', ceiling: 16990, gst: 'plus 5% GST' },
  { item: 'Knee - Articulating surface / insert', ceiling: 9550, gst: 'plus 5% GST' },
  { item: 'Knee - Patella', ceiling: 4090, gst: 'plus 5% GST' },
  { item: 'Knee - Tibial tray + insert, polyethylene', ceiling: 12960, gst: 'plus 5% GST' },
  { item: 'Knee - Tibial tray + insert, metallic', ceiling: 26546, gst: 'plus 5% GST' },
  { item: 'Knee revision - Femoral component', ceiling: 62770, gst: 'plus 5% GST' },
  { item: 'Knee revision - Tibial component', ceiling: 31220, gst: 'plus 5% GST' },
  { item: 'Knee revision - Articulating surface', ceiling: 15870, gst: 'plus 5% GST' },
];
If a line mentions "stent" or "knee" and an implant/component, and its rate
exceeds the closest NPPA ceiling, show it in its own section titled
"Above the statutory price cap (NPPA)" — this is a legal ceiling, not an
opinion. Keep it visually distinct from everything else.

──────────────────────────────  7. THE BILL REPORT  ────────────────────────
Render below the settlement result, in this order, hairline rules between:

  headline: "About ₹[deduction] was never itemised. Here is what your bill
             suggests it is made of."

  MATCHES THE PUBLISHED NON-PAYABLE LIST         ₹[sum]   [n] lines
    each: item name — amount — "matched: [list entry]"
  COMMONLY DEDUCTED, NOT ON THE PUBLISHED LIST   ₹[sum]   [n] lines
    labelled "needs confirmation, not a finding"
  one honest line:
    "This accounts for about X% of the ₹[deduction]. Insurers often deduct
     whole categories rather than line by line, so the rest may be consumables
     removed in bulk."

  then, only if non-empty:
  ABOVE THE STATUTORY PRICE CAP (NPPA)           [distinct treatment]
  BILL COMPLETENESS (IS 19493, a voluntary standard)  [list of missing items]
  RECONCILIATION       [the notice, if the totals disagree]
  APPEARS TWICE        [the duplicate notice, if any]

RULES
  • Never a flag without naming its source. No source → no flag.
  • Never the words "overcharge", "fraud", "wrongly billed". Say "matches the
    published non-payable list", "above the NPPA ceiling", "the standard
    expects".
  • exact and review in separate sections, not different colours in one list.

──────────────────────────────  8. UI POLISH  ──────────────────────────────
Same restraint as the existing page. Do not add new brand colours, icons,
badges, gradients or illustrations.
  • One accent colour only (the existing one). Everything else is ink on paper:
    near-black text, one muted grey for secondary text, hairline #E5E7EB rules.
  • Money in a tabular-figures font (font-variant-numeric: tabular-nums),
    right-aligned in any column.
  • Generous line-height (1.5+), section headings small, uppercase, letter-
    spaced, muted — the amounts are the loud thing, not the labels.
  • Max content width ~640px, centred. Comfortable padding on mobile (min 16px
    side gutters). Inputs at least 44px tall for thumbs.
  • Every section is collapsible; the settlement result and the headline start
    expanded, the check sections start collapsed.
  • One state at a time: calculator → (optional) upload → reading… → report.
    Don't show empty report scaffolding before a bill is uploaded.
  • No layout shift when the report appears — reserve nothing, just append.
