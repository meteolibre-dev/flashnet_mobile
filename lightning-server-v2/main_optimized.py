"""
Lightning Server V2 - Optimized COG Tile Server

High-performance tile server designed for pre-computed COG files.
Leverages COG internal overviews for instant low-zoom tiles.
"""

import os
from typing import Dict, Optional
from datetime import datetime, timedelta
from functools import lru_cache

import numpy as np
from fastapi import FastAPI, Query, HTTPException
from fastapi.responses import Response, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import rasterio
from rasterio.warp import transform_bounds
from rio_tiler.io import COGReader

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
BUCKET_BASE_URL = os.getenv("BUCKET_BASE_URL", "https://storage.googleapis.com/inference_result/forecasts")
PORT = int(os.getenv("PORT", "3001"))

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
        min=-2,
        max=15,
        colormap="viridis",
        invert=False
    ),
    "sat_ch1": BandConfig(
        name="Satellite Channel 1 (IR)",
        min=-3,
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


def get_cog_url(timestamp: str, band: str) -> str:
    """
    Generate the COG URL for a given timestamp and band.
    Matches the naming convention from inference_engine.py:
    - forecast_{timestamp}_sat_ch{0,1,...}.tiff
    - forecast_{timestamp}_lightning.tiff
    """
    return f"{BUCKET_BASE_URL}/{timestamp[:8]}/forecast_{timestamp}_{band}.tiff"


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
    url = get_cog_url(time, band)

    try:
        # Use COGReader - reads directly from GCS with HTTP range requests
        # COG internal overviews are used automatically for low zoom levels
        with COGReader(url) as cog:
            # Read tile - COG handles overview selection automatically
            tile = cog.tile(x, y, z, tilesize=256, indexes=(1,))
            data = tile.data[0].astype(np.float32)

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

            else:
                # Matplotlib colormap for satellite
                from matplotlib import cm
                from matplotlib.colors import Normalize

                cmap = cm.get_cmap(config.colormap)
                if config.invert:
                    cmap = cmap.reversed()

                norm = Normalize(vmin=config.min, vmax=config.max)
                normalized = norm(data.astype(float))
                rgba = (cmap(normalized) * 255).astype(np.uint8)
                rgba[:, :, 3] = 255

                # Handle nodata
                if tile.mask is not None:
                    rgba[~tile.mask] = [0, 0, 0, 0]

            # Convert to PNG
            from io import BytesIO
            from PIL import Image

            img = Image.fromarray(rgba, mode='RGBA')
            buffer = BytesIO()
            img.save(buffer, format='PNG', optimize=True)

            return Response(content=buffer.getvalue(), media_type="image/png")

    except Exception as e:
        # Return transparent tile on error
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

    url = get_cog_url(time, band)

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

            return JSONResponse({
                "url": url,
                "bounds": [minx, miny, maxx, maxy],
                "crs": crs,
                "size": [cog.width, cog.height],
                "nodata": cog.nodata,
                "overviews": cog.overviews(1) if hasattr(cog, 'overviews') else []
            })

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
            return JSONResponse({
                "url": url,
                "driver": cog.driver,
                "crs": str(cog.crs) if cog.crs else None,
                "bounds": list(cog.bounds),
                "size": [cog.width, cog.height],
                "nodata": cog.nodata,
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
