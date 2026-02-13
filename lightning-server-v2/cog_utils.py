"""
Utility script to convert existing TIFF files to Cloud Optimized GeoTIFF (COG) format.
This is useful if your source TIFFs are not already in COG format.
"""

import os
import sys
import argparse
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, as_completed
import tempfile
import shutil

try:
    from rio_cogeo import cogeo_translate
    from rio_cogeo.models import Coordinate, GTiff
    RIO_COGEO_AVAILABLE = True
except ImportError:
    RIO_COGEO_AVAILABLE = False
    print("Warning: rio-cogeo not available. Install with: pip install rio-cogeo")


def convert_to_cog(input_path: str, output_path: str, overview_levels=None) -> bool:
    """
    Convert a TIFF to Cloud Optimized GeoTIFF format.

    Args:
        input_path: Path to input TIFF
        output_path: Path for output COG
        overview_levels: List of overview levels to create (default: [2, 4, 8, 16, 32])

    Returns:
        True if successful, False otherwise
    """
    if not RIO_COGEO_AVAILABLE:
        print("Error: rio-cogeo is required. Install with: pip install rio-cogeo")
        return False

    if overview_levels is None:
        overview_levels = [2, 4, 8, 16, 32]

    try:
        print(f"Converting {input_path} -> {output_path}")

        # Output configuration
        output_config = GTiff(
            dtype="float32",
            compress="DEFLATE",
            tiled=True,
            blockxsize=256,
            blockysize=256,
            overview_resampling="bilinear",
            overview_level=len(overview_levels)
        )

        # Perform translation
        cogeo_translate(
            input_path,
            output_path,
            output_config,
            quiet=False
        )

        print(f"  Success: {output_path}")
        return True

    except Exception as e:
        print(f"  Error converting {input_path}: {e}")
        return False


def batch_convert(input_dir: str, output_dir: str, pattern: str = "*.tiff", max_workers: int = 4):
    """
    Convert all TIFF files in a directory to COG format.

    Args:
        input_dir: Input directory containing TIFF files
        output_dir: Output directory for COGs
        pattern: Glob pattern for matching files
        max_workers: Number of parallel workers
    """
    input_path = Path(input_dir)
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    # Find all TIFF files
    tiff_files = list(input_path.glob(pattern))
    print(f"Found {len(tiff_files)} TIFF files to convert")

    if len(tiff_files) == 0:
        print("No files found matching pattern")
        return

    # Convert each file
    success_count = 0
    failed = []

    with ProcessPoolExecutor(max_workers=max_workers) as executor:
        futures = {}

        for tiff_file in tiff_files:
            output_file = output_path / f"{tiff_file.stem}_cog.tif"
            future = executor.submit(
                convert_to_cog,
                str(tiff_file),
                str(output_file)
            )
            futures[future] = tiff_file.name

        for future in as_completed(futures):
            filename = futures[future]
            try:
                if future.result():
                    success_count += 1
            except Exception as e:
                print(f"Error processing {filename}: {e}")
                failed.append(filename)

    print(f"\nConversion complete: {success_count}/{len(tiff_files)} successful")
    if failed:
        print(f"Failed files: {failed}")


def verify_cog(cog_path: str) -> dict:
    """
    Verify that a file is a valid COG and check its properties.

    Args:
        cog_path: Path to the COG file

    Returns:
        Dictionary with verification results
    """
    import rasterio

    result = {
        "path": cog_path,
        "is_cog": False,
        "has_overviews": False,
        "is_tiled": False,
        "compression": None,
        "message": ""
    }

    try:
        with rasterio.open(cog_path) as src:
            result["width"] = src.width
            result["height"] = src.height
            result["crs"] = str(src.crs) if src.crs else None

            # Check if tiled
            if src.profile.get('tiled', False):
                result["is_tiled"] = True
                result["block_size"] = (src.profile.get('blockxsize'), src.profile.get('blockysize'))

            # Check compression
            compression = src.profile.get('compress', '').lower()
            result["compression"] = compression

            # Check for internal overviews
            try:
                if hasattr(src, 'overviews') and len(src.overviews(1)) > 0:
                    result["has_overviews"] = True
                    result["overview_levels"] = src.overviews(1)
            except:
                pass

            # Check if it's a COG (needs: tiled, compression, and overviews)
            result["is_cog"] = (
                result["is_tiled"] and
                compression in ['deflate', 'lzw', 'zstd'] and
                result["has_overviews"]
            )

            if result["is_cog"]:
                result["message"] = "Valid COG"
            else:
                reasons = []
                if not result["is_tiled"]:
                    reasons.append("not tiled")
                if not result["compression"]:
                    reasons.append("no compression")
                if not result["has_overviews"]:
                    reasons.append("no overviews")
                result["message"] = f"Not a valid COG: {', '.join(reasons)}"

    except Exception as e:
        result["message"] = f"Error: {e}"

    return result


def main():
    parser = argparse.ArgumentParser(
        description="COG conversion and verification utilities"
    )
    subparsers = parser.add_subparsers(dest="command", help="Commands")

    # Convert command
    convert_parser = subparsers.add_parser("convert", help="Convert TIFFs to COG")
    convert_parser.add_argument("input", help="Input directory")
    convert_parser.add_argument("output", help="Output directory")
    convert_parser.add_argument("--pattern", default="*.tiff", help="File pattern")
    convert_parser.add_argument("--workers", type=int, default=4, help="Parallel workers")

    # Verify command
    verify_parser = subparsers.add_parser("verify", help="Verify COG file")
    verify_parser.add_argument("file", help="Path to COG file")

    args = parser.parse_args()

    if args.command == "convert":
        batch_convert(args.input, args.output, args.pattern, args.workers)
    elif args.command == "verify":
        result = verify_cog(args.file)
        print(json.dumps(result, indent=2))
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
