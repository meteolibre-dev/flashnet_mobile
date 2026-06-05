"""
Lightning Server V2 - Optimized COG Tile Server

High-performance tile server designed for pre-computed COG files.
Leverages COG internal overviews for instant low-zoom tiles.
"""

import os
os.environ["CPL_VSIL_CURL_ALLOWED_EXTENSIONS"] = "tif,tiff"
os.environ["GDAL_DISABLE_READDIR_ON_OPEN"] = "EMPTY_DIR"
# VSI_CACHE can cause issues with cloud reads - disable or use with care
# See: https://github.com/OSGeo/gdal/issues/9658
os.environ["VSI_CACHE"] = "FALSE"  # Disable to avoid stale/corrupted cache
os.environ["VSI_CACHE_SIZE"] = "50000000" # 50 MB (not used if VSI_CACHE=FALSE)
os.environ["GDAL_HTTP_MERGE_CONSECUTIVE_RANGES"] = "YES"
# Disable caching for /vsigs/ to avoid stale data issues
os.environ["CPL_VSIL_CURL_NON_CACHED"] = "/vsigs/"




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
import math
from typing import Dict, Optional, Set, Tuple
from io import BytesIO
from PIL import Image

logger = logging.getLogger(__name__)

if os.getenv("DEBUG"):
    logging.basicConfig(level=logging.DEBUG)
else:
    logging.basicConfig(level=logging.INFO)
from datetime import datetime, timedelta
from hashlib import md5
import hashlib
import json as json_pkg
import threading

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

# Custom palette for radar (rain rate) channel
from palette_radar_35 import RAIN_CLASSES as RADAR_35_CLASSES, MAX_THRESHOLD as RADAR_35_MAX

# Logging configuration
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def dbz_to_mmh(dbz: float) -> float:
    """Marshall-Palmer Z-R relationship: Z = 200·R^1.6 → R = (Z/200)^(1/1.6).
    Converts radar reflectivity (dBZ) to rain rate (mm/h).
    """
    if dbz <= 0:
        return 0.0
    z = 10.0 ** (dbz / 10.0)
    return (z / 200.0) ** (1.0 / 1.6)

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
BUCKET_BASE_URL = os.getenv("BUCKET_BASE_URL", "gs://inference_result_meteolibre_forecast/forecasts")
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

# Cache: forecast_timestamp (YYYYMMDDHHMM) → H5 datetime subfolder (e.g. "2026-04-11_08-20")
_timestamp_to_h5_subfolder: Dict[str, str] = {}


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


def _extract_run_date(run_time: str) -> str:
    """Extract the date portion from a run_time string.

    run_time format: 'YYYY-MM-DD_HH-MM_region' (e.g. '2026-06-05_21-50_europe')
    Returns: 'YYYY-MM-DD' (e.g. '2026-06-05')
    """
    return run_time.split("_")[0]


def _find_h5_subfolder(timestamp: str) -> Optional[str]:
    """Find the H5 datetime subfolder for a given forecast timestamp.

    New bucket layout:
        forecasts/YYYY-MM-DD/{h5_datetime}/forecast_YYYYMMDDHHMM_band.tiff

    A forecast run on date D can contain timestamps for date D+1 (or even D+2).
    Therefore we search the date folder matching the timestamp AND the two
    previous day folders (the run that produced this timestamp may have started
    on a different calendar day).

    Checks the in-memory cache first, then scans GCS if needed.
    Returns None if no matching subfolder is found (falls back to old flat layout).
    """
    if timestamp in _timestamp_to_h5_subfolder:
        return _timestamp_to_h5_subfolder[timestamp]

    ts_date = f"{timestamp[:4]}-{timestamp[4:6]}-{timestamp[6:8]}"
    ts_dt = datetime.strptime(ts_date, "%Y-%m-%d")

    # Search the timestamp's own date folder and the two previous days
    # (a forecast run started 1–2 days earlier can produce this timestamp)
    search_dates = [
        (ts_dt - timedelta(days=offset)).strftime("%Y-%m-%d")
        for offset in range(3)  # 0, 1, 2 days back
    ]

    try:
        storage_client, bucket_name = get_gcs_client()
        bucket = storage_client.bucket(bucket_name)
        for date_folder in search_dates:
            prefix = f"forecasts/{date_folder}/"
            for blob in bucket.list_blobs(prefix=prefix):
                # New path: forecasts/YYYY-MM-DD/h5_subfolder/forecast_YYYYMMDDHHMM_band.tiff
                match = re.search(
                    r"forecasts/[^/]+/([^/]+)/forecast_(\d{12})_[^.]+\.tiff$", blob.name
                )
                if match and match.group(2) == timestamp:
                    subfolder = match.group(1)
                    _timestamp_to_h5_subfolder[timestamp] = subfolder
                    return subfolder
    except Exception as e:
        logger.warning(f"Could not scan GCS for h5 subfolder of {timestamp}: {e}")

    return None


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
        name="Rain Rate (mm/h)",
        min=0,
        max=130,  # mm/h — matches palette_radar_35 range
        colormap="custom",  # Uses palette_radar_35 with log mapping
        invert=False
    ),
}


