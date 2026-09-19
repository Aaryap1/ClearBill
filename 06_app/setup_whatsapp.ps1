# Connects the deployed clearbill-whatsapp service to your Meta app.
# Run:  powershell -ExecutionPolicy Bypass -File .\setup_whatsapp.ps1
# It asks for three values (from the Meta dashboard), stores two of them in
# Secret Manager, and updates the service. Nothing here needs editing.

$ErrorActionPreference = "Stop"
$g = "C:\Users\Aarya\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
$region = "asia-south1"
$service = "clearbill-whatsapp"
$num = (& $g projects describe (& $g config get-value project) --format="value(projectNumber)").Trim()
$sa = "$num-compute@developer.gserviceaccount.com"

Write-Host "`nFrom developers.facebook.com -> your app -> WhatsApp -> API Setup:" -ForegroundColor Cyan
$phoneId = (Read-Host "1/3  Phone number ID (digits, not the phone number)").Trim()
$tok = (Read-Host "2/3  Temporary access token").Trim()
Write-Host "From App settings -> Basic:" -ForegroundColor Cyan
$sec = (Read-Host "3/3  App Secret").Trim()

foreach ($pair in @(@("WHATSAPP_TOKEN", $tok), @("WHATSAPP_APP_SECRET", $sec))) {
  $name = $pair[0]; $val = $pair[1]
  & $g secrets describe $name *> $null
  if ($LASTEXITCODE -eq 0) { $val | & $g secrets versions add $name --data-file=- | Out-Null }
  else { $val | & $g secrets create $name --data-file=- --replication-policy=automatic | Out-Null }
  & $g secrets add-iam-policy-binding $name --member="serviceAccount:$sa" --role="roles/secretmanager.secretAccessor" | Out-Null
  Write-Host "stored $name"
}

& $g run services update $service --region $region `
  --update-secrets="WHATSAPP_TOKEN=WHATSAPP_TOKEN:latest,WHATSAPP_APP_SECRET=WHATSAPP_APP_SECRET:latest" `
  --update-env-vars="WHATSAPP_PHONE_NUMBER_ID=$phoneId" --quiet

# Read the handshake token from the live service instead of hardcoding it in this file.
$svc = (& $g run services describe $service --region $region --format=json) | ConvertFrom-Json
$verifyToken = ($svc.spec.template.spec.containers[0].env | Where-Object { $_.name -eq "WHATSAPP_VERIFY_TOKEN" }).value

Write-Host "`nDone. Now, in Meta -> WhatsApp -> Configuration -> Webhook:" -ForegroundColor Green
Write-Host "  Callback URL : https://clearbill-whatsapp-673502835894.asia-south1.run.app/webhook/whatsapp"
Write-Host "  Verify token : $verifyToken"
Write-Host "  then subscribe to the 'messages' field, and message the test number from your phone."
