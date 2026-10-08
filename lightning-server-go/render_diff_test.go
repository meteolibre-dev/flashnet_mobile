package main

// ============================================================================
// render_diff_test.go — Correctness: new optimized renderers vs the original
// reference implementations (verbatim copies of the pre-optimization code).
// ----------------------------------------------------------------------------
// Guarantees:
//   - lightning / satellite (generic LUT): output must be byte-identical.
//   - radar: the dBZ LUT may shift a pixel's color by one palette step when
//     the exact value sits within ~0.01 dB of a class boundary. The test
//     asserts the fraction of differing pixels stays negligible (< 0.5%).
//   - PNG BestSpeed vs DefaultCompression: decoded pixels must be identical.
// ============================================================================

import (
	"bytes"
	"image"
	"image/png"
	"math"
	"math/rand"
	"testing"
)

// ── Reference implementations (original code, unchanged) ──────────────────

func refRenderRadar(data []float32, rgba []byte, nodataMask []bool, tileSize int) {
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
		dataNorm := (logRate[i] - float32(radarLogMin)) / float32(radarLogMax-radarLogMin)
		if dataNorm < 0 {
			dataNorm = 0
		}
		if dataNorm > 1 {
			dataNorm = 1
		}
		idx := int(dataNorm * 255)
		if idx < 1 {
			idx = 0
		}
		c := RadarLUT[idx]
		rgba[off] = c[0]
		rgba[off+1] = c[1]
		rgba[off+2] = c[2]
		rgba[off+3] = c[3]
	}
}

func refBuildMask(data []float32, nodataMask []bool, nodata *float64) {
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
}

// ── Test data generators ───────────────────────────────────────────────────

func diffRadarData(r *rand.Rand) []float32 {
	// Adversarial mix: full range, values hovering exactly at 0.01 dB grid
	// points (worst case for LUT quantization), boundaries, specials.
	n := 256 * 256
	data := make([]float32, n)
	specials := []float32{0, -0.001, 0.001, 0.005, 0.01, 0.5, 1, 5, 10, 15.5,
		20, 25.7, 30, 35, 40, 45.3, 50, 55, 60, 65, 70, 80, 95, 99.99, 100,
		120, 1000, float32(math.NaN()), float32(math.Inf(1)), float32(math.Inf(-1)), -9999}
	for i := range data {
		switch r.Intn(4) {
		case 0:
			data[i] = specials[r.Intn(len(specials))]
		case 1: // exactly on the 0.01 dB grid
			data[i] = float32(float64(r.Intn(10001)) * 0.01)
		case 2: // just off the grid
			data[i] = float32(float64(r.Intn(10001))*0.01 + 0.0049)
		default:
			data[i] = r.Float32() * 120
		}
	}
	return data
}

// ── Tests ─────────────────────────────────────────────────────────────────

func TestRadarLUTMatchesReference(t *testing.T) {
	r := rand.New(rand.NewSource(42))
	var nd float64 = -9999

	for round := 0; round < 10; round++ {
		data := diffRadarData(r)
		n := len(data)

		// Reference
		refRGBA := make([]byte, n*4)
		refMask := make([]bool, n)
		refBuildMask(data, refMask, &nd)
		refRenderRadar(data, refRGBA, refMask, 256)

		// Optimized
		tb := renderTile(data, "radar", &nd, 256)
		if tb == nil {
			t.Fatal("renderTile returned nil for radar")
		}

		diff, worst := 0, 0
		for i := 0; i < n; i++ {
			o := i * 4
			a := refRGBA[o : o+4 : o+4]
			b := tb.rgba[o : o+4 : o+4]
			if a[0] != b[0] || a[1] != b[1] || a[2] != b[2] || a[3] != b[3] {
				diff++
				worst = i
			}
		}
		frac := float64(diff) / float64(n)
		t.Logf("round %d: %d/%d pixels differ (%.4f%%)", round, diff, n, frac*100)
		if diff > 0 {
			o := worst * 4
			t.Logf("  example: dbz=%g ref=%v new=%v", data[worst],
				refRGBA[o:o+4], tb.rgba[o:o+4])
		}
		if frac > 0.005 {
			t.Fatalf("radar LUT divergence too high: %.4f%% (round %d)", frac*100, round)
		}
		releaseTileBuffers(tb)
	}
}

