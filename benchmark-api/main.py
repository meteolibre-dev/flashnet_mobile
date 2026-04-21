"""
FlashNet Benchmark API — Point Forecast Service for WeatherIndex

Returns precipitation rate (mm/h) at a given (lon, lat) for all available
lead times from the latest forecast run.

Designed to be polled by WeatherIndex's forecast collector every 10 min.
"""

import os
import math
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional, List

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import numpy as np
import rasterio
from google.cloud import storage

# ── GDAL / GCS ──────────────────────────────────────────────────────────
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", "tif,tiff")
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("benchmark-api")

# ── Configuration ───────────────────────────────────────────────────────
BUCKET_NAME: str = os.getenv("BUCKET_NAME", "inference_result_meteolibre_forecast")
FORECASTS_PREFIX: str = os.getenv("FORECASTS_PREFIX", "forecasts")
PORT: int = int(os.getenv("PORT", "8080"))

BOUNDS = {
    "west": float(os.getenv("BOUNDS_WEST", "-10.0")),
    "east": float(os.getenv("BOUNDS_EAST", "33.0")),
    "south": float(os.getenv("BOUNDS_SOUTH", "33.0")),
    "north": float(os.getenv("BOUNDS_NORTH", "65.0")),
}

MAX_FORECAST_STEPS: int = int(os.getenv("MAX_FORECAST_STEPS", "18"))
STEP_MINUTES: int = int(os.getenv("STEP_MINUTES", "10"))
RATE_THRESHOLD: float = float(os.getenv("RATE_THRESHOLD", "0.1"))  # mm/h


# ── Helpers ─────────────────────────────────────────────────────────────

def dbz_to_mmh(dbz: float) -> float:
    """Marshall-Palmer Z-R: Z = 200·R^1.6 → R = (Z/200)^(1/1.6)."""
    if dbz <= 0:
        return 0.0
    z = 10.0 ** (dbz / 10.0)
    return (z / 200.0) ** (1.0 / 1.6)


def discover_latest_run() -> Optional[dict]:
    """Find the newest forecast run subfolder in GCS.

    Bucket layout:
        {FORECASTS_PREFIX}/{YYYY-MM-DD}/{YYYY-MM-DD_HH-MM}/forecast_*.tiff

    Returns dict with date_folder, run_subfolder, issuance_time or None.
    """
    client = storage.Client()
    bucket = client.bucket(BUCKET_NAME)
    now = datetime.now(timezone.utc)
    candidates: list[tuple[str, str]] = []

    for delta in range(3):
        date = now - timedelta(days=delta)
        date_str = date.strftime("%Y-%m-%d")
        prefix = f"{FORECASTS_PREFIX}/{date_str}/"
        iterator = bucket.list_blobs(prefix=prefix, delimiter="/")
        list(iterator)  # populate .prefixes
        for p in iterator.prefixes:
            sub = p.rstrip("/").split("/")[-1]
            candidates.append((sub, date_str))

    if not candidates:
        return None

    sub_name, date_str = max(candidates, key=lambda x: x[0])

    # Parse: "2026-04-21_08-20"
    d, t = sub_name.split("_")
    issuance = datetime(
        int(d[:4]), int(d[5:7]), int(d[8:]),
        int(t[:2]), int(t[3:]),
        tzinfo=timezone.utc,
    )

    return {
        "date_folder": date_str,
        "run_subfolder": sub_name,
        "issuance_time": issuance,
    }


# ── Response models ─────────────────────────────────────────────────────

class ForecastEntry(BaseModel):
    valid_time: str        # ISO 8601 UTC  e.g. "2026-04-21T08:30:00Z"
    offset_minutes: int
    precip_rate_mmh: float
    precip_type: str       # "rain" | "none"
    precip_prob: float     # 1.0 if rain, 0.0 otherwise


class PointForecast(BaseModel):
    location: dict
    issuance_time: str
    forecasts: List[ForecastEntry]
    coverage: str = "ok"  # "ok" | "out_of_bounds"


class RunInfo(BaseModel):
    date_folder: str
    run_subfolder: str
    issuance_time: str
    expected_timesteps: int
    max_lead_minutes: int


# ── App ─────────────────────────────────────────────────────────────────

