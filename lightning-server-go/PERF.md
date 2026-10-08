# perf/render-optimizations — benchmark report

Branch: `perf/render-optimizations` (base: `main` @ 2e78208)
Date: 2026-10-08 · Machine: i7-9700K (8C) · Go 1.26.0 · GDAL 3.12.2 · data: live GCS bucket

## Changes

1. **Buffer pooling** (`render.go`): RGBA + nodata-mask scratch buffers recycled
   via `sync.Pool` (`renderTile`/`releaseTileBuffers`); removed the 256 KB
   fixed-array copy per tile; PNG encoder now wraps the RGBA slice in an
   `image.NRGBA` view instead of copying into `img.Pix`.
2. **Radar dBZ→color LUT** (`palette.go`): precomputed 0.01 dB-granularity LUT
   (10,001 entries) replaces per-pixel `math.Pow`/`math.Log` (Z-R transform),
   fused into a single pass. Bin 0 evaluated at its midpoint (see
   `render_diff_test.go`).
3. **PNG BestSpeed** (`render.go`): `png.Encoder{CompressionLevel: BestSpeed}`
   via shared encoder. Override: `TILE_PNG_COMPRESSION=speed|default|best|none`.
   Empty tile PNG computed once.
4. **GDAL /vsigs/ tuning** (`main.go`): `VSI_CACHE=TRUE` (was FALSE) with
   50 MB cache, removed `CPL_VSIL_CURL_NON_CACHED=/vsigs/` (COGs are immutable
   → range-read caching is safe), `GDAL_HTTP_MULTIRANGE=YES`,
   `CPL_VSIL_CURL_CHUNK_SIZE=65536` (4× default), `GDAL_HTTP_MAX_RETRY=3`,
   `GDAL_HTTP_RETRY_DELAY=1`. All env-overridable; old behavior restorable via
   `VSI_CACHE=FALSE CPL_VSIL_CURL_NON_CACHED=/vsigs/`.

## Correctness (render_diff_test.go)

- lightning / sat_ch0-2: **byte-identical** to reference implementation.
- radar: 26–47 of 65,536 pixels differ per tile (**0.04–0.07%**), all
  single-palette-class shifts, only for values within 0.005 dB of a class
  boundary (adversarial data; real data is smoother). ETag is md5 of rendered
  pixels → affected tiles are simply refetched once.
- PNG BestSpeed vs Default: decoded pixels **identical**; file size +10.6% on a
  real radar tile (24,716 → 27,348 B), +20% on noise-like synthetic worst case.

## Micro-benchmarks (CPU pipeline, `go test -bench=. -benchmem -count=5`)

| Benchmark | Before | After | Speedup |
|---|---|---|---|
| RenderRadar | 5,470 µs · 852 KB · 4 allocs | 415 µs · 0 B · 0 allocs | **13.2×** |
| RenderLightning | 2,167 µs · 590 KB · 3 | 1,167 µs · ~0 B · 0 | 1.9× |
| RenderSatellite | 2,205 µs · 590 KB · 3 | 732 µs · ~0 B · 0 | 3.0× |
| EncodePNG | 18,585 µs · 1.24 MB | 6,014 µs · 1.37 MB | **3.1×** |
| PipelineRadar | 23,858 µs · 2.09 MB | 6,177 µs · 1.37 MB | **3.9×** |
| PipelineLightning | 20,870 µs | 6,045 µs | 3.5× |
| ETagMD5 (256 KB) | 263 µs | 261 µs | — |

PNG encoding dominated the old pipeline (78%); it and the radar transform were
the two big CPU costs. Full render+encode is now ~6 ms/tile with zero render
allocations (remaining allocs are the compressed PNG output + zlib internals).

## End-to-end (local server → live GCS, 8 workers, 40 tiles z3–z8)

| Phase | Metric | Before | After | Δ |
|---|---|---|---|---|
| WARM (hits) | p50 | 2.4 ms | 2.6 ms | ~flat* |
| WARM | rps | 3,137 | 2,493 | −20%* |
| COLD (misses), run 1 | p50 | 339.8 ms | 270.8 ms | **−20%** |
| COLD, run 1 | rps | 22.8 | 24.6 | +8% |
| COLD, run 2 (fresh restarts) | p50 | 300.8 ms | 276.8 ms | **−8%** |
| COLD, run 2 | rps | 23.6 | 25.3 | +7% |
| COLD, both runs | p99 | 873–929 ms | 874–934 ms | ~flat |

\* Hit-path code is unchanged; the warm regression is BestSpeed's +10% tile
bytes saturating loopback writes at ~2.5k rps. If bandwidth matters more than
encode CPU in production, set `TILE_PNG_COMPRESSION=default` (encode drops to
~2× faster than original instead of 3.1×).

Cold misses remain dominated by GCS round-trips and per-dataset serialization
(`ds.mu` in `gdal_cgo.go`) — the next lever there is multiple GDAL handles per
hot COG in `COGPool`, not more CPU work.

## Local GCS auth for benchmarking

GDAL `/vsigs/` ignores gcloud user ADC. For local runs, export from ADC:

```
GS_OAUTH2_REFRESH_TOKEN / GS_OAUTH2_CLIENT_ID / GS_OAUTH2_CLIENT_SECRET
GS_OAUTH2_SCOPE=https://www.googleapis.com/auth/cloud-platform
```

(Production Cloud Run uses the metadata-server path — unaffected.)

## Files

- `render.go` — pooling, fused radar LUT path, NRGBA view, BestSpeed encoder
- `palette.go` — `dbzColorLUT` construction
- `handlers.go` — tile handler uses pooled render + early ETag
- `main.go` — GDAL env tuning
- `render_diff_test.go` — pixel-level equivalence tests
- `render_bench_test.go`, `bench_local.py` — benchmarks (before/after raw
  output in `bench_before.txt` / `bench_after.txt`)
