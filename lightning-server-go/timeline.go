package main

// ============================================================================
// timeline.go — Merged observed + forecast timeline (discovery for the scrubber)
//
//   GET /timeline?days=2&obs_hours=3
//
// Returns a single, chronologically sorted list of timesteps for the app's
// scrubber: past = observed radar (truth, 5-min cadence), future = latest
// model run (10-min cadence). When a timestamp exists in both (a forecast
// frame that has aged into the past), the observation wins — exactly what
// the tile resolver (obs.go) serves, so the timeline and the tiles never
// disagree.
// ============================================================================

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"time"
)

// TimelineResponse is the /timeline payload.
type TimelineResponse struct {
	Timestamps        []TimestampInfo `json:"timestamps"`
	Count             int             `json:"count"`
	RunTime           string          `json:"run_time,omitempty"`      // latest forecast run
	LatestObsTS       string          `json:"latest_obs_ts,omitempty"` // newest observed frame
	LatestObsDatetime string          `json:"latest_obs_datetime,omitempty"`
}

// obsEntries returns timeline entries for observed frames newer than
// now-obsHours, read from the in-memory manifest index (no GCS calls).
func obsEntries(obsHours int, now time.Time) []TimestampInfo {
	cutoff := now.Add(-time.Duration(obsHours) * time.Hour).UTC().Format("200601021504")

	obsIndex.RLock()
	defer obsIndex.RUnlock()

	var out []TimestampInfo
	for ts := range obsIndex.available {
		if ts < cutoff {
			continue
		}
		dt, err := parseTimestamp(ts)
		if err != nil {
			continue
		}
		out = append(out, TimestampInfo{
			Timestamp:      ts,
			Datetime:       dt.UTC().Format("2006-01-02T15:04:05Z"),
			AvailableBands: []string{"radar"}, // observations exist only for radar
			Kind:           "obs",
			TiffURL: fmt.Sprintf("https://storage.googleapis.com/%s/%s",
				getBucketName(), obsBlobPath(ts)),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Timestamp < out[j].Timestamp })
	return out
}

// mergeTimeline merges observed and forecast entries chronologically.
// Observations win on timestamp collisions (truth over prediction —
// consistent with resolveCOG).
func mergeTimeline(obs, fcst []TimestampInfo) []TimestampInfo {
	obsSet := make(map[string]bool, len(obs))
	for _, e := range obs {
		obsSet[e.Timestamp] = true
	}

	merged := make([]TimestampInfo, 0, len(obs)+len(fcst))
	merged = append(merged, obs...)
	for _, e := range fcst {
		if obsSet[e.Timestamp] {
			continue // obs already covers this timestamp
		}
		merged = append(merged, e)
	}
	sort.Slice(merged, func(i, j int) bool { return merged[i].Timestamp < merged[j].Timestamp })
	return merged
}

// buildTimeline assembles the full response: latest forecast run scan +
// in-memory obs index.
func buildTimeline(ctx context.Context, days, obsHours int) (*TimelineResponse, error) {
	fcst, err := handleAvailable(ctx, days, "any")
	if err != nil {
		return nil, err
	}

	fcstEntries := fcst.Timestamps
	for i := range fcstEntries {
		fcstEntries[i].Kind = "forecast"
	}

	obs := obsEntries(obsHours, time.Now().UTC())
	merged := mergeTimeline(obs, fcstEntries)

	resp := &TimelineResponse{
		Timestamps: merged,
		Count:      len(merged),
		RunTime:    fcst.RunTime,
	}
	obsIndex.RLock()
	resp.LatestObsTS = obsIndex.latest
	obsIndex.RUnlock()
	if resp.LatestObsTS != "" {
		if dt, err := parseTimestamp(resp.LatestObsTS); err == nil {
			resp.LatestObsDatetime = dt.UTC().Format("2006-01-02T15:04:05Z")
		}
	}
	return resp, nil
}

// handleTimelineHTTP — GET /timeline
func handleTimelineHTTP(w http.ResponseWriter, r *http.Request) {
	setCacheHeaders(w, 60)
	days := clampInt(queryInt(r, "days", 2), 1, 7)
	obsHours := clampInt(queryInt(r, "obs_hours", 3), 1, 48)

	resp, err := buildTimeline(r.Context(), days, obsHours)
	if err != nil {
		writeError(w, 500, fmt.Sprintf("Error building timeline: %s", err))
		return
	}
	writeJSON(w, 200, resp)
}
