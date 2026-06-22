# k6 load test — lightning-server-v2 (via Cloud CDN)

Simulates a viral weather article on a top French news site: thousands of
viewers load the France map and scrub the timeline. The point is to **prove the
Cloud CDN setup holds** before handing the URL to actu.fr.

Tests `https://tiles.meteolibre.dev` by default (override with `BASE_URL`).

> **No k6 install needed** — runs inside the official `grafana/k6` Docker image.
> (The apt repo's signing key is currently broken on Ubuntu 25.10; Docker
> sidesteps it entirely.)

---

## 1. Quick start

```bash
cd lightning-server-v2/loadtest

# sanity check (1 VU, 30s) — must finish with ✓ and no errors
./run.sh smoke

# the real test: viral spike ramping 0 → 1000 concurrent viewers (~7 min)
./run.sh

# worst case: every request a unique tile (origin stress, cache-buster)
./run.sh stress
```

`run.sh` is a thin wrapper around `docker run grafana/k6`. It writes
`loadtest-results.json` (machine-readable) next to the script.

> Prerequisite: Docker must be running. That's it.

---

## 2. What the viral profile does (`./run.sh`)

One "virtual user" = a real page view: metadata (`/available`, `/bounds`) +
a 3×3 map viewport (9 tiles) + ~40% scrub forward one timestep. Users cluster
on 10 French cities → tiles overlap heavily → ideal CDN case.

| Stage | Duration | VUs | Meaning |
|------|---------|-----|---------|
| warm up | 30s | → 50 | CDN fills, origin warms |
| normal | 1m | 50 | typical traffic |
| viral | 30s | → 300 | article trending |
| hold | 2m | 300 | the spike |
| surge | 30s | → 1000 | homepage feature |
| hold | 2m | 1000 | peak sustained |
| cool down | 30s | → 0 | |

---

## 3. The proof that matters: CDN vs no-CDN

Run the same viral profile twice — once through the CDN, once bypassing it
straight to Cloud Run — and compare. This is the number you can show actu.fr.

```bash
# A) through the CDN (should stay fast, ~no errors, high cache hit rate)
./run.sh

# B) bypass the CDN, straight to the Cloud Run origin
BASE_URL=https://lightning-server-v2-935480850831.europe-west3.run.app ./run.sh
```

Expect B to degrade badly at 1000 VUs (origin is CPU-bound on cold decodes)
while A stays flat. That delta is exactly what the CDN buys you.

---

## 4. How to read the output

The k6 summary at the end of the run. The lines that matter:

| Metric | What it means | Pass threshold |
|--------|---------------|----------------|
| `http_req_failed` | % of non-2xx / timeouts | **< 1%** |
| `http_req_duration{type:tile} p(95)` | 95% of tiles under this ms | **< 1000ms** |
| `http_req_duration{type:meta} p(95)` | metadata latency | **< 300ms** |
| `cdn_cache_hit_rate` | share served from the edge | **> 80%** |

Custom metrics (CDN-specific):

| Metric | Meaning |
|--------|---------|
| `cdn_cache_hits` / `cdn_cache_misses` | raw edge HIT vs ORIGIN-fill counts |
| `tile_duration_ms` | tile latency isolated from metadata |

**A green run (all thresholds pass) = safe to launch.** A red
`cdn_cache_hit_rate` during the viral stage means the working set is too large
for cache to dominate → then check raw tile p95 to see if the origin still copes.

> **Smoke note:** `./run.sh smoke` only gates on `http_req_failed`. Cache hit
> rate and tile p95 will look "low" with a single user — that's expected and
> fine. It just confirms URLs resolve and tiles fetch.

---

## 5. Knobs

| Env | Default | Notes |
|-----|---------|-------|
| `BASE_URL` | `https://tiles.meteolibre.dev` | CDN front. Set to `*.run.app` to bypass. |
| `BAND` | `lightning` | `radar`, `sat_ch0`, `sat_ch1`… |
| `PROFILE` | `realistic` | (or pass `smoke`/`stress` as arg to `run.sh`) |

```bash
BAND=radar ./run.sh
BASE_URL=https://lightning-server-v2-935480850831.europe-west3.run.app ./run.sh
```

---

## 6. Running from a realistic location

Your dev machine's latency ≠ a French user's. For a credible number for actu.fr:

- **k6 Cloud**: `k6 cloud k6-loadtest.js` — run from AWS Paris / GCP europe-west.
- A **GCP VM in `europe-west3`** (same region as Cloud Run) measures origin +
  intra-GCP CDN latency.
- The CDN edge POP closest to French users will be lower than either.

---

## 7. Troubleshooting

- **Tiles 404 / setup finds 0 timestamps** → no recent forecast run in the
  bucket, or the bucket path changed. The `setup()` console line shows how many
  timesteps it found. Run your inference/uploader.
- **`run.sh: Permission denied`** → `chmod +x run.sh`.
- **Docker not running** → `systemctl start docker` (or open Docker Desktop).
- **`404 not found` on a tile the script built** → usually a `run_time`
  mismatch; the test pulls `run_time` from `/available`, so confirm that
  endpoint returns it (it does for the current server).

---

## Native k6 install (optional, if you prefer not to use Docker)

```bash
# Go (cleanest native path on any OS):
go install go.k6.io/k6@latest

# then: PROFILE=smoke k6 run k6-loadtest.js
```
