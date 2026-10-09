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

// dbzColorLUT maps quantized dBZ directly to the final RGBA color, skipping
// the per-pixel math.Pow/math.Log of the Z-R transform. Built by replicating
// the original two-pass float32 math at 0.01 dB resolution — a pixel's color
// can only differ from the exact path when it sits within ~0.01 dB of a
// palette class boundary (visually imperceptible; see render_diff_test.go).
const (
	dbzLutStep  = 0.01                  // dB resolution of the LUT
	dbzLutScale = 1.0 / dbzLutStep     // dBZ → index multiplier
	dbzLutMax   = 100.0                 // dBZ upper bound (clamped above)
)

var dbzColorLUT [][4]byte // index = round(dbz / dbzLutStep)

// viridisLUT and plasmaLUT are the exact matplotlib colormaps (256 entries).
// Generated from the BIDS/colormap reference data (CC0).
//
// irEnhancedLUT is the satellite enhanced-IR palette (spectral → greys),
// filled in by colormap_data.go's init().
var viridisLUT [256][3]byte
var plasmaLUT [256][3]byte
var irEnhancedLUT [256][3]byte

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

	// Build dBZ→color LUT (exact replica of the original per-pixel math,
	// including the float32 intermediate casts, at 0.01 dB granularity).
	// Entry i represents the bin [i·step−step/2, i·step+step/2), so bin 0
	// (values in (0, 0.005)) is evaluated at its midpoint — NOT at dbz=0,
	// whose "no rain" color is handled by the transparent check before the
	// LUT is ever consulted.
	dbzColorLUT = make([][4]byte, int(dbzLutMax/dbzLutStep)+1)
	for i := range dbzColorLUT {
		dbz := float64(i) * dbzLutStep
		if i == 0 {
			dbz = dbzLutStep / 4 // midpoint of (0, 0.005)
		}
		logRate := float32(0)
		if dbz > 0 {
			z := float32(math.Pow(10.0, dbz/10.0))
			rainRate := float32(math.Pow(float64(z)/200.0, 1.0/1.6))
			if rainRate < 0.01 {
				rainRate = 0.01
			}
			if rainRate > float32(radarMaxRate) {
				rainRate = float32(radarMaxRate)
			}
			logRate = float32(math.Log(float64(rainRate)))
		}
		// Normalize using logarithmic mapping (same as old render loop)
		dataNorm := (logRate - float32(radarLogMin)) / float32(radarLogMax-radarLogMin)
		if dataNorm < 0 {
			dataNorm = 0
		}
		if dataNorm > 1 {
			dataNorm = 1
		}
		idx := int(dataNorm * 255)
		if idx < 1 {
			idx = 0 // index 0 = transparent
		}
		dbzColorLUT[i] = RadarLUT[idx]
	}

	// Build colormap LUTs for each band
	for name, cfg := range BANDS {
		if cfg.Colormap == "custom" {
			continue
		}
		var lut [256][4]byte
		switch cfg.Colormap {
		case "viridis":
			lut = buildRGBAFromRGB(&viridisLUT, cfg.Invert)
		case "plasma":
			lut = buildRGBAFromRGB(&plasmaLUT, cfg.Invert)
		case "ir_enhanced":
			// Satellite IR: two-segment stretch over the spectral→greys palette
			// (see buildIREnhancedLUT).
			lut = buildIREnhancedLUT(cfg.Min, cfg.Max, cfg.SplitValue, cfg.Invert)
		case "greyscale":
			// Plain greyscale (white → black); Invert flips the direction.
			lut = buildGreyscaleLUT(cfg.Invert)
		default:
			continue
		}
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

// Segment lengths inside irEnhancedLUT (spectral = cold end incl. black,
// greys = warm end). The palette's own spectral↔greys transition falls at
// src index ~163.
const (
	irSpectralLen = 163 // src[0..162]:   black → dark red → … → navy
	irGreysLen    = 93  // src[163..255]: light grey → dark grey
)

// buildIREnhancedLUT composes the enhanced-IR palette over a data range in
// two segments, mirroring trollimage's
//
//	spectral.set_range(cold…) + greys.set_range(warm…)
//
// example (https://trollimage.readthedocs.io/en/latest/colormap.html):
//
//   - [min, split]  (warm: surfaces, light cloud) → greyscale ramp:
//     darkest grey at min → lightest grey at split
//   - (split, max]  (cold: cloud tops) → spectral ramp:
//     navy at split → red → black at max
//
// A single linear stretch cannot do this: the palette's greys segment covers
// only ~36% of its length, so it must be stretched over the warm data range
// and the spectral segment compressed over the cold range, or mid-range
// values (oceans) would land in the navy transition zone.
func buildIREnhancedLUT(min, max, split float64, invert bool) [256][4]byte {
	// sane fallbacks
	if max <= min {
		max = min + 1
	}
	if split <= min || split >= max {
		split = min + 0.6*(max-min)
	}

	var lut [256][4]byte
	for i := 0; i < 256; i++ {
		v := min + float64(i)/255.0*(max-min)
		var srcIdx int
		if v <= split {
			// warm segment → greys (dark at min, light at split)
			f := (v - min) / (split - min)
			srcIdx = 255 - int(math.Round(f*float64(irGreysLen-1)))
		} else {
			// cold segment → spectral (navy at split, black at max)
			f := (v - split) / (max - split)
			srcIdx = irSpectralLen - 1 - int(math.Round(f*float64(irSpectralLen-1)))
		}
		c := irEnhancedLUT[srcIdx]
		lut[i] = [4]byte{c[0], c[1], c[2], 255}
	}

	if invert {
		for i, j := 0, 255; i < j; i, j = i+1, j-1 {
			lut[i], lut[j] = lut[j], lut[i]
		}
	}
	return lut
}

// buildGreyscaleLUT returns a white→black greyscale RGBA LUT (index 0 =
// white, index 255 = black); invert=true reverses it to black→white.
func buildGreyscaleLUT(invert bool) [256][4]byte {
	var lut [256][4]byte
	for i := 0; i < 256; i++ {
		v := byte(255 - i)
		if invert {
			v = byte(i)
		}
		lut[i] = [4]byte{v, v, v, 255}
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
