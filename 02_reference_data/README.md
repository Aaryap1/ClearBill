# ClearBill reference data

Two tables. Every row carries where it came from and when it took effect.

## irdai_non_payables.csv  (145 rows)
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

**Verify before shipping.** Built from an insurer-circulated copy of the list. Check it against the current IRDAI master circular — a wrong row is a wrong flag, and a wrong flag costs more credibility than a missing one.

## nppa_ceilings.csv  (16 rows)
NPPA price ceilings. A price above a ceiling (plus applicable GST) is worth asking the hospital to explain; whether it breaches the order depends on details the app cannot see (GST, exact device, the notification in force on the bill date). The app never calls a knee-implant line a violation.

Stent ceilings verified against NPPA order S.O. 1587(E), effective 1 April 2026:
BMS ₹10,762.15 and DES ₹39,186.03, both exclusive of GST. Superseded 2025 figures
are retained in the CSV with `confidence = superseded`, but the app does NOT use them: it has no date logic, so a bill from that period is compared with the current ceilings. Stent rows carry no end date in the app yet.

Knee implant rows are marked `verify` — the ceiling was extended to November 2026, but
confirm the current figures against NPPA directly before flagging on them.

## match.py
Matches bill line items against the IRDAI table. Normalises credit lines first
(a negative total forces a negative quantity — the model is inconsistent about this).
Reports exact matches separately from review items, and never merges the two.
