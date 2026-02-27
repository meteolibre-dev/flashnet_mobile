"""
Tile Generator for Pre-computed PNG Tiles

Generates PNG tiles from COG files for fast static serving.
Discovers timestamps from GCS bucket and generates tiles for the last 18.

Usage:
    # Process last 18 timestamps
    python tile_generator.py --all
    
    # Process specific timestamp
    python tile_generator.py --timestamp 202602231200
    
    # Process specific bands
    python tile_generator.py --all --bands lightning sat_ch0 sat_ch1
    
    # Custom zoom levels
    python tile_generator.py --all --zoom-levels 3-7
"""

import os
import re
import logging
import argparse
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Optional

import numpy as np
from PIL import Image
from io import BytesIO

try:
    from rio_tiler.io import Reader
    RIO_TILER_AVAILABLE = True
except ImportError:
    RIO_TILER_AVAILABLE = False
    print("Warning: rio-tiler not available")

try:
    from google.cloud import storage
    GCS_AVAILABLE = True
except ImportError:
    GCS_AVAILABLE = False
    print("Warning: google-cloud-storage not available")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

BUCKET_NAME = os.getenv("TILES_BUCKET", "inference_result")
BUCKET_BASE_URL = os.getenv("BUCKET_BASE_URL", "gs://inference_result/forecasts")
TILES_BUCKET = os.getenv("TILES_BUCKET", "inference_result")
TILES_PREFIX = os.getenv("TILES_PREFIX", "tiles")

REGION_BOUNDS = {
    "lon_min": -10.0,
    "lat_min": 33.0,
    "lon_max": 33.0,
    "lat_max": 60.0,
}

ZOOM_LEVELS = list(range(3, 9))  # 3 to 8 inclusive

BANDS = {
    "lightning": {"min": 0, "max": 4, "colormap": "custom", "invert": False},
    "radar": {"min": 0, "max": 75, "colormap": "turbo", "invert": False},
}

LIGHTNING_CMAP = {
    0: (255, 255, 0, 150),
    1: (255, 255, 0, 180),
    2: (255, 200, 0, 210),
    3: (255, 100, 0, 230),
    4: (255, 0, 0, 255),
}


def discover_timestamps(n: int = 18) -> List[str]:
    """Discover the last n timestamps from the GCS bucket."""
    if not GCS_AVAILABLE:
        logger.error("google-cloud-storage not available")
        return []
    
    try:
        client = storage.Client()
        bucket = client.bucket(BUCKET_NAME)
        prefix = "forecasts/"
        
        logger.info(f"Searching for timestamps in bucket={BUCKET_NAME}, prefix={prefix}")
        
        # First, let's see what blobs exist at the forecasts/ level
        test_blobs = list(bucket.list_blobs(prefix="forecasts", max_results=10))
        logger.info(f"Test listing at 'forecasts': found {len(test_blobs)} items")
        for b in test_blobs[:5]:
            logger.info(f"  Blob: {b.name}")
        
        # Use delimiter to get "common prefixes" (date folders)
        blobs = bucket.list_blobs(prefix=prefix, delimiter="/")
        
        date_folders = set()
        
        # When using delimiter, prefixes (date folders) are in the prefixes property
        # The prefix format is like "forecasts/2026-02-27/"
        prefixes = list(blobs.prefixes) if hasattr(blobs, 'prefixes') else []
        logger.info(f"Found prefixes from delimiter: {prefixes}")
        
        # If no prefixes found via delimiter, try extracting from blob names
        if not prefixes:
            logger.info("Trying fallback: extracting dates from blob names")
            all_blobs = list(bucket.list_blobs(prefix=prefix))
            for blob in all_blobs:
                match = re.search(r"forecasts/(\d{4}-\d{2}-\d{2})/", blob.name)
                if match:
                    date_folders.add(match.group(1))
        else:
            for date_prefix in prefixes:
                match = re.search(r"(\d{4}-\d{2}-\d{2})/", date_prefix)
                if match:
                    date_folders.add(match.group(1))
        
        if not date_folders:
            logger.warning("No date folders found in bucket")
            logger.warning(f"Prefix used: {prefix}, prefixes found: {prefixes}")
            return []
        
        sorted_dates = sorted(date_folders, reverse=True)[:n]
        
        timestamps = set()
        for date_folder in sorted_dates:
            prefix = f"forecasts/{date_folder}/"
            blobs = list(bucket.list_blobs(prefix=prefix))
            
            for blob in blobs:
                match = re.search(r"forecast_(\d{12})_(\w+)\.tiff", blob.name)
                if match:
                    timestamps.add(match.group(1))
        
        sorted_timestamps = sorted(timestamps, reverse=True)[:n]
        logger.info(f"Discovered {len(sorted_timestamps)} timestamps: {sorted_timestamps}")
        return sorted_timestamps
        
    except Exception as e:
        logger.error(f"Error discovering timestamps: {e}")
        return []


