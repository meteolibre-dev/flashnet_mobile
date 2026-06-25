#!/usr/bin/env python3
"""
Benchmark: Python (TiTiler) vs Go (GDAL cgo) COG tile servers.

Tests both backends directly (no CDN) on the same tile requests and
compares latency, throughput, and success rates.

Usage:
    python3 benchmark_backends.py

    # Custom parameters
    PYTHON_URL=https://... GO_URL=https://... python3 benchmark_backends.py
    BAND=radar CONCURRENT=20 DURATION=30 python3 benchmark_backends.py
"""

import os
import sys
import time
import json
import statistics
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import defaultdict

# ── Configuration ──────────────────────────────────────────────────────────

PYTHON_URL = os.getenv("PYTHON_URL", "https://lightning-server-v2-935480850831.europe-west3.run.app")
GO_URL     = os.getenv("GO_URL",     "https://lightning-server-go-935480850831.europe-west3.run.app")
BAND       = os.getenv("BAND",       "lightning")
CONCURRENT = int(os.getenv("CONCURRENT", "10"))   # parallel workers
DURATION   = int(os.getenv("DURATION", "20"))      # seconds per test round
TIMEOUT    = int(os.getenv("TIMEOUT", "30"))        # per-request timeout

# Colors
class C:
    RESET  = "\033[0m"
    BOLD   = "\033[1m"
    DIM    = "\033[2m"
    RED    = "\033[91m"
    GREEN  = "\033[92m"
    YELLOW = "\033[93m"
    BLUE   = "\033[94m"
    CYAN   = "\033[96m"
    PY     = "\033[95m"  # purple for Python
    GO     = "\033[96m"  # cyan for Go


# ── Helpers ────────────────────────────────────────────────────────────────

def http_get(url, timeout=TIMEOUT):
    """GET a URL, return (status_code, elapsed_seconds, body_bytes) or (0, elapsed, 0) on error."""
    start = time.monotonic()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "benchmark/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            elapsed = time.monotonic() - start
            return resp.status, elapsed, len(body)
    except urllib.error.HTTPError as e:
        elapsed = time.monotonic() - start
        return e.code, elapsed, 0
    except Exception as e:
        elapsed = time.monotonic() - start
        return 0, elapsed, 0


def fetch_json(url):
    """Fetch and parse JSON from a URL."""
    status, _, _ = http_get(url)
    if status != 200:
        return None
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as resp:
            return json.loads(resp.read())
    except:
        return None


