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

And the finding that shapes the product: matching IRDAI's List I against this bill explains **₹460 (8%)** of the deduction. (It read ₹1,310 / 22% until 6 Oct 2026, when an ₹850 "insurance processing fee" stopped being counted as List I: IRDAI's 68-item list does not name it, so it is now "commonly deducted, ask your insurer".) A further **₹689.60** is named on IRDAI's Lists II-IV — items that should already be included in the room, procedure or treatment charge, not billed as their own line (added 27 Sep 2026, cited separately from List I since it's a different claim). Including commonly-deducted-but-unlisted items on top of List I reaches **₹3,062 (51%)**. Assuming the whole consumables category was deducted wholesale reaches **₹5,560 (93%)**.

**Insurers deduct by category, not line by line against the published list.** So the honest promise is not *"we will predict your deduction"* — it is *"we will show you what it is made of."*

---

## The architecture rule

The model reads. Code judges.

Gemini's only job is turning a photograph into structured rows. Every flag after that is a table lookup or an arithmetic operation, so each one can name the document or the formula it came from. No flag can be constructed without a source.

Above that line a mistake is a bug. Below it a mistake is a lie. Keep them on opposite sides and everything else in the design is negotiable.

A signed-in user can optionally save a checked bill and its letter — "My Bills" (added 1 Oct 2026) — to track what the insurer said afterwards. The same rule applies there: `server.js` verifies every Google ID token itself (`06_app/lib/google_auth.js`, hand-rolled against Node's own `crypto`, no library) and every Firestore call is scoped to that verified account (`06_app/lib/firestore_rest.js`) — a user can only ever see their own saved bills, enforced server-side on every request, not by a client-side check. See `06_app/DEPLOY.md` for the (free) setup.

---

## Still open

- **Live extraction and its limits** — the app runs on Cloud Run (asia-south1) with the Gemini key in Secret Manager. The server limits requests per IP and per day; when a limit is hit it says so and offers the user's own key. It is not a guaranteed-availability service.
- **My Bills sign-in** is new (1 Oct 2026) and tested against a mocked Google/Firestore (see `06_app/lib/test_google_auth.js`, `test_firestore_rest.js`, and the `/api/bills` section of `test_server.js`) plus a live local smoke test; it has not yet been exercised through a real Google sign-in by an end user.
- **User validation** at n=1.
- **Test corpus** — one real six-page bill plus a synthetic set. Accuracy on real photographed bills beyond that one bill is not established.
- **Not tested on real devices** — phone browsers, print-to-PDF output, screen readers.
- **Hindi and Marathi text** is machine-translated and has not been reviewed by a native speaker.
- **NPPA knee-implant ceilings** are real notifications this project has not independently re-confirmed, and were published as valid until 15 Nov 2026. The GST allowance applied to implant ceilings (5%) is an assumption pending a primary source.
- **IRDAI table** is built from an insurer's reproduction of List I; see `02_reference_data/IRDAI_VERIFICATION.md` for what was checked and what was not.
