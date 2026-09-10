# ClearBill v1 — PRD (user-facing app)

**Drafted 2 September 2026. Scope bounded by Final Checkpoint (5 Sep) and Lock (7 Sep). Three build days.**

---

## The shape of v1

The MVP proved the finding. v1 makes the finding legible.

> ClearBill v1 takes a hospital settlement and its itemised bill and returns a
> plain-language, sourced account of what the patient's unexplained payment was
> made of — in English, Hindi or Marathi — plus a letter they can send.

The promise does not change: *we show you what it is made of*, not *we predict
your deduction*. Everything below is downstream of that sentence.

### The moment this is built for

A family member, on a phone, days or months after a discharge. They paid ₹9,349
at a counter. They were told ₹5,962 was "not covered." They have a six-page bill
they have never read. They are not going to learn what IRDAI List I is, and they
should not have to. Four minutes, one thumb.

- Every finding must survive being read **once**, quickly, possibly in a second language.
- No term of art appears without its plain gloss beside it — not in a footnote.
- The output has to be forwardable: shown at a hospital desk, pasted into a family WhatsApp group.

---

## Where the build actually stands

`checkpoint2_submission_FINAL.md` lists "checks not yet wired into the deployed
app" as an open gap. **That gap is closed** — `06_app/index.html` runs all five
deterministic checks client-side. The submission text under-sells the build.

| Already true — do not re-plan | | What v1 owes | |
|---|---|---|---|
| Settlement decomposition | ₹1 of actual | Plain-language explanation layer | not started |
| Gemini extraction | 251/251 synthetic | Hindi + Marathi output | not started |
| IRDAI matcher, in app | 129 rows | 17 mis-graded IRDAI rows | flagging red |
| NPPA / reconcile / dupes / IS 19493 | in app | Flags naming their source document | partial |
| Letter generator | English | Multi-page bill input | 1 image only |
| PWA install + Cloud Run proxy | written | NPPA table in app | 6 of 16 rows |
| Synthetic corpus + scorer | 11/11, 0 fp | Cloud Run deploy, verified | contested |

---

## 1 · The explanation layer

### The rule, extended to language

> **The model reads. Code judges. Templates speak.**
> No rupee figure, no percentage and no bill item name passes through a language
> model on its way to the user. If a Hindi sentence contains ₹1,992.50, that
> figure was formatted by `Intl.NumberFormat` from a number deterministic code
> computed.

The failure this prevents: a model asked to "explain this finding in Hindi" will
occasionally round ₹1,992.50 to ₹2,000, or re-derive a percentage. Above the
architecture line a mistake is a bug; below it, a lie. Translation becomes a
lookup, exactly as the IRDAI table is a lookup.

### Findings become objects, not strings

`renderReport()` currently builds HTML inline, so the finding and its English
wording are the same artifact and neither can be translated or tested alone.
Split them: `analyse()` returns findings, `render(finding, lang)` makes words.

```
Finding {
  code:     'IRDAI_EXACT' | 'IRDAI_REVIEW' | 'NPPA_ABOVE_CEILING'
            | 'RECONCILE_GAP' | 'DUPLICATE_LINE' | 'IS19493_MISSING'
  severity: 'finding' | 'confirm' | 'clear'
  amount:   number | null      // rupees, computed — never generated
  count:    number | null
  slots:    { … }              // named values the template interpolates
  basis:    'irdai_list_i' | 'policy_exclusion' | 'not_listed'
            | 'nppa_dpco' | 'arithmetic' | 'is19493_voluntary'
  source:   { document, clause, effective_date }
  lines:    [ … ]              // the bill rows behind it
}
```

### Three slots, every finding, every language

1. **What we found** — the fact, with its number, naming its source document.
2. **What it means for your money** — the consequence in rupees, or an explicit
   "this does not change what you owe."
3. **What you can do** — one concrete action, or "nothing, this is normal."
   Never a vague "follow up."

Slot 3 is what the MVP most lacks. A user reads *"6 charges match the published
non-payable list — ₹1,992"* and cannot tell whether that is good news, bad news,
or theirs to act on.

### Severity vocabulary — a contract, not a starting point

