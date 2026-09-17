package main

// ============================================================================
// palette.go — Colormaps for the global model server
// ============================================================================

import (
	"log"
	"math"
	"strings"
)

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
	// Build the radar rain-rate LUT (log rain-rate axis), identical to
	// lightning-server-go's RadarLUT: index i ↔ rate = exp(logMin +
	// i/255·(logMax−logMin)); entries below the first class threshold stay
	// transparent. buildRadarRainRGBA below resamples it over dBZ.
	radarThresholds = make([]float64, len(RAIN_CLASSES))
	for i, rc := range RAIN_CLASSES {
		radarThresholds[i] = rc.Threshold
	}
	for i := 0; i < 256; i++ {
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
		radarRateLUT[i] = [4]byte{RAIN_CLASSES[idx].RGB[0], RAIN_CLASSES[idx].RGB[1], RAIN_CLASSES[idx].RGB[2], 255}
	}

	// Build colormap LUTs for each band
	for name, cfg := range BANDS {
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
		case "radar_rain":
			// Radar reflectivity: the operational rain-rate colorbar from
			// lightning-server-go (palette_radar_35.py), stretched over the
			// band's dBZ range. See buildRadarRainRGBA.
			lut = buildRadarRainRGBA(cfg.Min, cfg.Max, cfg.Invert)
		case "greyscale":
			// Plain greyscale (white → black); Invert flips the direction.
			lut = buildGreyscaleLUT(cfg.Invert)
		default:
			continue
		}
		cfg.colormap = &lut
		PrecomputedColormaps[name] = &lut

		// Parse the optional no-data color (e.g. radar_dbz grey) into RGBA.
		if cfg.NodataColor != "" {
			if rgba, ok := parseHexColor(cfg.NodataColor); ok {
				cfg.nodataRGBA = &rgba
			} else {
				logInvalidNodataColor(name, cfg.NodataColor)
			}
		}
	}
}

func logInvalidNodataColor(band, color string) {
	// Warn without failing the server — the band renders transparent instead.
	log.Printf("warning: band %s: invalid NODATA_COLOR %q (expected #RRGGBB[AA]) — falling back to transparent", band, color)
}

// parseHexColor parses "#RGB", "#RRGGBB" or "#RRGGBBAA" (leading #
// optional) into RGBA bytes. Alpha defaults to 255 (opaque).
func parseHexColor(s string) ([4]byte, bool) {
	out := [4]byte{0, 0, 0, 255}
	s = strings.TrimPrefix(s, "#")

	switch len(s) {
	case 3, 4: // short form, e.g. "abc" / "abcd"
		for i := 0; i < len(s); i++ {
			v, ok := hexNibble(s[i])
			if !ok {
				return out, false
			}
			out[i] = v * 17 // 0xf → 0xff
		}
		if len(s) == 3 {
			out[3] = 255
		}
	case 6, 8: // long form, e.g. "9e9e9e" / "9e9e9e80"
		for i := 0; i < len(s)/2; i++ {
			hi, ok1 := hexNibble(s[i*2])
			lo, ok2 := hexNibble(s[i*2+1])
			if !ok1 || !ok2 {
				return out, false
			}
			out[i] = hi<<4 | lo
		}
		if len(s) == 6 {
			out[3] = 255
		}
	default:
		return out, false
	}
	return out, true
}

func hexNibble(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
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

// ---------------------------------------------------------------------------
// Radar palette (rain-rate colorbar shared with lightning-server-go)
// ---------------------------------------------------------------------------

// RainClass is one segment of the operational rain-rate palette from
// palette_radar_35.py, as served by lightning-server-go.
type RainClass struct {
	Threshold float64 // lower bound of the segment (mm/h)
	RGB       [3]byte
}

// RAIN_CLASSES — 34 classes from palette_radar_35.py (thresholds 0.02 → 341.9 mm/h).
// Kept byte-identical to lightning-server-go/palette.go so both tile
// servers render the exact same radar colorbar.
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

// Radar log-mapping constants (mirrors lightning-server-go/palette.go).
var (
	radarMaxRate    = float64(RAIN_CLASSES[len(RAIN_CLASSES)-1].Threshold)
	radarLogMin     = math.Log(0.005)
	radarLogMax     = math.Log(radarMaxRate)
	radarThresholds []float64
)

// radarRateLUT is a 256-entry RGBA LUT over the log rain-rate axis —
// identical to lightning-server-go's RadarLUT. It is an intermediate:
// buildRadarRainRGBA resamples it over the band's dBZ range.
var radarRateLUT [256][4]byte

// buildRadarRainRGBA stretches the lightning-server rain-rate colorbar over
// the band's dBZ range [min, max]: each LUT index ↔ dBZ → rain rate via the
// Marshall-Palmer Z-R relation → RAIN_CLASSES color (log-mapped). This is
// exactly lightning-server-go's per-pixel renderRadarTile math, evaluated
// once per LUT entry; since log(rain rate) is affine in dBZ under the Z-R
// relation, the log stretch is preserved by the linear dBZ resampling.
//
// Entries whose rate falls below the first class threshold get the first
// class color (the generic renderer forces alpha=255, so a transparent LUT
// entry would render black); with the default Min=5 dBZ every in-range
// value maps above the first threshold anyway.
func buildRadarRainRGBA(min, max float64, invert bool) [256][4]byte {
	if max <= min {
		max = min + 1
	}

	first := RAIN_CLASSES[0].RGB
	var lut [256][4]byte
	for i := 0; i < 256; i++ {
		dbz := min + float64(i)/255.0*(max-min)
		c := radarRateLUT[radarRateIndex(dbzToMmh(dbz))]
		if c[3] == 0 {
			c = [4]byte{first[0], first[1], first[2], 255}
		}
		lut[i] = c
	}

	if invert {
		for i, j := 0, 255; i < j; i, j = i+1, j-1 {
			lut[i], lut[j] = lut[j], lut[i]
		}
	}
	return lut
}

// radarRateIndex maps a rain rate (mm/h) to a radarRateLUT index, using the
// same clamps and log normalization as lightning-server-go's renderer.
func radarRateIndex(rate float64) int {
	if rate < 0.01 {
		rate = 0.01
	}
	if rate > radarMaxRate {
		rate = radarMaxRate
	}
	norm := (math.Log(rate) - radarLogMin) / (radarLogMax - radarLogMin)
	if norm < 0 {
		norm = 0
	}
	if norm > 1 {
		norm = 1
	}
	idx := int(norm * 255)
	if idx < 1 {
		idx = 0
	}
	return idx
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
