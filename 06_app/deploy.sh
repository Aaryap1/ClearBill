#!/usr/bin/env bash
# ClearBill — deploy to Cloud Run with the Gemini key held server-side.
# Run this in Google Cloud Shell (console.cloud.google.com -> terminal icon),
# from inside the 06_app/ folder. No local install needed.
#
#   bash deploy.sh <PROJECT_ID> <GEMINI_API_KEY>
#
set -euo pipefail

PROJECT="${1:?Usage: bash deploy.sh <PROJECT_ID> <GEMINI_API_KEY>}"
KEY="${2:?Usage: bash deploy.sh <PROJECT_ID> <GEMINI_API_KEY>}"
REGION="${3:-asia-south1}"
SERVICE="clearbill"

gcloud config set project "$PROJECT"

echo "== enabling APIs =="
gcloud services enable run.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com

echo "== storing the key in Secret Manager =="
if gcloud secrets describe GEMINI_API_KEY >/dev/null 2>&1; then
  printf '%s' "$KEY" | gcloud secrets versions add GEMINI_API_KEY --data-file=-
else
  printf '%s' "$KEY" | gcloud secrets create GEMINI_API_KEY --data-file=- --replication-policy=automatic
fi

echo "== granting Cloud Run access to the secret =="
NUM=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
gcloud secrets add-iam-policy-binding GEMINI_API_KEY \
  --member="serviceAccount:${NUM}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" >/dev/null

echo "== deploying =="
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --set-secrets=GEMINI_API_KEY=GEMINI_API_KEY:latest

echo
echo "Done. URL:"
gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)'
echo
echo "Open that URL. The API-key field is gone — the server holds the key."
