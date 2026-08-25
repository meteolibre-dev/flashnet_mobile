# MeteoLibre Tiles API

**Base URL:** `https://tiles.meteolibre.dev`

A raster tile server for weather forecasting over **Europe**. It serves pre-rendered PNG map tiles (XYZ scheme) for lightning, radar and satellite channels, generated on the fly from Cloud-Optimized GeoTIFF (COG) files stored on Google Cloud Storage.

- Coverage: Europe — bounds `[-10.0, 33.0, 33.0, 65.0]` (W, S, E, N), CRS `EPSG:4326`
- Tiles: 256×256 PNG, zoom levels 0–12, no-data pixels are **transparent**
- CORS: enabled on all endpoints (`Access-Control-Allow-Origin: *`)
- No authentication required
- Errors are JSON: `{"detail": "..."}`

---

## Bands

| Band key | Description | Value range | Colormap |
|---|---|---|---|
| `lightning` | Lightning probability | 0–4 | Yellow → red (discrete) |
| `radar` | Rain rate | 0–130 mm/h | Radar 35-class (log) |
| `sat_ch0` | Satellite visible | 0–12 | viridis |
| `sat_ch1` | Satellite IR | 3–120 | plasma (inverted) |
| `sat_ch2` | Satellite channel 2 | -3–120 | plasma (inverted) |

---

## Endpoints

### Tiles (main usage)

```
GET /tiles/{z}/{x}/{y}.png?band={band}&time={YYYYMMDDHHMM}&run_time={optional}
```

| Param | Required | Description |
|---|---|---|
| `z/x/y` | ✅ | XYZ tile coordinates (z: 0–12) |
| `band` | ✅ | One of the band keys above (e.g. `lightning`) |
| `time` | ✅ | Forecast timestamp, UTC, format `YYYYMMDDHHMM` (e.g. `202601190100`) |
| `run_time` | – | Pin a specific model run, format `YYYY-MM-DD_HH-MM_region` (e.g. `2026-01-19_08-20_europe`). Optional — if omitted, the latest run containing that timestamp is auto-discovered. |

Returns a 256×256 PNG. Headers include `Cache-Control: public, max-age=300` and `X-Cache: HIT|MISS`.
If no data exists for the tile, a **fully transparent PNG** is returned (HTTP 200).

Example:

```
https://tiles.meteolibre.dev/tiles/6/32/22.png?band=lightning&time=202601190100
```

### Discovery

| Endpoint | Description |
|---|---|
| `GET /available?days=2&band=lightning` | Scans storage for **actually available** forecast timesteps (days: 1–7). Returns timestamps with `datetime`, `available_bands`, `run_time`. |
| `GET /history/dates?days=30` | Dates with data (days: 1–90) |
| `GET /history/dates/{YYYY-MM-DD}?band=lightning` | Model runs and timesteps for a given date |
| `GET /times?hours=24` | Generated list of the last N hourly timestamps (hours: 1–72) — informational only |
| `GET /times/{YYYYMMDDHHMM}` | COG URLs per band for a timestamp |

### Metadata & data

| Endpoint | Description |
|---|---|
| `GET /tilejson?band={band}&time={time}` | TileJSON 2.1.0 document for the requested band/time |
| `GET /bounds?band={band}&time={time}` | Geographic bounds, size, nodata, overviews |
| `GET /info?band={band}&time={time}` | Full COG metadata + band render config |
| `GET /point?lat={lat}&lon={lon}&band={band}` | Time series of values at a coordinate (last 18 available timesteps). For `radar`, values are converted to mm/h. |
| `GET /preview?band={band}&time={time}&width=1024&height=1024` | Full-extent rendered PNG (width/height: 256–2048) |

### Misc

| Endpoint | Description |
|---|---|
| `GET /` | API info |
| `GET /health` | Health check |
| `GET /bands` | Band configuration (min/max/colormap) |
| `GET /cache/stats` | Server tile cache stats |

---

## Typical workflow

1. **Find available data:** `GET /available?band=lightning` → pick a `timestamp` and its `run_time`
2. **Fetch tiles:** `GET /tiles/{z}/{x}/{y}.png?band=lightning&time={timestamp}&run_time={run_time}`
3. Optionally grab `GET /tilejson?...` for bounds/zooms.

## MapLibre GL JS example

```js
const map = new maplibregl.Map({
  container: "map",
  style: "https://demotiles.maplibre.org/style.json",
  center: [10, 48],
  zoom: 4,
});

const TIME = "202601190100";
const RUN = "2026-01-19_08-20_europe";

map.on("load", () => {
  map.addSource("lightning", {
    type: "raster",
    tiles: [
      `https://tiles.meteolibre.dev/tiles/{z}/{x}/{y}.png?band=lightning&time=${TIME}&run_time=${RUN}`,
    ],
    tileSize: 256,
    minzoom: 0,
    maxzoom: 12,
    attribution: "MeteoLibre",
  });

  map.addLayer({
    id: "lightning-layer",
    type: "raster",
    source: "lightning",
    paint: { "raster-opacity": 0.85 },
  });
});
```

Works the same with Leaflet's `L.tileLayer(...)` or any XYZ raster client.

---

*Questions → Adrien*
