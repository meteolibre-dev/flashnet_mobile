#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# Thin wrapper: runs the k6 load test inside the grafana/k6 Docker image so
# you don't need a local k6 install (and don't have to fight apt keys).
#
#   ./run.sh                 → realistic viral-spike profile (~7 min)
#   ./run.sh smoke           → 1 VU, 30s sanity check
#   ./run.sh stress          → cache-buster origin stress test
#
# Env knobs (optional):
#   BASE_URL=...  ./run.sh        # point at a different origin (e.g. raw Cloud Run)
#   BAND=radar    ./run.sh
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

PROFILE="${1:-realistic}"

# Pull the image on first use (silent if already present).
docker image inspect grafana/k6 >/dev/null 2>&1 || docker pull grafana/k6

echo "▶  profile=$PROFILE  base=${BASE_URL:-https://tiles.meteolibre.dev}  band=${BAND:-lightning}"
echo

# --user        → results file writes as your host UID (no permission errors)
# --network host→ respects your DNS / lets you hit localhost origins for local dev
exec docker run --rm \
  --user "$(id -u):$(id -g)" \
  -e PROFILE="$PROFILE" \
  ${BASE_URL:+-e BASE_URL="$BASE_URL"} \
  ${BAND:+-e BAND="$BAND"} \
  -v "$PWD:/scripts" -w /scripts \
  --network host \
  grafana/k6 run k6-loadtest.js