def get_cog_url(timestamp: str, band: str) -> str:
    """Generate the COG URL for a given timestamp and band."""
    date_folder = f"{timestamp[:4]}-{timestamp[4:6]}-{timestamp[6:8]}"
    
    if BUCKET_BASE_URL.startswith("gs://"):
        return f"gs://inference_result/forecasts/{date_folder}/forecast_{timestamp}_{band}.tiff"
    else:
        return f"{BUCKET_BASE_URL}/{date_folder}/forecast_{timestamp}_{band}.tiff"


def lon_lat_to_tile(lon: float, lat: float, zoom: int) -> tuple:
    """Convert longitude/latitude to tile x/y at given zoom."""
    import math
    
    lat_rad = math.radians(lat)
    n = 2.0 ** zoom
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    
    return x, y


def get_tiles_for_region(bounds: dict, zoom: int) -> List[tuple]:
    """Get list of (x, y) tiles that cover the specified region."""
    x_min, y_min = lon_lat_to_tile(bounds["lon_min"], bounds["lat_max"], zoom)
    x_max, y_max = lon_lat_to_tile(bounds["lon_max"], bounds["lat_min"], zoom)
    
    tiles = []
    for x in range(x_min, x_max + 1):
        for y in range(y_min, y_max + 1):
            tiles.append((x, y))
    
    return tiles


def generate_tile_rgba(cog_url: str, x: int, y: int, z: int, band: str) -> Optional[np.ndarray]:
    """Generate RGBA array for a single tile from COG."""
    if not RIO_TILER_AVAILABLE:
        logger.error("rio-tiler not available")
        return None
    
    config = BANDS.get(band, {})
    if not config:
        return None
    
    try:
        with Reader(cog_url) as cog:
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
            
            data = np.clip(data, config["min"], config["max"])
            data = ((data - config["min"]) / (config["max"] - config["min"]) * 255).astype(np.uint8)
            
            if band == "lightning":
                rgba = np.zeros((256, 256, 4), dtype=np.uint8)
                
                for val, color in LIGHTNING_CMAP.items():
                    if val > 0:
                        mask = data >= int(val * 255 / config["max"])
                        rgba[mask] = color
                
                non_zero_mask = data > 0
                rgba[non_zero_mask & (rgba[:, :, 3] == 0)] = [255, 255, 0, 150]
                
                if nodata_mask is not None:
                    rgba[nodata_mask] = [0, 0, 0, 0]
            else:
                from matplotlib import cm
                
                cmap = cm.get_cmap(config["colormap"])
                if config["invert"]:
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
        logger.warning(f"Error generating tile {z}/{x}/{y}: {e}")
        return None


def tile_to_png(rgba: np.ndarray, format: str = "PNG") -> bytes:
    """Convert RGBA array to PNG bytes."""
    img = Image.fromarray(rgba, mode='RGBA')
    buffer = BytesIO()
    
    if format == "WEBP":
        img.save(buffer, format='WEBP', quality=85, method=6)
    else:
        img.save(buffer, format='PNG', optimize=True)
    
    buffer.seek(0)
    return buffer.getvalue()


def upload_to_gcs(bucket_name: str, blob_path: str, data: bytes) -> bool:
    """Upload data to GCS bucket."""
    if not GCS_AVAILABLE:
        return False
    
    try:
        client = storage.Client()
        bucket = client.bucket(bucket_name)
        blob = bucket.blob(blob_path)
        blob.upload_from_string(data, content_type=f"image/{'png' if blob_path.endswith('.png') else 'webp'}")
        return True
    except Exception as e:
        logger.error(f"Error uploading to GCS: {e}")
        return False


