# global-server-go

High-performance COG tile server for the **global weather model** (0.1° / 1h),
based on [lightning-server-go](../lightning-server-go) (which serves the local
1km/10min model).

## What's different from lightning-server-go

| | lightning-server-go (local model) | global-server-go (this) |
|---|---|---|
| **Model** | Local 1 km / 10 min | Global 0.1° / 1 h |
| **Bucket** | `gs://inference_result_meteolibre_forecast` | `gs://inference_result_flashedges_forecast` |
| **Layout** | `forecasts/YYYY-MM-DD/{run}/forecast_{ts}_{band}.tiff` | `forecasts/YYYYMMDD/YYYYMMDD_HHMM/forecast_{ts}_{band}.tif` |
| **Bands** | lightning, radar, sat_ch0–2 (one band per file) | `sat_ch0` (IR) + `sat_ch1` (VIS) in `forecast_{ts}_sat.tif`; 7 `metar_*` bands (tmpc, dwpc, mslp, cloud_cover, p01m, wind_u, wind_v) in `forecast_{ts}_metar.tif` |
| **Bounds** | Europe (-10, 33, 33, 65) | Global (-180, -90, 180, 90) |
| **Raster size** | ~4000×4000 | 3600×1800 |

The `metar` COGs are served since v1.1: logical bands `metar_tmpc`,
`metar_dwpc`, `metar_mslp`, `metar_cloud_cover`, `metar_p01m`,
`metar_wind_u`, `metar_wind_v` (raster bands 1-7, same order as the dataset
generator's `METAR_FEATURES`).

Because both channels live in the same GeoTIFF, every COG read takes a
1-based `bandIndex` parameter (IR = 1, VIS = 2) — this is the main code
change vs the lightning server.

## Anonymous fallback

If no GCS credentials are configured (`GCP_CREDENTIALS_B64`, `GCP_CREDENTIALS`
or the metadata server), the server automatically:
- reads rasters over `/vsicurl/https://storage.googleapis.com/...` (GDAL)
- lists the bucket unauthenticated (Go API client)

This works because the bucket objects are publicly readable — handy for local
dev. On Cloud Run, Workload Identity/metadata server credentials are used and
rasters are read via authenticated `/vsigs/`.

## Build & Run

```bash
cd global-server-go
go build -o global-server-go .
GCS_ANONYMOUS=1 ./global-server-go   # local, public bucket
# or
docker compose up -d                 # binds to localhost:3002
```

Requires Go 1.22+ and `libgdal-dev` (cgo).

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3002` (Docker: `8080`) | Server listen port |
| `BUCKET_BASE_URL` | `gs://inference_result_flashedges_forecast/forecasts` | GCS bucket URL |
| `TILE_CACHE_MAX_SIZE` | `2000` | Max LRU tile cache entries |
| `COG_POOL_MAX_SIZE` | `50` | Max open GDAL datasets |
| `GDAL_CACHEMAX` | `500` | GDAL internal cache (MB) |
| `BAND_SAT_CH0_MIN/MAX` | `0` / `250` | VIS render range override |
| `BAND_SAT_CH1_MIN/MAX` | `-35` / `250` | IR render range override |
| `GCS_ANONYMOUS` | — | Force unauthenticated GCS access |
| `GCP_CREDENTIALS_B64` | — | Base64 service account JSON (Cloud Run) |
| `AIRPORTS_AWC_URL` | AWC bulk cache URL | Source for the live station list |
| `AIRPORTS_REFRESH_MINUTES` | `30` | /airports background refresh interval |
| `AIRPORTS_MAX_REPORT_AGE` | `3h` | Max report age for a station to be listed |

## API Endpoints

Same surface as lightning-server-go:

| Endpoint | Description |
|---|---|
| `GET /` | API info |
| `GET /health` | Health check |
| `GET /bands` | Band configs (incl. raster band index) |
| `GET /times` | Generated hourly timestamps |
| `GET /available` | Latest run + its timesteps |
| `GET /airports` | METAR stations with a recent report (live AWC snapshot, gzip+ETag) |
| `GET /history/dates` | Dates with data |
| `GET /history/dates/{YYYY-MM-DD}` | Runs valid on a date |
| `GET /tiles/{z}/{x}/{y}.png` | XYZ tile (PNG) |
| `GET /tilejson` | TileJSON |
| `GET /bounds`, `/info` | COG metadata |
| `GET /point` | Time series at a coordinate |
| `GET /preview` | Full-globe PNG |
| `GET /cache/stats`, `/cache/clear` | Tile cache management |

### Example requests

```
GET /available?days=7
→ { "run_time": "20260823_1500", "count": 24, "timestamps": [
     { "timestamp": "202608231500", "available_bands": ["sat_ch0","sat_ch1"], ... } ] }

GET /tiles/3/4/3.png?band=sat_ch1&time=202608231500&run_time=20260823_1500
GET /point?lat=48.85&lon=2.35&band=sat_ch0
GET /point?lat=48.86&lon=2.35&band=metar_tmpc,metar_dwpc&steps=all&run_time=20260823_1500
```

### METAR airports

`GET /airports` returns only the stations that **actually reported METAR
recently** (previous-hour snapshot, ~5k stations) instead of the full AWC
station registry (~7.7k):

- The server fetches AWC's bulk metar cache (same source as the dataset
  generator's `fetch_latest_global`) every `AIRPORTS_REFRESH_MINUTES` (30) in
  the background, keeps METAR/SPECI reports not older than
  `AIRPORTS_MAX_REPORT_AGE` (3h), and joins station names/countries from the
  embedded registry `data/airports.json` (regenerate with
  `python3 scripts/fetch_airports.py`).
- Responses are pre-rendered per refresh: gzip + per-snapshot ETag + 15 min
  browser cache. `X-Airports-Live: true|false` tells whether the payload is
  the live snapshot or the registry fallback (used until the first
  successful fetch; stale list is kept if AWC is unreachable).

## Deployment

CI/CD: [.github/workflows/deploy-global-server.yml](../.github/workflows/deploy-global-server.yml)
builds the Docker image (multi-stage, GDAL via cgo), pushes it to Artifact
Registry (`europe-west3/flashnet-repo`) and deploys to **Cloud Run** as
`global-server-go` (2 Gi / 2 CPU, 1–4 instances, unauthenticated ingress).

## License

ISC
