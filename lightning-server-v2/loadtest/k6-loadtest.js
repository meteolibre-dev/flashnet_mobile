/**
 * k6 load test for lightning-server-v2 served through Cloud CDN
 * (https://tiles.meteolibre.dev).
 *
 * Models a real viral scenario: a weather article on a top French news site.
 * Thousands of viewers load the France map, pan/zoom a bit, and scrub the
 * forecast timeline. Most of them hit the SAME tiles → the CDN should absorb
 * the burst and your Cloud Run origin should stay nearly idle.
 *
 * ── Quick start ───────────────────────────────────────────────────────────
 *   # smoke test (1 VU, sanity check that URLs work + cache warms)
 *   PROFILE=smoke k6 run k6-loadtest.js
 *
 *   # realistic + viral spike (the main test — ~7 min)
 *   k6 run k6-loadtest.js
 *
 *   # worst-case: every request a unique tile (origin stress, cache buster)
 *   PROFILE=stress k6 run k6-loadtest.js
 *
 *   # point at a different origin (e.g. raw Cloud Run, to compare CDN vs no-CDN)
 *   BASE_URL=https://lightning-server-v2-935480850831.europe-west3.run.app k6 run k6-loadtest.js
 *
 *   # knobs
 *   BAND=radar k6 run k6-loadtest.js
 * ──────────────────────────────────────────────────────────────────────────
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';

// ─── Config (all overridable via env) ─────────────────────────────────────
const BASE = __ENV.BASE_URL || 'https://tiles.meteolibre.dev';
const BAND = __ENV.BAND || 'lightning';
const PROFILE = __ENV.PROFILE || 'realistic';

// ─── Custom metrics (show up in the k6 summary) ───────────────────────────
const cacheHits = new Counter('cdn_cache_hits');
const cacheMisses = new Counter('cdn_cache_misses');
const cacheHitRate = new Rate('cdn_cache_hit_rate');     // 1 if response served from edge
const tileDuration = new Trend('tile_duration_ms', true); // isolated tile latency

// ─── Web Mercator tile math ───────────────────────────────────────────────
function lonLatToTile(lon, lat, z) {
  const n = Math.pow(2, z);
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)), z };
}

/** All tiles in a (2*radius+1)² viewport centered on lon/lat. */
function viewportTiles(lon, lat, z, radius) {
  const c = lonLatToTile(lon, lat, z);
  const tiles = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      const n = Math.pow(2, z);
      tiles.push({
        x: Math.max(0, Math.min(n - 1, c.x + dx)),
        y: Math.max(0, Math.min(n - 1, c.y + dy)),
        z,
      });
    }
  }
  return tiles;
}

const rnd = (min, max) => min + Math.random() * (max - min);

// French cities — realistic geographic spread for an actu.fr weather article.
// Users cluster on a few cities → tiles overlap heavily → ideal CDN case.
const FRENCH_CITIES = [
  { name: 'Paris', lon: 2.35, lat: 48.86 },
  { name: 'Marseille', lon: 5.37, lat: 43.3 },
  { name: 'Lyon', lon: 4.83, lat: 45.76 },
  { name: 'Toulouse', lon: 1.44, lat: 43.6 },
  { name: 'Nice', lon: 7.26, lat: 43.7 },
  { name: 'Nantes', lon: -1.55, lat: 47.22 },
  { name: 'Bordeaux', lon: -0.58, lat: 44.84 },
  { name: 'Lille', lon: 3.06, lat: 50.63 },
  { name: 'Strasbourg', lon: 7.75, lat: 48.58 },
  { name: 'Rennes', lon: -1.68, lat: 48.11 },
];

// Full data region (matches server REGION) — used for the stress/cold profile.
const REGION = { west: -10, east: 33, south: 33, north: 65 };

// ─── setup(): run once, shared with all VUs ───────────────────────────────
// Discover real timestamps + run_time so we don't hardcode (and 404).
export function setup() {
  console.log(`k6: probing ${BASE}/available?days=2&band=${BAND} ...`);
  const res = http.get(`${BASE}/available?days=2&band=${BAND}`, { tags: { type: 'meta' } });

  if (res.status !== 200) {
    console.error(
      `✗ /available returned ${res.status} — check BASE_URL ('${BASE}') and that ` +
      `a recent forecast run exists. Aborting.`
    );
    return { timestamps: [] };
  }

  const body = JSON.parse(res.body);
  const timestamps = (body.timestamps || [])
    .filter((t) => t.run_time)            // need run_time for a stable cache key
    .map((t) => ({ timestamp: t.timestamp, run_time: t.run_time }));

  console.log(
    `k6: ${timestamps.length} timesteps found. ` +
    `Latest run_time=${timestamps[0] && timestamps[0].run_time}`
  );
  return { timestamps };
}

// ─── Per-tile fetch + cache-hit tracking ──────────────────────────────────
// Cloud CDN sets an `Age` header only when it serves the object from the edge.
// Origin responses (cache MISS) carry no Age → presence == edge HIT.
function fetchTile(url) {
  const res = http.get(url, { tags: { type: 'tile' }, responseType: 'binary' });

  const isHit = res.headers['Age'] !== undefined && res.headers['Age'] !== null;
  if (isHit) {
    cacheHits.add(1);
    cacheHitRate.add(1);
  } else {
    cacheMisses.add(1);
    cacheHitRate.add(0);
  }

  tileDuration.add(res.timings.duration);

  check(res, {
    'tile status 200': (r) => r.status === 200,
    'tile is png': (r) =>
      (r.headers['Content-Type'] || '').includes('image/png') ||
      (r.headers['content-type'] || '').includes('image/png'),
  });
}

