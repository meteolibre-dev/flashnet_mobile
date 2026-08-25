package main

// ============================================================================
// palette.go — Colormaps for the global model server
// ============================================================================

import "math"

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
