# Deploying ClearBill

The app is in this folder: `index.html`, `manifest.json`, `icon.svg`,
plus `server.js` + `Dockerfile` for the Cloud Run path.

Two ways to run it. Do **A** first to get a phone-testable URL today; move to
**B** when you want the key off the client.

---

## A · Static — fastest (5 min, key stays in the browser)

The app is plain files. Any static host works.

### Netlify (no account setup beyond signup)
1. Go to app.netlify.com → "Add new site" → "Deploy manually".
2. Drag the whole `06_app` folder onto the page.
3. You get a URL like `https://clearbill-xxxx.netlify.app` — open it on your phone.

### Firebase Hosting
```
npm i -g firebase-tools
cd 06_app
firebase login
firebase init hosting     # public dir: . (this folder), single-page: No
firebase deploy
```

### Cloud Run (static, via the Node server with no key)
```
cd 06_app
gcloud run deploy clearbill --source . --region asia-south1 --allow-unauthenticated
```
`server.js` serves the files. `/api/config` reports `proxy:false`, so the app
keeps using the in-browser key field.

---

## B · Cloud Run with the Gemini key server-side (recommended for the submission)

Now the browser never sees a key. The app auto-detects the proxy
(`/api/config` → `proxy:true`), hides the key field, and POSTs the image to
`/api/read-bill`.

### 1. Put the key in Secret Manager
```
gcloud services enable secretmanager.googleapis.com run.googleapis.com
printf '%s' 'YOUR_GEMINI_API_KEY' | gcloud secrets create GEMINI_API_KEY --data-file=-
```

### 2. Let Cloud Run read it
```
PROJECT=$(gcloud config get-value project)
NUM=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
gcloud secrets add-iam-policy-binding GEMINI_API_KEY \
  --member="serviceAccount:${NUM}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### 3. Deploy
```
cd 06_app
gcloud run deploy clearbill \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --set-secrets=GEMINI_API_KEY=GEMINI_API_KEY:latest
```

`gcloud run services describe clearbill --region asia-south1 --format='value(status.url)'`
gives the public URL. Open it on your phone → the bill upload works with no key
field.

Model override if needed: `--set-env-vars=GEMINI_MODEL=gemini-3-flash-preview`.

---

## Install on a phone (PWA)

Once the app is on an `https://` URL:

- **Android / Chrome:** an **Install as an app** button appears in the header,
  or use the browser menu → "Install app" / "Add to Home screen".
- **iPhone / Safari:** tap **Share** → **Add to Home Screen**. The app shows a
  hint for this automatically.

Installed, it opens full-screen with its own icon. Needs a connection for the bill upload.

---

## Test on your phone right now, before deploying

Same wifi as your PC:
```
# in 06_app
python -m http.server 8000 --bind 0.0.0.0
```
Find your PC's IP: `ipconfig` (Windows) → IPv4 Address, e.g. `192.168.1.7`.
On the phone browser: `http://192.168.1.7:8000`
(Service worker / install needs https, so PWA install won't work over plain
http — but the whole app and the Gemini call will.)

---

## Spend protection (free)

The proxy is public and sits in front of a billed key, so `server.js` limits
abuse on its own: it serves only `index.html`, `manifest.json` and `icon.svg`;
accepts photos only; answers an honest `429 busy` when a per-IP or per-day cap
is reached (the app then offers "use your own free Gemini key"); and times out
a hanging upstream call. Defaults are generous (60 calls / 10 min / IP, 600 /
day) and can be changed with env vars `RATE_MAX_PER_IP`, `RATE_WINDOW_MS`,
`DAILY_CAP`, `MAX_BODY_BYTES`, `UPSTREAM_TIMEOUT_MS`.

These counters live in memory: every Cloud Run instance counts separately and
they reset when an instance restarts. They reduce abuse; they are not a quota.
**The hard backstop is a daily quota on the key itself** (free, set once):
Google Cloud console → APIs & Services → *Generative Language API* → Quotas →
pick the per-day request quota → Edit → set a ceiling you are comfortable
paying for. Optionally add a Billing budget alert (Billing → Budgets & alerts).

Before every deploy run `node lib/run_gates.js` — it checks the generated
`lib/checks.js`, the frozen regression numbers, the Node suites and the server
protections. If a deploy misbehaves, roll back in seconds with
`gcloud run services update-traffic clearbill --region asia-south1 --to-revisions=<previous-revision>=100`.
