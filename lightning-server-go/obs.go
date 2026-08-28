package main

// ============================================================================
// obs.go — Observed-radar (OPERA) source: manifest index + source resolver
//
// The 5-min ingest job (meteolibre_datasetgen/src/eumetnet/radar_obs_ingest.py)
// publishes true radar COGs next to the forecasts:
//
//   gs://<bucket>/observations/{YYYY-MM-DD}/obs_{YYYYMMDDHHMM}_radar.tiff
//   gs://<bucket>/observations/latest.json      (manifest, refreshed per run)
//
// The manifest is mirrored into an in-memory index (refreshed every
// ObsRefreshInterval) and used by resolveCOG to serve observed frames for
// radar timestamps that have aged into the past, falling back to the latest
// forecast otherwise. Everything is backward compatible: clients that pass
// the latest run's run_time (as the current apps do) or no run_time at all
// get the live view (obs-first); explicit historical run_times are served
// exactly as requested.
// ============================================================================

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// obsManifest mirrors observations/latest.json written by the ingest job.
type obsManifest struct {
	UpdatedAt      string   `json:"updated_at"`
	LatestTS       string   `json:"latest_ts"`
	LatestDatetime string   `json:"latest_datetime"`
	Count          int      `json:"count"`
	Timestamps     []string `json:"timestamps"`
}

// obsIndex is the in-memory mirror of the manifest.
var obsIndex struct {
	sync.RWMutex
	available map[string]bool
	latest    string
	updatedAt string
	lastErr   string
	loaded    bool
}

// latestRunTracker remembers the newest forecast run subfolder discovered by
// /available. Tile requests carrying this run_time (or none) are "live view".
var latestRunTracker struct {
	sync.RWMutex
	sub string
}

func setLatestRun(sub string) {
	if sub == "" {
		return
	}
	latestRunTracker.Lock()
	latestRunTracker.sub = sub
	latestRunTracker.Unlock()
}

func latestRun() string {
	latestRunTracker.RLock()
	defer latestRunTracker.RUnlock()
	return latestRunTracker.sub
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

func obsManifestPath() string { return ObsPrefix + "/latest.json" }

// obsBlobPath: ts "YYYYMMDDHHMM" → "observations/YYYY-MM-DD/obs_..._radar.tiff"
func obsBlobPath(ts string) string {
	date := ts[:4] + "-" + ts[4:6] + "-" + ts[6:8]
	return fmt.Sprintf("%s/%s/obs_%s_radar.tiff", ObsPrefix, date, ts)
}

func obsURL(ts string) string {
	return "/vsigs/" + getBucketName() + "/" + obsBlobPath(ts)
}

// ---------------------------------------------------------------------------
// Manifest fetching / index maintenance
// ---------------------------------------------------------------------------

func fetchObsManifest() error {
	svc := getGCSService()
	resp, err := svc.Objects.Get(getBucketName(), obsManifestPath()).Download()
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20)) // 1 MiB cap
	if err != nil {
		return err
	}

	var m obsManifest
	if err := json.Unmarshal(body, &m); err != nil {
		return err
	}

	avail := make(map[string]bool, len(m.Timestamps))
	for _, ts := range m.Timestamps {
		avail[ts] = true
	}

	obsIndex.Lock()
	obsIndex.available = avail
	obsIndex.latest = m.LatestTS
	obsIndex.updatedAt = m.UpdatedAt
	obsIndex.lastErr = ""
	obsIndex.loaded = true
	obsIndex.Unlock()

	log.Printf("[OBS] index refreshed: %d timestamps, latest=%s (manifest updated %s)",
		len(m.Timestamps), m.LatestTS, m.UpdatedAt)
	return nil
}

// startObsIndexRefresher launches the background manifest refresh loop.
// Failures are non-fatal: the previous index stays in use and the server
// degrades to forecast-only serving.
func startObsIndexRefresher() {
	go func() {
		if err := fetchObsManifest(); err != nil {
			obsIndex.Lock()
			obsIndex.lastErr = err.Error()
			obsIndex.Unlock()
			log.Printf("[OBS] initial manifest load failed: %v (retrying every %s; serving forecast-only)",
				err, ObsRefreshInterval)
		}
		ticker := time.NewTicker(ObsRefreshInterval)
		defer ticker.Stop()
		for range ticker.C {
			if err := fetchObsManifest(); err != nil {
				obsIndex.Lock()
				obsIndex.lastErr = err.Error()
				obsIndex.Unlock()
				log.Printf("[OBS] manifest refresh failed: %v (keeping previous index)", err)
			}
		}
	}()
}

