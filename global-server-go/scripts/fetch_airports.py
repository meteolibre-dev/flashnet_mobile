#!/usr/bin/env python3
"""Regenerate global-server-go/data/airports.json from NOAA AWC.

Pulls the Aviation Weather Center station cache (worldwide, ~10k entries) and
keeps only stations that report METAR (icaoId set + "METAR" in siteType).
The result is embedded in the Go binary (see airports.go) and served by
GET /airports.

Usage:
    python3 scripts/fetch_airports.py [--out data/airports.json]

Requires: requests (or falls back to urllib).
"""

import argparse
import json
import sys
import urllib.request
from datetime import datetime, timezone

AWC_STATIONS_URL = "https://aviationweather.gov/data/cache/stations.cache.json"
UA = "meteolibre-global-server/1.0 (airport list generator)"


def fetch_stations() -> list:
    req = urllib.request.Request(AWC_STATIONS_URL, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.load(resp)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        default="data/airports.json",
        help="Output path (default: data/airports.json, relative to repo root)",
    )
    args = parser.parse_args()

    print(f"Fetching {AWC_STATIONS_URL} ...")
    raw = fetch_stations()
    print(f"  total stations in cache: {len(raw)}")

    airports = {}
    for s in raw:
        icao = s.get("icaoId")
        lat, lon = s.get("lat"), s.get("lon")
        if not icao or lat is None or lon is None:
            continue
        if "METAR" not in (s.get("siteType") or []):
            continue
        if not (-90 <= float(lat) <= 90 and -180 <= float(lon) <= 180):
            continue
        airports[icao] = {
            "icao": icao,
            "name": (s.get("site") or icao).strip(),
            "lat": round(float(lat), 4),
            "lon": round(float(lon), 4),
            "country": s.get("country") or "",
        }

    out = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "source": AWC_STATIONS_URL,
        "count": len(airports),
        "airports": [airports[k] for k in sorted(airports)],
    }

    with open(args.out, "w") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
    print(f"Wrote {len(airports)} METAR airports -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
