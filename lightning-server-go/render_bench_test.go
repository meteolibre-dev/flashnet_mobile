package main

// ============================================================================
// render_bench_test.go — Micro-benchmarks for the tile render hot path.
// ----------------------------------------------------------------------------
// Measures the CPU-side pipeline (colormap → RGBA → PNG encode → ETag) in
// isolation, without GDAL/GCS. Run with:
//
//	go test -bench=. -benchmem -run='^$' -count=5 | tee bench_out.txt
//
// Data mixes approximate real tiles: ~30% nodata (NaN), ~25% zero/transparent,
// rest uniform in the band's physical range.
// ============================================================================

import (
	"crypto/md5"
	"math"
	"math/rand"
	"testing"
)

func makeBenchTile(n int, seed int64, min, max float32, zeroFrac, nodataFrac float64) []float32 {
	r := rand.New(rand.NewSource(seed))
	data := make([]float32, n)
	for i := range data {
		p := r.Float64()
		switch {
		case p < nodataFrac:
			data[i] = float32(math.NaN())
		case p < nodataFrac+zeroFrac:
			data[i] = 0
		default:
			data[i] = min + r.Float32()*(max-min)
		}
	}
	return data
}

const benchTileSize = 256

// ── Per-band render (colormap application) ────────────────────────────────

func BenchmarkRenderRadar(b *testing.B) {
	data := makeBenchTile(benchTileSize*benchTileSize, 1, 5, 65, 0.25, 0.30)
	var nd float64 = -9999
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		rgba := generateTileRGBA(data, "radar", &nd, benchTileSize)
		if rgba == nil {
			b.Fatal("nil rgba")
		}
	}
}

func BenchmarkRenderLightning(b *testing.B) {
	data := makeBenchTile(benchTileSize*benchTileSize, 2, 0, 4, 0.25, 0.30)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		rgba := generateTileRGBA(data, "lightning", nil, benchTileSize)
		if rgba == nil {
			b.Fatal("nil rgba")
		}
	}
}

func BenchmarkRenderSatellite(b *testing.B) {
	// sat_ch1: plasma colormap, generic LUT path
	data := makeBenchTile(benchTileSize*benchTileSize, 3, 3, 120, 0.25, 0.30)
	var nd float64 = -9999
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		rgba := generateTileRGBA(data, "sat_ch1", &nd, benchTileSize)
		if rgba == nil {
			b.Fatal("nil rgba")
		}
	}
}

// ── PNG encoding of a rendered radar tile ─────────────────────────────────

func BenchmarkEncodePNG(b *testing.B) {
	data := makeBenchTile(benchTileSize*benchTileSize, 1, 5, 65, 0.25, 0.30)
	var nd float64 = -9999
	rgba := generateTileRGBA(data, "radar", &nd, benchTileSize)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := encodePNG(rgba[:benchTileSize*benchTileSize*4], benchTileSize, benchTileSize); err != nil {
			b.Fatal(err)
		}
	}
}

// ── Full pipeline (render + encode), as used per cache-miss ───────────────

func BenchmarkPipelineRadar(b *testing.B) {
	data := makeBenchTile(benchTileSize*benchTileSize, 1, 5, 65, 0.25, 0.30)
	var nd float64 = -9999
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := renderAndEncodeTile(data, "radar", &nd, benchTileSize); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkPipelineLightning(b *testing.B) {
	data := makeBenchTile(benchTileSize*benchTileSize, 2, 0, 4, 0.25, 0.30)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := renderAndEncodeTile(data, "lightning", nil, benchTileSize); err != nil {
			b.Fatal(err)
		}
	}
}

// ── ETag computation (md5 over 256 KB of RGBA) ────────────────────────────

func BenchmarkETagMD5(b *testing.B) {
	data := makeBenchTile(benchTileSize*benchTileSize, 1, 5, 65, 0.25, 0.30)
	var nd float64 = -9999
	rgba := generateTileRGBA(data, "radar", &nd, benchTileSize)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = md5.Sum(rgba[:256*256*4])
	}
}