| Finding | Says | Never says |
|---|---|---|
| `IRDAI_EXACT` | "This is on the list insurers don't pay for." | "overcharge", "illegal" |
| `IRDAI_REVIEW` | "Commonly deducted, but not actually named on the list. Worth asking." | anything red-coloured |
| `NPPA_ABOVE_CEILING` | "Above the legal maximum price." The only violation v1 asserts. | — |
| `RECONCILE_GAP` | "The hospital's own total doesn't match its own lines." | "they overcharged you" |
| `DUPLICATE_LINE` | "This charge appears twice at the same amount." | "double billing" as verdict |
| `IS19493_MISSING` | "A voluntary standard expects this field." Carries the word *voluntary* in all three languages. | "non-compliant" |

### Language mechanics

- **Three locales:** `en`, `hi`, `mr`. One `STRINGS` object keyed `code.slot`.
  A missing key falls back to English silently and logs — a half-translated
  report beats a blank one.
- **Switching is instant.** Re-render only: no re-extraction, no network, no
  re-upload. Persisted to `localStorage`.
- **The selector is visible on first paint**, in the header. A user who cannot
  read the English header will not hunt through a menu for the control that
  fixes that.
- **Numbers and dates in-locale** via `Intl.NumberFormat('hi-IN')` / `('mr-IN')`.
  All three preserve Indian lakh grouping.
- **Bill item names are never translated.** The hospital printed `ALCO SWAB` and
  the user must find that exact string on their paper. Translate the gloss, keep
  the source text verbatim.
- **Reading level: a 14-year-old.** The test is reading the Hindi aloud to
  someone who has not seen the app.

---

## 2 · Deterministic logic corrections

User-facing correctness, not cleanup. Each currently produces a flag that is
wrong, or one that cannot name where it came from.

### R1 · Re-grade the 17 contested rows `exact` → `review` — **blocking**

Verified against the live app: all 17 rows named in `IRDAI_VERIFICATION.md` are
still `tier:"exact"` in `06_app/index.html`. Cotton, Gauze, Blanket, SPO2 Probe,
BiPAP, Bed Pan, Commode, Referral Doctor's Fees and nine others are flagged red
as "named in the published list" when they are not named in List I. This is the
false-positive machine the README warns against, shipping in production.

Safe to fix: none of the 17 matched `bill_01`, so ₹1,992 / 33% is unchanged.

### R2 · Add `basis` so each flag cites the right authority — **blocking**

Seven rows (Dental, HRT, Infertility, Obesity, LASIK, Aesthetic, Stem Cell) are
standardized policy exclusions under the Excl-series, not List I non-medical
items. Still non-payable, but the app cites the wrong document. With `basis`
set, the explanation layer names the correct source in slot 1.

### R3 · Carry `source_document` + `effective_date` into the app — **required**

The CSV has both; the inline table dropped them. "Every flag names its source"
is currently true only at the granularity of the words *IRDAI List I*. A user
who asks *says who?* should get a document and a date.

### R4 · One source of truth for reference data — **required**

