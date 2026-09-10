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