function tileUrl(t, ts) {
  return `${BASE}/tiles/${t.z}/${t.x}/${t.y}.png?band=${BAND}` +
    `&time=${ts.timestamp}&run_time=${ts.run_time}`;
}

// ─── Scenario A: realistic viral user (default) ───────────────────────────
// One "session" = a page view + maybe a timeline scrub. ~14–26 requests over
// ~10–18s. This is what a real actu.fr reader does.
export function realisticUser(data) {
  const ts = data.timestamps;
  if (!ts || ts.length === 0) { sleep(5); return; }

  const city = FRENCH_CITIES[Math.floor(Math.random() * FRENCH_CITIES.length)];
  const zoom = 5 + Math.floor(Math.random() * 3);   // z5 / z6 / z7
  const tiles = viewportTiles(city.lon, city.lat, zoom, 1); // 3×3 = 9 tiles

  // Most users look at "now" or the next few steps.
  const idx = Math.floor(Math.random() * Math.min(ts.length, 6));
  const step = ts[idx];

  // 1. metadata (heavily cached at the edge)
  http.get(`${BASE}/available?days=2&band=${BAND}`, { tags: { type: 'meta' } });
  http.get(`${BASE}/bounds?band=${BAND}&time=${step.timestamp}&run_time=${step.run_time}`, {
    tags: { type: 'meta' },
  });

  // 2. render the viewport
  for (const t of tiles) fetchTile(tileUrl(t, step));

  // 3. user looks at the map
  sleep(rnd(2, 6));

  // 4. ~40% scrub forward one timestep (common in your player)
  if (Math.random() < 0.4) {
    const next = ts[Math.min(idx + 1, ts.length - 1)];
    for (const t of tiles) fetchTile(tileUrl(t, next));
    sleep(rnd(2, 5));
  }
}

// ─── Scenario B: cache-buster / origin stress ─────────────────────────────
// Every request targets a random European tile at a random timestep → minimal
// overlap → mostly origin misses. This answers "how does the ORIGIN hold up
// if the CDN weren't there?" Lower the VU count: each tile is a cold decode.
export function stressBuster(data) {
  const ts = data.timestamps;
  if (!ts || ts.length === 0) { sleep(5); return; }

  const lon = rnd(REGION.west, REGION.east);
  const lat = rnd(REGION.south, REGION.north);
  const z = 4 + Math.floor(Math.random() * 5); // z4–z8
  const step = ts[Math.floor(Math.random() * ts.length)];
  const tiles = viewportTiles(lon, lat, z, 1);

  for (const t of tiles) fetchTile(tileUrl(t, step));
  sleep(rnd(0.2, 1)); // aggressive — no "viewing" pause
}

// ─── Scenario dispatch ────────────────────────────────────────────────────
export default function (data) {
  if (PROFILE === 'stress') {
    stressBuster(data);
  } else {
    realisticUser(data);
  }
}

// ─── Options: profile-based scenarios + thresholds ────────────────────────
function buildOptions() {
  // ─── Thresholds ───────────────────────────────────────────────────────
  // Smoke = "does it run without errors" (cache can't be warm with 1 VU).
  // Realistic/stress = full SLA gates. Tile p95 of 1000ms deliberately
  // accommodates one-time cold fills (a unique tile's first fetch from the
  // origin) — once cached, repeats are <100ms. The CDN health gate is the
  // cache hit rate.
  const smokeThresholds = {
    'http_req_failed': ['rate<0.01'],
  };
  const fullThresholds = {
    'http_req_failed': ['rate<0.01'],                       // <1% non-2xx/timeout
    'http_req_duration{type:tile}': ['p(95)<1000', 'p(99)<2000'],
    'http_req_duration{type:meta}': ['p(95)<300'],
    // CDN hit rate over the whole run (cold fills at the start drag it down).
    // 0.80 = the clear majority served from the edge = origin protected.
    'cdn_cache_hit_rate': ['rate>0.80'],
  };

  if (PROFILE === 'smoke') {
    return {
      scenarios: {
        smoke: {
          executor: 'constant-vus', exec: 'realisticUser',
          vus: 1, duration: '30s',
        },
      },
      thresholds: smokeThresholds,
    };
  }

  if (PROFILE === 'stress') {
    return {
      scenarios: {
        stress: {
          executor: 'ramping-vus', exec: 'stressBuster',
          startVUs: 0,
          stages: [
            { duration: '20s', target: 50 },
            { duration: '1m', target: 50 },
            { duration: '20s', target: 150 },
            { duration: '1m', target: 150 },
            { duration: '20s', target: 0 },
          ],
          gracefulRampDown: '15s',
        },
      },
      thresholds: fullThresholds,
    };
  }

  // default: realistic viral-spike scenario
  return {
    scenarios: {
      viral: {
        executor: 'ramping-vus', exec: 'realisticUser',
        startVUs: 0,
        stages: [
          { duration: '30s', target: 50 },     // warm up + warm CDN
          { duration: '1m', target: 50 },      // normal traffic
          { duration: '30s', target: 300 },    // article goes viral
          { duration: '2m', target: 300 },     // hold the spike
          { duration: '30s', target: 1000 },   // homepage-feature surge
          { duration: '2m', target: 1000 },    // hold the surge
          { duration: '30s', target: 0 },      // cool down
        ],
        gracefulRampDown: '15s',
      },
    },
    thresholds: fullThresholds,
  };
}

export const options = buildOptions();

// ─── Save machine-readable results alongside the printed summary ──────────
export function handleSummary(data) {
  return {
    'loadtest-results.json': JSON.stringify(data, null, 2), // written next to the script
  };
}
