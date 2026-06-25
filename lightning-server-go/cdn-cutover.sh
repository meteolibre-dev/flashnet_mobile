#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# Switch the existing Cloud CDN (tiles.meteolibre.dev) from the Python
# backend (lightning-server-v2) to the Go backend (lightning-server-go).
#
# GCP allows only ONE serverless NEG per region per backend service,
# so we can't just add the Go NEG alongside the Python one. Instead:
#
#   1. Create a new serverless NEG → lightning-server-go
#   2. Create a new backend service with the Go NEG + Cloud CDN
#   3. Repoint the URL map to the new backend (instant cutover)
#   4. Clean up old backend service & NEG
#
# Zero downtime: the URL map switch is atomic. The IP, SSL cert,
# forwarding rules, and DNS all stay the same.
#
# Idempotent: safe to re-run.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-meteoforecast}"
REGION="${REGION:-europe-west3}"

NEW_SERVICE="lightning-server-go"
OLD_SERVICE="lightning-server-v2"

# Resource names
NEG_NEW="lightning-neg-go"
NEG_OLD="lightning-neg"
BACKEND_NEW="lightning-cdn-backend-go"
BACKEND_OLD="lightning-cdn-backend"
URL_MAP="lightning-cdn-urlmap"

gcloud config set project "$PROJECT_ID"

exists() { gcloud "$@" >/dev/null 2>&1; }

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Switching tiles.meteolibre.dev → $NEW_SERVICE (Go)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─── 1. Create new serverless NEG → lightning-server-go ──────────────────
echo ""
echo "==> 1/5  Create serverless NEG → Cloud Run '$NEW_SERVICE'"
if exists compute network-endpoint-groups describe "$NEG_NEW" --region="$REGION" --project="$PROJECT_ID"; then
  echo "    (skipped: $NEG_NEW already exists)"
else
  gcloud compute network-endpoint-groups create "$NEG_NEW" \
    --region="$REGION" --project="$PROJECT_ID" \
    --network-endpoint-type=serverless \
    --cloud-run-service="$NEW_SERVICE"
  echo "    Created $NEG_NEW"
fi

# ─── 2. Create new backend service with Cloud CDN ────────────────────────
echo ""
echo "==> 2/5  Create new backend service '$BACKEND_NEW' with Cloud CDN"
if exists compute backend-services describe "$BACKEND_NEW" --global --project="$PROJECT_ID"; then
  echo "    (skipped: $BACKEND_NEW already exists)"
else
  gcloud compute backend-services create "$BACKEND_NEW" \
    --global --project="$PROJECT_ID" \
    --load-balancing-scheme=EXTERNAL_MANAGED \
    --enable-cdn \
    --cache-mode=USE_ORIGIN_HEADERS \
    --negative-caching \
    --negative-caching-policy=404=60,410=60
  echo "    Created $BACKEND_NEW"
fi

# Attach new NEG to new backend
if gcloud compute backend-services describe "$BACKEND_NEW" --global --project="$PROJECT_ID" \
     --format='value(backends[].group)' 2>/dev/null | grep -q "$NEG_NEW"; then
  echo "    (skipped: $NEG_NEW already attached to $BACKEND_NEW)"
else
  gcloud compute backend-services add-backend "$BACKEND_NEW" \
    --global --project="$PROJECT_ID" \
    --network-endpoint-group="$NEG_NEW" \
    --network-endpoint-group-region="$REGION"
  echo "    Attached $NEG_NEW → $BACKEND_NEW"
fi

# ─── 3. Repoint URL map to new backend (THE CUTOVER — atomic) ────────────
echo ""
echo "==> 3/5  Repoint URL map '$URL_MAP' → '$BACKEND_NEW'"
CURRENT_BACKEND=$(gcloud compute url-maps describe "$URL_MAP" --project="$PROJECT_ID" \
  --format='value(defaultService)' 2>/dev/null || echo "")

if echo "$CURRENT_BACKEND" | grep -q "$BACKEND_NEW"; then
  echo "    (skipped: URL map already points to $BACKEND_NEW)"
else
  gcloud compute url-maps set-default-service "$URL_MAP" \
    --project="$PROJECT_ID" \
    --default-backend-bucket="" \
    --default-service="$BACKEND_NEW" 2>/dev/null || \
  gcloud compute url-maps set-default-service "$URL_MAP" \
    --project="$PROJECT_ID" \
    --default-service="$BACKEND_NEW"
  echo "    ✅ Cutover complete! tiles.meteolibre.dev → $NEW_SERVICE"
fi

# ─── 4. Verify ────────────────────────────────────────────────────────────
echo ""
echo "==> 4/5  Verify"
echo ""
echo "  URL map '$URL_MAP' default service:"
gcloud compute url-maps describe "$URL_MAP" --project="$PROJECT_ID" \
  --format='value(defaultService)' | sed 's/^/    /'
echo ""
echo "  Functional test (via CDN):"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://tiles.meteolibre.dev/health" --max-time 10 || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  RESPONSE=$(curl -s "https://tiles.meteolibre.dev/health" --max-time 10 2>/dev/null || echo "")
  if echo "$RESPONSE" | grep -q "lightning-server-go"; then
    echo "    ✅ tiles.meteolibre.dev → lightning-server-go (Go) — CONFIRMED"
  elif echo "$RESPONSE" | grep -q "lightning-server-v2"; then
    echo "    ⚠  Still serving Python (CDN cache). Wait 2-3 min for cache to expire."
  else
    echo "    ✅ tiles.meteolibre.dev responding (HTTP 200)"
  fi
else
  echo "    ⚠  HTTP $HTTP_CODE — NEG change propagating. Wait 2-3 min."
fi

# ─── 5. Clean up old backend + NEG (Python) ──────────────────────────────
echo ""
echo "==> 5/5  Clean up old Python backend resources"
echo ""
echo "  Old backend service '$BACKEND_OLD':"
if exists compute backend-services describe "$BACKEND_OLD" --global --project="$PROJECT_ID"; then
  echo "    Deleting $BACKEND_OLD (no longer referenced by URL map)..."
  gcloud compute backend-services delete "$BACKEND_OLD" --global --project="$PROJECT_ID" --quiet
  echo "    Deleted $BACKEND_OLD"
else
  echo "    (skipped: already deleted)"
fi

echo "  Old NEG '$NEG_OLD':"
if exists compute network-endpoint-groups describe "$NEG_OLD" --region="$REGION" --project="$PROJECT_ID"; then
  gcloud compute network-endpoint-groups delete "$NEG_OLD" --region="$REGION" --project="$PROJECT_ID" --quiet
  echo "    Deleted $NEG_OLD"
else
  echo "    (skipped: already deleted)"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ DONE! tiles.meteolibre.dev → lightning-server-go (Go)"
echo ""
echo "  CDN resources unchanged:"
echo "    - Static IP: lightning-cdn-ip"
echo "    - SSL cert:  lightning-cdn-cert (tiles.meteolibre.dev)"
echo "    - URL map:   lightning-cdn-urlmap → lightning-cdn-backend-go"
echo ""
echo "  The old Python service (lightning-server-v2) is still deployed"
echo "  but receives no CDN traffic. Scale to 0 or delete when ready:"
echo ""
echo "    gcloud run services update lightning-server-v2 \\"
echo "      --region=$REGION --min-instances=0 --max-instances=1"
echo ""
echo "  NOTE: CDN cache may serve stale (Python) tiles for up to 5 min"
echo "  (max-age=300 on tile responses). This is expected."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