def generate_tiles_for_band_timestamp(
    timestamp: str,
    band: str,
    zoom_levels: List[int] = ZOOM_LEVELS,
    region_bounds: dict = REGION_BOUNDS,
    bucket_name: str = TILES_BUCKET,
    prefix: str = TILES_PREFIX,
    output_format: str = "PNG",
    dry_run: bool = False,
    tile_workers: int = 8
) -> dict:
    """Generate all tiles for a specific band and timestamp."""
    stats = {
        "timestamp": timestamp,
        "band": band,
        "tiles_generated": 0,
        "tiles_failed": 0,
        "tiles_skipped": 0,
        "zoom_levels": zoom_levels,
    }
    
    if not RIO_TILER_AVAILABLE:
        logger.error("rio-tiler not available")
        return stats
    
    cog_url = get_cog_url(timestamp, band)
    logger.info(f"Processing {band} for {timestamp} from {cog_url}")
    
    # Create GCS client once for all uploads
    gcs_client = None
    if GCS_AVAILABLE and not dry_run:
        gcs_client = storage.Client()
    
    config = BANDS.get(band, {})
    if not config:
        logger.error(f"Unknown band: {band}")
        return stats
    
    # Collect all tile coordinates
    all_tiles = []
    for z in zoom_levels:
        tiles = get_tiles_for_region(region_bounds, z)
        for x, y in tiles:
            all_tiles.append((x, y, z))
    
    logger.info(f"Total tiles to process: {len(all_tiles)}")
    
    # Process tiles in chunks for parallel upload
    chunk_size = 32
    
    try:
        # Open COG reader ONCE and reuse for all tiles
        with Reader(cog_url) as cog:
            for i in range(0, len(all_tiles), chunk_size):
                chunk = all_tiles[i:i + chunk_size]
                logger.info(f"Processing chunk {i//chunk_size + 1}: {len(chunk)} tiles")
                
                # Generate all tiles in chunk sequentially (COG reader is not thread-safe)
                tile_data = []
                for x, y, z in chunk:
                    try:
                        rgba = _generate_single_tile(cog, x, y, z, band, config)
                        if rgba is None:
                            stats["tiles_skipped"] += 1
                            continue
                        
                        png_data = tile_to_png(rgba, format=output_format)
                        ext = "png" if output_format == "PNG" else "webp"
                        blob_path = f"{prefix}/{band}/{timestamp}/{z}/{x}/{y}.{ext}"
                        
                        tile_data.append((blob_path, png_data))
                        
                    except Exception as e:
                        logger.error(f"Error generating tile {z}/{x}/{y}: {e}")
                        stats["tiles_failed"] += 1
                
                # Upload all tiles in parallel
                if tile_data and not dry_run:
                    with ThreadPoolExecutor(max_workers=tile_workers) as executor:
                        futures = {
                            executor.submit(_upload_to_gcs, gcs_client, bucket_name, path, data): idx
                            for idx, (path, data) in enumerate(tile_data)
                        }
                        
                        for future in as_completed(futures):
                            idx = futures[future]
                            try:
                                if future.result():
                                    stats["tiles_generated"] += 1
                                else:
                                    stats["tiles_failed"] += 1
                            except Exception as e:
                                logger.error(f"Error uploading tile: {e}")
                                stats["tiles_failed"] += 1
                elif dry_run:
                    for path, data in tile_data:
                        logger.info(f"[DRY RUN] Would upload: {path} ({len(data)} bytes)")
                        stats["tiles_generated"] += 1
    
    except Exception as e:
        logger.error(f"Error opening COG {cog_url}: {e}")
        return stats
    
    logger.info(f"Completed {band}/{timestamp}: {stats['tiles_generated']} generated, "
                f"{stats['tiles_skipped']} skipped, {stats['tiles_failed']} failed")
    
    return stats


def _generate_single_tile(cog, x: int, y: int, z: int, band: str, config: dict) -> Optional[np.ndarray]:
    """Generate a single tile from an already-open COG reader."""
    try:
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
        
        data = np.clip(data, config["min"], config["max"])
        data = ((data - config["min"]) / (config["max"] - config["min"]) * 255).astype(np.uint8)
        
        if band == "lightning":
            rgba = np.zeros((256, 256, 4), dtype=np.uint8)
            
            for val, color in LIGHTNING_CMAP.items():
                if val > 0:
                    mask = data >= int(val * 255 / config["max"])
                    rgba[mask] = color
            
            non_zero_mask = data > 0
            rgba[non_zero_mask & (rgba[:, :, 3] == 0)] = [255, 255, 0, 150]
            
            if nodata_mask is not None:
                rgba[nodata_mask] = [0, 0, 0, 0]
        else:
            from matplotlib import cm
            
            cmap = cm.get_cmap(config["colormap"])
            if config["invert"]:
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
        logger.warning(f"Error generating tile {z}/{x}/{y}: {e}")
        return None


def _upload_to_gcs(client, bucket_name: str, blob_path: str, data: bytes) -> bool:
    """Upload data to GCS using a pre-created client."""
    if client is None:
        return False
    
    try:
        bucket = client.bucket(bucket_name)
        blob = bucket.blob(blob_path)
        blob.upload_from_string(data, content_type=f"image/{'png' if blob_path.endswith('.png') else 'webp'}")
        return True
    except Exception as e:
        logger.error(f"Error uploading to GCS: {e}")
        return False


