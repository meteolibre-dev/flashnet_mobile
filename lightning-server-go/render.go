package main

// ============================================================================
// render.go — Colormap application and PNG tile generation
// ----------------------------------------------------------------------------
// Performance notes (perf/render-optimizations branch):
//   - Tile buffers (RGBA, nodata mask) are recycled through a sync.Pool
//     instead of being allocated per tile.
//   - The radar path uses a precomputed dBZ→color LUT (see palette.go)
//     instead of per-pixel math.Pow/math.Log, fused into a single pass.
//   - PNG encoding wraps the RGBA slice in an image.NRGBA view (no 256 KB
//     copy) and uses BestSpeed compression (env TILE_PNG_COMPRESSION).
// ============================================================================

import (
	"bytes"
	"image"
	"image/png"
	"math"
	"sync"
)

// ---------------------------------------------------------------------------
// Buffer pool
// ---------------------------------------------------------------------------

// tileBuffers holds the scratch buffers for one 256×256 tile render.
type tileBuffers struct {
	rgba  []byte   // tileSize×tileSize×4
	mask  []bool   // tileSize×tileSize nodata mask
	pooled bool    // true if owned by the pool (must be returned)
}

const tileRGBASize = 256 * 256 * 4

var tileBufPool = sync.Pool{
	New: func() interface{} {
		return &tileBuffers{
			rgba: make([]byte, tileRGBASize),
			mask: make([]bool, 256*256),
		}
	},
}

// getTileBuffers returns scratch buffers for a tileSize×tileSize render.
// Only the canonical 256×256 size is pooled; other sizes allocate fresh
// (preview path uses its own buffers).
func getTileBuffers(tileSize int) *tileBuffers {
	if tileSize*tileSize*4 == tileRGBASize {
		tb := tileBufPool.Get().(*tileBuffers)
		tb.pooled = true
		return tb
	}
	return &tileBuffers{
		rgba: make([]byte, tileSize*tileSize*4),
		mask: make([]bool, tileSize*tileSize),
	}
}

// releaseTileBuffers returns buffers to the pool. Call when done with tb.rgba.
func releaseTileBuffers(tb *tileBuffers) {
	if tb != nil && tb.pooled {
		tb.pooled = false
		tileBufPool.Put(tb)
	}
}

// ---------------------------------------------------------------------------
// Tile rendering
// ---------------------------------------------------------------------------

// renderTile applies the band's colormap to a float32 tile buffer, rendering
// into pooled scratch memory. The result is valid until releaseTileBuffers is
// called. Returns nil for an unknown band.
func renderTile(data []float32, band string, nodata *float64, tileSize int) *tileBuffers {
	if _, ok := BANDS[band]; !ok {
		return nil
	}

	tb := getTileBuffers(tileSize)

	switch band {
	case "radar":
		// Single fused pass: transparent check + dBZ LUT lookup.
		renderRadarTileLUT(data, tb.rgba, nodata, tileSize)
	case "lightning":
		buildNodataMask(data, tb.mask, nodata)
		renderLightningTile(data, tb.rgba, tb.mask, BANDS[band], tileSize)
	default:
		buildNodataMask(data, tb.mask, nodata)
		renderGenericTile(data, tb.rgba, tb.mask, BANDS[band], tileSize)
	}

	return tb
}

// buildNodataMask fills mask[i] = (data[i]==nodata) || !isFinite(data[i]).
// Uses pure float32 comparisons — no float64 round-trips.
func buildNodataMask(data []float32, mask []bool, nodata *float64) {
	const fmax = math.MaxFloat32 / 2 // excludes ±Inf and NaN
	if nodata != nil {
		nd := float32(*nodata)
		for i, v := range data {
			mask[i] = v == nd || !(v >= -fmax && v <= fmax)
		}
	} else {
		for i, v := range data {
			mask[i] = !(v >= -fmax && v <= fmax)
		}
	}
}

// renderRadarTileLUT applies the Z-R transform via the precomputed dBZ→color
// LUT (dbzColorLUT in palette.go). Semantics match the original two-pass
// implementation: a pixel is transparent when it is nodata, non-finite,
// or ≤ 0 dBZ (zero rain = transparent).
func renderRadarTileLUT(data []float32, rgba []byte, nodata *float64, tileSize int) {
	maxIdx := len(dbzColorLUT) - 1
	const fmax = math.MaxFloat32 / 2

	hasNd := nodata != nil
	nd := float32(0)
	if hasNd {
		nd = float32(*nodata)
	}

	for i, v := range data {
		off := i * 4
		// Transparent: nodata, NaN/Inf, or non-positive reflectivity.
		// (NaN fails every comparison, so it lands here — same as before.)
		if (hasNd && v == nd) || !(v >= -fmax && v <= fmax) || v <= 0 {
			rgba[off], rgba[off+1], rgba[off+2], rgba[off+3] = 0, 0, 0, 0
			continue
		}
		ci := int(v*dbzLutScale + 0.5)
		if ci > maxIdx {
			ci = maxIdx // dBZ ≥ 100 dB clamps to max rain rate color
		}
		c := dbzColorLUT[ci]
		rgba[off] = c[0]
		rgba[off+1] = c[1]
		rgba[off+2] = c[2]
		rgba[off+3] = c[3]
	}
}

