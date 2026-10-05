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

## C · My Bills (optional): save bills to a Google account

Lets a signed-in user save a checked bill and its letter, and record what the
insurer said afterwards. Entirely free — no Firebase project, no npm
dependency, no billing account. Two GCP pieces, both one-time setup:

### 1. A Firestore database (Native mode), free tier
```
gcloud services enable firestore.googleapis.com
gcloud firestore databases create --location=asia-south1 --type=firestore-native
```
Free tier: 1 GiB storage, 50k reads / 20k writes / 20k deletes per day — far
more than a personal project needs.

### 2. Let Cloud Run's service account read/write it
```
PROJECT=$(gcloud config get-value project)
SA=$(gcloud run services describe clearbill --region asia-south1 --format='value(spec.template.spec.serviceAccountName)')
gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:$SA" --role="roles/datastore.user"
```

### 3. An OAuth client for "Sign in with Google"
In the Cloud Console: **APIs & Services → Google Auth Platform** (first visit
asks you to accept the Firebase/Google API Services terms — a one-time,
unavoidable click, not optional config) → **Clients → Create client** →
*Web application* → add your Cloud Run URL (and `http://localhost:<port>` for
local testing) under **Authorized JavaScript origins**. No redirect URI is
needed — the app uses Google Identity Services' button flow, not a
server-side redirect. Copy the generated Client ID (not secret — it is meant
to be public, and is handed to the browser via `/api/config`).

Your sign-in app starts in **Testing** mode (Audience tab), capped to the
Google accounts you explicitly add as test users. Add your own account there
to try it; "Publish app" lifts the cap once you're ready for others to sign
in (no extra verification needed for this app's scopes — just email/profile).

### 4. Deploy with the two extra env vars
```
gcloud run deploy clearbill --source . --region asia-south1 --allow-unauthenticated \
  --set-secrets=GEMINI_API_KEY=GEMINI_API_KEY:latest \
  --update-env-vars=GOOGLE_CLIENT_ID=<your-client-id>.apps.googleusercontent.com,FIRESTORE_PROJECT_ID=<your-project-id>
```
`/api/config` then reports `bills:true` and the app shows the sign-in button.
Leave either var unset and the feature quietly stays off — nothing else
changes, and nothing errors.

**How it's kept zero-dependency and zero-cost:** `lib/google_auth.js` verifies
the browser's Google ID token by hand (fetch Google's public keys, check the
RS256 signature with Node's own `crypto`) instead of pulling in
`google-auth-library`; `lib/firestore_rest.js` talks to Firestore's plain
REST API over `fetch`, authenticated with a token fetched from the Cloud Run
instance's own metadata server — no service-account key file, nothing that
can leak. See `lib/test_google_auth.js` and `lib/test_firestore_rest.js` for
the (offline, mocked) tests covering both.

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

Since R16 it also:
- caps uploads at 10 MB (`MAX_BODY_BYTES`);
- counts every POST, valid or not, toward `ATTEMPT_MAX_PER_IP` (120 per 10 minutes);
- reads at most `READ_INFLIGHT_MAX` photos at once per instance (4). Others wait in a queue of `READ_QUEUE_MAX` (16) for up to `READ_QUEUE_WAIT_MS` (45 s), with their upload not yet read.
- My Bills: limits a request to 40 KB (`BILLS_MAX_BODY_BYTES`), an account to `BILLS_MAX_PER_USER` saved bills (100), and saves plus edits to `BILLS_WRITES_PER_USER` per 10 minutes (60), and checks the type and length of every field.

**Health and alerts.** `GET /api/health` answers 200 `{"ok":true}` while photos can be read. It answers 503 when there is no server key, or when Google refuses the key or the model. It checks this with Google's model-metadata call: no photo, no generation quota, at most once per 5 minutes per instance. Point the Cloud Monitoring uptime check at `/api/health` with the content check `"ok":true`, and the "site is down" alert then also fires for a revoked key or a retired model.

**After every deploy** run the smoke test against the live URL. It reads no photo and saves nothing:
```
node lib/smoke.js https://<your-service-url>
```

**Billing alert.** A budget of ₹1 on the billing account emails the billing admins the moment anything is charged. Budgets are free:
```
gcloud billing budgets create --billing-account=<ACCOUNT_ID> --display-name="ClearBill: any charge" --budget-amount=1INR --threshold-rule=percent=0.5 --threshold-rule=percent=1.0
```

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
