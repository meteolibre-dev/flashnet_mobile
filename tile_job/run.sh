#!/bin/bash
# Tile Job Runner
# Run this on a low-cost CPU machine (no GPU needed)
# Usage: ./run.sh [--dry-run]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

DRY_RUN=""
if [ "$1" = "--dry-run" ]; then
    DRY_RUN="--dry-run"
fi

echo "Installing dependencies..."
pip install -r requirements.txt

echo "Starting tile generation..."
python tile_generator.py --all $DRY_RUN

echo "Done!"