# ClearBill on WhatsApp — setup

The bot is deployed as its own Cloud Run service, `clearbill-whatsapp`, separate
from the web app. Until the Meta credentials below are added it is inert: it
answers the webhook handshake and returns `501 WhatsApp not configured` to
anything else. Nothing here touches the web app.

Webhook URL:

    https://clearbill-whatsapp-673502835894.asia-south1.run.app/webhook/whatsapp

## What v1 does — and does not

- **Does:** you send a photo of an itemised-bill page; it replies with the
  IRDAI-list matches, "commonly deducted, not named" charges, NPPA ceiling
  breaches, and duplicate charges found on that page. Same rules, same reference
  tables and same wording discipline as the web app (unconfirmed NPPA ceilings
  are never called a legal violation).
- **Does not:** total-vs-lines reconciliation or IS 19493 completeness (both need
  every page together — on one page they would produce false findings), the
  settlement calculator, or the letter builder. The reply says so and links the
  web app.
- Photos are sent to Google's Gemini API to be read and are not stored. The bot
  logs only the last 4 digits of a sender and a status, never message content.
- Per sender: 6 photos per 10 minutes. Meta retries are de-duplicated.

## 1. Meta side (about 15 minutes, needs your own Meta login)

The dashboard layout changes now and then; the names below are the stable ones.

1. Go to <https://developers.facebook.com>, log in, **My Apps → Create App**.
   Choose the *Business* type and the use case *Connect with customers through
   WhatsApp*. Add the **WhatsApp** product.
2. **WhatsApp → API Setup.** Meta gives you a free test number. Note:
   - the **Phone number ID** (not the phone number itself)
   - the **temporary access token** (valid 24 hours — see "Going beyond testing")
   - add your own WhatsApp number under *To* and confirm the code it sends.
     The test number can only message up to 5 numbers you add here.
3. **App settings → Basic →** copy the **App Secret**. (The bot uses it to check
   that every webhook really came from Meta.)
4. **WhatsApp → Configuration → Webhook → Edit.**
   - Callback URL: the webhook URL above.
   - Verify token: read it with
     `gcloud run services describe clearbill-whatsapp --region asia-south1 --format="value(spec.template.spec.containers[0].env)"`
     and copy the `WHATSAPP_VERIFY_TOKEN` value.
   - Click **Verify and save**, then under *Webhook fields* subscribe to **messages**.

## 2. Google Cloud side (PowerShell — prompts for each value, nothing to edit)

```powershell
$g = "C:\Users\Aarya\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
$sa = "673502835894-compute@developer.gserviceaccount.com"
$tok = Read-Host "WhatsApp access token"
$sec = Read-Host "Meta App Secret"
$phoneId = Read-Host "Phone number ID"
$tok | & $g secrets create WHATSAPP_TOKEN --data-file=-
$sec | & $g secrets create WHATSAPP_APP_SECRET --data-file=-
foreach ($n in "WHATSAPP_TOKEN","WHATSAPP_APP_SECRET") {
  & $g secrets add-iam-policy-binding $n --member="serviceAccount:$sa" --role="roles/secretmanager.secretAccessor"
}
& $g run services update clearbill-whatsapp --region asia-south1 `
  --update-secrets="WHATSAPP_TOKEN=WHATSAPP_TOKEN:latest,WHATSAPP_APP_SECRET=WHATSAPP_APP_SECRET:latest" `
  --update-env-vars="WHATSAPP_PHONE_NUMBER_ID=$phoneId"
```

Trailing newlines from the pipe are harmless — the server trims its config.

## 3. Test

From the WhatsApp number you added, message the test number: any text gets the
welcome message; a photo of an itemised-bill page gets the findings in about 30
seconds. If nothing arrives: Cloud Run → `clearbill-whatsapp` → Logs, look for
lines starting `[wa]`.

## Going beyond testing (be aware before promising this to anyone)

- The 24-hour token is for testing. A permanent one needs a *System User* token
  from Meta Business Settings.
- Messaging the general public needs a real WhatsApp Business number and Meta
  business verification — that is Meta's process, not something the code can
  shortcut. Replies to a user who messaged first need no template approval.
- The Graph API version defaults to `v22.0`; override with
  `WHATSAPP_GRAPH_VERSION` if Meta retires it.

## For developers

- `lib/checks.js` is **generated** from `index.html` (`node lib/build_checks.js`),
  so the bot and the web app can never disagree about a reference row.
  `node lib/build_checks.js --check` fails if it is stale.
- `node lib/test_whatsapp.js` runs the real `server.js` against mock Meta and
  Gemini servers with signed payloads (37 checks). It cannot prove Meta delivers
  to your URL — only a real message can.