# ============================================
# PERFORMANCE OPTIMIZATIONS
# ============================================

# ============================================
# LRU TILE CACHE
# ============================================

_TILE_CACHE_MAX_SIZE = int(os.getenv("TILE_CACHE_MAX_SIZE", "2000"))
_TILE_CACHE_LOCK = threading.Lock()
_tile_cache: Dict[Tuple, bytes] = {}
_tile_cache_order: list = []  # Most-recent-last for LRU eviction

def _cache_get(key: Tuple) -> Optional[bytes]:
    """Thread-safe LRU cache lookup."""
    with _TILE_CACHE_LOCK:
        if key in _tile_cache:
            # Move to end (most recently used)
            _tile_cache_order.remove(key)
            _tile_cache_order.append(key)
            return _tile_cache[key]
    return None

def _cache_put(key: Tuple, value: bytes) -> None:
    """Thread-safe LRU cache insert with eviction."""
    with _TILE_CACHE_LOCK:
        if key in _tile_cache:
            _tile_cache_order.remove(key)
        elif len(_tile_cache) >= _TILE_CACHE_MAX_SIZE:
            # Evict oldest (front of list)
            oldest = _tile_cache_order.pop(0)
            del _tile_cache[oldest]
        _tile_cache[key] = value
        _tile_cache_order.append(key)

def _cache_invalidate(run_time: Optional[str] = None) -> int:
    """Invalidate cache entries. If run_time given, only evict entries NOT matching it."""
    with _TILE_CACHE_LOCK:
        if run_time is None:
            count = len(_tile_cache)
            _tile_cache.clear()
            _tile_cache_order.clear()
            return count
        # Evict entries whose run_time differs from the current one
        to_remove = [k for k in _tile_cache if k[5] != run_time]
        for k in to_remove:
            del _tile_cache[k]
            _tile_cache_order.remove(k)
        return len(to_remove)


# Pre-computed colormaps at startup (avoid recreating per tile)
from matplotlib import cm as matplotlib_cm
import matplotlib

# Force matplotlib to use non-interactive backend
matplotlib.use('Agg')

PRECOMPUTED_COLORMAPS: Dict[str, np.ndarray] = {}
for band_name, config in BANDS.items():
    if config.colormap != "custom":
        cmap = matplotlib_cm.get_cmap(config.colormap)
        if config.invert:
            cmap = cmap.reversed()
        # Pre-compute colormap as 256x4 array (RGBA)
        PRECOMPUTED_COLORMAPS[band_name] = (cmap(np.linspace(0, 1, 256)) * 255).astype(np.uint8)