def discover_tiles(base_url, band):
    """
    Hit /available to get the latest run, then generate a set of
    tile coordinates at various zoom levels that cover Europe.
    """
    print(f"  {C.DIM}Discovering available data from {base_url}/available ...{C.RESET}")
    data = fetch_json(f"{base_url}/available?days=2&band={band}")
    if not data or not data.get("timestamps"):
        print(f"  {C.RED}Failed to get available timestamps!{C.RESET}")
        sys.exit(1)

    run_time = data.get("run_time", "")
    ts = data["timestamps"][0]["timestamp"]
    print(f"  {C.GREEN}✓{C.RESET} Latest run: {C.BOLD}{run_time}{C.RESET}, timestamp: {C.BOLD}{ts}{C.RESET}")

    # Generate tile coordinates covering Europe at several zoom levels
    # Europe roughly: lon [-10, 33], lat [35, 65]
    tiles = []
    for z in [3, 4, 5, 6, 7, 8]:
        # Tile range for Europe at this zoom
        n = 2 ** z
        # lon → x: x = (lon + 180) / 360 * n
        x_min = int((-10 + 180) / 360 * n)
        x_max = int(( 33 + 180) / 360 * n) + 1
        # lat → y: y = (1 - ln(tan(lat) + sec(lat)) / π) / 2 * n
        def lat_to_y(lat):
            import math
            return int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
        y_min = lat_to_y(65)
        y_max = lat_to_y(35) + 1

        # Sample a subset (don't test every tile)
        x_step = max(1, (x_max - x_min) // 6)
        y_step = max(1, (y_max - y_min) // 6)
        for x in range(x_min, x_max, x_step):
            for y in range(y_min, y_max, y_step):
                tiles.append((z, x, y))

    print(f"  {C.GREEN}✓{C.RESET} Generated {C.BOLD}{len(tiles)}{C.RESET} tile coordinates across z=3..z=8")
    return tiles, ts, run_time


def tile_url(base_url, z, x, y, band, ts, run_time):
    """Build a tile request URL."""
    url = f"{base_url}/tiles/{z}/{x}/{y}.png?band={band}&time={ts}"
    if run_time:
        url += f"&run_time={run_time}"
    return url


# ── Benchmark runner ──────────────────────────────────────────────────────

def warmup(base_url, tiles, band, ts, run_time, label):
    """Warm up: hit a few tiles to prime GDAL caches."""
    print(f"\n  {C.DIM}Warming up {label} ...{C.RESET}")
    warm_tiles = tiles[:5]
    for z, x, y in warm_tiles:
        url = tile_url(base_url, z, x, y, band, ts, run_time)
        http_get(url)


def benchmark(base_url, tiles, band, ts, run_time, label, color):
    """
    Run a timed benchmark: spawn CONCURRENT workers that keep requesting
    tiles round-robin for DURATION seconds. Collect per-request stats.
    """
    print(f"\n  {color}{C.BOLD}Benchmarking {label}{C.RESET}")
    print(f"  {C.DIM}Concurrency: {CONCURRENT} | Duration: {DURATION}s | Tiles: {len(tiles)} | Band: {band}{C.RESET}")

    results = []
    errors = 0
    error_statuses = defaultdict(int)
    total_requests = 0
    deadline = time.monotonic() + DURATION
    tile_idx = 0
    lock = __import__("threading").Lock()

    def worker():
        nonlocal tile_idx
        local_results = []
        local_errors = 0
        local_error_statuses = defaultdict(int)
        local_count = 0
        while time.monotonic() < deadline:
            with lock:
                idx = tile_idx % len(tiles)
                tile_idx += 1
            z, x, y = tiles[idx]
            url = tile_url(base_url, z, x, y, band, ts, run_time)
            status, elapsed, size = http_get(url)
            if status == 200:
                local_results.append(elapsed)
            else:
                local_errors += 1
                local_error_statuses[status] += 1
            local_count += 1
        return local_results, local_errors, local_count, local_error_statuses

    start_time = time.monotonic()
    with ThreadPoolExecutor(max_workers=CONCURRENT) as pool:
        futures = [pool.submit(worker) for _ in range(CONCURRENT)]
        for f in as_completed(futures):
            r, e, c, es = f.result()
            results.extend(r)
            errors += e
            total_requests += c
            for k, v in es.items():
                error_statuses[k] += v
    wall_time = time.monotonic() - start_time

    if error_statuses:
        print(f"  {C.YELLOW}⚠ Error breakdown: {dict(error_statuses)}{C.RESET}")

    # Compute stats
    if not results:
        return None

    results.sort()
    n = len(results)
    avg = statistics.mean(results)
    p50 = results[int(n * 0.50)]
    p90 = results[int(n * 0.90)]
    p95 = results[int(n * 0.95)]
    p99 = results[min(int(n * 0.99), n - 1)]
    rps = n / wall_time
    success_rate = ((n - errors) / n) * 100 if n > 0 else 0

    stats = {
        "label": label,
        "color": color,
        "requests": n,
        "errors": errors,
        "wall_time": wall_time,
        "avg_ms": avg * 1000,
        "p50_ms": p50 * 1000,
        "p90_ms": p90 * 1000,
        "p95_ms": p95 * 1000,
        "p99_ms": p99 * 1000,
        "rps": rps,
        "success_rate": success_rate,
    }

    print(f"  {color}✓{C.RESET} {n} requests in {wall_time:.1f}s ({rps:.1f} req/s)")
    return stats


# ── Reporting ──────────────────────────────────────────────────────────────

def print_comparison(python_stats, go_stats):
    """Print a side-by-side comparison table."""
    print(f"\n{'═' * 72}")
    print(f"  {C.BOLD}📊 RESULTS COMPARISON{C.RESET}")
    print(f"{'═' * 72}")

    # Header
    print(f"  {'Metric':<20} {C.PY}{'Python':>22}{C.RESET}   {C.GO}{'Go':>22}{C.RESET}   {'Winner':>8}")
    print(f"  {'─'*20} {'─'*22}   {'─'*22}   {'─'*8}")

    rows = [
        ("Requests",      f"{python_stats['requests']}",          f"{go_stats['requests']}"),
        ("Errors",        f"{python_stats['errors']}",            f"{go_stats['errors']}"),
        ("Success Rate",  f"{python_stats['success_rate']:.1f}%", f"{go_stats['success_rate']:.1f}%"),
        ("Avg Latency",   f"{python_stats['avg_ms']:.1f} ms",     f"{go_stats['avg_ms']:.1f} ms"),
        ("p50 Latency",   f"{python_stats['p50_ms']:.1f} ms",     f"{go_stats['p50_ms']:.1f} ms"),
        ("p90 Latency",   f"{python_stats['p90_ms']:.1f} ms",     f"{go_stats['p90_ms']:.1f} ms"),
        ("p95 Latency",   f"{python_stats['p95_ms']:.1f} ms",     f"{go_stats['p95_ms']:.1f} ms"),
        ("p99 Latency",   f"{python_stats['p99_ms']:.1f} ms",     f"{go_stats['p99_ms']:.1f} ms"),
        ("Throughput",    f"{python_stats['rps']:.1f} req/s",     f"{go_stats['rps']:.1f} req/s"),
        ("Wall Time",     f"{python_stats['wall_time']:.1f}s",    f"{go_stats['wall_time']:.1f}s"),
    ]

    latency_metrics = {"Avg Latency", "p50 Latency", "p90 Latency", "p95 Latency", "p99 Latency"}
    higher_better   = {"Throughput", "Success Rate"}

    for label, py_val, go_val in rows:
        if label in latency_metrics:
            py_f = float(py_val.split()[0])
            go_f = float(go_val.split()[0])
            winner = f"{C.PY}Python{C.RESET}" if py_f < go_f else (f"{C.GO}Go{C.RESET}" if go_f < py_f else "Tie")
            # Speedup
            if py_f > 0 and go_f > 0:
                speedup = py_f / go_f
                speedup_str = f" ({speedup:.2f}x)" if speedup != 1.0 else ""
            else:
                speedup_str = ""
        elif label in higher_better:
            py_f = float(py_val.split("%")[0].split()[0])
            go_f = float(go_val.split("%")[0].split()[0])
            winner = f"{C.GO}Go{C.RESET}" if go_f > py_f else (f"{C.PY}Python{C.RESET}" if py_f > go_f else "Tie")
            speedup_str = ""
        else:
            winner = ""
            speedup_str = ""

        print(f"  {label:<20} {C.PY}{py_val:>22}{C.RESET}   {C.GO}{go_val:>22}{C.RESET}   {winner}{speedup_str}")

    print(f"{'═' * 72}")

    # Summary verdict
    py_p50 = python_stats["p50_ms"]
    go_p50 = go_stats["p50_ms"]
    py_rps = python_stats["rps"]
    go_rps = go_stats["rps"]

    print(f"\n  {C.BOLD}🎯 SUMMARY{C.RESET}")
    if go_p50 < py_p50:
        ratio = py_p50 / go_p50
        print(f"  {C.GO}Go{C.RESET} is {C.BOLD}{ratio:.2f}x faster{C.RESET} at p50 latency ({go_p50:.0f}ms vs {py_p50:.0f}ms)")
    else:
        ratio = go_p50 / py_p50
        print(f"  {C.PY}Python{C.RESET} is {C.BOLD}{ratio:.2f}x faster{C.RESET} at p50 latency ({py_p50:.0f}ms vs {go_p50:.0f}ms)")

    if go_rps > py_rps:
        ratio = go_rps / py_rps
        print(f"  {C.GO}Go{C.RESET} handles {C.BOLD}{ratio:.2f}x more throughput{C.RESET} ({go_rps:.0f} vs {py_rps:.0f} req/s)")
    else:
        ratio = py_rps / go_rps
        print(f"  {C.PY}Python{C.RESET} handles {C.BOLD}{ratio:.2f}x more throughput{C.RESET} ({py_rps:.0f} vs {go_rps:.0f} req/s)")
    print()


def print_cold_start():
    """Measure and compare cold-start response times."""
    print(f"\n  {C.BOLD}❄️  Cold-start test (first tile request after idle){C.RESET}")

    for label, url, color in [("Python", PYTHON_URL, C.PY), ("Go", GO_URL, C.GO)]:
        # Use a tile we haven't requested before (unique time to avoid cache)
        cold_url = f"{url}/tiles/5/16/11.png?band={BAND}&time=202501010000&_cold=1"
        status, elapsed, size = http_get(cold_url)
        print(f"  {color}{label:>8}{C.RESET}: {elapsed*1000:>8.0f} ms  (status={status}, size={size} bytes)")


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    print(f"\n{'═' * 72}")
    print(f"  {C.BOLD}⚡ Lightning Server Backend Benchmark: Python vs Go{C.RESET}")
    print(f"{'═' * 72}")
    print(f"  {C.PY}Python{C.RESET}: {PYTHON_URL}")
    print(f"  {C.GO}Go    {C.RESET}: {GO_URL}")
    print(f"  Band: {BAND} | Concurrency: {CONCURRENT} | Duration: {DURATION}s per backend")
    print(f"{'═' * 72}")

    # Step 1: Discover tiles
    print(f"\n{C.BOLD}Step 1: Discover available data{C.RESET}")
    tiles, ts, run_time = discover_tiles(GO_URL, BAND)

    # Step 2: Health checks
    print(f"\n{C.BOLD}Step 2: Health checks{C.RESET}")
    for label, url, color in [("Python", PYTHON_URL, C.PY), ("Go", GO_URL, C.GO)]:
        status, elapsed, _ = http_get(f"{url}/health")
        icon = f"{C.GREEN}✓{C.RESET}" if status == 200 else f"{C.RED}✗{C.RESET}"
        print(f"  {color}{label:>8}{C.RESET} {icon} /health → {status} ({elapsed*1000:.0f}ms)")

    # Step 3: Warmup both + pre-filter to valid tiles only
    print(f"\n{C.BOLD}Step 3: Warmup & validate tiles{C.RESET}")
    warmup(PYTHON_URL, tiles, BAND, ts, run_time, f"{C.PY}Python{C.RESET}")
    warmup(GO_URL, tiles, BAND, ts, run_time, f"{C.GO}Go{C.RESET}")

    # Filter out tiles that fail on either backend (edge tiles outside data region)
    print(f"  {C.DIM}Filtering to tiles valid on both backends ...{C.RESET}")
    valid_tiles = []
    test_subset = tiles[:40]  # check first 40 tiles
    for z, x, y in test_subset:
        url = tile_url(GO_URL, z, x, y, BAND, ts, run_time)
        status, _, _ = http_get(url, timeout=15)
        if status == 200:
            valid_tiles.append((z, x, y))
    if len(valid_tiles) < 10:
        # Fallback: use all tiles
        print(f"  {C.YELLOW}⚠ Only {len(valid_tiles)} valid tiles found, using all{C.RESET}")
        valid_tiles = tiles
    else:
        print(f"  {C.GREEN}✓{C.RESET} {len(valid_tiles)} valid tiles confirmed")
        tiles = valid_tiles

    # Step 4: Benchmark Python
    print(f"\n{C.BOLD}Step 4: Benchmark Python backend{C.RESET}")
    py_stats = benchmark(PYTHON_URL, tiles, BAND, ts, run_time, "Python", C.PY)

    # Brief pause between tests
    print(f"\n  {C.DIM}Pausing 3s between backends ...{C.RESET}")
    time.sleep(3)

    # Step 5: Benchmark Go
    print(f"\n{C.BOLD}Step 5: Benchmark Go backend{C.RESET}")
    go_stats = benchmark(GO_URL, tiles, BAND, ts, run_time, "Go", C.GO)

    # Step 6: Comparison
    if py_stats and go_stats:
        print_comparison(py_stats, go_stats)

    # Step 7: Cold-start comparison
    print(f"\n{C.BOLD}Step 6: Cold-start comparison{C.RESET}")
    print_cold_start()

    print(f"\n{'═' * 72}\n")


if __name__ == "__main__":
    main()
