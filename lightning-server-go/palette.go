package main

// ============================================================================
// palette.go — Radar palette LUT, colormaps (viridis/plasma), and math
// ============================================================================

import "math"

// RGB is a simple RGB color triplet (0–255).
type RGB struct{ R, G, B byte }

// RainClass mirrors the Python RainClass from palette_radar_35.py.
type RainClass struct {
	Threshold float64 // lower bound of the segment (mm/h)
	RGB       [3]byte
}

// RAIN_CLASSES — 34 classes from palette_radar_35.py (thresholds 0.02 → 341.9 mm/h)
var RAIN_CLASSES = []RainClass{
	{0.02, [3]byte{155, 190, 196}},
	{0.04, [3]byte{102, 191, 199}},
	{0.06, [3]byte{126, 225, 240}},
	{0.09, [3]byte{98, 235, 253}},
	{0.12, [3]byte{51, 170, 207}},
	{0.16, [3]byte{19, 155, 228}},
	{0.23, [3]byte{18, 117, 230}},
	{0.32, [3]byte{8, 38, 225}},
	{0.4, [3]byte{2, 254, 1}},
	{0.6, [3]byte{3, 237, 1}},
	{0.9, [3]byte{2, 221, 4}},
	{1.1, [3]byte{1, 207, 0}},
	{1.2, [3]byte{1, 192, 1}},
	{1.6, [3]byte{1, 174, 2}},
	{2.8, [3]byte{1, 160, 0}},
	{3.2, [3]byte{0, 143, 2}},
	{4.4, [3]byte{248, 239, 1}},
	{6.1, [3]byte{239, 208, 0}},
	{8.5, [3]byte{234, 180, 0}},
	{10.0, [3]byte{241, 148, 2}},
	{12.9, [3]byte{253, 114, 2}},
	{18.0, [3]byte{252, 80, 1}},
	{22.3, [3]byte{252, 41, 2}},
	{30.2, [3]byte{251, 1, 1}},
	{39.2, [3]byte{238, 1, 0}},
	{50.1, [3]byte{210, 1, 4}},
	{63.6, [3]byte{196, 0, 0}},
	{80.7, [3]byte{172, 0, 0}},
	{102.5, [3]byte{251, 201, 252}},
	{130.1, [3]byte{229, 162, 230}},
	{166.2, [3]byte{202, 124, 198}},
	{211.4, [3]byte{178, 87, 180}},
	{268.8, [3]byte{151, 45, 152}},
	{341.9, [3]byte{255, 185, 255}},
}

const RadarMaxThreshold = 490.3

// Pre-computed radar colormap LUT
var (
	radarMaxRate   = float64(RAIN_CLASSES[len(RAIN_CLASSES)-1].Threshold)
	radarLogMin    = math.Log(0.005)
	radarLogMax    = math.Log(radarMaxRate)
	radarThresholds []float64
)

// RadarLUT is a 256-entry RGBA lookup table for rain rate → color,
// using logarithmic mapping (mirrors the Python _RADAR_CMAP_LUT).
// Index 0 is transparent (no rain).
var RadarLUT [256][4]byte

// viridisLUT and plasmaLUT are the exact matplotlib colormaps (256 entries).
// Generated from the BIDS/colormap reference data (CC0).
var viridisLUT [256][3]byte
var plasmaLUT [256][3]byte

// PrecomputedColormaps maps band name → 256-entry RGBA LUT.
var PrecomputedColormaps = map[string]*[256][4]byte{}

func init() {
	// Build radar thresholds slice
	radarThresholds = make([]float64, len(RAIN_CLASSES))
	for i, rc := range RAIN_CLASSES {
		radarThresholds[i] = rc.Threshold
	}

	// Build radar LUT
	for i := 1; i < 256; i++ {
		rate := math.Exp(radarLogMin + (float64(i)/255.0)*(radarLogMax-radarLogMin))
		if rate < RAIN_CLASSES[0].Threshold {
			continue // stays transparent
		}
		idx := searchSortedRight(radarThresholds, rate) - 1
		if idx < 0 {
			idx = 0
		}
		if idx >= len(radarThresholds) {
			idx = len(radarThresholds) - 1
		}
		RadarLUT[i] = [4]byte{RAIN_CLASSES[idx].RGB[0], RAIN_CLASSES[idx].RGB[1], RAIN_CLASSES[idx].RGB[2], 255}
	}

	// Build colormap LUTs for each band
	for name, cfg := range BANDS {
		if cfg.Colormap == "custom" {
			continue
		}
		var src *[256][3]byte
		switch cfg.Colormap {
		case "viridis":
			src = &viridisLUT
		case "plasma":
			src = &plasmaLUT
		default:
			continue
		}
		lut := buildRGBAFromRGB(src, cfg.Invert)
		cfg.colormap = &lut
		PrecomputedColormaps[name] = &lut
	}
}

// buildRGBAFromRGB converts a 256-entry RGB LUT to RGBA (alpha=255),
// optionally reversed.
func buildRGBAFromRGB(src *[256][3]byte, invert bool) [256][4]byte {
	var lut [256][4]byte
	for i := 0; i < 256; i++ {
		idx := i
		if invert {
			idx = 255 - i
		}
		lut[i] = [4]byte{src[idx][0], src[idx][1], src[idx][2], 255}
	}
	return lut
}

// searchSortedRight returns the index where `value` would be inserted to keep
// the slice sorted (right side), matching numpy.searchsorted(side='right').
func searchSortedRight(sorted []float64, value float64) int {
	lo, hi := 0, len(sorted)
	for lo < hi {
		mid := (lo + hi) / 2
		if value >= sorted[mid] {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	return lo
}

// dbzToMmh converts radar reflectivity (dBZ) to rain rate (mm/h) via the
// Marshall-Palmer Z-R relationship: Z = 200·R^1.6 → R = (Z/200)^(1/1.6).
func dbzToMmh(dbz float64) float64 {
	if dbz <= 0 {
		return 0
	}
	z := math.Pow(10.0, dbz/10.0)
	return math.Pow(z/200.0, 1.0/1.6)
}
