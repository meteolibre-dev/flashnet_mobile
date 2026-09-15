#!/usr/bin/env python3
"""Extract the enhanced-IR satellite colormap LUT from a colorbar screenshot.

Reads ../colorbar.png (a screenshot of the reference colorbar: saturated
spectral ramp on the cold end, greyscale ramp on the warm end, black at both
extremes — the classic enhanced-IR satellite palette, cf. trollimage's
"spectral + greys" example: https://trollimage.readthedocs.io/en/latest/colormap.html)
and emits the 256-entry Go LUT used by irEnhancedLUT in colormap_data.go.

Method:
  1. Take the per-column dominant (mode) color of the colorbar strip —
     robust against the tick-label text overlaid on the bar.
  2. Median-filter (window 21) each RGB channel to remove residual label
     spikes from the screenshot.
  3. Linearly resample the cleaned 1853-column gradient to 256 LUT entries.

Usage:
    python3 scripts/extract_ir_colormap.py [path/to/colorbar.png]

The generated table is written to stdout as Go source.
"""

import sys
from collections import Counter
from pathlib import Path

from PIL import Image

# Colorbar strip geometry in the reference screenshot (colorbar.png).
# The strip is the middle band; X0/X1 are the true gradient extent
# (excluding the ~6 px border ramps at both edges).
STRIP_Y0, STRIP_Y1 = 66, 132
BAR_X0, BAR_X1 = 19, 1871
LUT_SIZE = 256


def extract(path: str):
    img = Image.open(path).convert("RGB")

    # 1. per-column mode color (rejects tick-label text pixels)
    cols = []
    for x in range(BAR_X0, BAR_X1 + 1):
        cnt = Counter(img.getpixel((x, y)) for y in range(STRIP_Y0, STRIP_Y1))
        cols.append(cnt.most_common(1)[0][0])
    n = len(cols)

    # 2. median filter per channel (kills residual text/AA spikes)
    window = 21
    med = []
    for i in range(n):
        lo, hi = max(0, i - window // 2), min(n, i + window // 2 + 1)
        chans = [
            sorted(c[k] for c in cols[lo:hi])[len(cols[lo:hi]) // 2]
            for k in range(3)
        ]
        med.append(tuple(chans))

    # 3. resample to 256 entries
    lut = []
    for i in range(LUT_SIZE):
        pos = i / (LUT_SIZE - 1) * (n - 1)
        j = int(pos)
        t = pos - j
        a, b = med[j], med[min(j + 1, n - 1)]
        lut.append(tuple(round(a[k] + (b[k] - a[k]) * t) for k in range(3)))
    return lut


def main():
    default = Path(__file__).resolve().parent.parent.parent / "colorbar.png"
    path = sys.argv[1] if len(sys.argv) > 1 else default
    lut = extract(str(path))
    for start in range(0, LUT_SIZE, 5):
        print("\t\t" + ", ".join("{%d, %d, %d}" % c for c in lut[start:start + 5]) + ",")


if __name__ == "__main__":
    main()
