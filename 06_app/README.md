# ClearBill — the app

One file: `index.html`. No build step, no framework, no `npm install`.
The settlement calculator, the Gemini call and all the checks are in that file.

## Run it locally

Double-click `index.html`, **or** (better, so the browser lets it call Gemini):

```
cd 06_app
python -m http.server 8000
```

Open <http://127.0.0.1:8000>.

## What it does

1. **Settlement** — enter total bill, what you paid at the discharge counter,
   hospital discount, co-pay %. It solves backwards for the deduction you were
   never told about. (Load the worked example to see the real ₹5,962 case.)
2. **Bill check (optional)** — paste a Gemini API key
   (aistudio.google.com/apikey, free tier is fine), upload a photo of the
   itemised bill. Gemini reads it into rows; then, in your browser:
   - **matcher** — lines against IRDAI List I; "exact" (named in the list) and
     "review" (commonly deducted, not named) kept separate, never merged
   - **reconciliation** — sum of lines vs the bill's printed Gross Amount
   - **duplicate check** — same item + same amount twice
   - **NPPA** — stent / knee implant priced above the statutory ceiling
   - **IS 19493** — which required bill fields are missing (voluntary standard)

The API key is stored only in the browser's localStorage. The image goes to
Google's Gemini endpoint and nowhere else; the checks are pure client-side.

## Deploy

It is a static file. Any of:
- **Cloud Run** — `Dockerfile` with `nginx`, copy `index.html` to
  `/usr/share/nginx/html/`. Or `gcloud run deploy --source .` with a static
  buildpack.
- **Firebase Hosting / Netlify / GitHub Pages** — drop `index.html` in.
- Keep it in **AI Studio** — paste the file contents back into the app.

## Tested

- Settlement math reproduces the real case (₹5,962.89 vs actual ₹5,962).
- `analyse()` reproduces the tested module results: bill_01 exact-match total
  ₹1,992.50; SYN-07 reconciliation catches the ₹150 gap; SYN-04 duplicate
  caught; SYN-06 no-unit-column and missing-GSTIN caught.
