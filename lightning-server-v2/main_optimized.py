"""
Lightning Server V2 - Optimized COG Tile Server

High-performance tile server designed for pre-computed COG files.
Leverages COG internal overviews for instant low-zoom tiles.
"""

import os
os.environ["CPL_VSIL_CURL_ALLOWED_EXTENSIONS"] = "tif,tiff"
os.environ["GDAL_DISABLE_READDIR_ON_OPEN"] = "EMPTY_DIR"
os.environ["VSI_CACHE"] = "TRUE"
os.environ["VSI_CACHE_SIZE"] = "50000000" # 50 MB
os.environ["GDAL_HTTP_MERGE_CONSECUTIVE_RANGES"] = "YES"




# Pre-fetch GCS access token for GDAL /vsigs/ access
# This must be done BEFORE rasterio is imported

def _get_gcs_access_token() -> str:
    """Get GCS access token from GCP metadata server or decode from credentials."""
    import base64
    import tempfile
    import json
    
    print(f"[INIT] Checking for GCP_CREDENTIALS_B64 env var...")
    
    # Option 1: Try to decode base64 credentials from environment variable
    creds_base64 = os.getenv('GCP_CREDENTIALS_B64')
    print(f"[INIT] GCP_CREDENTIALS_B64 present: {creds_base64 is not None}")
    if creds_base64:
        print(f"[INIT] GCP_CREDENTIALS_B64 length: {len(creds_base64)}")
        try:
            creds_json = base64.b64decode(creds_base64).decode('utf-8')
            creds_data = json.loads(creds_json)
            print(f"[INIT] Decoded base64 credentials, client_email: {creds_data.get('client_email', 'N/A')}")
            
            if 'private_key' in creds_data and 'client_email' in creds_data:
                # Write private key to temp file for GDAL
                with tempfile.NamedTemporaryFile(mode='w', suffix='.pem', delete=False) as key_file:
                    key_file.write(creds_data['private_key'])
                    key_file.flush()
                    os.environ['GS_OAUTH2_PRIVATE_KEY_FILE'] = key_file.name
                    os.environ['GS_OAUTH2_CLIENT_EMAIL'] = creds_data['client_email']
                    print(f"[INIT] Configured GDAL with service account: {creds_data['client_email']}")
                    return None  # No token needed, we're using OAuth2 key
        except Exception as e:
            print(f"[INIT] Failed to decode base64 credentials: {e}")
    
    # Option 2: Try to read credentials from environment variable (raw JSON)
    creds_json = os.getenv('GCP_CREDENTIALS')
    print(f"[INIT] GCP_CREDENTIALS present: {creds_json is not None}")
    if creds_json:
        print(f"[INIT] GCP_CREDENTIALS length: {len(creds_json)}")
        try:
            creds_data = json.loads(creds_json)
            print(f"[INIT] Decoded credentials, client_email: {creds_data.get('client_email', 'N/A')}")
            
            if 'private_key' in creds_data and 'client_email' in creds_data:
                with tempfile.NamedTemporaryFile(mode='w', suffix='.pem', delete=False) as key_file:
                    key_file.write(creds_data['private_key'])
                    key_file.flush()
                    os.environ['GS_OAUTH2_PRIVATE_KEY_FILE'] = key_file.name
                    os.environ['GS_OAUTH2_CLIENT_EMAIL'] = creds_data['client_email']
                    print(f"[INIT] Configured GDAL with service account: {creds_data['client_email']}")
                    return None
        except Exception as e:
            print(f"[INIT] Failed to decode credentials: {e}")
    
    # Check other env vars
    gac_path = os.getenv('GOOGLE_APPLICATION_CREDENTIALS')
    print(f"[INIT] GOOGLE_APPLICATION_CREDENTIALS: {gac_path}")
    
    # Option 2: Try to get token from metadata server (Workload Identity)
    print(f"[INIT] Trying metadata server for access token...")
    try:
        import requests as _requests
        metadata_url = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
        resp = _requests.get(metadata_url, headers={"Metadata-Flavor": "Google"}, timeout=5)
        print(f"[INIT] Metadata server response status: {resp.status_code}")
        if resp.status_code == 200:
            token_data = resp.json()
            if 'access_token' in token_data:
                print(f"[INIT] Got access token from metadata server")
                return token_data['access_token']
    except Exception as e:
        print(f"[INIT] Failed to get token from metadata server: {e}")
    
    print(f"[INIT] No credentials found!")
    return None