func TestLightningGenericByteIdentical(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	var nd float64 = -9999
	n := 256 * 256

	cases := []struct {
		band  string
		min   float32
		max   float32
		nodat *float64
	}{
		{"lightning", 0, 4, nil},
		{"lightning", 0, 4, &nd},
		{"sat_ch0", 0, 12, &nd},
		{"sat_ch1", 3, 120, &nd},
		{"sat_ch2", -3, 120, &nd},
	}

	for _, tc := range cases {
		data := make([]float32, n)
		for i := range data {
			p := r.Float64()
			switch {
			case p < 0.10:
				data[i] = float32(math.NaN())
			case p < 0.20:
				data[i] = -9999
			default:
				data[i] = tc.min + r.Float32()*(tc.max-tc.min)
			}
		}

		// Reference: original two-step (mask build + render), copied logic
		refRGBA := make([]byte, n*4)
		refMask := make([]bool, n)
		refBuildMask(data, refMask, tc.nodat)
		if tc.band == "lightning" {
			renderLightningTile(data, refRGBA, refMask, BANDS[tc.band], 256)
		} else {
			renderGenericTile(data, refRGBA, refMask, BANDS[tc.band], 256)
		}

		tb := renderTile(data, tc.band, tc.nodat, 256)
		if tb == nil {
			t.Fatalf("renderTile returned nil for %s", tc.band)
		}
		for i := 0; i < n*4; i++ {
			if refRGBA[i] != tb.rgba[i] {
				t.Fatalf("%s: byte %d differs: ref=%d new=%d (pixel %d)",
					tc.band, i, refRGBA[i], tb.rgba[i], i/4)
			}
		}
		releaseTileBuffers(tb)
		t.Logf("%s: byte-identical over %d pixels", tc.band, n)
	}
}

func TestPNGBestSpeedPixelIdentical(t *testing.T) {
	data := makeBenchTile(256*256, 1, 5, 65, 0.25, 0.30)
	var nd float64 = -9999
	tb := renderTile(data, "radar", &nd, 256)
	defer releaseTileBuffers(tb)

	speedEnc := &png.Encoder{CompressionLevel: png.BestSpeed}
	defEnc := &png.Encoder{CompressionLevel: png.DefaultCompression}
	img := &image.NRGBA{Pix: tb.rgba, Stride: 256 * 4, Rect: image.Rect(0, 0, 256, 256)}

	var b1, b2 bytes.Buffer
	if err := speedEnc.Encode(&b1, img); err != nil {
		t.Fatal(err)
	}
	if err := defEnc.Encode(&b2, img); err != nil {
		t.Fatal(err)
	}

	d1, err1 := png.Decode(bytes.NewReader(b1.Bytes()))
	d2, err2 := png.Decode(bytes.NewReader(b2.Bytes()))
	if err1 != nil || err2 != nil {
		t.Fatalf("decode failed: %v %v", err1, err2)
	}
	if d1.Bounds() != d2.Bounds() {
		t.Fatal("bounds differ")
	}
	for y := 0; y < 256; y++ {
		for x := 0; x < 256; x++ {
			r1, g1, b1_, a1 := d1.At(x, y).RGBA()
			r2, g2, b2_, a2 := d2.At(x, y).RGBA()
			if r1 != r2 || g1 != g2 || b1_ != b2_ || a1 != a2 {
				t.Fatalf("pixel (%d,%d) differs between BestSpeed and Default", x, y)
			}
		}
	}
	t.Logf("PNG sizes: BestSpeed=%d bytes Default=%d bytes (%.1f%%)",
		b1.Len(), b2.Len(), float64(b1.Len())/float64(b2.Len())*100)
}