The app's 129-row table is a hand-maintained duplicate of the CSV, and they have
already drifted: 6 NPPA entries in the app against 16 rows in
`nppa_ceilings.csv`. Generate the app's table from the CSVs at build time. Never
edit two files that must agree. (Same rule covers the model name, hardcoded in
both `server.js` and the client's direct-call URL.)

### R5 · NPPA coverage and date awareness — **required**

6 of 16 rows, missing all three knee *revision* components. Two stent rows are
marked `superseded` with effective dates — a bill from before 1 April 2026 must
check against the older ceiling, and the app ignores dates entirely. Knee rows
are graded `verify`: confirm them against NPPA, or render knee results as
*confirm*, never as a stated violation.

### R6 · Clamp the coverage percentage — **small**

`renderReport` computes `exactSum / deduction` unclamped. Matched items
exceeding the deduction print a figure over 100%, which is meaningless. Clamp
and change the sentence when it saturates.

---

## 3 · Multi-page input

The real bill is six pages; the app accepts one image. **The demo's own worked
example does not fit through the front door** — and the two hospital-side
defects it exists to show (the ₹10 medicines subtotal, the duplicated first
visit) sit on different pages.

**Ship: multi-image accumulate.** Select or photograph N pages, extract each,
concatenate `line_items`, take `header` from the first page carrying one, union
`printed_subtotals`. Reconciliation then runs across the whole bill — the only
configuration in which both defects surface in one report.

**Defer: PDF input.** A phone user photographs a bill; they do not hold a PDF. P1.

---

## 4 · Deployment

**Resolve first:** root `README.md` says the first Cloud Run deploy is
*outstanding*; `checkpoint2_submission_FINAL.md` says the app is *"Deployed to
Google Cloud Run behind a public URL."* One is wrong, and the submission is the
dangerous one to have wrong.

Target: Cloud Run in `asia-south1`, key in Secret Manager, `/api/config`
returning `proxy:true` so the API-key field never renders for a real user. Path
B in `DEPLOY.md` is already written — execute it, don't redesign it. Verify on a
physical phone over mobile data, not office wifi.

---

## 5 · The demo

The before/after is already in the repository and is unusually strong.

**Before:** a settlement receipt reading ₹5,962 "Other Deductions", an
authorisation letter stating in writing that a breakdown was shared, and a year
of unanswered follow-up.

**After:** the same case through the app in three minutes — ₹1,992 named with
sources, two defects the hospital's own arithmetic produced, and a letter ready
to send.

Run part of it in Hindi. The multilingual claim should be watched, not asserted
on a slide.

---

## 6 · Not in v1

- Accounts, login, saved case history
- Server-side storage of bills — ephemeral by design, and the UI should say so
- Pre-admission cost estimation (validation kit Q6 — the next product)
- Deduction **prediction** — permanently out; contradicts the honest promise
- Hospital or insurer integrations
- Languages beyond en / hi / mr
- Document AI in the live path — an evaluated component, not a runtime one

---

## 7 · Acceptance criteria

Testable, and most run against harnesses that already exist.

1. `check_detection.js` still reports 11/11 planted defects and 0 false
   positives on the four clean bills **after** the R1 re-grade.
2. Real bill still yields exact-match total ₹1,992.50 at 33% coverage,
   unchanged by R1 and R2.
3. Every rendered finding carries a source string naming a document and a date.
4. No rupee figure and no item name in any of the three languages originates
   from a model.
5. Switching language re-renders a complete report with no English strings
   leaking into hi or mr on the demo case.
6. The six-page real bill uploads as six images and produces one report
   containing both the ₹10 subtotal defect and the duplicated first-visit charge.
7. Public https URL, no API-key field visible, PWA installs on Android and iOS.
8. Report readable end to end at a 360px viewport.

---

## 8 · Five days

| when | what |
|---|---|
| **3 Sep · Wed** | **Foundations.** R1–R4: reference data corrected and generated from one source. Finding-object refactor. English strings extracted into the three-slot contract. |
| **4 Sep · Thu** | **Language.** Hindi and Marathi strings, selector, in-locale numbers and dates. Multi-image accumulate. |
| **5 Sep · Fri** | **Checkpoint ships.** R5, R6. Cloud Run deploy via Path B. Verified on a real phone over mobile data. |
| **6 Sep · Sat** | **Polish.** UI pass, demo rehearsed end to end on the real bill, deck built. |
| **7 Sep · Sun** | **Lock.** Record, submit. Code frozen midday — the last hours are for the submission, not for commits. |

**If a day is lost, cut in this order:** PDF input (already P1) → knee NPPA rows
(render as *confirm*) → Marathi (ship en + hi, name mr as next) → the IS 19493
detail panel.

**Never cut:** R1, the source strings, the deploy. Those three are what make the
app honest, and honesty is what this project is selling.

---

## 9 · Risks

| risk | mitigation |
|---|---|
| Translation quality, no native reviewer, three days | Templates, not free generation. One Hindi and one Marathi speaker read ~30 strings aloud — a twenty-minute favour, not a translation project. |
| Multi-page means N Gemini calls — latency and free-tier rate limits | Sequential, per-page progress shown. Test all six pages before the demo, not during it. |
| The demo depends on a live Gemini call | Record a fallback video; keep `bill_01_extracted.json` behind a "load the worked example" path needing no network. |
| R1 removes findings the demo relied on | Verified: none of the 17 matched `bill_01`. The headline is safe. |
| Explanation layer slips and the checkpoint has nothing new | English three-slot copy lands day 1 and ships alone. Hindi is additive, not a prerequisite. |

---

## 10 · What v1 still will not claim

Real-bill accuracy rests on one bill. User validation rests on one person.
Coverage against the published list is 33%, not 93%. v1 should keep saying all
three out loud, in the app and in the pitch — a product that names its own
limits reads as control, and this one has spent its whole life arguing that
undisclosed numbers are the problem.