def generate_tiles_for_timestamp(
    timestamp: str,
    bands: List[str] = None,
    zoom_levels: List[int] = ZOOM_LEVELS,
    region_bounds: dict = REGION_BOUNDS,
    bucket_name: str = TILES_BUCKET,
    prefix: str = TILES_PREFIX,
    output_format: str = "PNG",
    max_workers: int = 4,
    dry_run: bool = False
) -> dict:
    """Generate all tiles for a timestamp across all bands."""
    if bands is None:
        bands = list(BANDS.keys())
    
    results = {
        "timestamp": timestamp,
        "total_bands": len(bands),
        "band_stats": [],
        "total_tiles": 0,
    }
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {}
        
        for band in bands:
            if band not in BANDS:
                logger.warning(f"Unknown band: {band}, skipping")
                continue
            
            future = executor.submit(
                generate_tiles_for_band_timestamp,
                timestamp,
                band,
                zoom_levels,
                region_bounds,
                bucket_name,
                prefix,
                output_format,
                dry_run
            )
            futures[future] = band
        
        for future in as_completed(futures):
            band = futures[future]
            try:
                stats = future.result()
                results["band_stats"].append(stats)
                results["total_tiles"] += stats["tiles_generated"]
            except Exception as e:
                logger.error(f"Error processing band {band}: {e}")
    
    logger.info(f"Completed timestamp {timestamp}: {results['total_tiles']} total tiles generated")
    
    return results


def get_tile_url(band: str, timestamp: str, z: int, x: int, y: int, format: str = "png") -> str:
    """Get the URL for a pre-generated tile."""
    ext = format.lower()
    if format.lower() == "webp":
        ext = "webp"
    return f"gs://{TILES_BUCKET}/{TILES_PREFIX}/{band}/{timestamp}/{z}/{x}/{y}.{ext}"


def main():
    parser = argparse.ArgumentParser(
        description="Generate pre-computed PNG tiles from COG files"
    )
    parser.add_argument(
        "--timestamp",
        type=str,
        help="Specific timestamp in YYYYMMDDHHMM format (e.g., 202602231200)"
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Process the last 18 timestamps from the bucket"
    )
    parser.add_argument(
        "--bands",
        type=str,
        nargs="+",
        default=["lightning", "radar"],
        help="Bands to process"
    )
    parser.add_argument(
        "--zoom-levels",
        type=str,
        default="3-8",
        help="Zoom levels (e.g., 3-8 or 4,5,6)"
    )
    parser.add_argument(
        "--format",
        type=str,
        default="PNG",
        choices=["PNG", "WEBP"],
        help="Output format"
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=8,
        help="Number of parallel workers"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Don't upload to GCS, just log what would be done"
    )
    parser.add_argument(
        "--bucket",
        type=str,
        default=TILES_BUCKET,
        help="GCS bucket for tiles"
    )
    parser.add_argument(
        "--prefix",
        type=str,
        default=TILES_PREFIX,
        help="Prefix for tile storage"
    )
    parser.add_argument(
        "--count",
        type=int,
        default=18,
        help="Number of timestamps to process with --all"
    )
    
    args = parser.parse_args()
    
    if "-" in args.zoom_levels:
        z_min, z_max = map(int, args.zoom_levels.split("-"))
        zoom_levels = list(range(z_min, z_max + 1))
    elif "," in args.zoom_levels:
        zoom_levels = [int(z) for z in args.zoom_levels.split(",")]
    else:
        zoom_levels = [int(args.zoom_levels)]
    
    timestamps = []
    if args.all:
        timestamps = discover_timestamps(n=args.count)
        if not timestamps:
            logger.error("No timestamps discovered, exiting")
            return
    elif args.timestamp:
        timestamps = [args.timestamp]
    else:
        logger.error("Please specify either --timestamp or --all")
        parser.print_help()
        return
    
    logger.info(f"Starting tile generation for {len(timestamps)} timestamps, "
                f"bands={args.bands}, zoom_levels={zoom_levels}")
    
    total_tiles = 0
    for timestamp in timestamps:
        logger.info(f"Processing timestamp: {timestamp}")
        results = generate_tiles_for_timestamp(
            timestamp=timestamp,
            bands=args.bands,
            zoom_levels=zoom_levels,
            bucket_name=args.bucket,
            prefix=args.prefix,
            output_format=args.format,
            max_workers=args.workers,
            dry_run=args.dry_run
        )
        total_tiles += results["total_tiles"]
    
    logger.info(f"Generation complete: {total_tiles} total tiles generated")


if __name__ == "__main__":
    main()