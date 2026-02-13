"""
TiTiler-based COG server for lightning and satellite data.
Optimized for 18 temporal timesteps × 3 channels.
"""

import os
import json
from typing import List, Optional
from datetime import datetime, timedelta

from fastapi import FastAPI, Query, HTTPException
from fastapi.responses import Response, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from titiler.core.factory import TilerFactory
from titiler.core.resources.responses import JSONResponse as TitilerJSONResponse
from titiler.extensions import ViewerExtension

import rio_tiler
from rio_tiler.models import ImageData
from rio_tiler.expression import apply_expression
import rasterio
from rasterio.warp import calculate_default_transform, transform_bounds

# Configuration
BUCKET_BASE_URL = os.getenv("BUCKET_BASE_URL", "https://storage.googleapis.com/inference_result/forecasts")
PORT = int(os.getenv("PORT", "3001"))

app = FastAPI(
    title="Lightning Server V2",
    description="TiTiler-based COG server for lightning and satellite forecasting data",
    version="2.0.0"
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Band configuration
BANDS = {
    "lightning": {
        "name": "Lightning",
        "min": 0,
        "max": 4,
        "colormap": "custom_lightning",
        "expression": "b1"
    },
    "sat_ch0": {
        "name": "Satellite Channel 0",
        "min": -2,
        "max": 15,
        "colormap": "viridis",
        "expression": "b1"
    },
    "sat_ch1": {
        "name": "Satellite Channel 1 (IR)",
        "min": -3,
        "max": 120,
        "colormap": "plasma",
        "expression": "b1",
        "invert": True  # Invert colormap for IR
    }
}


def get_cog_url(timestamp: str, band: str) -> str:
    """Generate the COG URL for a given timestamp and band."""
    return f"{BUCKET_BASE_URL}/{timestamp[:8]}/forecast_{timestamp}_{band}.tiff"


def list_available_timestamps() -> List[str]:
    """List available timestamps (in production, this would query GCS)."""
    # In production, you would query GCS here
    # For now, we'll generate timestamps dynamically
    timestamps = []
    now = datetime.utcnow()

    # Generate last 18 timesteps (assuming hourly data)
    for i in range(18):
        # Adjust this based on actual data frequency
        d = now - timedelta(hours=i)
        timestamp = d.strftime("%Y%m%d%H%M")
        timestamps.append(timestamp)

    return timestamps


def get_custom_colormap(band: str) -> dict:
    """Get custom colormap for a band."""
    if band == "lightning":
        # Yellow to red for lightning
        return {
            0: (0, 0, 0, 0),       # Transparent for no data
            1: (255, 255, 0, 150),  # Yellow
            2: (255, 200, 0, 200),  # Orange-yellow
            3: (255, 100, 0, 230),  # Orange
            4: (255, 0, 0, 255),    # Red
        }
    return None


@app.get("/")
async def root():
    """API info endpoint."""
    return {
        "name": "Lightning Server V2",
        "version": "2.0.0",
        "description": "TiTiler-based COG server",
        "bands": list(BANDS.keys()),
        "endpoints": {
            "tiles": "/tiles/{z}/{x}/{y}.png",
            "tilejson": "/tilejson",
            "bounds": "/bounds",
            "available_times": "/times"
        }
    }


@app.get("/bands")
async def list_bands():
    """List available bands."""
    return BANDS


@app.get("/times")
async def list_times():
    """List available timestamps."""
    return {
        "timestamps": list_available_timestamps(),
        "count": 18
    }


@app.get("/times/{timestamp}")
async def check_timestamp(timestamp: str):
    """Check if a specific timestamp is available for all bands."""
    available = {}
    for band in BANDS.keys():
        url = get_cog_url(timestamp, band)
        available[band] = {
            "url": url,
            "exists": True  # In production, check if URL is accessible
        }
    return {
        "timestamp": timestamp,
        "bands": available
    }


# Create tile factory with custom options
class CustomTilerFactory(TilerFactory):
    """Custom TilerFactory with colormap support."""

    def tile(self, z: int, x: int, y: int, band: str = Query(...), time: str = Query(...)):
        """Get tile with custom colormap."""
        from titiler.core import utils

        # Get the COG URL
        url = get_cog_url(time, band)

        # Get band config
        band_config = BANDS.get(band, {})
        rescale = band_config.get("min", 0), band_config.get("max", 100)

        # Get colormap
        colormap = get_custom_colormap(band)

        # Build options
        options = {}
        if colormap:
            options["colormap"] = colormap

        # Use the parent's tile method with custom options
        return super().tile(z, x, y, url, **options)


# Create tile factory
basetiler = TilerFactory(
    reader_options={"cog_http_client": {"timeout": 30}}
)


@app.get("/tiles/{z}/{x}/{y}.png")
async def get_tile(
    z: int,
    x: int,
    y: int,
    band: str = Query(..., description="Band name (lightning, sat_ch0, sat_ch1)"),
    time: str = Query(..., description="Timestamp (YYYYMMDDHHMM)")
):
    """Get a tile for the specified band and time."""
    if band not in BANDS:
        raise HTTPException(status_code=400, detail=f"Invalid band: {band}")

    url = get_cog_url(time, band)

    try:
        # Get band config
        band_config = BANDS[band]
        rescale_values = f"{band_config['min']},{band_config['max']}"

        # Custom colormap
        custom_cm = get_custom_colormap(band)

        # Read the COG
        with rasterio.open(url) as cog:
            # Use rio-tiler to read the tile
            img = rio_tiler.io.CogReader(url).tile(x, y, z, tilesize=256)

            # Apply rescale if needed
            if rescale_values:
                from rio_tiler.utils import rescale_intensity
                rescale_min, rescale_max = map(float, rescale_values.split(','))
                img = rescale_intensity(img, (rescale_min, rescale_max))

            # Apply colormap
            if custom_cm:
                from rio_tiler.colormap import apply_cmap
                img = apply_cmap(img, custom_cm)

        # Return as PNG
        return Response(
            content=img.render(img_format="PNG"),
            media_type="image/png"
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error generating tile: {str(e)}")


@app.get("/tilejson")
async def get_tilejson(
    band: str = Query(..., description="Band name"),
    time: str = Query(..., description="Timestamp")
):
    """Get TileJSON for a specific band and time."""
    if band not in BANDS:
        raise HTTPException(status_code=400, detail=f"Invalid band: {band}")

    url = get_cog_url(time, band)

    try:
        with rasterio.open(url) as cog:
            bounds = cog.bounds
            # Transform to WGS84 if needed
            if cog.crs and cog.crs != "EPSG:4326":
                dst_crs = "EPSG:4326"
                minx, miny, maxx, maxy = transform_bounds(
                    cog.crs, dst_crs, bounds.left, bounds.bottom, bounds.right, bounds.top
                )
            else:
                minx, miny, maxx, maxy = bounds.left, bounds.bottom, bounds.right, bounds.top

        return JSONResponse({
            "tilejson": "2.1.0",
            "name": f"{band}_{time}",
            "description": f"{BANDS[band]['name']} at {time}",
            "version": "1.0.0",
            "scheme": "xyz",
            "tiles": [
                f"/tiles/{{z}}/{{x}}/{{y}}.png?band={band}&time={time}"
            ],
            "bounds": [minx, miny, maxx, maxy],
            "center": [
                (minx + maxx) / 2,
                (miny + maxy) / 2,
                4
            ]
        })

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error getting tilejson: {str(e)}")


@app.get("/bounds")
async def get_bounds(
    band: str = Query(..., description="Band name"),
    time: str = Query(..., description="Timestamp")
):
    """Get bounds for a COG."""
    if band not in BANDS:
        raise HTTPException(status_code=400, detail=f"Invalid band: {band}")

    url = get_cog_url(time, band)

    try:
        with rasterio.open(url) as cog:
            bounds = cog.bounds

            # Transform to WGS84 if needed
            if cog.crs and str(cog.crs) != "EPSG:4326":
                dst_crs = "EPSG:4326"
                minx, miny, maxx, maxy = transform_bounds(
                    str(cog.crs), dst_crs, bounds.left, bounds.bottom, bounds.right, bounds.top
                )
            else:
                minx, miny, maxx, maxy = bounds.left, bounds.bottom, bounds.right, bounds.top

            return JSONResponse({
                "band": band,
                "time": time,
                "url": url,
                "bounds": [minx, miny, maxx, maxy],
                "crs": str(cog.crs) if cog.crs else None,
                "size": [cog.width, cog.height]
            })

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error getting bounds: {str(e)}")


@app.get("/info")
async def get_info(
    band: str = Query(..., description="Band name"),
    time: str = Query(..., description="Timestamp")
):
    """Get detailed COG metadata."""
    if band not in BANDS:
        raise HTTPException(status_code=400, detail=f"Invalid band: {band}")

    url = get_cog_url(time, band)

    try:
        with rasterio.open(url) as cog:
            return JSONResponse({
                "band": band,
                "time": time,
                "url": url,
                "driver": cog.driver,
                "crs": str(cog.crs) if cog.crs else None,
                "bounds": list(cog.bounds),
                "size": [cog.width, cog.height],
                "nodata": cog.nodata,
                "tags": cog.tags().get("IMAGE_STRUCTURE", {}),
                "overviews": cog.overviews(1) if hasattr(cog, 'overviews') else []
            })

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error getting info: {str(e)}")


# Multi-band endpoint for combining bands
@app.get("/composite/{band}/{time}")
async def get_composite(
    band: str,
    time: str,
    expression: Optional[str] = Query(None, description="Raster expression")
):
    """
    Get composite image for visualization.
    Useful for combining multiple bands.
    """
    if band not in BANDS:
        raise HTTPException(status_code=400, detail=f"Invalid band: {band}")

    url = get_cog_url(time, band)

    try:
        with rasterio.open(url) as cog:
            # Read overview level 2 (reduced resolution for composites)
            img = cog.read(1, overview_level=2)

            return JSONResponse({
                "shape": img.shape.tolist(),
                "min": float(img.min()),
                "max": float(img.max()),
                "mean": float(img.mean()),
                "dtype": str(img.dtype)
            })

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error creating composite: {str(e)}")


if __name__ == "__main__":
    import uvicorn

    print(f"Starting Lightning Server V2 on port {PORT}")
    print(f"Data source: {BUCKET_BASE_URL}")

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=PORT,
        log_level="info"
    )