func obsAvailable(ts string) bool {
	obsIndex.RLock()
	defer obsIndex.RUnlock()
	return obsIndex.available[ts]
}

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

type resolvedCOG struct {
	URL    string // /vsigs/... URL to read
	Source string // "obs" | "forecast" — used for cache keying + X-Source header
}

// resolveCOG is the single decision point for which COG backs a request.
//
// sourceParam: "" / "auto" (default) | "obs" | "forecast" (force, for
// debugging or power users).
//
// Auto rules:
//   - band != radar                       → forecast (obs only exists for radar)
//   - explicit historical run_time        → forecast (exact replay, no hijack)
//   - live view (no run_time, or the
//     latest run from /available) and the
//     timestamp exists in the obs index    → obs (truth wins over prediction)
//   - otherwise                           → forecast (latest run)
//
// The obs-index check is an in-memory map lookup — no GCS round trip on the
// hot path. When the manifest is at most ObsRefreshInterval stale, a
// brand-new frame may briefly fall back to forecast until the next refresh.
func resolveCOG(timestamp, band, runTime, sourceParam string) resolvedCOG {
	sp := strings.ToLower(strings.TrimSpace(sourceParam))

	if sp == "obs" {
		return resolvedCOG{URL: obsURL(timestamp), Source: "obs"}
	}
	if sp == "forecast" || sp == "fcst" {
		return resolvedCOG{URL: getCOGUrl(timestamp, band, runTime), Source: "forecast"}
	}

	isLiveView := runTime == "" || runTime == latestRun()
	if band == "radar" && isLiveView && obsAvailable(timestamp) {
		return resolvedCOG{URL: obsURL(timestamp), Source: "obs"}
	}
	return resolvedCOG{URL: getCOGUrl(timestamp, band, runTime), Source: "forecast"}
}

// verifyObsReady checks that the obs COG for a timestamp exists with a sane size.
func verifyObsReady(ts string) bool {
	svc := getGCSService()
	obj, err := svc.Objects.Get(getBucketName(), obsBlobPath(ts)).Do()
	if err == nil && obj.Size >= 1000 {
		return true
	}
	return false
}

// withLatestObs prepends the latest observation to an /available result (or
// marks the matching run frame as obs), so /available clients get truth at
// "now" followed by the forecast frames: [latest obs, fcst T+10 ... T+180].
// Observations are radar-only; the tile resolver serves observed tiles for
// kind:"obs" timestamps automatically. No-op when the obs index is empty
// (ingest down) — /available then behaves exactly as before.
func withLatestObs(result []TimestampInfo) []TimestampInfo {
	obsIndex.RLock()
	obsTS := obsIndex.latest
	obsIndex.RUnlock()
	if obsTS == "" {
		return result
	}

	for i := range result {
		if result[i].Timestamp == obsTS {
			// Aged forecast frame that now has an observation → the resolver
			// already serves obs for it; flag it so clients label it correctly.
			result[i].Kind = "obs"
			return result
		}
	}

	dt, err := parseTimestamp(obsTS)
	if err != nil {
		return result
	}
	result = append(result, TimestampInfo{
		Timestamp:      obsTS,
		Datetime:       dt.UTC().Format("2006-01-02T15:04:05Z"),
		AvailableBands: []string{"radar"},
		Kind:           "obs",
		TiffURL: fmt.Sprintf("https://storage.googleapis.com/%s/%s",
			getBucketName(), obsBlobPath(obsTS)),
	})
	sort.Slice(result, func(i, j int) bool { return result[i].Timestamp < result[j].Timestamp })
	return result
}

// ---------------------------------------------------------------------------
// /obs/status — ops/debug endpoint
// ---------------------------------------------------------------------------

func handleObsStatus(w http.ResponseWriter, r *http.Request) {
	setNoStore(w)
	obsIndex.RLock()
	defer obsIndex.RUnlock()
	count := 0
	if obsIndex.available != nil {
		count = len(obsIndex.available)
	}
	writeJSON(w, 200, map[string]interface{}{
		"loaded":               obsIndex.loaded,
		"latest_obs_ts":        obsIndex.latest,
		"count":                count,
		"manifest_updated_at":  obsIndex.updatedAt,
		"last_error":           obsIndex.lastErr,
		"refresh_interval_sec": int(ObsRefreshInterval.Seconds()),
		"latest_forecast_run":  latestRun(),
	})
}
