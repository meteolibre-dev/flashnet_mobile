#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# Cloud CDN in front of the lightning-server-v2 Cloud Run service.
#
# Creates a GLOBAL EXTERNAL Application Load Balancer with a serverless NEG
# backend to Cloud Run, with Cloud CDN enabled in USE_ORIGIN_HEADERS mode.
#
# Idempotent: safe to re-run. Already-created resources are skipped, and create
# commands do NOT swallow errors, so any real problem is visible.
#
# Result: https://$DOMAIN  →  Cloud CDN edge  →  Cloud Run origin
#
# Prereqs:
#   - Cloud Run service 'lightning-server-v2' already deployed
#   - You own $DOMAIN and can edit its DNS
#   - gcloud installed, authenticated
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ─── Config (override via env) ───────────────────────────────────────────
PROJECT_ID="${PROJECT_ID:-meteoforecast}"
REGION="${REGION:-europe-west3}"
SERVICE="${SERVICE:-lightning-server-v2}"
DOMAIN="${DOMAIN:-tiles.meteolibre.dev}"

# Resource names
IP_NAME="lightning-cdn-ip"
NEG_NAME="lightning-neg"
BACKEND="lightning-cdn-backend"
URL_MAP="lightning-cdn-urlmap"
CERT="lightning-cdn-cert"
HTTPS_PROXY="lightning-cdn-https-proxy"
FR_HTTPS="lightning-cdn-fr-https"
REDIR_URLMAP="lightning-cdn-redir-urlmap"
HTTP_PROXY="lightning-cdn-http-proxy"
FR_HTTP="lightning-cdn-fr-http"

gcloud config set project "$PROJECT_ID"

# Helper: run a create only if the resource does not already exist.
#   mk_exist <describe-args...>     → returns 0 if it exists
exists() { gcloud "$@" >/dev/null 2>&1; }

echo "==> 1/9  Reserve global static IP"
if exists compute addresses describe "$IP_NAME" --global --project="$PROJECT_ID"; then
  echo "    (skipped: already exists)"
else
  gcloud compute addresses create "$IP_NAME" --global --project="$PROJECT_ID"
fi
IP=$(gcloud compute addresses describe "$IP_NAME" --global --project="$PROJECT_ID" --format='value(address)')
echo "    IP: $IP"

echo "==> 2/9  Create serverless NEG → Cloud Run '$SERVICE'"
if exists compute network-endpoint-groups describe "$NEG_NAME" --region="$REGION" --project="$PROJECT_ID"; then
  echo "    (skipped: already exists)"
else
  gcloud compute network-endpoint-groups create "$NEG_NAME" \
    --region="$REGION" --project="$PROJECT_ID" \
    --network-endpoint-type=serverless \
    --cloud-run-service="$SERVICE"
fi

echo "==> 3/9  Create backend service with Cloud CDN (USE_ORIGIN_HEADERS)"
# NOTE 1: --connection-draining-timeout is intentionally OMITTED — it is rejected
#         for serverless-NEG backend services.
# NOTE 2: In USE_ORIGIN_HEADERS mode, GCP FORBIDS --default-ttl / --max-ttl —
#         the TTL comes entirely from the origin's Cache-Control headers
#         (set in main_optimized.py's cache_control_middleware: 60s for
#         /available, 300s for tiles & per-forecast endpoints).
if exists compute backend-services describe "$BACKEND" --global --project="$PROJECT_ID"; then
  echo "    (skipped: already exists)"
else
  gcloud compute backend-services create "$BACKEND" \
    --global --project="$PROJECT_ID" \
    --load-balancing-scheme=EXTERNAL_MANAGED \
    --enable-cdn \
    --cache-mode=USE_ORIGIN_HEADERS \
    --negative-caching \
    --negative-caching-policy=404=60,410=60
fi

