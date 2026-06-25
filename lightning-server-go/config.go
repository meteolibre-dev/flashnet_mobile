package main

// ============================================================================
// config.go — Band configuration and server constants
// ============================================================================

import "os"

// BandConfig describes how to render a single forecast band/channel.
type BandConfig struct {
	Name      string  `json:"name"`
	Min       float64 `json:"min"`
	Max       float64 `json:"max"`
	Colormap  string  `json:"colormap"`  // "custom" for lightning, "viridis", "plasma", etc.
	Invert    bool    `json:"invert"`
	DType     string  `json:"dtype"`
	colormap  *[256][4]byte // pre-computed 256-entry RGBA LUT (nil for custom/radar)
}

// Region bounds for point queries (matches frontend REGION)
var Region = struct {
	West, North, East, South float64
}{
	West:  -10.0,
	North: 65.0,
	East:  33.0,
	South: 33.0,
}

// Default bounds for Europe
var defaultBounds = [4]float64{-10.0, 33.0, 33.0, 65.0}

// BANDS maps band name → config. Matches the Python BANDS dict exactly.
var BANDS = map[string]*BandConfig{
	"lightning": {
		Name:     "Lightning",
		Min:      0,
		Max:      4,
		Colormap: "custom",
		Invert:   false,
	},
	"sat_ch0": {
		Name:     "Satellite Channel 0 (VIS)",
		Min:      0,
		Max:      12,
		Colormap: "viridis",
		Invert:   false,
	},
	"sat_ch1": {
		Name:     "Satellite Channel 1 (IR)",
		Min:      3,
		Max:      120,
		Colormap: "plasma",
		Invert:   true, // Inverted for IR (cold = bright)
	},
	"sat_ch2": {
		Name:     "Satellite Channel 2",
		Min:      -3,
		Max:      120,
		Colormap: "plasma",
		Invert:   true,
	},
	"radar": {
		Name:     "Rain Rate (mm/h)",
		Min:      0,
		Max:      130,
		Colormap: "custom", // Uses palette_radar_35 with log mapping
		Invert:   false,
	},
}

// LightningColorEntries is the lightning colormap as an ORDERED slice.
// Must be a slice (not a map) so iteration is deterministic — Go maps
// iterate in random order, which would let a lower-valued entry overwrite
// a higher one and produce wrong colors (e.g. green from alpha-blending).
// Entries are sorted ascending; the highest matching entry wins.
var LightningColorEntries = []struct {
	Val   int
	Color [4]byte
}{
	{0, [4]byte{255, 255, 0, 150}}, // Yellow (default for non-zero)
	{1, [4]byte{255, 255, 0, 180}}, // Yellow
	{2, [4]byte{255, 200, 0, 210}}, // Orange-yellow
	{3, [4]byte{255, 100, 0, 230}}, // Orange
	{4, [4]byte{255, 0, 0, 255}},   // Red
}

// LightningDefaultColor is the fallback for non-zero pixels that don't
// match any threshold (shouldn't normally happen).
var LightningDefaultColor = [4]byte{255, 255, 0, 150}

// Environment-driven configuration
var (
	BucketBaseURL = envOr("BUCKET_BASE_URL", "gs://inference_result_meteolibre_forecast/forecasts")
	Port          = envOr("PORT", "3001")

	// Tile cache
	TileCacheMaxSize = atoiOr(envOr("TILE_CACHE_MAX_SIZE", "2000"), 2000)

	// COG dataset pool (keep GDAL datasets open for reuse)
	COGPoolMaxSize = atoiOr(envOr("COG_POOL_MAX_SIZE", "50"), 50)
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func atoiOr(s string, fallback int) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return fallback
		}
		n = n*10 + int(c-'0')
	}
	if n == 0 {
		return fallback
	}
	return n
}

// extractRunDate extracts the date portion from a run_time string.
// run_time format: "YYYY-MM-DD_HH-MM_region" → "YYYY-MM-DD"
func extractRunDate(runTime string) string {
	for i, c := range runTime {
		if c == '_' {
			return runTime[:i]
		}
	}
	return runTime
}

func bandNames() []string {
	names := make([]string, 0, len(BANDS))
	for name := range BANDS {
		names = append(names, name)
	}
	return names
}
