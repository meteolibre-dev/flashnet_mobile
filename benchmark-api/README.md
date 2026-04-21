# FlashNet Benchmark API

Lightweight point-forecast service for [WeatherIndex](https://github.com/RainbowMeteo-Technologies/weatherindex) precipitation benchmarking.

Returns precipitation rate (mm/h) at a given `(lon, lat)` for all available lead times from the latest FlashNet forecast run.

## Quick Start

```bash
# Set up credentials (one of)
gcloud auth application-default login
# or
export GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json

# Run locally
pip install -r requirements.txt
python main.py
```

## API

| Endpoint | Description |
|---|---|
| `GET /` | API info & model bounds |
| `GET /health` | Health check (for Cloud Run) |
| `GET /run/latest` | Latest forecast run metadata |
| `GET /nowcast/v1/precip?lon=&lat=` | Point precipitation forecast |

### Example

```bash
curl "http://localhost:8080/nowcast/v1/precip?lon=2.35&lat=48.85"
```

```json
{
  "location": {"lon": 2.35, "lat": 48.85},
  "issuance_time": "2026-04-21T08:20:00Z",
  "forecasts": [
    {
      "valid_time": "2026-04-21T08:30:00Z",
      "offset_minutes": 10,
      "precip_rate_mmh": 1.23,
      "precip_type": "rain",
      "precip_prob": 1.0
    },
    {
      "valid_time": "2026-04-21T08:40:00Z",
      "offset_minutes": 20,
      "precip_rate_mmh": 0.0,
      "precip_type": "none",
      "precip_prob": 0.0
    }
  ],
  "coverage": "ok"
}
```

Points outside the model domain (`lon [-10, 33], lat [33, 65]`) get:

```json
{
  "location": {"lon": -120.0, "lat": 40.0},
  "issuance_time": "",
  "forecasts": [],
  "coverage": "out_of_bounds"
}
```

## How It Works

1. On each request, discovers the latest forecast run folder in GCS
2. For each lead time (T+10, T+20, … T+180 min), constructs the expected radar TIFF path
3. Opens the COG via GDAL `/vsigs/` and samples a single pixel at `(lon, lat)`
4. Converts dBZ → mm/h using Marshall-Palmer (Z = 200·R^1.6)
5. Returns JSON

No data caching — every request reads fresh from GCS.

## Deployment (Cloud Run)

```bash
# Build & push
gcloud builds submit --tag gcr.io/PROJECT_ID/flashnet-benchmark-api

# Deploy
gcloud run deploy flashnet-benchmark-api \
  --image gcr.io/PROJECT_ID/flashnet-benchmark-api \
  --region europe-west1 \
  --allow-unauthenticated \
  --set-env-vars BUCKET_NAME=inference_result_meteolibre_forecast
```

---

## WeatherIndex Integration

Once this API is deployed, you need to add three files to a fork of the [weatherindex](https://github.com/RainbowMeteo-Technologies/weatherindex) repo.

### 1. Forecast Provider

Create `tools/forecast/providers/flashnet.py`:

```python
from forecast.providers.provider import BaseForecastInPointProvider
from forecast.utils.req_interface import RequestInterface, Response
from typing_extensions import override


class FlashNet(BaseForecastInPointProvider, RequestInterface):
    """Polls the FlashNet Benchmark API for point precipitation forecasts."""

    def __init__(self, api_url: str, token: str | None = None, **kwargs):
        super().__init__(**kwargs)
        self._api_url = api_url.rstrip("/")
        self._token = token

    @override
    async def get_json_forecast_in_point(self, lon: float, lat: float) -> str | bytes | None:
        url = f"{self._api_url}/nowcast/v1/precip?lon={lon}&lat={lat}"
        return await self._native_get(url=url)
```

### 2. Parser

Create `metrics/parse/forecast/flashnet.py`:

```python
import json
import os
from datetime import datetime, timezone
from metrics.parse.base_parser import BaseParser
from metrics.data_vendor import DataVendor
from typing import List


class FlashNetParser(BaseParser):
    """Parse FlashNet JSON responses into the unified column format."""

    def _get_columns(self) -> List[str]:
        return ["id", "lon", "lat", "timestamp", "precip_rate", "precip_prob", "precip_type"]

    def _parse_file(self, file_path: str) -> List[dict]:
        sensor_id = os.path.splitext(os.path.basename(file_path))[0]
        with open(file_path) as f:
            data = json.load(f)

        lon = data.get("location", {}).get("lon")
        lat = data.get("location", {}).get("lat")

        # Skip out-of-bounds responses
        if data.get("coverage") == "out_of_bounds" or not data.get("forecasts"):
            return []

        rows = []
        for fc in data["forecasts"]:
            dt = datetime.fromisoformat(
                fc["valid_time"].replace("Z", "+00:00")
            )
            rows.append({
                "id": sensor_id,
                "lon": lon,
                "lat": lat,
                "timestamp": int(dt.timestamp()),
                "precip_rate": fc["precip_rate_mmh"],
                "precip_prob": fc["precip_prob"],
                "precip_type": fc["precip_type"],
            })
        return rows
```

### 3. Register the vendor

In `metrics/data_vendor.py`:

```python
class DataVendor(BaseDataVendor, Enum):
    # ... existing vendors ...
    FlashNet = "flashnet"
```

In `metrics/checkout/data_source.py`, add to `ForecastSourcesInfo`:

```python
s3_uri_flashnet: Optional[str] = None
```

In `metrics/checkout/__main__.py`, add the CLI argument and pass it through.

In `tools/forecast/__main__.py`, add the FlashNet subparser:

```python
from forecast.providers.flashnet import FlashNet

flashnet_parser = subparser.add_parser("flashnet", help="FlashNet")
_add_sensors_params(flashnet_parser)
flashnet_parser.add_argument("--api-url", required=True, help="FlashNet Benchmark API base URL")
flashnet_parser.set_defaults(func=_create_flashnet)

def _create_flashnet(args):
    publisher = _create_publisher(args)
    sensors = Sensor.from_csv(sensors_path=args.sensors, include_countries=args.include_countries)
    return FlashNet(
        api_url=args.api_url,
        download_path=args.download_path,
        publisher=publisher,
        process_num=args.process_num,
        chunk_size=args.chunk_size,
        frequency=args.download_period,
        sensors=sensors,
    )
```

### 4. Run the pipeline

```bash
# 1. Collect forecasts (polls every 10 min per sensor)
python -m forecast \
  --download-path /data/flashnet \
  --s3-uri s3://your-bucket/flashnet/ \
  --sensors metar.sensors.all.csv \
  flashnet --api-url https://your-api.run.app/

# 2. Collect observations (METAR)
python -m forecast \
  --download-path /data/metar \
  --s3-uri s3://your-bucket/metar/ \
  --sensors metar.sensors.all.csv \
  # ... metar provider ...

# 3. Checkout
python -m metrics.checkout \
  --session-path sessions/test \
  --start-time 1745233200 --end-time 1745240400 \
  --s3-uri-flashnet s3://your-bucket/flashnet/ \
  --s3-uri-metar s3://your-bucket/metar/

# 4. Parse
python -m metrics.parse --session-path sessions/test

# 5. Compute metrics
python -m metrics.calc \
  --session-path sessions/test \
  --output-csv results/flashnet_vs_metar.csv \
  events \
  --offsets "10 20 30 40 50 60 70 80 90 100 110 120" \
  --forecast-vendor flashnet \
  --observation-vendor metar
```

### API call budget

```
European METAR sensors ≈ 200 (within model bounds)
Polls per day           = 144  (every 10 min)
Daily requests          = 200 × 144 = 28 800
```

Filter the sensor list to European stations to avoid unnecessary out-of-bounds calls.
