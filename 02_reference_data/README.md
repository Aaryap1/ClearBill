# ClearBill reference data

Two tables. Every row carries where it came from and when it took effect.

## irdai_non_payables.csv  (129 rows)
Items insurers do not pay for, which the patient absorbs.

| column | meaning |
|---|---|
| item | name as published |
| category | administrative, hygiene, consumable, ward, toiletries, baby, guest, equipment, exclusion |
| match_keywords | pipe-separated, lowercase, substring-matched against bill line text |
| confidence | `exact` = named in the list, safe to flag. `review` = commonly deducted but NOT named — surface to a human, never auto-flag. |
| source_document | provenance |
| effective_date | when it applied from |

**Verify before shipping.** Built from an insurer-circulated copy of the list. Check it against the current IRDAI master circular — a wrong row is a wrong flag, and a wrong flag costs more credibility than a missing one.

## nppa_ceilings.csv  (16 rows)
Statutory maximum prices. A charge above these is a legal violation, not an opinion.

Stent ceilings verified against NPPA order S.O. 1587(E), effective 1 April 2026:
BMS ₹10,762.15 and DES ₹39,186.03, both exclusive of GST. Superseded 2025 figures
are retained with `confidence = superseded` so bills from that period still check correctly.

Knee implant rows are marked `verify` — the ceiling was extended to November 2026, but
confirm the current figures against NPPA directly before flagging on them.

## match.py
Matches bill line items against the IRDAI table. Normalises credit lines first
(a negative total forces a negative quantity — the model is inconsistent about this).
Reports exact matches separately from review items, and never merges the two.
