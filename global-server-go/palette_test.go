package main

import "testing"

// TestRadarRainLUT checks that the radar_dbz band LUT (dBZ-stretched over
// 5–65 dBZ) reproduces lightning-server-go's colorbar: dBZ → mm/h via the
// Marshall-Palmer Z-R relation → log-mapped RAIN_CLASSES lookup.
//
// Expected colors are the RAIN_CLASSES segments containing each dBZ's
// derived rain rate (computed by hand):
//
//	10 dBZ → 0.154 mm/h → [0.12, 0.16)   → blue
//	20 dBZ → 0.648 mm/h → [0.6, 0.9)    → green
//	40 dBZ → 11.53 mm/h → [10.0, 12.9)  → orange
//	55 dBZ → 99.9 mm/h  → [80.7, 102.5) → dark red
//	65 dBZ → 421 mm/h (clamped 341.9)   → deep purple (see note)
//
// The 65 dBZ entry intentionally matches lightning-server-go's
// RadarLUT[255] = class of 268.8 mm/h: the log-max rate (341.9) lands an
// epsilon below the last class threshold due to float rounding, so the
// final pink class never renders in either server — verified against
// lightning-server-go's own renderer output.
func TestRadarRainLUT(t *testing.T) {
	cfg, ok := BANDS["radar_dbz"]
	if !ok {
		t.Fatal("radar_dbz band missing")
	}
	if cfg.Colormap != "radar_rain" {
		t.Fatalf("radar_dbz colormap = %q, want radar_rain", cfg.Colormap)
	}
	lut, ok := PrecomputedColormaps["radar_dbz"]
	if !ok {
		t.Fatal("radar_dbz LUT not built")
	}

	cases := []struct {
		dbz  float64
		want [4]byte
	}{
		{10, [4]byte{51, 170, 207, 255}},   // blue
		{20, [4]byte{3, 237, 1, 255}},      // green
		{40, [4]byte{241, 148, 2, 255}},    // orange
		{55, [4]byte{172, 0, 0, 255}},      // dark red
		{65, [4]byte{151, 45, 152, 255}},   // deep purple (see note above)
	}
	for _, tc := range cases {
		idx := int((tc.dbz - cfg.Min) / (cfg.Max - cfg.Min) * 255)
		if got := (*lut)[idx]; got != tc.want {
			t.Errorf("LUT[%d] (%.1f dBZ) = %v, want %v", idx, tc.dbz, got, tc.want)
		}
	}
}

// TestDbzToMmh spot-checks the Z-R conversion against hand-computed values.
func TestDbzToMmh(t *testing.T) {
	for _, tc := range []struct{ dbz, want float64 }{
		{20, 0.6484},  // (100/200)^(1/1.6)
		{40, 11.532},  // (10^4/200)^(1/1.6)
		{65, 421.07},   // (10^6.5/200)^(1/1.6)
	} {
		if got := dbzToMmh(tc.dbz); abs64(got-tc.want) > 0.01 {
			t.Errorf("dbzToMmh(%v) = %.4f, want ~%.4f", tc.dbz, got, tc.want)
		}
	}
	if dbzToMmh(0) != 0 || dbzToMmh(-5) != 0 {
		t.Error("dbzToMmh should return 0 for dBZ ≤ 0")
	}
}

func abs64(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}