echo "==> 4/9  Attach serverless NEG to backend"
if gcloud compute backend-services describe "$BACKEND" --global --project="$PROJECT_ID" \
     --format='value(backends[].group)' 2>/dev/null | grep -q "$NEG_NAME"; then
  echo "    (skipped: NEG already attached)"
else
  gcloud compute backend-services add-backend "$BACKEND" \
    --global --project="$PROJECT_ID" \
    --network-endpoint-group="$NEG_NAME" \
    --network-endpoint-group-region="$REGION"
fi

echo "==> 5/9  Create URL map (default route → backend)"
if exists compute url-maps describe "$URL_MAP" --project="$PROJECT_ID"; then
  echo "    (skipped: already exists)"
else
  gcloud compute url-maps create "$URL_MAP" \
    --project="$PROJECT_ID" \
    --default-service="$BACKEND"
fi

echo "==> 6/9  Create Google-managed SSL certificate for $DOMAIN"
if exists compute ssl-certificates describe "$CERT" --project="$PROJECT_ID"; then
  echo "    (skipped: already exists)"
else
  gcloud compute ssl-certificates create "$CERT" \
    --project="$PROJECT_ID" --domains="$DOMAIN"
fi

echo "==> 7/9  Create HTTPS target proxy"
if exists compute target-https-proxies describe "$HTTPS_PROXY" --project="$PROJECT_ID"; then
  echo "    (skipped: already exists)"
else
  gcloud compute target-https-proxies create "$HTTPS_PROXY" \
    --project="$PROJECT_ID" \
    --url-map="$URL_MAP" \
    --ssl-certificates="$CERT"
fi

echo "==> 8/9  Create HTTPS forwarding rule (443)"
if exists compute forwarding-rules describe "$FR_HTTPS" --global --project="$PROJECT_ID"; then
  echo "    (skipped: already exists)"
else
  gcloud compute forwarding-rules create "$FR_HTTPS" \
    --global --project="$PROJECT_ID" \
    --address="$IP_NAME" \
    --target-https-proxy="$HTTPS_PROXY" \
    --ports=443
fi

echo "==> 9/9  Create HTTP→HTTPS redirect (80 → 443)"
if ! exists compute url-maps describe "$REDIR_URLMAP" --project="$PROJECT_ID"; then
  gcloud compute url-maps import "$REDIR_URLMAP" --project="$PROJECT_ID" <<EOF
name: $REDIR_URLMAP
defaultUrlRedirect:
  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT
  httpsRedirect: true
EOF
fi
if ! exists compute target-http-proxies describe "$HTTP_PROXY" --project="$PROJECT_ID"; then
  gcloud compute target-http-proxies create "$HTTP_PROXY" \
    --project="$PROJECT_ID" --url-map="$REDIR_URLMAP"
fi
if ! exists compute forwarding-rules describe "$FR_HTTP" --global --project="$PROJECT_ID"; then
  gcloud compute forwarding-rules create "$FR_HTTP" \
    --global --project="$PROJECT_ID" \
    --address="$IP_NAME" \
    --target-http-proxy="$HTTP_PROXY" \
    --ports=80
fi

cat <<EOF

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅  Load balancer + Cloud CDN provisioned.   Edge IP: $IP

NEXT STEPS

1) Point DNS for  $DOMAIN  →  $IP
     $DOMAIN.   IN  A   $IP

2) Wait ~10–30 min for the managed SSL cert to go ACTIVE:
     gcloud compute ssl-certificates describe $CERT \\
       --project $PROJECT_ID \\
       --format='value(managed.status)'

3) Verify caching (2nd request should show a cache HIT / age growing):
     curl -sI "https://$DOMAIN/available"  | grep -iE 'cache|age'

4) Point your clients at https://$DOMAIN (replace the *.run.app URL).

5) OPTIONAL — reduce Cloud Run scale now that the CDN absorbs bursts:
     gcloud run services update $SERVICE --region=$REGION \\
       --min-instances=2 --max-instances=6
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF
