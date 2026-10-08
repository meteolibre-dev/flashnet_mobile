#!/usr/bin/env python3
"""
Local end-to-end benchmark for a single Lightning Server Go instance.

Two phases:
  A) WARM  — same small tile set repeatedly → measures LRU cache-hit path
  B) COLD  — every request uses a different timestamp → measures the full
             miss path (GDAL read from GCS + render + PNG encode + cache fill)

Usage:
    python3 bench_local.py [--url http://localhost:3101] [--band radar]
                           [--concurrent 8] [--duration 15] [--phase both]
"""

import argparse
import json
import math
import statistics
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

def http_get(url, timeout=30):
    start = time.monotonic()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "bench-local/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            return resp.status, time.monotonic() - start, len(body), resp.headers.get("X-Cache", "")
    except Exception:
        return 0, time.monotonic() - start, 0, ""

def fetch_json(url):
    status, _, _, _ = http_get(url)
    if status != 200:
        return None
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            return json.loads(resp.read())
    except Exception:
        return None

def discover(base, band):
    data = fetch_json(f"{base}/available?days=2&band={band}")
    if not data or not data.get("timestamps"):
        print("FATAL: /available failed", file=sys.stderr)
        sys.exit(1)
    run_time = data.get("run_time", "")
    stamps = [t["timestamp"] for t in data["timestamps"]]
    print(f"  run={run_time}  timestamps={len(stamps)}  latest={stamps[0]}")
    return run_time, stamps

def gen_tiles():
    tiles = []
    for z in [3, 4, 5, 6, 7, 8]:
        n = 2 ** z
        x_min = int((-10 + 180) / 360 * n)
        x_max = int((33 + 180) / 360 * n) + 1
        def lat_to_y(lat):
            return int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
        y_min, y_max = lat_to_y(65), lat_to_y(35) + 1
        xs = max(1, (x_max - x_min) // 6)
        ys = max(1, (y_max - y_min) // 6)
        for x in range(x_min, x_max, xs):
            for y in range(y_min, y_max, ys):
                tiles.append((z, x, y))
    return tiles

def tile_url(base, z, x, y, band, ts, run_time):
    u = f"{base}/tiles/{z}/{x}/{y}.png?band={band}&time={ts}"
    if run_time:
        u += f"&run_time={run_time}"
    return u

def run_round(base, tiles, band, run_time, stamps, fixed_ts, concurrent, duration, label):
    """If stamps is None → warm phase (fixed timestamp); else cold (cycling timestamps)."""
    print(f"\n── {label}: workers={concurrent} duration={duration}s tiles={len(tiles)}")
    results, errors, xcache = [], 0, {"HIT": 0, "MISS": 0}
    idx, lock = 0, threading.Lock()
    deadline = time.monotonic() + duration

    def worker(_=None):
        nonlocal idx, errors
        local, lerr = [], 0
        while time.monotonic() < deadline:
            with lock:
                i = idx
                idx += 1
            z, x, y = tiles[i % len(tiles)]
            ts = fixed_ts if stamps is None else stamps[(i // len(tiles)) % len(stamps)]
            status, elapsed, _, xc = http_get(tile_url(base, z, x, y, band, ts, run_time))
            if status == 200:
                local.append(elapsed)
                if xc in ("HIT", "MISS"):
                    xcache[xc] += 1
            else:
                lerr += 1
        return local, lerr

    start = time.monotonic()
    with ThreadPoolExecutor(max_workers=concurrent) as pool:
        for local, lerr in [f.result() for f in [pool.submit(worker) for _ in range(concurrent)]]:
            results.extend(local)
            errors += lerr
    wall = time.monotonic() - start

    if not results:
        print("  no successful requests!")
        return None
    results.sort()
    n = len(results)
    stats = dict(
        label=label, n=n, errors=errors, wall=wall,
        avg_ms=statistics.mean(results) * 1000,
        p50_ms=results[int(n * 0.50)] * 1000,
        p90_ms=results[int(n * 0.90)] * 1000,
        p99_ms=results[min(int(n * 0.99), n - 1)] * 1000,
        rps=n / wall, hits=xcache["HIT"], misses=xcache["MISS"],
    )
    print(f"  {n} ok / {errors} err | {stats['rps']:.1f} req/s | "
          f"avg {stats['avg_ms']:.1f}ms p50 {stats['p50_ms']:.1f}ms "
          f"p90 {stats['p90_ms']:.1f}ms p99 {stats['p99_ms']:.1f}ms | "
          f"cache HIT {stats['hits']} MISS {stats['misses']}")
    return stats

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:3101")
    ap.add_argument("--band", default="radar")
    ap.add_argument("--concurrent", type=int, default=8)
    ap.add_argument("--duration", type=int, default=15)
    ap.add_argument("--phase", choices=["both", "warm", "cold"], default="both")
    args = ap.parse_args()

    print(f"Local benchmark → {args.url} band={args.band}")
    run_time, stamps = discover(args.url, args.band)
    tiles = gen_tiles()
    print(f"  {len(tiles)} tile coords (z3–z8)")

    # validate a subset
    valid = []
    for z, x, y in tiles[:40]:
        s, _, _, _ = http_get(tile_url(args.url, z, x, y, args.band, stamps[0], run_time), timeout=15)
        if s == 200:
            valid.append((z, x, y))
    if len(valid) >= 10:
        tiles = valid
    print(f"  {len(tiles)} validated tiles")

    out = []
    if args.phase in ("both", "warm"):
        out.append(run_round(args.url, tiles, args.band, run_time, None, stamps[0],
                              args.concurrent, args.duration, "WARM (cache hits)"))
    if args.phase in ("both", "cold"):
        out.append(run_round(args.url, tiles, args.band, run_time, stamps, stamps[0],
                              args.concurrent, args.duration, "COLD (unique timestamps)"))
    print("\nJSON:", json.dumps(out))

if __name__ == "__main__":
    main()
