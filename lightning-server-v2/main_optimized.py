"""
Lightning Server V2 - Optimized COG Tile Server

High-performance tile server designed for pre-computed COG files.
Leverages COG internal overviews for instant low-zoom tiles.
"""

import os
import re
import logging
from typing import Dict, Optional, Set
from datetime import datetime, timedelta
from functools import lru_cache

import numpy as np
import requests
from fastapi import FastAPI, Query, HTTPException
from fastapi.responses import Response, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import rasterio
from rasterio.warp import transform_bounds
from rio_tiler.io import COGReader

# Google Cloud Storage for bucket listing
from google.cloud import storage
from google.auth import compute_engine
from google.auth.transport.requests import Request

# Logging configuration
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Configuration
app = FastAPI(
    title="Lightning Server V2",
    description="High-performance COG tile server for weather forecasting",
    version="2.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Environment variables
# Use gs:// for private buckets (requires GCS credentials), https:// for public buckets
BUCKET_BASE_URL = os.getenv("BUCKET_BASE_URL", "gs://inference_result/forecasts")
PORT = int(os.getenv("PORT", "3001"))

# GCS client for signed URLs (lazy initialization)
_gcs_client = None
_gcs_bucket_name = None
_gcs_service_account_email = None


def get_gcs_client():
    """Get or create GCS client for signed URL generation."""
    global _gcs_client, _gcs_bucket_name, _gcs_service_account_email
    if _gcs_client is None:
        _gcs_client = storage.Client()
        # Extract bucket name from URL
        if BUCKET_BASE_URL.startswith("gs://"):
            _gcs_bucket_name = BUCKET_BASE_URL.replace("gs://", "").split("/")[0]
        else:
            _gcs_bucket_name = BUCKET_BASE_URL.replace("https://storage.googleapis.com/", "").split("/")[0]

        # Get service account email for IAM Sign Blob API (needed for Cloud Run)
        # This allows generating signed URLs without a private key
        _gcs_service_account_email = os.getenv("GOOGLE_SERVICE_ACCOUNT_EMAIL")
        if _gcs_service_account_email is None:
            # Try to get from GCP metadata server (automatic on Cloud Run)
            try:
                metadata_url = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email"
                resp = requests.get(metadata_url, headers={"Metadata-Flavor": "Google"}, timeout=2)
                if resp.status_code == 200:
                    _gcs_service_account_email = resp.text.strip()
            except Exception:
                pass  # Not running on GCP or metadata not available

    return _gcs_client, _gcs_bucket_name, _gcs_service_account_email


def get_signing_credentials(service_account_email: str):
    """Get signing credentials for Cloud Run/Compute Engine environments."""
    auth_request = Request()
    signing_credentials = compute_engine.IDTokenCredentials(
        auth_request,
        "",
        service_account_email=service_account_email
    )
    return signing_credentials


# Band configuration - matches inference output naming
class BandConfig(BaseModel):
    name: str
    min: float
    max: float
    colormap: str
    invert: bool = False
    dtype: str = "float32"


BANDS: Dict[str, BandConfig] = {
    "lightning": BandConfig(
        name="Lightning",
        min=0,
        max=4,
        colormap="custom",
        invert=False
    ),
    "sat_ch0": BandConfig(
        name="Satellite Channel 0 (VIS)",
        min=0,
        max=12,
        colormap="viridis",
        invert=False
    ),
    "sat_ch1": BandConfig(
        name="Satellite Channel 1 (IR)",
        min=5,
        max=120,
        colormap="plasma",
        invert=True  # Inverted for IR (cold = bright)
    ),
    # Add more channels as needed
    "sat_ch2": BandConfig(
        name="Satellite Channel 2",
        min=-3,
        max=120,
        colormap="plasma",
        invert=True
    ),
}


def get_cog_url(timestamp: str, band: str, signed: bool = True) -> str:
    """
    Generate the COG URL for a given timestamp and band.
    Matches the naming convention from inference_engine.py:
    - forecast_{timestamp}_sat_ch{0,1,...}.tiff
    - forecast_{timestamp}_lightning.tiff

    If signed=True (default), generates a signed URL for private bucket access.
    """
    # Convert YYYYMMDD to YYYY-MM-DD for bucket path
    date_folder = f"{timestamp[:4]}-{timestamp[4:6]}-{timestamp[6:8]}"
    blob_path = f"forecasts/{date_folder}/forecast_{timestamp}_{band}.tiff"

    if signed and BUCKET_BASE_URL.startswith("gs://"):
        # Generate signed URL for private bucket access
        client, bucket_name, service_account_email = get_gcs_client()
        bucket = client.bucket(bucket_name)
        blob = bucket.blob(blob_path)
        # Use compute_engine.IDTokenCredentials for Cloud Run/Compute Engine
        if service_account_email:
            signing_credentials = get_signing_credentials(service_account_email)
            return blob.generate_signed_url(
                version="v4",
                expiration=timedelta(hours=1),
                method="GET",
                credentials=signing_credentials
            )
        else:
            # Fallback to standard signed URL (requires private key)
            return blob.generate_signed_url(
                version="v4",
                expiration=timedelta(hours=1),
                method="GET"
            )
    else:
        # Public URL or local file
        return f"{BUCKET_BASE_URL}/{date_folder}/forecast_{timestamp}_{band}.tiff"


# Custom colormap for lightning (yellow -> red)
LIGHTNING_CMAP = {
    0: (0, 0, 0, 0),       # Transparent
    1: (255, 255, 0, 180),  # Yellow
    2: (255, 200, 0, 210),  # Orange-yellow
    3: (255, 100, 0, 230),  # Orange
    4: (255, 0, 0, 255),    # Red
}


@app.get("/")
async def root():
    """API info endpoint."""
    return {
        "name": "Lightning Server V2",
        "version": "2.0.0",
        "description": "COG-based tile server for weather forecasting",
        "docs": "/docs",
        "bands": list(BANDS.keys()),
        "data_source": BUCKET_BASE_URL,
        "cog_features": [
            "Internal overviews for fast tiles",
            "HTTP range requests",
            "DEFLATE compression"
        ]
    }


@app.get("/bands")
async def list_bands():
    """List available bands."""
    return {
        band: config.dict()
        for band, config in BANDS.items()
    }


@app.get("/times")
async def list_times(hours: int = Query(24, ge=1, le=72)):
    """List available timestamps."""
    timestamps = []
    now = datetime.utcnow()

    for i in range(hours):
        d = now - timedelta(hours=i)
        timestamps.append({
            "timestamp": d.strftime("%Y%m%d%H%M"),
            "datetime": d.isoformat() + "Z"
        })

    return {
        "timestamps": timestamps,
        "count": len(timestamps)
    }


@app.get("/available")
async def get_available_timesteps(
    days: int = Query(2, ge=1, le=7, description="Number of days to scan"),
    band: str = Query("lightning", description="Band to check for availability")
):
    """
    Scan the GCS bucket for available timesteps.
    Returns actual timestamps that have data in the bucket.
    For each timestamp, also indicates which other bands are available.
    """
    try:
        # Initialize GCS client using the helper
        storage_client, bucket_name, _ = get_gcs_client()
        bucket = storage_client.bucket(bucket_name)

        # Track timestamps and their available bands
        timestamp_bands: Dict[str, Set[str]] = {}
        now = datetime.utcnow()

        # Scan for each day and each band
        for i in range(days):
            d = now - timedelta(days=i)
            date_folder = d.strftime("%Y-%m-%d")
            prefix = f"forecasts/{date_folder}/"

            # List blobs with this prefix
            blobs = bucket.list_blobs(prefix=prefix, max_results=1000)

            for blob in blobs:
                # Extract timestamp and band from filename
                # Pattern: forecasts/YYYY-MM-DD/forecast_YYYYMMDDHHMM_band.tiff
                match = re.search(r"forecast_(\d{12})_([^.]+)\.tiff$", blob.name)
                if match:
                    ts = match.group(1)
                    found_band = match.group(2)

                    if ts not in timestamp_bands:
                        timestamp_bands[ts] = set()
                    timestamp_bands[ts].add(found_band)

        # Convert to sorted list with datetime info
        timestamps = []
        for ts, bands in sorted(timestamp_bands.items()):
            try:
                year = ts[0:4]
                month = ts[4:6]
                day = ts[6:8]
                hour = ts[8:10]
                minute = ts[10:12]
                dt = datetime(int(year), int(month), int(day), int(hour), int(minute))
                timestamps.append({
                    "timestamp": ts,
                    "datetime": dt.isoformat() + "Z",
                    "date_folder": f"{year}-{month}-{day}",
                    "available_bands": list(bands)
                })
            except ValueError:
                continue

        return {
            "timestamps": timestamps,
            "count": len(timestamps),
            "all_bands": list(BANDS.keys())
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error scanning bucket: {str(e)}")


@app.get("/times/{timestamp}")
async def check_timestamp(timestamp: str):
    """Check which bands are available for a timestamp."""
    results = {}
    for band in BANDS.keys():
        url = get_cog_url(timestamp, band)
        results[band] = {"url": url, "checked": False}

    return {"timestamp": timestamp, "bands": results}


@app.get("/tiles/{z}/{x}/{y}.png")
async def get_tile(
    z: int,
    x: int,
    y: int,
    band: str = Query(..., description="Band: lightning, sat_ch0, sat_ch1, ..."),
    time: str = Query(..., description="Timestamp: YYYYMMDDHHMM")
):
    """
    Get a PNG tile for the specified band and time.
    Uses COG internal overviews for optimal performance.
    """
    if band not in BANDS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid band: {band}. Available: {list(BANDS.keys())}"
        )

    config = BANDS[band]

    try:
        url = get_cog_url(time, band)
    except Exception as e:
        # Signed URL generation failed - return transparent tile
        logger.error(f"Failed to generate signed URL for tile {z}/{x}/{y} band={band} time={time}: {e}")
        from io import BytesIO
        from PIL import Image
        img = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
        buffer = BytesIO()
        img.save(buffer, format='PNG')
        return Response(content=buffer.getvalue(), media_type="image/png")

    try:
        # Use COGReader - reads directly from GCS with HTTP range requests
        # COG internal overviews are used automatically for low zoom levels
        with COGReader(url) as cog:
            # Read tile - COG handles overview selection automatically
            tile = cog.tile(x, y, z, tilesize=256, indexes=(1,))
            data = tile.data[0].astype(np.float32)

            # Get nodata value from COG for fallback handling
            nodata_value = cog.nodata if hasattr(cog, 'nodata') else None

            # Create nodata mask BEFORE rescaling (handles NaN and explicit nodata)
            nodata_mask = None
            if nodata_value is not None:
                nodata_mask = (data == nodata_value) | (~np.isfinite(data))
            elif tile.mask is not None:
                nodata_mask = ~tile.mask.astype(bool)
            elif np.any(~np.isfinite(data)):
                # Fallback: treat any non-finite values as nodata
                nodata_mask = ~np.isfinite(data)

            # Apply rescaling
            data = np.clip(data, config.min, config.max)
            data = ((data - config.min) / (config.max - config.min) * 255).astype(np.uint8)

            # Apply colormap
            if band == "lightning":
                # Custom discrete colormap
                rgba = np.zeros((256, 256, 4), dtype=np.uint8)
                for val, color in LIGHTNING_CMAP.items():
                    mask = data == int(val * 255 / config.max)
                    rgba[mask] = color

                # Gradient alpha for values between thresholds
                data_float = data / 255 * config.max
                alpha = np.clip(data_float * 80, 0, 255).astype(np.uint8)
                rgba[:, :, 3] = np.maximum(rgba[:, :, 3], alpha)

                # Handle nodata - set transparent
                if nodata_mask is not None:
                    rgba[nodata_mask] = [0, 0, 0, 0]

            else:
                # Matplotlib colormap for satellite
                from matplotlib import cm

                cmap = cm.get_cmap(config.colormap)
                if config.invert:
                    cmap = cmap.reversed()

                # Normalize data to 0-1 range for colormap
                normalized = data.astype(float) / 255.0
                rgba = (cmap(normalized) * 255).astype(np.uint8)
                rgba[:, :, 3] = 255  # Make fully opaque

                # Set lowest values (0) to transparent (nodata/no signal)
                zero_mask = data == 0
                rgba[zero_mask] = [0, 0, 0, 0]

                # Handle nodata - set transparent
                if nodata_mask is not None:
                    rgba[nodata_mask] = [0, 0, 0, 0]

            # Convert to PNG
            from io import BytesIO
            from PIL import Image

            img = Image.fromarray(rgba, mode='RGBA')
            buffer = BytesIO()
            img.save(buffer, format='PNG', optimize=True)

            return Response(content=buffer.getvalue(), media_type="image/png")

    except Exception as e:
        # Return transparent tile on error
        logger.error(f"Error generating tile {z}/{x}/{y} band={band} time={time}: {e}", exc_info=True)
        from io import BytesIO
        from PIL import Image

        img = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
        buffer = BytesIO()
        img.save(buffer, format='PNG')

        return Response(content=buffer.getvalue(), media_type="image/png")


@app.get("/tilejson")
async def get_tilejson(
    band: str = Query(...),
    time: str = Query(...)
):
    """Get TileJSON for map integration."""
    if band not in BANDS:
        raise HTTPException(status_code=400, detail=f"Invalid band: {band}")

    url = get_cog_url(time, band)

    try:
        with rasterio.open(url) as cog:
            bounds = cog.bounds

            # Transform to WGS84 if needed
            if cog.crs and str(cog.crs) != "EPSG:4326":
                minx, miny, maxx, maxy = transform_bounds(
                    str(cog.crs), "EPSG:4326",
                    bounds.left, bounds.bottom, bounds.right, bounds.top
                )
            else:
                minx, miny, maxx, maxy = bounds.left, bounds.bottom, bounds.right, bounds.top

            # Check for NaN/inf values and use default bounds if invalid
            import math
            default_bounds = [-10.0, 33.0, 33.0, 65.0]
            if any(not math.isfinite(v) for v in [minx, miny, maxx, maxy]):
                minx, miny, maxx, maxy = default_bounds

        return JSONResponse({
            "tilejson": "2.1.0",
            "name": f"{BANDS[band].name} - {time}",
            "version": "1.0.0",
            "scheme": "xyz",
            "tiles": [f"/tiles/{{z}}/{{x}}/{{y}}.png?band={band}&time={time}"],
            "bounds": [minx, miny, maxx, maxy],
            "center": [(minx + maxx) / 2, (miny + maxy) / 2, 4],
            "minzoom": 0,
            "maxzoom": 12
        })

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/bounds")
async def get_bounds(
    band: str = Query(...),
    time: str = Query(...)
):
    """Get geographic bounds for a COG."""
    if band not in BANDS:
        raise HTTPException(status_code=400, detail=f"Invalid band: {band}")

    # Default bounds for Europe region (matching frontend REGION)
    default_bounds = [-10.0, 33.0, 33.0, 65.0]  # [west, south, east, north]

    try:
        url = get_cog_url(time, band)
    except Exception as e:
        # Signed URL generation failed - return default bounds
        return JSONResponse({
            "url": f"gs://inference_result/forecasts/{time[:4]}-{time[4:6]}-{time[6:8]}/forecast_{time}_{band}.tiff",
            "bounds": default_bounds,
            "crs": "EPSG:4326",
            "size": None,
            "nodata": None,
            "overviews": [],
            "error": f"Failed to generate signed URL: {str(e)}"
        })

    try:
        with rasterio.open(url) as cog:
            bounds = cog.bounds

            if cog.crs and str(cog.crs) != "EPSG:4326":
                minx, miny, maxx, maxy = transform_bounds(
                    str(cog.crs), "EPSG:4326",
                    bounds.left, bounds.bottom, bounds.right, bounds.top
                )
                crs = "EPSG:4326"
            else:
                minx, miny, maxx, maxy = bounds.left, bounds.bottom, bounds.right, bounds.top
                crs = str(cog.crs) if cog.crs else "EPSG:4326"

            # Check for NaN/inf values and use default bounds if invalid
            import math
            if any(not math.isfinite(v) for v in [minx, miny, maxx, maxy]):
                minx, miny, maxx, maxy = default_bounds
                crs = "EPSG:4326"

            # Handle nodata - could be NaN
            nodata = cog.nodata
            if nodata is not None and not math.isfinite(nodata):
                nodata = None

            return JSONResponse({
                "url": url,
                "bounds": [minx, miny, maxx, maxy],
                "crs": crs,
                "size": [cog.width, cog.height],
                "nodata": nodata,
                "overviews": list(cog.overviews(1)) if hasattr(cog, 'overviews') else []
            })

    except rasterio.errors.RasterioIOError as e:
        # File doesn't exist or can't be read - return default bounds
        # This allows the frontend to continue working even if some files are missing
        return JSONResponse({
            "url": url,
            "bounds": default_bounds,
            "crs": "EPSG:4326",
            "size": None,
            "nodata": None,
            "overviews": [],
            "error": "File not found, using default bounds"
        })
    except Exception as e:
        # Other errors - return default bounds with error info
        return JSONResponse({
            "url": url,
            "bounds": default_bounds,
            "crs": "EPSG:4326",
            "size": None,
            "nodata": None,
            "overviews": [],
            "error": str(e)
        })


@app.get("/info")
async def get_info(
    band: str = Query(...),
    time: str = Query(...)
):
    """Get detailed COG metadata."""
    if band not in BANDS:
        raise HTTPException(status_code=400, detail=f"Invalid band: {band}")

    url = get_cog_url(time, band)

    try:
        with rasterio.open(url) as cog:
            import math

            # Handle bounds - check for NaN/inf
            bounds = list(cog.bounds)
            bounds = [b if math.isfinite(b) else None for b in bounds]

            # Handle nodata - could be NaN
            nodata = cog.nodata
            if nodata is not None and not math.isfinite(nodata):
                nodata = None

            return JSONResponse({
                "url": url,
                "driver": cog.driver,
                "crs": str(cog.crs) if cog.crs else None,
                "bounds": bounds,
                "size": [cog.width, cog.height],
                "nodata": nodata,
                "dtypes": [cog.dtypes[0]],
                "overviews": list(cog.overviews(1)) if hasattr(cog, 'overviews') else [],
                "band_config": BANDS[band].dict()
            })

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/health")
async def health_check():
    """Health check."""
    return {"status": "healthy", "version": "2.0.0"}


if __name__ == "__main__":
    import uvicorn

    print(f"Starting Lightning Server V2 on port {PORT}")
    print(f"Data source: {BUCKET_BASE_URL}")

    uvicorn.run(
        "main_optimized:app",
        host="0.0.0.0",
        port=PORT,
        reload=False,
        log_level="info"
    )
