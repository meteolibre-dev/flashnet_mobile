package main

// ============================================================================
// render.go — Colormap application and PNG tile generation (global model)
// ----------------------------------------------------------------------------

import (
	"bytes"
	"image"
	"image/png"
	"math"
)

// generateTileRGBA applies the band's colormap to a float32 tile buffer,
// returning a 256×256 RGBA byte slice.
//
// Parameters:
//   - data: float32 array of tileSize×tileSize values
//   - band: logical band name (determines colormap)
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

	renderGenericTile(data, rgba, nodataMask, cfg, tileSize)

	// Convert to fixed-size array
	var result [256 * 256 * 4]byte
	copy(result[:], rgba[:256*256*4])
	return &result
}

// renderGenericTile applies a pre-computed colormap LUT (viridis/plasma) or
// a grayscale fallback.
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
		if nodataMask[i] {
			rgba[off], rgba[off+1], rgba[off+2], rgba[off+3] = 0, 0, 0, 0
			continue
		}

		// Convert to uint8 first (matches Python's .astype(np.uint8)).
		// Tiny interpolated values truncate to 0 → transparent.
		clipped := v
		if clipped < float32(cfg.Min) {
			clipped = float32(cfg.Min)
		}
		if clipped > float32(cfg.Max) {
			clipped = float32(cfg.Max)
		}
		normalized := uint8((float64(clipped) - cfg.Min) / range_ * 255.0)

		if normalized == 0 {
			rgba[off], rgba[off+1], rgba[off+2], rgba[off+3] = 0, 0, 0, 0
			continue
		}

		c := (*lut)[normalized]
		rgba[off] = c[0]
		rgba[off+1] = c[1]
		rgba[off+2] = c[2]
		rgba[off+3] = 255
	}
}

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

// encodePNG encodes a raw straight-alpha RGBA byte slice into PNG bytes.
//
// IMPORTANT: uses image.NRGBA (non-premultiplied alpha), NOT image.RGBA.
// image.RGBA stores alpha-premultiplied pixels, so if we wrote straight-alpha
// values into it, the PNG encoder would "un-premultiply" them (dividing R,G,B
// by A/255), corrupting all semi-transparent pixels. NRGBA stores straight
// alpha and the PNG encoder writes it correctly.
func encodePNG(rgba []byte, width, height int) ([]byte, error) {
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
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