def get_cog_url(timestamp: str, band: str, run_time: Optional[str] = None) -> str:
    """
    Generate the COG URL for a given timestamp and band.
    Uses GDAL's /vsigs/ virtual file system which natively supports 
    Google Application Default Credentials (ADC).
    
    This eliminates the signed URL bottleneck (50-200ms per request)
    by letting GDAL handle GCS authentication directly.
    
    Args:
        timestamp: Forecast timestamp (YYYYMMDDHHMM)
        band: Band name (lightning, radar, sat_ch0, ...)
        run_time: Explicit run identifier (H5 subfolder name, e.g. "2026-04-20_08-20").
                  When provided, skips GCS bucket scanning and builds the path directly.
                  Acts as a cache-busting key: when a new forecast run lands,
                  the run_time changes → natural cache invalidation.
    """
    global _gcs_bucket_name
    
    # Ensure bucket name is initialized (lazy initialization)
    if _gcs_bucket_name is None:
        get_gcs_client()

    # When run_time is provided, derive the date folder from the run_time
    # (not the timestamp).  A forecast run started on 2026-06-05 can produce
    # timestamps on 2026-06-06, but the files still live under forecasts/2026-06-05/.
    if run_time:
        run_date = _extract_run_date(run_time)
        return f"/vsigs/{_gcs_bucket_name}/forecasts/{run_date}/{run_time}/forecast_{timestamp}_{band}.tiff"

    # Fallback: discover subfolder via GCS scan
    h5_subfolder = _find_h5_subfolder(timestamp)
    if h5_subfolder:
        # The h5_subfolder tells us which run produced this timestamp;
        # extract the run's start date from the subfolder name.
        run_date = _extract_run_date(h5_subfolder)
        return f"/vsigs/{_gcs_bucket_name}/forecasts/{run_date}/{h5_subfolder}/forecast_{timestamp}_{band}.tiff"

    # Fallback to flat layout for files uploaded before the subfolder change
    date_folder = f"{timestamp[:4]}-{timestamp[4:6]}-{timestamp[6:8]}"
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

    h5_subfolder = _find_h5_subfolder(timestamp)
    if h5_subfolder:
        run_date = _extract_run_date(h5_subfolder)
        blob_name = f"forecasts/{run_date}/{h5_subfolder}/forecast_{timestamp}_{band}.tiff"
    else:
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

# ─── Radar palette LUT (palette_radar_35.py) ────────────────────────────
# Discrete class palette: 24 classes, thresholds from 0.2 to 125 mm/h.
# ─── Radar palette LUT (palette_radar_35.py) ────────────────────────
# Discrete class palette: 34 classes, thresholds from 0.02 to 341.9 mm/h.
# Uses LOGARITHMIC mapping so that low rain rates (0.1–2 mm/h) get enough
# LUT indices to be visible.  With a linear mapping, values < 0.5 mm/h
# all collapse to index 0 (transparent) due to integer truncation.
_RADAR_MAX_RATE = float(RADAR_35_MAX)
_RADAR_LOG_MIN = np.log(0.005)   # floor of log range
_RADAR_LOG_MAX = np.log(_RADAR_MAX_RATE)
_radar_thresholds = np.array([rc.threshold for rc in RADAR_35_CLASSES])
_radar_rgbs = np.array([list(rc.rgb) + [255] for rc in RADAR_35_CLASSES], dtype=np.uint8)

_RADAR_CMAP_LUT = np.zeros((256, 4), dtype=np.uint8)
for _i in range(1, 256):
    _rate = np.exp(_RADAR_LOG_MIN + (_i / 255.0) * (_RADAR_LOG_MAX - _RADAR_LOG_MIN))
    if _rate < RADAR_35_CLASSES[0].threshold:
        continue  # stays transparent
    _idx = int(np.searchsorted(_radar_thresholds, _rate, side='right')) - 1
    _idx = max(0, min(_idx, len(_radar_thresholds) - 1))
    _RADAR_CMAP_LUT[_i] = _radar_rgbs[_idx]
