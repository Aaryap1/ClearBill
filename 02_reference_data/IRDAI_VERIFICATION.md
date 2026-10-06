# IRDAI table — verification against the official list

**Done 28 Aug 2026.** `python verify_against_official.py` reproduces this.

## Source of truth

The official IRDAI standardized **"List of excluded items" (List I)** — 68 items,
optional / non-medical items the patient absorbs. Extracted verbatim from an
insurer's reproduction (New India Assurance, `List_of_excluded_items.pdf`), which
matches the IRDAI 2016 standardization circular and the 2020 Guidelines on
Standardization of Exclusions.

**Corrected 6 Oct 2026 (R18).** This section used to say the 2024 Master
Circular "did not replace" the lists and confirmed them. That was wrong.
Checked against IRDAI's own PDFs (irdai.gov.in, documentId=4942918):
- The **Master Circular on Health Insurance Business, 29 May 2024**
  (IRDAI/HLT/CIR/PRO/84/5/2024), Part IV, says: "This Circular supersedes all
  the Guidelines/Circulars listed in Annexure-6."
- **Annexure-6, item 1** is IRDAI/HLT/REG/CIR/193/07/2020 of 22.07.2020,
  the "Master Circular on Standardization of Health Insurance Products". That
  is the circular that carried Lists I-IV after the 2019 guidelines.
- Neither the 2024 circular nor its annexures restate the lists. The text of
  the annexures never mentions non-payable items, "List I", "Optional items"
  or proportionate deduction. Item 19 of Annexure-6 is the 2020
  proportionate-deduction circular, IRDAI/HLT/REG/CIR/151/06/2020, which is
  also superseded.

So the app now cites the lists as published in IRDAI's 2019–2020
standardization guidelines, says the 2024 circular superseded them, and asks
the insurer to confirm whether the policy still applies them. The rule the
letter relies on today is para 17(b) of the 2024 circular, quoted verbatim:
"In case, the claim is repudiated or disallowed partially, details shall be
conveyed to the claimant along with full details giving reference to the
specific terms and conditions of the policy document."

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

## Lists II, III and IV added, and 46 rows re-cited, 27 Sep 2026

The gap named above ("Lists II, III and IV ... are NOT covered by the app") is closed: they are read on IRDAI's own page (same document as above) and added as `irdai_subsumed_lists_ii_iv.csv` (74 rows covering 77 of the 78 official item names; the one deliberate gap, bare "Cotton", is documented in `06_app/lib/test_reference.js`). They are a different regulatory point from List I: List I says an insurer need not pay; Lists II-IV say the item should already be folded into the room, procedure or treatment charge and never billed as its own line. The app cites them separately, in their own report card and letter paragraph, and never counts them toward the List I "Explained %".

Cross-checking the Lists II-IV item names against the rest of the app's table (`NON_PAYABLE`) turned up 46 rows that had been cited as List I when they are actually Lists II-IV items — for example "Scrub Solution / Sterillium" and "Alcohol Swabs" are List IV item names verbatim, and "Gown", "Caps", "Tooth Brush", "Hand Wash" and others were tied to List I only through a loose "toiletries" synonym (an editorial note on official item #54, "creams powders lotions") because List II/III/IV were not yet known when that synonym was written. All 46 were moved to the correct list. This is a declared, intended change: on the worked example and the real bill, the List I total dropped from ₹1,992.50 to ₹1,310 (the moved amount, ₹682.50 of it, plus one further item newly caught, now shows correctly under Lists II-IV instead). The full list of moved rows is in the R8 commit message and `07_change_log`.
