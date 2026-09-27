# ClearBill reference data

Three tables. Every row carries where it came from and when it took effect.

## irdai_non_payables.csv  (99 rows) — IRDAI List I
Items insurers do not pay for, which the patient absorbs.

**This file and `03_code/lookup_table_for_prompt.txt` are generated from the app's own table** (`NON_PAYABLE` in `06_app/index.html`) by `06_app/lib/sync_reference.js`, and `06_app/lib/test_reference.js` fails if they disagree. Edit the table in the app, then run `node 06_app/lib/sync_reference.js`. `build_irdai.py` was the original one-off builder and no longer produces the current table; do not run it over this file.

| column | meaning |
|---|---|
| item | name as published |
| category | administrative, hygiene, consumable, ward, toiletries, baby, guest, equipment, exclusion |
| match_keywords | pipe-separated, lowercase. Matched as WHOLE WORDS against the bill line (punctuation counts as a space; a plural "s"/"es" is allowed), so "comb" does not match "Combiflam". |
| confidence | `exact` = named in the list, safe to flag. `review` = commonly deducted but NOT named — surface to a human, never auto-flag. |
| source_document | provenance |
| effective_date | when it applied from |
| basis | blank = an item of IRDAI List I; `policy_exclusion` = one of IRDAI's standardised policy exclusions (still non-payable, but a different document) |
| not_keywords | words that cancel a match (for example "cage" or "cement" for the plain "spacer" row) |

Of the 68 official List I items, five are deliberately not matched on their own because the bare word is too broad (gloves, mask, sling, belts/braces, creams/powders/lotions); six more are `review` because a policy may cover them (ambulance, food charges, oxygen cylinder, ECG electrodes, "any kit", service charges). `06_app/lib/test_reference.js` names each of these.

**Verify before shipping.** Built from an insurer-circulated copy of the list, and cross-checked against IRDAI's own site (irdai.gov.in) on 27 Sep 2026 — see `IRDAI_VERIFICATION.md`. A wrong row is a wrong flag, and a wrong flag costs more credibility than a missing one.

## irdai_subsumed_lists_ii_iv.csv  (74 rows) — IRDAI Lists II, III, IV
A different, later addition (27 Sep 2026). These items are not about what an insurer must pay — IRDAI's guidelines say a hospital should already have folded them into another charge and never billed them as a separate line: List II into ROOM charges, List III into PROCEDURE/surgery charges, List IV into the overall TREATMENT cost. Read on irdai.gov.in ("Modification Guidelines on Standardization in Health Insurance", 27 Sep 2019).

Same generation rule as the List I file above: run `node 06_app/lib/sync_reference.js` after editing `SUBSUMED` in `06_app/index.html`; `06_app/lib/test_reference.js` checks all 78 official item names are covered and fails if this file drifts from the app. One deliberate gap each on List II and III: bare "Caps" and bare "Cotton" are not matched on their own, because "Cap" is a common Indian medicine-label abbreviation for "Capsule" and a bare "cotton" keyword would collide with List I's own "Cotton Buds" row (documented in the test file).

| column | meaning |
|---|---|
| item | name as published (a few rows fold more than one official name together, e.g. the Baby Charges group) |
| list | `II`, `III` or `IV` |
| match_keywords | same whole-word matching rule as List I |
| source_document / effective_date | the 27 Sep 2019 guidelines |

## nppa_ceilings.csv  (16 rows)
NPPA price ceilings. A price above a ceiling (plus applicable GST) is worth asking the hospital to explain; whether it breaches the order depends on details the app cannot see (GST, exact device, the notification in force on the bill date). The app never calls a knee-implant line a violation.

Stent ceilings verified against NPPA order S.O. 1587(E), effective 1 April 2026:
BMS ₹10,762.15 and DES ₹39,186.03, both exclusive of GST. Superseded 2025 figures
are retained in the CSV with `confidence = superseded`, but the app does NOT use them: a bill dated before 1 April 2026 is not compared with the current ceilings at all, rather than being compared against the wrong ones (added 25 Sep 2026 — see the NPPA_STENT_FROM guard in the app).

Knee implant rows are marked `verify` — the ceiling was extended to November 2026, but
confirm the current figures against NPPA directly before flagging on them.

## match.py
Matches bill line items against the IRDAI table. Normalises credit lines first
(a negative total forces a negative quantity — the model is inconsistent about this).
Reports exact matches separately from review items, and never merges the two.