# Index 0 stays transparent (no rain)


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
        ],
        "performance_features": [
            "COG internal overviews",
            "Pre-computed colormaps",
            "HTTP cache headers"
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

        now = datetime.utcnow()
        timestamp_bands: Dict[str, Set[str]] = {}

        # Step 1: collect all run subfolders across the scanned day range.
        # Subfolder names are YYYY-MM-DD_HH-MM_region, so the global lexicographic max
        # is always the most recent run regardless of which day it falls on.
        all_run_subfolders = []  # list of (sub_name, full_prefix)
        flat_prefix_fallback = None  # used only if no subfolders exist at all

        for i in range(-1, days):
            d = now + timedelta(days=i)
            date_folder = d.strftime("%Y-%m-%d")
            date_prefix = f"forecasts/{date_folder}/"

            iterator = bucket.list_blobs(prefix=date_prefix, delimiter="/")
            for _ in iterator:
                pass
            for prefix in iterator.prefixes:
                sub = prefix.rstrip("/").split("/")[-1]
                all_run_subfolders.append((sub, prefix))

            if not iterator.prefixes:
                flat_prefix_fallback = date_prefix  # remember last flat-layout day

        # Step 2: pick the single globally latest run and list only its files.
        if all_run_subfolders:
            latest_sub, latest_prefix = max(all_run_subfolders, key=lambda x: x[0])
            logger.info(f"/available: using latest run '{latest_sub}'")
            # Evict stale cache entries from previous runs
            evicted = _cache_invalidate(run_time=latest_sub)
            if evicted > 0:
                logger.info(f"Cache: evicted {evicted} entries from stale runs")
            for blob in bucket.list_blobs(prefix=latest_prefix):
                m = re.search(r"forecast_(\d{12})_([^.]+)\.tiff$", blob.name)
                if not m:
                    continue
                ts, found_band = m.group(1), m.group(2)
                _timestamp_to_h5_subfolder[ts] = latest_sub
                if ts not in timestamp_bands:
                    timestamp_bands[ts] = set()
                timestamp_bands[ts].add(found_band)
        elif flat_prefix_fallback:
            # Old flat layout: files directly under forecasts/YYYY-MM-DD/
            for blob in bucket.list_blobs(prefix=flat_prefix_fallback):
                m = re.search(r"forecasts/[^/]+/forecast_(\d{12})_([^.]+)\.tiff$", blob.name)
                if not m:
                    continue
                ts, found_band = m.group(1), m.group(2)
                if ts not in timestamp_bands:
                    timestamp_bands[ts] = set()
                timestamp_bands[ts].add(found_band)

        # Convert to sorted list with datetime info
        # Determine the actual date_folder (where data lives on GCS) from the run.
        # A forecast started on 2026-06-05 may produce timestamps for 2026-06-06,
        # but those files still live under forecasts/2026-06-05/.  The frontend
        # uses date_folder to build direct download URLs, so it must match the
        # GCS location — not the timestamp's calendar date.
        run_date_folder = _extract_run_date(latest_sub) if all_run_subfolders and latest_sub else None
        timestamps = []
        for ts, bands in sorted(timestamp_bands.items()):
            try:
                year = ts[0:4]
                month = ts[4:6]
                day = ts[6:8]
                hour = ts[8:10]
                minute = ts[10:12]
                dt = datetime(int(year), int(month), int(day), int(hour), int(minute))
                # Build the full direct-download URL so frontends don't
                # need to construct it themselves (avoids cross-midnight bugs
                # when the run date ≠ timestamp date).
                if all_run_subfolders and latest_sub:
                    run_date = _extract_run_date(latest_sub)
                    tiff_url = f"https://storage.googleapis.com/{_gcs_bucket_name}/forecasts/{run_date}/{latest_sub}/forecast_{ts}_{{band}}.tiff"
                else:
                    ts_date_folder = run_date_folder if run_date_folder else f"{year}-{month}-{day}"
                    tiff_url = f"https://storage.googleapis.com/{_gcs_bucket_name}/forecasts/{ts_date_folder}/forecast_{ts}_{{band}}.tiff"
                timestamps.append({
                    "timestamp": ts,
                    "datetime": dt.isoformat() + "Z",
                    "date_folder": ts_date_folder,
                    "available_bands": list(bands),
                    "run_time": latest_sub if all_run_subfolders else None,
                    "tiff_url": tiff_url,
                })
            except ValueError:
                continue

        return {
            "timestamps": timestamps,
            "count": len(timestamps),
            "all_bands": list(BANDS.keys()),
            "run_time": latest_sub if all_run_subfolders else None
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error scanning bucket: {str(e)}")


@app.get("/history/dates")
async def get_history_dates(
    days: int = Query(30, ge=1, le=90, description="Number of days to scan back from today"),
):
    """
    List all dates that have forecast data in the bucket.
    This is a lightweight endpoint — it only checks for the existence of
    date-level prefixes (no file listing), so it's very fast.

    Returns:
        dates: list of { date, display_date, has_data }
    """
    try:
        storage_client, bucket_name = get_gcs_client()
        bucket = storage_client.bucket(bucket_name)

        now = datetime.utcnow()
        dates = []

        for i in range(-1, days):
            d = now - timedelta(days=i)
            date_folder = d.strftime("%Y-%m-%d")
            date_prefix = f"forecasts/{date_folder}/"

            # Use delimiter-based listing to check if date folder has any content
            # This is cheap — GCS returns prefixes without listing individual blobs
            iterator = bucket.list_blobs(prefix=date_prefix, delimiter="/", max_results=1)
            blobs = list(iterator)

            # If there are blobs directly or subfolder prefixes, the date has data
            has_data = len(blobs) > 0 or len(iterator.prefixes) > 0

            if has_data:
                dates.append({
                    "date": date_folder,
                    "display_date": d.strftime("%A %d %B %Y"),  # e.g. "Monday 02 June 2026"
                    "day_of_week": d.strftime("%a"),  # e.g. "Mon"
                    "short_date": d.strftime("%d/%m"),  # e.g. "02/06"
                })

        return {
            "dates": dates,
            "count": len(dates),
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error scanning dates: {str(e)}")


@app.get("/history/dates/{date}")
async def get_history_date_runs(
    date: str,
    band: str = Query("lightning", description="Band to check for availability"),
):
    """
    Get all forecast runs whose timestamps fall on a specific date.

    Because a forecast run started on day D can produce timestamps for day D+1
    (or D+2), this endpoint also scans the 2 previous days' folders and filters
    for timestamps matching the requested date.

    Args:
        date: Date in YYYY-MM-DD format (e.g. "2026-06-01")
        band: Band to filter by (use "any" to include all bands)

    Returns:
        date: the requested date
        runs: list of { run_time, date_folder, timestamps: [...], available_bands: [...] }
    """
    # Validate date format
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
        raise HTTPException(status_code=400, detail="Date must be in YYYY-MM-DD format")

    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date")

    try:
        storage_client, bucket_name = get_gcs_client()
        bucket = storage_client.bucket(bucket_name)

        # Scan the requested date + 2 previous days (forecasts from those days
        # can produce timestamps that fall on the requested date)
        requested_dt = datetime.strptime(date, "%Y-%m-%d")
        scan_dates = [
            (requested_dt - timedelta(days=offset)).strftime("%Y-%m-%d")
            for offset in range(3)  # 0, 1, 2 days back
        ]

        runs = []

        for scan_date in scan_dates:
            date_prefix = f"forecasts/{scan_date}/"

            # Step 1: list run subfolders for this scan_date
            iterator = bucket.list_blobs(prefix=date_prefix, delimiter="/")
            for _ in iterator:
                pass

            run_subfolders = []
            for prefix in iterator.prefixes:
                sub = prefix.rstrip("/").split("/")[-1]
                run_subfolders.append(sub)

            if not run_subfolders:
                # Flat layout (old format) — files directly under date folder
                ts_bands: Dict[str, Set[str]] = {}
                for blob in bucket.list_blobs(prefix=date_prefix):
                    m = re.search(r"forecasts/[^/]+/forecast_(\d{12})_([^.]+)\.tiff$", blob.name)
                    if not m:
                        continue
                    ts, found_band = m.group(1), m.group(2)
                    # Only include timestamps that fall on the REQUESTED date
                    ts_date = f"{ts[0:4]}-{ts[4:6]}-{ts[6:8]}"
                    if ts_date != date:
                        continue
                    if band != "any" and found_band != band:
                        continue
                    if ts not in ts_bands:
                        ts_bands[ts] = set()
                    ts_bands[ts].add(found_band)

                if ts_bands:
                    timestamps = []
                    for ts in sorted(ts_bands.keys()):
                        try:
                            year, month, day = ts[0:4], ts[4:6], ts[6:8]
                            hour, minute = ts[8:10], ts[10:12]
                            dt = datetime(int(year), int(month), int(day), int(hour), int(minute))
                            timestamps.append({
                                "timestamp": ts,
                                "datetime": dt.isoformat() + "Z",
                                "available_bands": list(ts_bands[ts]),
                                "tiff_url": f"https://storage.googleapis.com/{_gcs_bucket_name}/forecasts/{scan_date}/forecast_{ts}_{{band}}.tiff",
                            })
                        except ValueError:
                            continue
                    if timestamps:
                        runs.append({
                            "run_time": None,
                            "date_folder": scan_date,
                            "timestamps": timestamps,
                            "count": len(timestamps),
                            "available_bands": list(set(b for bs in ts_bands.values() for b in bs)),
                        })
            else:
                # New layout: each subfolder is a run
                for sub in sorted(run_subfolders):
                    run_prefix = f"forecasts/{scan_date}/{sub}/"
                    ts_bands: Dict[str, Set[str]] = {}
                    for blob in bucket.list_blobs(prefix=run_prefix):
                        m = re.search(r"forecast_(\d{12})_([^.]+)\.tiff$", blob.name)
                        if not m:
                            continue
                        ts, found_band = m.group(1), m.group(2)
                        # Only include timestamps that fall on the REQUESTED date
                        ts_date = f"{ts[0:4]}-{ts[4:6]}-{ts[6:8]}"
                        if ts_date != date:
                            continue
                        if band != "any" and found_band != band:
                            continue
                        if ts not in ts_bands:
                            ts_bands[ts] = set()
                        ts_bands[ts].add(found_band)

                    timestamps = []
                    for ts in sorted(ts_bands.keys()):
                        try:
                            year, month, day = ts[0:4], ts[4:6], ts[6:8]
                            hour, minute = ts[8:10], ts[10:12]
                            dt = datetime(int(year), int(month), int(day), int(hour), int(minute))
                            tiff_url = f"https://storage.googleapis.com/{_gcs_bucket_name}/forecasts/{scan_date}/{sub}/forecast_{ts}_{{band}}.tiff"
                            timestamps.append({
                                "timestamp": ts,
                                "datetime": dt.isoformat() + "Z",
                                "run_time": sub,
                                "date_folder": scan_date,  # actual GCS folder, not requested date
                                "available_bands": list(ts_bands[ts]),
                                "tiff_url": tiff_url,
                            })
                            # Cache h5 subfolder mapping — also store the correct date folder
                            _timestamp_to_h5_subfolder[ts] = sub
                        except ValueError:
                            continue

                    if timestamps:
                        runs.append({
                            "run_time": sub,
                            "date_folder": scan_date,  # actual GCS folder
                            "timestamps": timestamps,
                            "count": len(timestamps),
                            "available_bands": list(set(b for bs in ts_bands.values() for b in bs)),
                        })

        return {
            "date": date,
            "runs": runs,
            "total_runs": len(runs),
            "total_timesteps": sum(r["count"] for r in runs),
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error scanning date {date}: {str(e)}")


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
        test_url = "/vsigs/inference_result_meteolibre_forecast/forecasts/2026-02-28/"
        logger.info(f"Testing GCS access to: {test_url}")
        result["gcs_test"] = "URL generated OK"
    except Exception as e:
        result["gcs_test_error"] = str(e)
    
    return result


@app.get("/debug/read")
async def debug_read(
    band: str = Query("radar"),
    time: str = Query("202602281300")
):
    """Debug COG reading directly."""
    import traceback
    import rasterio
    from rio_tiler.io import COGReader
    
    result = {
        "requested": {"band": band, "time": time},
    }
    
    try:
        url = get_cog_url(time, band)
        result["url"] = url
        
        # Check file exists
        if not verify_cog_file_ready(time, band):
            result["error"] = "File not ready"
            return result
        
        result["file_verified"] = True
        
        # Try to open with rasterio directly first
        result["rasterio_open"] = "attempting..."
        with rasterio.open(url) as cog:
            result["rasterio_open"] = "success"
            result["cog_bounds"] = list(cog.bounds)
            result["cog_size"] = [cog.width, cog.height]
            result["cog_driver"] = cog.driver
            result["cog_count"] = cog.count
            
        # Try with COGReader
        result["cogreader_open"] = "attempting..."
        with COGReader(url) as cog:
            result["cogreader_open"] = "success"
            result["cog_nodata"] = cog.nodata
            result["cog_bounds"] = list(cog.bounds) if cog.bounds else None
            
            # Try to read a small part
            result["cog_part"] = "attempting..."
            part = cog.part((-10, 33.8, 33, 59.6), width=100, height=100, indexes=(1,))
            result["cog_part"] = "success"
            result["cog_part_shape"] = part.data[0].shape
        
    except Exception as e:
        result["error"] = str(e)
        result["traceback"] = traceback.format_exc()
    
    return result


@app.get("/cache/stats")
async def cache_stats():
    """Cache statistics for monitoring."""
    with _TILE_CACHE_LOCK:
        total_size = sum(len(v) for v in _tile_cache.values())
        return {
            "entries": len(_tile_cache),
            "max_entries": _TILE_CACHE_MAX_SIZE,
            "total_bytes": total_size,
            "total_mb": round(total_size / 1024 / 1024, 2),
        }


@app.get("/cache/clear")
async def cache_clear():
    """Clear the tile cache."""
    count = _cache_invalidate()
    return {"cleared": count}


@app.get("/tiles/{z}/{x}/{y}.png")
def get_tile_png(
    z: int,
    x: int,
    y: int,
    band: str = Query(..., description="Band: lightning, sat_ch0, sat_ch1, ..."),
    time: str = Query(..., description="Timestamp: YYYYMMDDHHMM"),
    run_time: Optional[str] = Query(None, description="Run identifier (H5 subfolder) from /available. Enables cache-busting & skips GCS lookups.")
):
    """
    Get a PNG tile for the specified band and time.
    Uses COG internal overviews for optimal performance.
    
    Pass run_time from /available to:
    - Skip GCS bucket scanning (faster URL resolution)
    - Enable accurate caching (cache key includes run_time)
    """

    cache_key = (z, x, y, band, time, run_time)

    # Check LRU cache first
    cached_png = _cache_get(cache_key)
    if cached_png is not None:
        return Response(
            content=cached_png,
            media_type="image/png",
            headers={
                "Cache-Control": "public, max-age=300",
                "X-Cache": "HIT"
            }
        )

    rgba = generate_tile_rgba(x, y, z, band, time, run_time)
    
    if rgba is None:
        img = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
        buffer = BytesIO()
        img.save(buffer, format='PNG')
        png_bytes = buffer.getvalue()
        # Cache empty tiles too (they're tiny and avoid repeated GCS lookups)
        _cache_put(cache_key, png_bytes)
        return Response(
            content=png_bytes,
            media_type="image/png",
            headers={
                "Cache-Control": "public, max-age=300",
                "X-Cache": "MISS"
            }
        )
    
    img = Image.fromarray(rgba, mode='RGBA')
    buffer = BytesIO()
    img.save(buffer, format='PNG')
    png_bytes = buffer.getvalue()
    
    # Store in LRU cache
    _cache_put(cache_key, png_bytes)
    
    # Generate ETag for response
    tile_hash = md5(rgba.tobytes()).hexdigest()
    
    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={
            "Cache-Control": "public, max-age=300",  # 5 min browser cache (safe because run_time busts cache on new runs)
            "ETag": f'"{tile_hash}"',
            "X-Cache": "MISS"
        }
    )


def generate_tile_rgba(x: int, y: int, z: int, band: str, time: str, run_time: Optional[str] = None) -> Optional[np.ndarray]:
    """Generate RGBA array for a single tile. Returns None on error."""
    if band not in BANDS:
        return None
    
    config = BANDS[band]
    
    # Retry logic for transient GCS/network errors
    max_retries = 3
    retry_delay = 0.5  # seconds
    
    for attempt in range(max_retries):
        try:
            url = get_cog_url(time, band, run_time=run_time)
            logger.debug(f"COG URL for {time}/{band}: {url}")
        except Exception as e:
            import traceback
            logger.error(f"Failed to get COG URL for tile {z}/{x}/{y} band={band} time={time}: {e}")
            logger.error(f"Traceback: {traceback.format_exc()}")
            return None

        # NOTE: File verification removed for performance
        # In production, ensure files are fully uploaded before making them available
        # If needed, verify at the /available endpoint instead of per-tile
        
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

                # ── Radar band: Z-R transform (dBZ → mm/h) + palette_radar_35 ─
                if band == "radar":
                    rain_rate = np.zeros_like(data)
                    valid = data > 0
                    z_linear = np.power(10.0, data[valid] / 10.0)
                    rain_rate[valid] = np.power(z_linear / 200.0, 1.0 / 1.6)

                    # Logarithmic mapping: spreads low rain rates across LUT indices
                    log_rate = np.log(np.clip(rain_rate, 0.01, _RADAR_MAX_RATE))
                    data_norm = np.clip(
                        (log_rate - _RADAR_LOG_MIN) / (_RADAR_LOG_MAX - _RADAR_LOG_MIN),
                        0, 1,
                    )
                    indices = (data_norm * 255).astype(np.uint8)
                    rgba = _RADAR_CMAP_LUT[indices]

                    zero_mask = rain_rate <= 0
                    rgba[zero_mask] = [0, 0, 0, 0]
                    if nodata_mask is not None:
                        rgba[nodata_mask] = [0, 0, 0, 0]
                    return rgba

                # ── Default rendering for other bands ────────────────────
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
                    # Use pre-computed colormap for performance
                    if band in PRECOMPUTED_COLORMAPS:
                        cmap = PRECOMPUTED_COLORMAPS[band]
                        normalized = data.astype(float) / 255.0
                        # Convert float indices (0.0-1.0) to integer indices (0-255)
                        indices = (normalized * 255).astype(np.uint8)
                        rgba = cmap[indices]
                    else:
                        # Fallback to dynamic colormap if not pre-computed
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
    time: str = Query(...),
    run_time: Optional[str] = Query(None, description="Run identifier (H5 subfolder)")
):
    """Get TileJSON for map integration."""
    if band not in BANDS:
        raise HTTPException(status_code=400, detail=f"Invalid band: {band}")

    url = get_cog_url(time, band, run_time=run_time)

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
    time: str = Query(...),
    run_time: Optional[str] = Query(None, description="Run identifier (H5 subfolder)")
):
    """Get geographic bounds for a COG."""
    if band not in BANDS:
        raise HTTPException(status_code=400, detail=f"Invalid band: {band}")

    # Default bounds for Europe region (matching frontend REGION)
    default_bounds = [-10.0, 33.0, 33.0, 65.0]  # [west, south, east, north]

    try:
        url = get_cog_url(time, band, run_time=run_time)
    except Exception as e:
        # COG URL generation failed - return default bounds
        return JSONResponse({
            "url": f"gs://inference_result_meteolibre_forecast/forecasts/{time[:4]}-{time[4:6]}-{time[6:8]}/{_timestamp_to_h5_subfolder.get(time, '')}/forecast_{time}_{band}.tiff".replace("//", "/"),
            "bounds": default_bounds,
            "crs": "EPSG:4326",
            "size": None,
            "nodata": None,
            "overviews": [],
            "error": f"Failed to get COG URL: {str(e)}"
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
    time: str = Query(...),
    run_time: Optional[str] = Query(None, description="Run identifier (H5 subfolder)")
):
    """Get detailed COG metadata."""
    if band not in BANDS:
        raise HTTPException(status_code=400, detail=f"Invalid band: {band}")

    url = get_cog_url(time, band, run_time=run_time)

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
    is_radar = (band == "radar")
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
                    elif is_radar and value is not None:
                        # Convert dBZ → mm/h for radar band
                        value = round(dbz_to_mmh(float(value)), 2)
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

            # ── Radar band in preview: Z-R transform + palette_radar_35 ──
            if band == "radar":
                rain_rate = np.zeros_like(data)
                valid = data > 0
                z_linear = np.power(10.0, data[valid] / 10.0)
                rain_rate[valid] = np.power(z_linear / 200.0, 1.0 / 1.6)

                # Resize if needed
                if rain_rate.shape != (height, width):
                    pil_rr = PILImage.fromarray(rain_rate.astype(np.float32), mode='F')
                    pil_rr = pil_rr.resize((width, height), PILImage.Resampling.BILINEAR)
                    rain_rate = np.array(pil_rr)

                # Logarithmic mapping: spreads low rain rates across LUT indices
                log_rate = np.log(np.clip(rain_rate, 0.01, _RADAR_MAX_RATE))
                data_norm = np.clip(
                    (log_rate - _RADAR_LOG_MIN) / (_RADAR_LOG_MAX - _RADAR_LOG_MIN),
                    0, 1,
                )
                indices = (data_norm * 255).astype(np.uint8)
                rgba = _RADAR_CMAP_LUT[indices]

                zero_mask = rain_rate <= 0
                rgba[zero_mask] = [0, 0, 0, 0]
                if nodata_mask is not None:
                    if nodata_mask.shape != (height, width):
                        mask_img = PILImage.fromarray(nodata_mask.astype(np.uint8) * 255)
                        mask_img = mask_img.resize((width, height), PILImage.Resampling.NEAREST)
                        nodata_mask = np.array(mask_img) > 127
                    rgba[nodata_mask] = [0, 0, 0, 0]

            elif band == "lightning":
                data = np.clip(data, config.min, config.max)
                data = ((data - config.min) / (config.max - config.min) * 255).astype(np.uint8)

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

                data = np.clip(data, config.min, config.max)
                data = ((data - config.min) / (config.max - config.min) * 255).astype(np.uint8)
                
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

    import multiprocessing

    workers = int(os.getenv("UVICORN_WORKERS", multiprocessing.cpu_count()))
    print(f"Starting with {workers} workers")

    uvicorn.run(
        "main_optimized:app",
        host="0.0.0.0",
        port=PORT,
        reload=False,
        log_level="info",
        workers=workers
    )
