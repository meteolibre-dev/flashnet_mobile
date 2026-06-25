# lightning-server-go

High-performance COG tile server written in Go — a rewrite of [lightning-server-v2](../lightning-server-v2) (Python/FastAPI/TiTiler).

## Why Go?

| | Python (V2) | Go (this) |
|---|---|---|
| **Concurrency** | GIL + threadpool | Goroutines (true parallelism) |
| **Binary size** | 300–400 MB Docker image | ~50 MB image |
| **Cold start** | 3–5 s (Python + GDAL imports) | <100 ms |
| **Dataset reuse** | Opens COGReader per request | **Dataset pool** (keeps GDAL datasets open) |
| **Memory** | High (Python overhead + GDAL) | Low (Go runtime + GDAL) |
| **COG reading** | rasterio / rio-tiler | **GDAL cgo binding** (same engine) |

## Architecture

```
┌─────────────────────────────────────────────┐
│           Client (App / MapLibre)           │
└──────────────────────┬──────────────────────┘
                       │ HTTP XYZ Tiles
                       ▼
┌─────────────────────────────────────────────┐
│         Lightning Server Go (net/http)      │
│  ┌──────────┐ ┌──────────┐ ┌─────────────┐ │
│  │ Handlers │ │  Cache   │ │  Renderer   │ │
│  │ (all API)│ │ (LRU)    │ │ (colormaps) │ │
│  └────┬─────┘ └──────────┘ └─────────────┘ │
│       │                                     │
│  ┌────▼──────────────────────────────────┐ │
│  │     COG Pool + GDAL cgo binding       │ │
│  │     (keeps datasets open for reuse)   │ │
│  └────────────────────┬──────────────────┘ │
└───────────────────────┼─────────────────────┘
                        │ /vsigs/ range requests
                        ▼
┌─────────────────────────────────────────────┐
│          Google Cloud Storage (GCS)         │
│   forecast_YYYYMMDDHHMM_{band}.tiff         │
└─────────────────────────────────────────────┘
```

### Key performance optimizations vs Python:

1. **Dataset pool** (`cog.go`): Keeps GDAL datasets open per URL instead of reopening on every tile request. This eliminates repeated TIFF header fetches from GCS — the single biggest latency win.

2. **No GIL**: Go's goroutine scheduler runs truly in parallel across all CPU cores. Every tile request runs concurrently without GIL contention.

3. **LRU cache**: Thread-safe tile cache using `sync.Mutex` + `container/list`. No Python threading lock bottleneck.

4. **Exact same GDAL engine**: Uses the same libgdal underneath, so COG overview selection, range reads, and decompression are identical to the Python version.

## Build & Run

### Prerequisites

- **Go 1.22+**
- **libgdal-dev** (for cgo compilation):
  ```bash
  # macOS
  brew install gdal

  # Ubuntu/Debian
  apt-get install libgdal-dev gdal-bin
  ```

### Local development

```bash
cd lightning-server-go

# Download dependencies
go mod tidy

# Run
go run .

# Or build a binary
go build -o lightning-server-go .
./lightning-server-go
```

### Docker

```bash
docker build -t lightning-server-go .
docker run -p 3001:8080 lightning-server-go

# Or with docker-compose
docker-compose up -d
```

### Configuration

All configuration via environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Server listen port |
| `BUCKET_BASE_URL` | `gs://inference_result_...` | GCS bucket URL |
| `TILE_CACHE_MAX_SIZE` | `2000` | Max LRU tile cache entries |
| `COG_POOL_MAX_SIZE` | `50` | Max open GDAL datasets |
| `GDAL_CACHEMAX` | `500` | GDAL internal cache (MB) |
| `GCP_CREDENTIALS_B64` | — | Base64-encoded service account JSON |
| `GCP_CREDENTIALS` | — | Raw service account JSON |
| `GOOGLE_APPLICATION_CREDENTIALS` | — | Path to credentials file |

## API Endpoints

Identical to the Python version:

| Endpoint | Description |
|---|---|
| `GET /` | API info |
| `GET /health` | Health check |
| `GET /bands` | List available bands |
| `GET /times` | List timestamps (generated) |
| `GET /available` | Scan GCS for available data |
| `GET /history/dates` | List dates with data |
| `GET /history/dates/{date}` | Get runs for a date |
| `GET /tiles/{z}/{x}/{y}.png` | Get XYZ tile (PNG) |
| `GET /tilejson` | Get TileJSON |
| `GET /bounds` | Get geographic bounds |
| `GET /info` | Get COG metadata |
| `GET /point` | Get time series at a point |
| `GET /preview` | Get full-extent preview image |
| `GET /cache/stats` | Cache statistics |
| `GET /cache/clear` | Clear tile cache |

### Tile request

```
GET /tiles/{z}/{x}/{y}.png?band=lightning&time=202601190100&run_time=2026-01-19_08-20_europe
```

## File structure

```
lightning-server-go/
├── main.go              # Entry point, GDAL env setup, HTTP server
├── config.go            # Band configuration, constants
├── palette.go           # Radar palette LUT, colormaps, math (dbz→mm/h)
├── colormap_data.go     # Exact viridis/plasma 256-entry LUTs
├── cache.go             # Thread-safe LRU cache
├── gcs.go               # GCS listing, URL building, GDAL auth
├── cog.go               # COG reading via GDAL (tile/preview/point)
├── render.go            # Colormap application + PNG encoding
├── handlers.go          # HTTP handlers (all endpoints)
├── go.mod               # Go module definition
├── Dockerfile           # Multi-stage build with GDAL
├── docker-compose.yml   # Docker Compose config
└── README.md            # This file
```

## Bands

| Band | Colormap | Range | Notes |
|---|---|---|---|
| `lightning` | Custom (yellow→red) | 0–4 | Discrete scale |
| `radar` | Radar 35-class | 0–130 mm/h | Z-R transform + log palette |
| `sat_ch0` | viridis | 0–12 | Satellite visible |
| `sat_ch1` | plasma (inverted) | 3–120 | Satellite IR |
| `sat_ch2` | plasma (inverted) | -3–120 | Satellite channel 2 |

## License

ISC
