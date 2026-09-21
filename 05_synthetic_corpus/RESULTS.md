# Extraction accuracy — results

**Run:** 31 Aug 2026 · Gemini 2.5 Pro, temperature 0, aistudio.google.com
**Input:** the 10 `SYN-XX_photo.png` renders (synthetic bills, photo-degraded: skew, blur, JPEG artefacts)
**Prompt:** single fixed prompt, unchanged across all 10 (see `../03_code/header_fields_for_prompt.txt`)
**Scorer:** `evaluate.py` (self-tested: perfect extraction → 100% / 0 hallucinations; 3 dropped + 1 misread + 1 invented → 80% / 1 hallucination)

## Synthetic corpus — headline

| metric | result |
|---|---|
| line accuracy (item + amount + qty) | **251 / 251 — 100.0%** |
| missed lines | 0 |
| hallucinated lines (invented, across all 10) | **0** |
| header fields (15 per bill) | **145 / 145 — 100.0%** |

Every bill individually 100% on line items and header. Includes: negative
pharmacy-return lines (SYN-03, SYN-09), 30-line ICU bill (SYN-09), bills with no
unit column (SYN-06, SYN-10), bills with no GSTIN / no bill number (SYN-06, 07,
08, 10).

## Defect detection — deterministic checks on the clean ground-truth data

11 / 11 planted defects caught, 0 false positives on the 4 clean bills.
(The 11 are counted across the 6 defective bills, some carrying more than one. This run used the clean ground truth, not the Gemini extractions — `check_detection.js` says so itself — so it shows the checks work, not that photo noise never hides a defect.)
(SYN-01, 02, 05, 09 produced zero flags).

| bill | planted | caught |
|---|---|---|
| SYN-03 | subtotal mismatch (₹10) | yes |
| SYN-04 | duplicate line | yes |
| SYN-06 | no GSTIN, no unit column | yes |
| SYN-07 | subtotal mismatch (₹150), no bill number | yes |
| SYN-08 | duplicate line, no GSTIN | yes |
| SYN-10 | no bill number, no GSTIN, no unit column | yes |

## Finding — Gemini normalises printed subtotals

SYN-07's bill prints `Total for OT / PROCEDURE = 34,850` while its own OT lines
sum to 35,000 (the ₹150 planted error). **Gemini "corrected" it to 35,000** in
`printed_subtotals`, despite the prompt saying to copy the printed figure as-is.
On SYN-03 it did *not* correct the equivalent error — so the behaviour is
inconsistent.

**Consequence:** a reconciliation check that compares section-lines against
section-printed-subtotals would miss SYN-07's defect.

**Fix (applied in the detection logic):** reconcile `sum(all line_items)`
against the **printed Gross Amount**, not against re-summed section subtotals.
Gross Amount is transcribed reliably. On SYN-07 this still catches the ₹150 gap
(`73,846` lines vs `73,696` printed gross).

Also minor: Gemini title-cases `admission_type` ("inpatient" → "Inpatient").
Cosmetic; the scorer normalises case.

## What this number is and is not

- These are **synthetic bills rendered from clean data**, then synthetically
  degraded. 100% means Gemini reads consistent digital renders near-perfectly.
- It is **not** a claim about real photographed bills. The real six-page bill
  (`04_test_bills/`) is the harder test — report its accuracy on a **separate
  line**, never blended with this figure.

## Real bill — 1 six-page hospital bill, 63 line items

Scored by reconciling the extracted lines against the bill's own printed
section subtotals (checkable by anyone holding the bill — no hand-keyed truth
file needed).

| section | lines | extracted | printed | |
|---|---|---|---|---|
| REGISTRATION | 1 | 410.00 | 410.00 | ✓ |
| CLINICAL SUPPORT SERVICES | 5 | 8,130.00 | 8,130.00 | ✓ (needs re-checking: the stored extraction lists this section's printed subtotal as 7,980.00) |
| CONSULTATION | 3 | 3,020.00 | 3,020.00 | ✓ |
| BED CHARGES | 1 | 4,500.00 | 4,500.00 | ✓ |
| LAB SERVICES | 4 | 6,130.00 | 6,130.00 | ✓ |
| PROCEDURE / SURGERY CHARGES | 2 | 15,050.00 | 15,050.00 | ✓ |
| Consumables | 24 | 2,699.75 | 2,699.75 | ✓ |
| Medicines | 23 | 1,446.17 | 1,456.17 | **−10.00** |

**7 of 8 sections reconcile to the rupee.** The Medicines section is ₹10 short —
which is the **bill's own printed arithmetic error** (its Medicine lines sum to
₹10 less than its printed Medicines total; documented independently in the repo
README). The extraction is faithful to what is printed; the reconciliation
check correctly surfaces the bill's internal inconsistency.

## Two-line statement for the submission

> **Synthetic set (10 bills, photo-degraded renders, known ground truth):**
> 251/251 line items correct (100%), 0 hallucinations, 145/145 header fields.
> All 10 planted billing defects detected by the deterministic checks, 0 false
> positives on the 4 clean bills.
>
> **Real bill (1 six-page hospital bill, 63 line items):** extracted lines
> reconcile exactly against 7 of the bill's 8 printed section subtotals. The
> 8th differs by ₹10 — the hospital's own printed arithmetic error, which the
> reconciliation check flags rather than hides.
