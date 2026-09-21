# ClearBill

Making hospital bills checkable. Patchamomma 2026.

**Lock submission: 7 September 2026. No extensions.**

---

## Where things are

```
01_checkpoint2/      what to submit on 28 August
02_reference_data/   the tables the product checks against
03_code/             working scripts
04_test_bills/       the redacted real case
```

---

### 01_checkpoint2

| file | what it is |
|---|---|
| `submission_pack.md` | Corrected timeline, status text, the four fixes to the first submission, and the gaps stated plainly. Paste from here into the form. |
| `user_validation_kit.md` | Six questions, ten minutes each, plus a WhatsApp version. Five conversations before Friday. |

**Do the timeline correction first.** One earlier draft ran milestones to 21 September, two weeks after lock. That is the only thing in this repository that could actively damage the submission.

---

### 02_reference_data

| file | what it is |
|---|---|
| `irdai_non_payables.csv` | 129 rows. Items insurers don't pay for. Each row carries match keywords, a source, an effective date, and a confidence grade. |
| `nppa_ceilings.csv` | 16 rows. Statutory maximum prices for stents and knee implants. A charge above these is a legal violation, not an opinion. |
| `build_irdai.py`, `build_nppa.py` | Regenerate the CSVs. Edit these, not the CSVs, so provenance survives. |
| `README.md` | Column meanings and what still needs verifying. |

**The confidence column is the important one.** `exact` means the item is named in the published list and is safe to flag. `review` means it is commonly deducted but *not* actually named — CSSD sterilisation, ECG leads, sterile surgical gloves. Those go to a human. Never auto-flag a `review` row; that distinction is what stops this becoming a false-positive machine.

---

### 03_code

| file | what it is |
|---|---|
| `match.py` | Matches bill line items against the IRDAI table. Normalises credit-line signs first, since Gemini is inconsistent about them. Reports exact and review matches separately and never merges the two. |
| `redact.py` | Removes identifying content from a bill PDF and renders pages to PNG. Real redaction — deletes the content, does not draw boxes over it. |

Run the matcher:
```
python3 03_code/match.py
```

---

### 04_test_bills

One real case, redacted. Six pages: settlement receipt, TPA authorisation letter, terms, and a three-page itemised bill.

| file | what it is |
|---|---|
| `bill_01_redacted.pdf` | The redacted document |
| `pages/page_1..6.png` | Page images at 200 dpi — this is what you feed to Gemini |
| `bill_01_extracted.json` | 63 extracted line items |

**Check the pages yourself before using them anywhere.** Some text on a scan has no text layer, so no search can find it. Automated redaction cannot be trusted alone.

---

## What the case establishes

```
Total bill                41,396
Other deductions         - 5,962      never itemised
Hospital discount        - 1,572
Co-pay, 10% of 33,862    - 3,387
                          ──────
Authorised                30,476
Paid at the counter        9,349      = 5,962 + 3,387
```

Three documents reconciling to the rupee. Two defects found in them:

- The hospital's own Medicines subtotal is **₹10** higher than its printed medicine lines — it printed ₹53.27 on one line and totalled ₹63.27.
- **"IP – SPECIALTY – FIRST VISIT" charged twice**, ₹1,260 each, on 31/05 and 01/06. There is no such thing as a second first visit.

And the finding that shapes the product: matching the IRDAI list against this bill explains **₹1,992 (33%)** of the deduction. Including commonly-deducted-but-unlisted items reaches **₹3,824 (64%)**. Assuming the whole consumables category was deducted wholesale reaches **₹5,560 (93%)**.

**Insurers deduct by category, not line by line against the published list.** So the honest promise is not *"we will predict your deduction"* — it is *"we will show you what it is made of."*

---

## The architecture rule

The model reads. Code judges.

Gemini's only job is turning a photograph into structured rows. Every flag after that is a table lookup or an arithmetic operation, so each one can name the document or the formula it came from. No flag can be constructed without a source.

Above that line a mistake is a bug. Below it a mistake is a lie. Keep them on opposite sides and everything else in the design is negotiable.

---

## Still open

- **Live extraction and its limits** — the app runs on Cloud Run (asia-south1) with the Gemini key in Secret Manager. The server limits requests per IP and per day; when a limit is hit it says so and offers the user's own key. It is not a guaranteed-availability service.
- **User validation** at n=1.
- **Test corpus** — one real six-page bill plus a synthetic set. Accuracy on real photographed bills beyond that one bill is not established.
- **Not tested on real devices** — phone browsers, print-to-PDF output, screen readers.
- **Hindi and Marathi text** is machine-translated and has not been reviewed by a native speaker.
- **NPPA knee-implant ceilings** are real notifications this project has not independently re-confirmed, and were published as valid until 15 Nov 2026. The GST allowance applied to implant ceilings (5%) is an assumption pending a primary source.
- **IRDAI table** is built from an insurer's reproduction of List I; see `02_reference_data/IRDAI_VERIFICATION.md` for what was checked and what was not.
