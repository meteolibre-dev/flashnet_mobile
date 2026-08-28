package main

// ============================================================================
// obs_test.go — resolver + cache semantics for the observed-radar source
// ============================================================================

import (
	"encoding/json"
	"strings"
	"testing"
)

func setObsIndex(ts ...string) {
	m := make(map[string]bool, len(ts))
	for _, t := range ts {
		m[t] = true
	}
	obsIndex.Lock()
	obsIndex.available = m
	obsIndex.Unlock()
}

func TestResolveCOG(t *testing.T) {
	const ts = "202608281145"
	setLatestRun("2026-08-28_11-35_europe")

	cases := []struct {
		name       string
		band       string
		runTime    string
		source     string
		obsTs      []string
		wantSource string
	}{
		{"auto, no run_time, obs hit", "radar", "", "auto", []string{ts}, "obs"},
		{"auto, no run_time, obs miss", "radar", "", "auto", nil, "forecast"},
		{"auto, latest run (app compat), obs hit", "radar", "2026-08-28_11-35_europe", "", []string{ts}, "obs"},
		{"auto, old run (replay), obs hit → must stay forecast", "radar", "2026-08-20_15-20_europe", "", []string{ts}, "forecast"},
		{"forced obs", "radar", "", "obs", nil, "obs"},
		{"forced forecast despite obs", "radar", "", "forecast", []string{ts}, "forecast"},
		{"non-radar band never resolves obs", "lightning", "", "", []string{ts}, "forecast"},
		{"sat band, latest run, obs ts (no effect)", "sat_ch0", "2026-08-28_11-35_europe", "", []string{ts}, "forecast"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setObsIndex(tc.obsTs...)
			got := resolveCOG(ts, tc.band, tc.runTime, tc.source)
			if got.Source != tc.wantSource {
				t.Errorf("source = %q, want %q", got.Source, tc.wantSource)
			}
			if tc.wantSource == "obs" && !strings.Contains(got.URL, "/observations/") {
				t.Errorf("obs URL = %q, want observations path", got.URL)
			}
			if tc.wantSource == "obs" && !strings.Contains(got.URL, "obs_"+ts+"_radar.tiff") {
				t.Errorf("obs URL = %q, missing obs blob name", got.URL)
			}
			if tc.wantSource == "forecast" && strings.Contains(got.URL, "/observations/") {
				t.Errorf("forecast URL = %q, must not use observations path", got.URL)
			}
		})
	}
}

func TestObsPaths(t *testing.T) {
	got := obsBlobPath("202608281145")
	want := "observations/2026-08-28/obs_202608281145_radar.tiff"
	if got != want {
		t.Errorf("obsBlobPath = %q, want %q", got, want)
	}
	if !strings.HasPrefix(obsURL("202608281145"), "/vsigs/") {
		t.Errorf("obsURL should be a /vsigs/ URL, got %q", obsURL("202608281145"))
	}
}

func TestManifestParsing(t *testing.T) {
	// Simulate what fetchObsManifest does with a real manifest body
	body := `{"updated_at":"2026-08-28T11:47:12Z","latest_ts":"202608281145",
	          "latest_datetime":"2026-08-28T11:45:00Z","count":2,
	          "timestamps":["202608281140","202608281145"]}`
	var m obsManifest
	if err := jsonUnmarshal(body, &m); err != nil {
		t.Fatal(err)
	}
	if m.LatestTS != "202608281145" || len(m.Timestamps) != 2 {
		t.Errorf("unexpected manifest: %+v", m)
	}
}

func TestInvalidateRunKeepsObs(t *testing.T) {
	cache := NewLRUCache(10)
	fcstKey := CacheKey{Z: 6, X: 1, Y: 2, Band: "radar", Time: "202608281100", RunTime: "old_run", Source: "forecast"}
	obsKey := CacheKey{Z: 6, X: 1, Y: 2, Band: "radar", Time: "202608281100", RunTime: "old_run", Source: "obs"}

	cache.Put(fcstKey, []byte("f"))
	cache.Put(obsKey, []byte("o"))

	removed := cache.InvalidateRun("new_run")

	if removed != 1 {
		t.Errorf("removed = %d, want 1 (only the forecast entry)", removed)
	}
	if _, ok := cache.Get(obsKey); !ok {
		t.Error("obs entry must survive run rotation")
	}
	if _, ok := cache.Get(fcstKey); ok {
		t.Error("forecast entry from old run must be evicted")
	}
}

// jsonUnmarshal indirection so the test doesn't import encoding/json twice.
func jsonUnmarshal(body string, v interface{}) error {
	return json.Unmarshal([]byte(body), v)
}
