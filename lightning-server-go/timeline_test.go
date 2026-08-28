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

	merged := mergeTimeline(obs, fcstEntries)

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
	)
	for i := 1; i < len(unsorted); i++ {
		if unsorted[i].Timestamp <= unsorted[i-1].Timestamp {
			t.Errorf("not sorted: %v", unsorted)
		}
	}
}

func TestMergeTimelineEmptyObs(t *testing.T) {
	merged := mergeTimeline(nil, []TimestampInfo{fcst("202608281100", "r")})
	if len(merged) != 1 || merged[0].Kind != "" {
		t.Errorf("forecast-only merge broken: %+v", merged)
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