# Try to configure GDAL early (before rasterio imports)
_token = _get_gcs_access_token()
if _token:
    os.environ['GS_ACCESS_TOKEN'] = _token
    print(f"[INIT] Set GS_ACCESS_TOKEN from metadata server")
else:
    print(f"[INIT] No GS_ACCESS_TOKEN set - GDAL may fail!")

import re
import json
import logging
from typing import Dict, Optional, Set
from io import BytesIO
from PIL import Image

logger = logging.getLogger(__name__)

if os.getenv("DEBUG"):
    logging.basicConfig(level=logging.DEBUG)
else:
    logging.basicConfig(level=logging.INFO)
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

# Region bounds for point queries (matches frontend REGION)
REGION = {
    "west": -10.0,
    "north": 65.0,
    "east": 33.0,
    "south": 33.0,
}

# GCS client for bucket operations (lazy initialization)
_gcs_client = None
_gcs_bucket_name = None


def get_gcs_client():
    """Get or create GCS client for bucket listing operations."""
    global _gcs_client, _gcs_bucket_name
    if _gcs_client is None:
        _gcs_client = storage.Client()
        # Extract bucket name from URL
        if BUCKET_BASE_URL.startswith("gs://"):
            _gcs_bucket_name = BUCKET_BASE_URL.replace("gs://", "").split("/")[0]
        else:
            _gcs_bucket_name = BUCKET_BASE_URL.replace("https://storage.googleapis.com/", "").split("/")[0]

    return _gcs_client, _gcs_bucket_name


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
        min=3,
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
    "radar": BandConfig(
        name="Radar Reflectivity",
        min=0,
        max=75,  # dBZ typical range: 0-75
        colormap="turbo",  # Good for radar - green to red
        invert=False
    ),
}


def get_cog_url(timestamp: str, band: str) -> str:
    """
    Generate the COG URL for a given timestamp and band.
    Uses GDAL's /vsigs/ virtual file system which natively supports 
    Google Application Default Credentials (ADC).
    
    This eliminates the signed URL bottleneck (50-200ms per request)
    by letting GDAL handle GCS authentication directly.
    
    Matches the naming convention from inference_engine.py:
    - forecast_{timestamp}_sat_ch{0,1,...}.tiff
    - forecast_{timestamp}_lightning.tiff
    """
    global _gcs_bucket_name
    
    # Ensure bucket name is initialized (lazy initialization)
    if _gcs_bucket_name is None:
        get_gcs_client()
    
    # Convert YYYYMMDD to YYYY-MM-DD for bucket path
    date_folder = f"{timestamp[:4]}-{timestamp[4:6]}-{timestamp[6:8]}"
    
    # GDAL natively understands /vsigs/ and uses your Google Application Default Credentials
    # No signed URL generation needed - eliminates 50-200ms latency per tile
    return f"/vsigs/{_gcs_bucket_name}/forecasts/{date_folder}/forecast_{timestamp}_{band}.tiff"


def verify_cog_file_ready(timestamp: str, band: str, max_retries: int = 3, retry_delay: float = 1.0) -> bool:
    """
    Verify that a COG file exists and is ready to be read.
    This helps avoid GDAL "decoding errors" caused by reading incomplete files.
    
    Returns True if file appears ready, False otherwise.
    """
    import time
    global _gcs_bucket_name
    
    if _gcs_bucket_name is None:
        get_gcs_client()
    
    date_folder = f"{timestamp[:4]}-{timestamp[4:6]}-{timestamp[6:8]}"
    blob_name = f"forecasts/{date_folder}/forecast_{timestamp}_{band}.tiff"
    
    storage_client, bucket_name = get_gcs_client()
    bucket = storage_client.bucket(bucket_name)
    blob = bucket.blob(blob_name)
    
    for attempt in range(max_retries):
        try:
            # Check if blob exists and is not being composed
            if not blob.exists():
                logger.warning(f"File not found: {blob_name} (attempt {attempt + 1}/{max_retries})")
                if attempt < max_retries - 1:
                    time.sleep(retry_delay)
                continue
            
            # Get blob metadata to check if upload is complete
            blob.reload()
            metadata = blob.metadata or {}
            
            # Check for custom status flag set by uploader (if used)
            if metadata.get('upload_status') == 'incomplete':
                logger.warning(f"File marked as incomplete: {blob_name}")
                if attempt < max_retries - 1:
                    time.sleep(retry_delay)
                continue
            
            # Check file size is reasonable (at least some bytes)
            size = blob.size
            if size < 1000:  # Less than 1KB is suspicious
                logger.warning(f"File too small ({size} bytes): {blob_name}")
                if attempt < max_retries - 1:
                    time.sleep(retry_delay)
                continue
            
            logger.debug(f"File verified ready: {blob_name} ({size} bytes)")
            return True
            
        except Exception as e:
            logger.warning(f"Error verifying file {blob_name}: {e}")
            if attempt < max_retries - 1:
                time.sleep(retry_delay)
    
    return False


