# Added this session (28 Aug 2026)

Everything here is tested and self-contained. Nothing existing was changed.

## 03_code — three checks, each with a test

| file | what it does | test | result |
|---|---|---|---|
| `matcher.js` | matches extracted lines vs the IRDAI table; resolves ambiguous hits by specificity; keeps exact / review buckets separate; duplicate + grand-total reconciliation built in | `test_matcher.js` | reproduces the README's ₹1,992 (33%) / ₹3,824 (64%) on the real bill; catches the double "first visit" charge |
| `completeness.js` | IS 19493:2025 completeness — 26 header fields (23 mandatory, 3 conditional) + the unit/qty/rate/total columns; every output names the clause. Separates `missing` (the hospital did not print it) from `redacted` (we removed it — not assessable, never counted against the bill) | `test_completeness.js` | 19/19; finds the real bill's itemised pages carry no Unit column and no unique bill number |
| `lookup_table_for_prompt.txt` | 129 IRDAI entries (121 exact, 8 review), regenerated from `02_reference_data/irdai_non_payables.csv` | — | paste target for the AI Studio prompt |
| `header_fields_for_prompt.txt` | extraction-prompt add-on so Gemini also returns the bill header | — | — |

Run (from `03_code` — both scripts resolve the test bill relative to the
current directory, not the script):
```
cd 03_code && node test_matcher.js && node test_completeness.js
```

## 05_synthetic_corpus — the 10-bill test set

10 fictional bills, 251 line items, **known ground truth**. 6 carry planted
defects (2 subtotal mismatches, 2 duplicate charges, missing GSTIN / bill
number / unit column), 4 are clean. Each renders clean and photo-degraded.

| file | what it does |
|---|---|
| `generate.py` | rebuilds the whole corpus, deterministically |
| `evaluate.py` | scores an extraction vs truth; `--selftest` proves it (100%/0 on perfect, 80%/1 on −3 lines +1 misread +1 ghost) |
| `check_detection.js` | runs the matcher + completeness checks against truth: **11/11 planted defects caught, 0 false positives on the clean bills** |
| `simulate_extraction.py` | fake extractions for a sanity pass — NOT a measurement |
| `truth/`, `pages/`, `defects.md`, `manifest.json` | the data |

Run:
```
python 05_synthetic_corpus/generate.py
python 05_synthetic_corpus/evaluate.py --selftest
node   05_synthetic_corpus/check_detection.js
```

## 02_reference_data — IRDAI table verified

`verify_against_official.py` cross-checks the 129-row table against the official
IRDAI **List I** (68 items). Full write-up in `IRDAI_VERIFICATION.md`. Headlines:

- The 68-item List I is still current — the 2024 Master Circular consolidated but
  did not replace it.
- 8 expansions are sound (toiletries under official #54).
- **~17 rows graded `exact` are contested** (Cotton, Gauze, SPO2 Probe, BiPAP,
  Blanket…) and should move to `review` — this is the false-positive risk the
  README flags.
- 7 rows are policy exclusions, not List I — wrong authority cited.
- Re-grading the 17 **does not change** the real bill's ₹1,992 / 33% figure —
  none of them matched bill_01. The headline finding is robust.

## To get the real accuracy number

1. Run each `05_synthetic_corpus/pages/SYN-XX_photo.png` through the Gemini
   extraction prompt in the app.
2. Save each result as `05_synthetic_corpus/SYN-XX_extraction.json`
   (shape in `SYN-XX_extraction.template.json`).
3. `python 05_synthetic_corpus/evaluate.py --corpus 05_synthetic_corpus --label SYNTHETIC`
4. Score the real bill the same way on its own line. **Report the two
   separately** — synthetic renders are easier than a real photo.

## Still needs a person

- Wire `matcher.js` + `completeness.js` into the app (AI Studio) — duplicate the
  working app first.
- Verify the IRDAI 129-row table against the current master circular.
- User conversations — the WhatsApp text is in `01_checkpoint2/user_validation_kit.md`.
- `checkpoint2_submission.md` (in Downloads) needs the four bracketed answers.