// renderLightningTile applies the discrete lightning colormap.
// IMPORTANT: data values must be converted to uint8 (0-255) BEFORE the > 0 check,
// matching the Python server. This ensures that tiny interpolated values
// (e.g. 0.001 from GDAL resampling) are truncated to 0 and rendered transparent.
// Without this, those edge pixels get semi-transparent yellow (alpha=150)
// which blends with the map background to produce an unwanted green tint.
func renderLightningTile(data []float32, rgba []byte, nodataMask []bool, cfg *BandConfig, tileSize int) {
	rangeVal := cfg.Max - cfg.Min
	if rangeVal == 0 {
		rangeVal = 1
	}

	for i, v := range data {
		off := i * 4
		if nodataMask[i] {
			rgba[off], rgba[off+1], rgba[off+2], rgba[off+3] = 0, 0, 0, 0
			continue
		}

		// Convert to uint8 first — this truncates tiny values to 0,
		// exactly like Python's .astype(np.uint8)
		clipped := v
		if clipped < float32(cfg.Min) {
			clipped = float32(cfg.Min)
		}
		if clipped > float32(cfg.Max) {
			clipped = float32(cfg.Max)
		}
		normalized := uint8((float64(clipped) - cfg.Min) / rangeVal * 255.0)

		if normalized == 0 {
			rgba[off], rgba[off+1], rgba[off+2], rgba[off+3] = 0, 0, 0, 0
			continue
		}

		// Start with the default non-zero color
		color := LightningDefaultColor

		// Iterate in ascending order; the highest matching entry wins
		for _, e := range LightningColorEntries {
			if e.Val > 0 {
				threshold := int(float64(e.Val) * 255.0 / cfg.Max)
				if int(normalized) >= threshold {
					color = e.Color
				}
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

// pngEncoder is the shared encoder instance. Weather tiles are mostly flat
// regions, so BestSpeed compression trades a few % of file size for a large
// encode speedup. Override with TILE_PNG_COMPRESSION=speed|default|best|none.
var pngEncoder = &png.Encoder{CompressionLevel: png.BestSpeed}

func init() {
	switch envOr("TILE_PNG_COMPRESSION", "speed") {
	case "default":
		pngEncoder.CompressionLevel = png.DefaultCompression
	case "best":
		pngEncoder.CompressionLevel = png.BestCompression
	case "none":
		pngEncoder.CompressionLevel = png.NoCompression
	default: // "speed"
		pngEncoder.CompressionLevel = png.BestSpeed
	}
}

// encodePNG encodes a raw straight-alpha RGBA byte slice into PNG bytes.
//
// IMPORTANT: the pixel data uses straight (non-premultiplied) alpha, so we
// wrap it in an image.NRGBA view. image.RGBA would treat it as premultiplied
// and "un-premultiply" on read, corrupting semi-transparent pixels — e.g.
// yellow (255,255,0) with alpha=210 would become (54,243,0) = green.
//
// The rgba slice is only read during encoding (no copy is made); the caller
// may recycle it once encodePNG returns.
func encodePNG(rgba []byte, width, height int) ([]byte, error) {
	img := &image.NRGBA{
		Pix:    rgba,
		Stride: width * 4,
		Rect:   image.Rect(0, 0, width, height),
	}
	var buf bytes.Buffer
	if err := pngEncoder.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

var (
	emptyPNGOnce sync.Once
	emptyPNGData []byte
)

// encodeEmptyPNG returns a fully transparent PNG tile (computed once).
func encodeEmptyPNG(size int) []byte {
	emptyPNGOnce.Do(func() {
		img := image.NewNRGBA(image.Rect(0, 0, size, size))
		var buf bytes.Buffer
		_ = pngEncoder.Encode(&buf, img)
		emptyPNGData = buf.Bytes()
	})
	return emptyPNGData
}

// renderAndEncodeTile takes raw float32 data and returns encoded PNG bytes.
func renderAndEncodeTile(data []float32, band string, nodata *float64, tileSize int) ([]byte, error) {
	tb := renderTile(data, band, nodata, tileSize)
	if tb == nil {
		return encodeEmptyPNG(tileSize), nil
	}
	defer releaseTileBuffers(tb)
	return encodePNG(tb.rgba[:tileSize*tileSize*4], tileSize, tileSize)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func isFinite32(v float32) bool {
	return !math.IsNaN(float64(v)) && !math.IsInf(float64(v), 0)
}