# Custom colormap for lightning (yellow -> red)
LIGHTNING_CMAP = {
    0: (255, 255, 0, 150),  # Yellow
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
        storage_client, bucket_name = get_gcs_client()
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


@app.get("/debug/gcs")
async def debug_gcs():
    """Debug GCS configuration and connectivity."""
    import rasterio
    
    result = {
        "env_vars": {
            "GS_ACCESS_TOKEN": "***" if os.getenv("GS_ACCESS_TOKEN") else None,
            "GS_OAUTH2_PRIVATE_KEY_FILE": os.getenv("GS_OAUTH2_PRIVATE_KEY_FILE"),
            "GS_OAUTH2_CLIENT_EMAIL": os.getenv("GS_OAUTH2_CLIENT_EMAIL"),
            "GOOGLE_APPLICATION_CREDENTIALS": os.getenv("GOOGLE_APPLICATION_CREDENTIALS"),
            "GCP_CREDENTIALS_B64": "***set***" if os.getenv("GCP_CREDENTIALS_B64") else None,
            "GCP_CREDENTIALS": "***set***" if os.getenv("GCP_CREDENTIALS") else None,
        },
        "gdal_version": rasterio.__gdal_version__,
        "rasterio_version": rasterio.__version__,
    }
    
    # Test GCS connectivity
    try:
        from rasterio import _env
        result["gdal_data"] = _env.get_gdal_data()
    except Exception as e:
        result["gdal_data_error"] = str(e)
    
    # Test reading a small file from GCS
    try:
        test_url = "/vsigs/inference_result/forecasts/2026-02-28/"
        logger.info(f"Testing GCS access to: {test_url}")
        result["gcs_test"] = "URL generated OK"
    except Exception as e:
        result["gcs_test_error"] = str(e)
    
    return result


@app.get("/tiles/{z}/{x}/{y}.png")
def get_tile_png(
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

    
    rgba = generate_tile_rgba(x, y, z, band, time)
    
    if rgba is None:
        img = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
        buffer = BytesIO()
        img.save(buffer, format='PNG')
        return Response(content=buffer.getvalue(), media_type="image/png")
    
    img = Image.fromarray(rgba, mode='RGBA')
    buffer = BytesIO()
    img.save(buffer, format='PNG', optimize=True)
    return Response(content=buffer.getvalue(), media_type="image/png")


@app.get("/tiles/{z}/{x}/{y}.webp")
async def get_tile_webp(
    z: int,
    x: int,
    y: int,
    band: str = Query(..., description="Band: lightning, sat_ch0, sat_ch1, ..."),
    time: str = Query(..., description="Timestamp: YYYYMMDDHHMM")
):
    """
    Get a WebP tile for the specified band and time.
    Uses COG internal overviews for optimal performance.
    """
    from io import BytesIO
    from PIL import Image
    
    rgba = generate_tile_rgba(x, y, z, band, time)
    
    if rgba is None:
        img = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
        buffer = BytesIO()
        img.save(buffer, format='WEBP', quality=85, method=6)
        return Response(content=buffer.getvalue(), media_type="image/webp")
    
    img = Image.fromarray(rgba, mode='RGBA')
    buffer = BytesIO()
    img.save(buffer, format='WEBP', quality=85, method=6)
    return Response(content=buffer.getvalue(), media_type="image/webp")


def generate_tile_rgba(x: int, y: int, z: int, band: str, time: str) -> Optional[np.ndarray]:
    """Generate RGBA array for a single tile. Returns None on error."""
    if band not in BANDS:
        return None
    
    config = BANDS[band]
    
    # Retry logic for transient GCS/network errors
    max_retries = 3
    retry_delay = 0.5  # seconds
    
    for attempt in range(max_retries):
        try:
            url = get_cog_url(time, band)
            logger.debug(f"COG URL for {time}/{band}: {url}")
        except Exception as e:
            import traceback
            logger.error(f"Failed to get COG URL for tile {z}/{x}/{y} band={band} time={time}: {e}")
            logger.error(f"Traceback: {traceback.format_exc()}")
            return None
        
        # Verify file is ready before attempting to read
        # This prevents GDAL decoding errors from incomplete files
        logger.debug(f"Verifying file ready for {time}/{band}...")
        if not verify_cog_file_ready(time, band):
            if attempt < max_retries - 1:
                logger.warning(f"File not ready for {time}/{band}, retrying ({attempt + 1}/{max_retries})")
                import time as time_module
                time_module.sleep(retry_delay)
                continue
            else:
                logger.error(f"File not available after {max_retries} attempts: {time}/{band}")
                return None
        
        logger.debug(f"Opening COGReader for {url}...")
        try:
            with COGReader(url) as cog:
                logger.debug(f"COGReader opened, fetching tile {z}/{x}/{y}...")
                tile = cog.tile(x, y, z, tilesize=256, indexes=(1,))
                data = tile.data[0].astype(np.float32)
                
                nodata_value = cog.nodata if hasattr(cog, 'nodata') else None
                
                nodata_mask = None
                if nodata_value is not None:
                    nodata_mask = (data == nodata_value) | (~np.isfinite(data))
                elif tile.mask is not None:
                    nodata_mask = ~tile.mask.astype(bool)
                elif np.any(~np.isfinite(data)):
                    nodata_mask = ~np.isfinite(data)
                
                data = np.clip(data, config.min, config.max)
                data = ((data - config.min) / (config.max - config.min) * 255).astype(np.uint8)
                
                if band == "lightning":
                    rgba = np.zeros((256, 256, 4), dtype=np.uint8)
                    
                    non_zero_mask = data > 0
                    rgba[non_zero_mask] = [255, 255, 0, 150]
                    
                    for val, color in LIGHTNING_CMAP.items():
                        if val > 0:
                            mask = data >= int(val * 255 / config.max)
                            rgba[mask] = color
                    
                    if nodata_mask is not None:
                        rgba[nodata_mask] = [0, 0, 0, 0]
                else:
                    from matplotlib import cm
                    
                    cmap = cm.get_cmap(config.colormap)
                    if config.invert:
                        cmap = cmap.reversed()
                    
                    normalized = data.astype(float) / 255.0
                    rgba = (cmap(normalized) * 255).astype(np.uint8)
                    rgba[:, :, 3] = 255
                    
                    zero_mask = data == 0
                    rgba[zero_mask] = [0, 0, 0, 0]
                    
                    if nodata_mask is not None:
                        rgba[nodata_mask] = [0, 0, 0, 0]
                
                return rgba
                
        except Exception as e:
            import traceback
            error_str = str(e).lower()
            
            # Detect specific GDAL decoding errors that indicate corrupted/incomplete files
            is_decode_error = any(keyword in error_str for keyword in [
                'zipdecode', 'decoding error', 'tiffreadencodedtile', 
                'ireadblock', 'decode failed', 'corrupt', 'incomplete'
            ])
            
            if is_decode_error:
                logger.warning(f"GDAL decode error for {time}/{band} (attempt {attempt + 1}/{max_retries}): {e}")
                logger.warning(f"Traceback: {traceback.format_exc()}")
                # Longer delay for decode errors - file might still be uploading
                import time as time_module
                time_module.sleep(retry_delay * 2)
            elif attempt < max_retries - 1:
                logger.warning(f"Error generating tile {z}/{x}/{y} band={band} time={time}, retrying ({attempt + 1}/{max_retries}): {e}")
                logger.warning(f"Traceback: {traceback.format_exc()}")
                import time as time_module
                time_module.sleep(retry_delay)
            else:
                logger.error(f"Error generating tile {z}/{x}/{y} band={band} time={time}: {e}")
                logger.error(f"Traceback: {traceback.format_exc()}")
                return None
    
    return None


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
        # COG URL generation failed - return default bounds
        return JSONResponse({
            "url": f"gs://inference_result/forecasts/{time[:4]}-{time[4:6]}-{time[6:8]}/forecast_{time}_{band}.tiff",
            "bounds": default_bounds,
            "crs": "EPSG:4326",
            "size": None,
            "nodata": None,
            "overviews": [],
            "error": f"Failed to get COG URL: {str(e)}"
        })

    # Check if file is ready before attempting to read
    if not verify_cog_file_ready(time, band):
        return JSONResponse({
            "url": url,
            "bounds": default_bounds,
            "crs": "EPSG:4326",
            "size": None,
            "nodata": None,
            "overviews": [],
            "error": "File not ready or still uploading"
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

    # Check if file is ready before attempting to read
    if not verify_cog_file_ready(time, band):
        raise HTTPException(status_code=404, detail="File not ready or still uploading")

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


@app.get("/point")
async def get_point_forecast(
    lat: float = Query(..., description="Latitude"),
    lon: float = Query(..., description="Longitude"),
    band: str = Query("lightning", description="Band to query")
):
    """
    Get forecast values at a specific point for all available timesteps.
    Returns a time series for the selected band at the given coordinates.
    """
    if band not in BANDS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid band: {band}. Available: {list(BANDS.keys())}"
        )

    # Validate coordinates are within region
    if not (REGION["south"] <= lat <= REGION["north"] and 
            REGION["west"] <= lon <= REGION["east"]):
        raise HTTPException(
            status_code=400,
            detail=f"Coordinates out of bounds. Region: {REGION}"
        )

    # Get available timestamps
    try:
        available = await get_available_timesteps(days=2, band=band)
        timestamps = available["timestamps"]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error getting timestamps: {str(e)}")

    # Sample values at each timestep
    results = []
    for ts in timestamps[-18:]:  # Last 18 timesteps
        timestamp = ts["timestamp"]
        
        # Check if file is ready before reading
        if not verify_cog_file_ready(timestamp, band):
            results.append({
                "timestamp": timestamp,
                "value": None,
                "error": "File not ready"
            })
            continue
        
        try:
            url = get_cog_url(timestamp, band)
            with rasterio.open(url) as cog:
                # Transform lat/lon to pixel coordinates
                from rasterio.transform import rowcol
                row, col = rowcol(cog.transform, lon, lat)
                
                # Read value at point
                if 0 <= row < cog.height and 0 <= col < cog.width:
                    value = cog.read(1)[row, col]
                    
                    # Handle nodata
                    if cog.nodata is not None and value == cog.nodata:
                        value = None
                    elif not np.isfinite(value):
                        value = None
                else:
                    value = None
                    
            results.append({
                "timestamp": timestamp,
                "value": float(value) if value is not None else None
            })
        except Exception as e:
            logger.warning(f"Error reading point at {timestamp}: {e}")
            results.append({
                "timestamp": timestamp,
                "value": None
            })

    return {
        "coordinates": {"lat": lat, "lon": lon},
        "band": band,
        "timesteps": results
    }


@app.get("/preview")
async def get_preview(
    band: str = Query(..., description="Band: lightning, sat_ch0, sat_ch1, ..."),
    time: str = Query(..., description="Timestamp: YYYYMMDDHHMM"),
    width: int = Query(1024, ge=256, le=4096, description="Output image width"),
    height: int = Query(1024, ge=256, le=4096, description="Output image height")
):
    """
    Generate a full PNG preview image for the specified band and time.
    Covers the full geographic extent of the COG.
    Useful for MapLibre image source animations.
    """
    from io import BytesIO
    from PIL import Image as PILImage
    
    logger.info(f"/preview request: band={band}, time={time}, width={width}, height={height}")
    
    if band not in BANDS:
        logger.error(f"Invalid band requested: {band}")
        raise HTTPException(
            status_code=400,
            detail=f"Invalid band: {band}. Available: {list(BANDS.keys())}"
        )
    
    config = BANDS[band]
    
    try:
        url = get_cog_url(time, band)
        logger.debug(f"Generated URL: {url}")
    except Exception as e:
        logger.error(f"Failed to generate URL: {time}/{band} - {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to generate URL: {str(e)}")
    
    # Check if file is ready before attempting to read
    if not verify_cog_file_ready(time, band):
        raise HTTPException(status_code=404, detail="File not ready or still uploading")
    
    try:
        with COGReader(url) as cog:
            logger.debug(f"Opened COG: bounds={cog.bounds}, crs={cog.crs}")
            bounds = cog.bounds
            
            if isinstance(bounds, tuple):
                minx, miny, maxx, maxy = bounds
            else:
                minx, miny, maxx, maxy = bounds.left, bounds.bottom, bounds.right, bounds.top
            
            if cog.crs and str(cog.crs) != "EPSG:4326":
                minx, miny, maxx, maxy = transform_bounds(
                    str(cog.crs), "EPSG:4326",
                    minx, miny, maxx, maxy
                )
            
            import math
            if any(not math.isfinite(v) for v in [minx, miny, maxx, maxy]):
                minx, miny, maxx, maxy = -10.0, 33.0, 33.0, 65.0
            
            overview_level = 0
            if width > 2048 or height > 2048:
                overview_level = min(len(cog.overviews(1)) - 1, 2) if hasattr(cog, 'overviews') else 0
            
            img = cog.preview(
                width=min(width, 2048),
                height=min(height, 2048),
                indexes=(1,),
                overview_level=overview_level
            )
            
            data = img.data[0].astype(np.float32)
            
            nodata_mask = None
            if cog.nodata is not None:
                nodata_mask = (data == cog.nodata) | (~np.isfinite(data))
            elif np.any(~np.isfinite(data)):
                nodata_mask = ~np.isfinite(data)
            
            data = np.clip(data, config.min, config.max)
            data = ((data - config.min) / (config.max - config.min) * 255).astype(np.uint8)
            
            if band == "lightning":
                rgba = np.zeros((data.shape[0], data.shape[1], 4), dtype=np.uint8)
                
                for val, color in LIGHTNING_CMAP.items():
                    if val > 0:
                        mask = data >= int(val * 255 / config.max)
                        rgba[mask] = color
                
                non_zero_mask = data > 0
                rgba[non_zero_mask & (rgba[:, :, 3] == 0)] = [255, 255, 0, 150]
                
                if nodata_mask is not None:
                    rgba[nodata_mask] = [0, 0, 0, 0]
            else:
                from matplotlib import cm
                
                cmap = cm.get_cmap(config.colormap)
                if config.invert:
                    cmap = cmap.reversed()
                
                if data.shape != (height, width):
                    pil_data = PILImage.fromarray(data)
                    pil_data = pil_data.resize((width, height), PILImage.Resampling.BILINEAR)
                    data = np.array(pil_data)
                
                normalized = data.astype(float) / 255.0
                rgba = (cmap(normalized) * 255).astype(np.uint8)
                rgba[:, :, 3] = 255
                
                zero_mask = data == 0
                rgba[zero_mask] = [0, 0, 0, 0]
                
                if nodata_mask is not None:
                    if nodata_mask.shape != (height, width):
                        mask_img = PILImage.fromarray(nodata_mask.astype(np.uint8) * 255)
                        mask_img = mask_img.resize((width, height), PILImage.Resampling.NEAREST)
                        nodata_mask = np.array(mask_img) > 127
                    rgba[nodata_mask] = [0, 0, 0, 0]
            
            pil_img = PILImage.fromarray(rgba, mode='RGBA')
            
            if pil_img.size != (width, height):
                pil_img = pil_img.resize((width, height), PILImage.Resampling.BILINEAR)
            
            buffer = BytesIO()
            pil_img.save(buffer, format='PNG', optimize=False)
            buffer.seek(0)
            
            return Response(content=buffer.getvalue(), media_type="image/png")
    
    except rasterio.errors.RasterioIOError as e:
        logger.error(f"COG file not found: {time}/{band} - {str(e)}", exc_info=True)
        raise HTTPException(status_code=404, detail=f"COG file not found: {str(e)}")
    except Exception as e:
        logger.error(f"Error generating preview: band={band}, time={time} - {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error generating preview: {str(e)}")


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
