package main

// ============================================================================
// render.go — Colormap application and PNG tile generation
// ============================================================================

import (
	"bytes"
	"image"
	"image/png"
	"math"
)

// generateTileRGBA applies the band's colormap to a float32 tile buffer,
// returning a 256×256 RGBA byte slice. This mirrors generate_tile_rgba()
// in the Python server.
//
// Parameters:
//   - data: float32 array of tileSize×tileSize values
//   - band: band name (determines colormap)
//   - nodata: pointer to nodata value (nil if none)
//   - tileSize: typically 256
func generateTileRGBA(data []float32, band string, nodata *float64, tileSize int) *[256 * 256 * 4]byte {
	cfg, ok := BANDS[band]
	if !ok {
		return nil
	}

	rgba := make([]byte, tileSize*tileSize*4)

	// Build nodata mask
	nodataMask := make([]bool, tileSize*tileSize)
	if nodata != nil {
		nd := float32(*nodata)
		for i, v := range data {
			nodataMask[i] = v == nd || !isFinite32(v)
		}
	} else {
		for i, v := range data {
			nodataMask[i] = !isFinite32(v)
		}
	}

	switch band {
	case "radar":
		renderRadarTile(data, rgba, nodataMask, tileSize)
	case "lightning":
		renderLightningTile(data, rgba, nodataMask, cfg, tileSize)
	default:
		renderGenericTile(data, rgba, nodataMask, cfg, tileSize)
	}

	// Convert to fixed-size array
	var result [256 * 256 * 4]byte
	copy(result[:], rgba[:256*256*4])
	return &result
}

// renderRadarTile applies the Z-R transform and radar palette LUT.
func renderRadarTile(data []float32, rgba []byte, nodataMask []bool, tileSize int) {
	logRate := make([]float32, len(data))
	for i, dbz := range data {
		if dbz > 0 {
			z := float32(math.Pow(10.0, float64(dbz)/10.0))
			rainRate := float32(math.Pow(float64(z)/200.0, 1.0/1.6))
			if rainRate < 0.01 {
				rainRate = 0.01
			}
			if rainRate > float32(radarMaxRate) {
				rainRate = float32(radarMaxRate)
			}
			logRate[i] = float32(math.Log(float64(rainRate)))
		} else {
			logRate[i] = 0
			nodataMask[i] = true // zero rain = transparent
		}
	}

	for i := 0; i < len(logRate); i++ {
		off := i * 4
		if nodataMask[i] || data[i] <= 0 {
			rgba[off], rgba[off+1], rgba[off+2], rgba[off+3] = 0, 0, 0, 0
			continue
		}
		// Normalize using logarithmic mapping
		dataNorm := (logRate[i] - float32(radarLogMin)) / float32(radarLogMax-radarLogMin)
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
		c := RadarLUT[idx]
		rgba[off] = c[0]
		rgba[off+1] = c[1]
		rgba[off+2] = c[2]
		rgba[off+3] = c[3]
	}
}

// renderLightningTile applies the discrete lightning colormap.
func renderLightningTile(data []float32, rgba []byte, nodataMask []bool, cfg *BandConfig, tileSize int) {
	for i, v := range data {
		off := i * 4
		if nodataMask[i] || v <= 0 {
			rgba[off], rgba[off+1], rgba[off+2], rgba[off+3] = 0, 0, 0, 0
			continue
		}
		// Normalize to 0-255
		normalized := (float64(v) - cfg.Min) / (cfg.Max - cfg.Min) * 255
		if normalized > 255 {
			normalized = 255
		}

		// Find the highest matching color
		var color [4]byte = [4]byte{255, 255, 0, 150} // default for non-zero
		for val, c := range LightningCmap {
			if val > 0 && normalized >= float64(val)*255/cfg.Max {
				color = c
			}
		}
		rgba[off] = color[0]
		rgba[off+1] = color[1]
		rgba[off+2] = color[2]
		rgba[off+3] = color[3]
	}
}

// renderGenericTile applies a pre-computed colormap LUT (viridis/plasma) or fallback.
func renderGenericTile(data []float32, rgba []byte, nodataMask []bool, cfg *BandConfig, tileSize int) {
	range_ := cfg.Max - cfg.Min
	if range_ == 0 {
		range_ = 1
	}

	lut := cfg.colormap
	if lut == nil {
		// Fallback: grayscale
		for i, v := range data {
			off := i * 4
			if nodataMask[i] || v == 0 {
				rgba[off], rgba[off+1], rgba[off+2], rgba[off+3] = 0, 0, 0, 0
				continue
			}
			normalized := (float64(v) - cfg.Min) / range_
			if normalized < 0 {
				normalized = 0
			}
			if normalized > 1 {
				normalized = 1
			}
			gray := byte(normalized * 255)
			rgba[off], rgba[off+1], rgba[off+2], rgba[off+3] = gray, gray, gray, 255
		}
		return
	}

	for i, v := range data {
		off := i * 4
		if nodataMask[i] || v == 0 {
			rgba[off], rgba[off+1], rgba[off+2], rgba[off+3] = 0, 0, 0, 0
			continue
		}
		normalized := (float64(v) - cfg.Min) / range_
		if normalized < 0 {
			normalized = 0
		}
		if normalized > 1 {
			normalized = 1
		}
		idx := int(normalized * 255)
		if idx > 255 {
			idx = 255
		}
		c := (*lut)[idx]
		rgba[off] = c[0]
		rgba[off+1] = c[1]
		rgba[off+2] = c[2]
		rgba[off+3] = 255
	}
}

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

// encodePNG encodes a raw RGBA byte slice into PNG bytes.
func encodePNG(rgba []byte, width, height int) ([]byte, error) {
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	copy(img.Pix, rgba)

	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// encodeEmptyPNG returns a fully transparent PNG tile.
func encodeEmptyPNG(size int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

// renderAndEncodeTile takes raw float32 data and returns encoded PNG bytes.
func renderAndEncodeTile(data []float32, band string, nodata *float64, tileSize int) ([]byte, error) {
	rgba := generateTileRGBA(data, band, nodata, tileSize)
	if rgba == nil {
		return encodeEmptyPNG(tileSize), nil
	}
	return encodePNG(rgba[:tileSize*tileSize*4], tileSize, tileSize)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func isFinite32(v float32) bool {
	return !math.IsNaN(float64(v)) && !math.IsInf(float64(v), 0)
}


