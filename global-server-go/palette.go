package main

// ============================================================================
// palette.go — Colormaps for the global model server
// ============================================================================

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
			// Satellite IR: spectral on the cold end, greyscale on the warm end.
			lut = buildRGBAFromRGB(&irEnhancedLUT, cfg.Invert)
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
