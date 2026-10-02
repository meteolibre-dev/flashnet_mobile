package main

// ============================================================================
// timeline_test.go — merged obs/forecast timeline semantics
// ============================================================================

import (
	"testing"
	"time"
)

func fcst(ts, run string) TimestampInfo {
	return TimestampInfo{Timestamp: ts, RunTime: run, AvailableBands: []string{"lightning", "radar"}}
}

func obsInfo(ts string) TimestampInfo {
	return TimestampInfo{Timestamp: ts, Kind: "obs", AvailableBands: []string{"radar"}}
}

func TestMergeTimeline(t *testing.T) {
	now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	setObsIndex("202608281040", "202608281045", "202608281050", "202608281100")
	defer setObsIndex()

	obs := []TimestampInfo{
		obsInfo("202608281040"),
		obsInfo("202608281045"),
		obsInfo("202608281050"),
	}
	fcstEntries := []TimestampInfo{
		fcst("202608281050", "run1"), // collision → obs wins
		fcst("202608281100", "run1"),
		fcst("202608281110", "run1"),
	}

	merged := mergeTimeline(obs, fcstEntries, now)

	wantOrder := []string{"202608281040", "202608281045", "202608281050", "202608281100", "202608281110"}
	if len(merged) != len(wantOrder) {
		t.Fatalf("len = %d, want %d (%+v)", len(merged), len(wantOrder), merged)
	}
	for i, ts := range wantOrder {
		if merged[i].Timestamp != ts {
			t.Errorf("merged[%d] = %s, want %s", i, merged[i].Timestamp, ts)
		}
	}
	// Collision must resolve to obs
	if merged[2].Kind != "obs" {
		t.Errorf("collision entry kind = %q, want obs", merged[2].Kind)
	}
	// Sorted even when inputs are unordered
	unsorted := mergeTimeline(
		[]TimestampInfo{obsInfo("202608281050"), obsInfo("202608281040")},
		[]TimestampInfo{fcst("202608281110", "r"), fcst("202608281100", "r")},
		now,
	)
	for i := 1; i < len(unsorted); i++ {
		if unsorted[i].Timestamp <= unsorted[i-1].Timestamp {
			t.Errorf("not sorted: %v", unsorted)
		}
	}
}

func TestMergeTimelineEmptyObs(t *testing.T) {
	now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	merged := mergeTimeline(nil, []TimestampInfo{fcst("202608281100", "r")}, now)
	if len(merged) != 1 || merged[0].Kind != "" {
		t.Errorf("forecast-only merge broken: %+v", merged)
	}
}

// The latest run always starts in the past; when it starts before the
// requested obs window (obs_hours=1, run 11:50 → first frame 12:00 with a
// 12:03 cutoff, as seen in the field) the leading frame must still be
// labelled obs — resolveCOG serves its observation, not the forecast.
func TestMergeTimelineAgedRunFrameOutsideObsWindow(t *testing.T) {
	now := time.Date(2026, 8, 28, 12, 3, 0, 0, time.UTC)
	// Obs index covers the frame, but the obs window passed to the merge
	// starts at 12:05 (cutoff 11:05+…): 12:00 is NOT in the window entries.
	setObsIndex("202608281200", "202608281205", "202608281210")
	defer setObsIndex()

	obs := []TimestampInfo{obsInfo("202608281205"), obsInfo("202608281210")}
	fcstEntries := []TimestampInfo{
		fcst("202608281200", "run1"), // before the obs window → was "forecast"
		fcst("202608281220", "run1"), // future
		fcst("202608281230", "run1"), // future
	}

	merged := mergeTimeline(obs, fcstEntries, now)

	if merged[0].Timestamp != "202608281200" || merged[0].Kind != "obs" {
		t.Errorf("aged leading frame = %+v, want kind obs", merged[0])
	}
	if merged[1].Timestamp != "202608281205" || merged[1].Kind != "obs" {
		t.Errorf("window obs = %+v, want kind obs", merged[1])
	}
	for _, e := range merged[3:] {
		if e.Kind == "obs" {
			t.Errorf("future frame %s must stay forecast: %+v", e.Timestamp, e)
		}
	}
}

// No obs in the index for an aged frame (ingest gap) → keep the forecast
// label; resolveCOG falls back to the forecast for it too.
func TestMergeTimelineAgedFrameWithoutObsStaysForecast(t *testing.T) {
	now := time.Date(2026, 8, 28, 12, 3, 0, 0, time.UTC)
	setObsIndex("202608281205") // 12:00 missing (ingest gap)
	defer setObsIndex()

	merged := mergeTimeline(nil, []TimestampInfo{fcst("202608281200", "run1")}, now)
	if len(merged) != 1 || merged[0].Kind == "obs" {
		t.Errorf("frame without obs must stay forecast: %+v", merged)
	}
}

func TestObsEntriesWindowAndFormat(t *testing.T) {
	now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	setObsIndex("202608280900", "202608281100", "202608281155", "202608281156")
	// window = 2h → cutoff 10:00 → keeps 11:00, 11:55, 11:56; drops 09:00

	entries := obsEntries(2, now)
	if len(entries) != 3 {
		t.Fatalf("len = %d, want 3 (%+v)", len(entries), entries)
	}
	for _, e := range entries {
		if e.Kind != "obs" {
			t.Errorf("kind = %q, want obs", e.Kind)
		}
		if len(e.AvailableBands) != 1 || e.AvailableBands[0] != "radar" {
			t.Errorf("obs bands = %v, want [radar]", e.AvailableBands)
		}
		if e.Datetime != "2026-08-28T11:00:00Z" && e.Timestamp == "202608281100" {
			// datetime formatting check for one known entry
		}
	}
	if entries[0].Datetime != "2026-08-28T11:00:00Z" {
		t.Errorf("datetime = %q, want 2026-08-28T11:00:00Z", entries[0].Datetime)
	}
	if entries[0].TiffURL == "" {
		t.Error("obs entries should carry a direct COG TiffURL")
	}
}