app = FastAPI(
    title="FlashNet Benchmark API",
    description=(
        "Point-forecast API for WeatherIndex precipitation benchmarking. "
        "Samples the latest gridded radar forecast at a given (lon, lat) "
        "and returns precip_rate (mm/h) at each lead time."
    ),
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Endpoints ───────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {
        "name": "FlashNet Benchmark API",
        "version": "1.0.0",
        "model_bounds": BOUNDS,
        "endpoints": {
            "forecast": "/nowcast/v1/precip?lon=...&lat=...",
            "latest_run": "/run/latest",
            "health": "/health",
            "docs": "/docs",
        },
    }


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/run/latest")
def get_latest_run():
    """Return info about the latest available forecast run."""
    run = discover_latest_run()
    if run is None:
        raise HTTPException(404, "No forecast runs found in bucket")

    iss = run["issuance_time"]
    return RunInfo(
        date_folder=run["date_folder"],
        run_subfolder=run["run_subfolder"],
        issuance_time=iss.strftime("%Y-%m-%dT%H:%M:%SZ"),
        expected_timesteps=MAX_FORECAST_STEPS,
        max_lead_minutes=MAX_FORECAST_STEPS * STEP_MINUTES,
    )




@app.get("/nowcast/v1/precip")
def get_precip_forecast(
    lon: float = Query(..., description="Longitude (EPSG:4326)"),
    lat: float = Query(..., description="Latitude (EPSG:4326)"),
):
    """Return precipitation forecast at (lon, lat) for all lead times.

    This is the endpoint WeatherIndex polls for each sensor.
    Returns 200 with `coverage: "out_of_bounds"` if the point is outside
    the model domain — this lets the parser skip it cleanly instead of
    treating it as a fetch failure.

    Usage: GET /nowcast/v1/precip?lon=2.35&lat=48.85
    """
    # ── bounds check ────────────────────────────────────────────────
    in_bounds = (
        BOUNDS["south"] <= lat <= BOUNDS["north"]
        and BOUNDS["west"] <= lon <= BOUNDS["east"]
    )
    if not in_bounds:
        return PointForecast(
            location={"lon": lon, "lat": lat},
            issuance_time="",
            forecasts=[],
            coverage="out_of_bounds",
        )

    # ── find latest run ─────────────────────────────────────────────
    run = discover_latest_run()
    if run is None:
        raise HTTPException(503, "No forecast data available yet")

    issuance = run["issuance_time"]
    base_path = (
        f"/vsigs/{BUCKET_NAME}/{FORECASTS_PREFIX}/"
        f"{run['date_folder']}/{run['run_subfolder']}"
    )

    # ── sample each lead-time TIFF ──────────────────────────────────
    forecasts: list[ForecastEntry] = []

    for step in range(1, MAX_FORECAST_STEPS + 1):
        valid = issuance + timedelta(minutes=STEP_MINUTES * step)
        fname = f"forecast_{valid.strftime('%Y%m%d%H%M')}_radar.tiff"
        tiff_url = f"{base_path}/{fname}"

        try:
            with rasterio.open(tiff_url) as ds:
                rows = list(ds.sample([(lon, lat)]))
                value = float(rows[0][0])

            if not math.isfinite(value) or value <= 0:
                rate = 0.0
            else:
                rate = dbz_to_mmh(value)
        except Exception:
            # TIFF not uploaded yet or read error — skip this lead time
            continue

        is_rain = rate > RATE_THRESHOLD
        forecasts.append(
            ForecastEntry(
                valid_time=valid.strftime("%Y-%m-%dT%H:%M:%SZ"),
                offset_minutes=step * STEP_MINUTES,
                precip_rate_mmh=round(rate, 2),
                precip_type="rain" if is_rain else "none",
                precip_prob=1.0 if is_rain else 0.0,
            )
        )

    return PointForecast(
        location={"lon": lon, "lat": lat},
        issuance_time=issuance.strftime("%Y-%m-%dT%H:%M:%SZ"),
        forecasts=forecasts,
    )


# ── Entry point ─────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    logger.info("Starting FlashNet Benchmark API on port %d", PORT)
    logger.info("Bucket: gs://%s/%s", BUCKET_NAME, FORECASTS_PREFIX)
    logger.info("Model bounds: %s", BOUNDS)
    uvicorn.run("main:app", host="0.0.0.0", port=PORT)
