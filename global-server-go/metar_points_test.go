package main

// parseMetarPQ verification against a real global_live_*.pq snapshot.
// The testdata file is not committed (bucket-private); copy one in to run:
//
//	gcloud storage cp \
//	  gs://eumetsat_mtg_preprocess/inference_h5_global/global_live_YYYYMMDD_HH00.pq \
//	  global-server-go/testdata/global_live.pq

import (
	"os"
	"testing"
	"time"
)

const testPQPath = "testdata/global_live.pq"

func TestParseMetarPQ(t *testing.T) {
	data, err := os.ReadFile(testPQPath)
	if err != nil {
		t.Skipf("testdata not available: %v", err)
	}

	stations, latestObs, err := parseMetarPQ(data)
	if err != nil {
		t.Fatalf("parseMetarPQ: %v", err)
	}

	// Reference snapshot 20260926_1500: 5235 unique stations,
	// observations between 11:01 and 15:00 UTC.
	if len(stations) < 4000 || len(stations) > 8000 {
		t.Errorf("unexpected station count: %d", len(stations))
	}
	if latestObs.Before(time.Date(2026, 9, 26, 11, 0, 0, 0, time.UTC)) {
		t.Errorf("latestObs too old: %v", latestObs)
	}

	// A known station with valid coordinates.
	if st, ok := stations["KMRF"]; !ok {
		t.Errorf("KMRF missing from station set")
	} else if st.lat < 30 || st.lat > 31 || st.lon < -105 || st.lon > -104 {
		t.Errorf("KMRF has bad coordinates: %+v", st)
	}

	// Every station has usable coordinates or is explicitly junk-sentinel
	// (handled by the registry fallback in fetchMetarPointsSnapshot).
	for icao, st := range stations {
		if st.lat == 0 && st.lon == 0 && icao != "" {
			t.Errorf("station %s has 0/0 coordinates", icao)
		}
	}
}
