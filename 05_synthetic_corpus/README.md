# Synthetic bill corpus

Ten fictional Indian hospital bills with **known ground truth**, built to measure
two things the real single-bill test cannot:

1. **Extraction accuracy** — because every line was generated, the correct answer
   is exact. No hand-labelling.
2. **Defect detection** — 6 bills carry planted defects, so you can measure that
   the checker catches them *and* that it stays quiet on the 4 clean ones.

Everything here is invented — no real patient, hospital, GSTIN, or bill. The
programme brief allows synthetic data.

---

## Files

```
corpus_spec.py      the 10 bills as data (hospitals, procedures, item pools, defects)
generate.py         builds everything below — run this to regenerate
evaluate.py         scores an extraction against truth  (has --selftest)
check_detection.js  runs matcher.js + completeness.js against truth, scores detection
manifest.json       one line per bill: procedure, line count, total, defects
defects.md          human-readable table of which bill has what
truth/SYN-*.json    ground truth: every line, printed subtotals, defect records
pages/SYN-*_clean.png   clean digital render
pages/SYN-*_photo.png   same bill, degraded to look photographed (skew, blur,
                        uneven light, JPEG artefacts)
```

Regenerate (deterministic — same output every time):

```
python 05_synthetic_corpus/generate.py
```

---

## The 10 bills

| Bill | Procedure | Lines | Clean? | Planted defects |
|---|---|---|---|---|
| SYN-01 | Laparoscopic appendectomy | 23 | yes | — |
| SYN-02 | Cataract surgery (day care) | 19 | yes | — |
| SYN-03 | Coronary angioplasty (1 stent) | 34 | no | subtotal mismatch (PHARMACY, +₹10) |
| SYN-04 | Normal vaginal delivery | 25 | no | duplicate line (CONSULTATION) |
| SYN-05 | Haemodialysis (single session) | 19 | yes | — |
| SYN-06 | Chemotherapy cycle | 26 | no | no GSTIN · no Unit column |
| SYN-07 | Knee arthroscopy | 26 | no | subtotal mismatch (OT, −₹150) · no bill number |
| SYN-08 | Inguinal hernia repair (mesh) | 24 | no | duplicate line (INVESTIGATIONS) · no GSTIN |
| SYN-09 | Pneumonia — medical admission | 30 | yes | — |
| SYN-10 | Ureteroscopy for renal calculus | 25 | no | no bill number · no Unit column · no GSTIN |

251 line items total. SYN-03 and SYN-09 also include a negative pharmacy-return
line, to test credit-line handling.

Exact figures (which section, what delta, which item is duplicated) are in each
`truth/<id>.json` under `defects`.

---

## Workflow — measuring extraction accuracy

1. For each bill, feed `pages/SYN-XX_photo.png` (or `_clean.png`) to your Gemini
   extraction prompt.
2. Save the model's JSON as `05_synthetic_corpus/SYN-XX_extraction.json`, shape:

   ```json
   {
     "header": { "hospital_name": "...", "hospital_gstin": "...", "bill_number": "...",
                 "gross_amount": 0, "discount_amount": 0, "net_payable": 0 },
     "printed_subtotals": { "PHARMACY": 0 },
     "line_items": [
       { "item": "...", "unit": "...", "quantity": 1, "rate": 0, "total": 0, "section": "..." }
     ]
   }
   ```
   `header` and `printed_subtotals` are optional — omit them and only line
   accuracy is scored.

3. Score:

   ```
   python 05_synthetic_corpus/evaluate.py --corpus 05_synthetic_corpus --label SYNTHETIC
   ```

4. Score the **real** bill the same way, on its own line:

   ```
   python 05_synthetic_corpus/evaluate.py \
     --truth <real truth>.json --extraction <real extraction>.json --label REAL-BILL
   ```

**Report the two numbers separately.** These bills render from clean data, so
`_clean.png` is easier than any real photograph and `_photo.png` is a rough
approximation of one. A blended figure hides that.

---

## What the scorer counts

| metric | meaning |
|---|---|
| line accuracy | correct lines ÷ truth lines. A line is *correct* only if matched **and** total and quantity match. A misread amount is not correct. |
| item recall | lines found (amount may be wrong) ÷ truth lines |
| value accuracy | of the lines found, the fraction with exact amount + qty |
| hallucinations | extracted lines matching no truth line — counted, never folded into the % |
| header accuracy | correct header fields ÷ non-null truth header fields |

`evaluate.py --selftest` proves the scorer: a perfect extraction scores 100 % / 0
hallucinations; dropping 3 lines, misreading 1 amount and inventing 1 line on a
20-line bill scores 80 % / 1 hallucination.

---

## Defect detection

```
node 05_synthetic_corpus/check_detection.js
```

Runs `03_code/matcher.js` (duplicate + reconciliation) and
`03_code/completeness.js` (IS 19493 fields) against the **ground truth** — i.e. a
perfect extraction — so it measures the checks, not the OCR. Current result:
**11/11 planted defects caught, 0 false positives on the 4 clean bills.**

Run the same checks on real Gemini output of the `_photo.png` files to see how
much photo noise erodes the small-rupee subtotal check — that erosion is itself
a finding worth reporting.
