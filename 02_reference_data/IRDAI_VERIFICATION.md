# IRDAI table — verification against the official list

**Done 28 Aug 2026.** `python verify_against_official.py` reproduces this.

## Source of truth

The official IRDAI standardized **"List of excluded items" (List I)** — 68 items,
optional / non-medical items the patient absorbs. Extracted verbatim from an
insurer's reproduction (New India Assurance, `List_of_excluded_items.pdf`), which
matches the IRDAI 2016 standardization circular and the 2020 Guidelines on
Standardization of Exclusions.

The **IRDAI Master Circular on Health Insurance Business, 29 May 2024**
consolidated 55 earlier circulars but **did not replace** List I / II / III / IV.
The 68-item List I is still the operative annexure. So the table's provenance
line ("as circulated by insurers") is accurate; it should additionally cite the
2024 Master Circular as the confirming authority.

## What the CSV is

129 rows = the 68 official items, expanded — compound entries split, brand names
and keyword variants added. 121 graded `exact`, 8 graded `review`.

## Findings

### ✅ Defensible expansions (keep `exact`) — 8 rows
`Hand Wash, Brush, Tooth Paste, Towel, Slippers, Tissue Paper, Moisturiser,
Eau-De-Cologne / Room Freshners` — all inherit official item **#54 "CREAMS
POWDERS LOTIONS (Toiletries are not payable, only prescribed medical
pharmaceuticals payable)"**. Fine as `exact`.

### ⚠️ Wrong authority cited — 7 rows
`Dental Treatment Not Requiring Hospitalisation, Hormone Replacement Therapy,
Infertility / Assisted Conception, Obesity Treatment, Corrective Surgery for
Refractive Error, Aesthetic Treatment / Surgery, Stem Cell Implantation` —
these are **standardized policy exclusions (Excl-series)**, not List I
non-medical items. Still non-payable, but the flag should cite the exclusion
clause. Add a `basis` column value like `policy_exclusion` so the app names the
right source.

### 🔴 Re-grade to `review` — ~17 rows
Graded `exact` but **not in List I and not under a parent category** — commonly
deducted, but contested:

```
Micro Shield, Clean Sheet, Cotton, Gauze, Cliniplast, Curapore, Tourniquet,
Eye Pad, Eye Shield, Bed Pan, Blanket / Warmer Blanket, Medicine Box,
BiPAP Machine, Commode, SPO2 Probe, Hand Holder, Referral Doctor's Fees
```

Some are arguably tied to an official item on a closer read (`Bed Pan` ≈ #64
PAN CAN; `Clean Sheet` ≈ laundry; `Referral Doctor's Fees` is long-established).
But `Cotton, Gauze, SPO2 Probe, BiPAP, Blanket, Warmer` are the classic disputed
consumables/equipment — **flagging them as "named in the published list" when
they are not is exactly the false-positive the README warns against.** Move
them to `review` until each is tied to a specific clause.

### 📋 Scope gap (by design, worth stating)
The CSV is **List I only**. Lists II / III / IV — items to be *subsumed* into
room, procedure and treatment charges — are not included. A bill that itemises a
List II/III/IV charge on its own line (e.g. "gloves" billed separately when they
should sit inside procedure charges) would not be flagged. Adding II/III/IV is a
reasonable next step.

### Section A of the script output
22 official items flagged "no obvious matching row" — most are false alarms
(the row exists with different wording). Eyeball, don't act on it blindly.

## Recommended edits to `build_irdai.py`

1. Add authority: `IRDAI Master Circular on Health Insurance Business, 29-05-2024`.
2. Add a `basis` column: `list_i` | `list_i_parent` | `policy_exclusion`.
3. Re-grade the ~17 rows above from `exact` to `review` unless a specific clause
   is found.
4. Track List II/III/IV as a separate table for a later release.

## Primary-source check, 25 Sep 2026

The section above compared the table with an insurer's reproduction of the list. On 25 Sep 2026 the list was also read on IRDAI's own site:

- **Document:** "Modification Guidelines on Standardization in Health Insurance", 27 September 2019 (the page shows reference IRDAI/HLT/REG/CIR/176/09/2019), https://irdai.gov.in/document-detail?documentId=392476. It replaces the 2016 lists.
- **IRDAI's own heading is "List I - Optional Items"**, described as "the Optional Items to which Insurers may offer coverage". Standard policies do not cover them; a policy may offer cover for them as an option. The app's phrase "non-payable list" is the common description; the letter and the IRDAI card now use IRDAI's wording and ask whether the policy offers optional cover.
- **The 68 item names match** `OFFICIAL_68` in verify_against_official.py one for one, with one wording difference: IRDAI's page reads "Private Nurses Charges", while the insurer copy reads "Private nurses charges- special nursing charges". The app matches only "private nurse" and "private nursing".
- **Lists II, III and IV** (items to be subsumed into room charges, procedure charges and treatment costs, which an insurer should not deduct separately) are NOT covered by the app.
- **Bima Bharosa:** https://bimabharosa.irdai.gov.in is IRDAI's grievance management portal (operated by IRDAI, per the site).

Limits of this check: the page was read through a fetch tool that summarises it, not from the original PDF. Before quoting the circular in anything formal, open the PDF on irdai.gov.in and confirm the heading, date and reference number.
