package main

// ============================================================================
// config.go — Band configuration and server constants (global model)
// ============================================================================

import (
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
)

// BandConfig describes how to render a single forecast band/channel.
//
// The global model stores multiple raster bands inside a single file
// (forecast_{ts}_sat.tif holds IR in raster band 1 and VIS in raster band 2),
// so each logical band maps to a file band suffix + a 1-based raster index.
type BandConfig struct {
	Name     string  `json:"name"`
	Min      float64 `json:"min"`
	Max      float64 `json:"max"`
	Colormap string  `json:"colormap"` // "viridis", "plasma"
	Invert   bool    `json:"invert"`
	DType    string  `json:"dtype"`

	FileBand  string `json:"-"` // filename suffix, e.g. "sat" → forecast_{ts}_sat.tif
	BandIndex int    `json:"-"` // 1-based raster band within the file

	colormap *[256][4]byte // pre-computed 256-entry RGBA LUT
}

// Region bounds for point queries — the global model covers the whole world.
var Region = struct {
	West, North, East, South float64
}{
	West:  -180.0,
	North: 90.0,
	East:  180.0,
	South: -90.0,
}

// Default bounds for the globe [west, south, east, north]
var defaultBounds = [4]float64{-180.0, -90.0, 180.0, 90.0}

// BANDS maps logical band name → config. Both channels are served from the
// same forecast_{ts}_sat.tif COG: raster band 1 = IR (sat_ch0), raster band 2 = VIS (sat_ch1).
// Observed value ranges (global 0.1° model): band 1 ≈ 0…250, band 2 ≈ -32…250.
var BANDS = map[string]*BandConfig{
	"sat_ch0": {
		Name:      "Satellite Channel 0 (IR)",
		Min:       0,
		Max:       250,
		Colormap:  "plasma",
		Invert:    true, // Inverted colormap (cold = bright)
		DType:     "float32",
		FileBand:  "sat",
		BandIndex: 1,
	},
	"sat_ch1": {
		Name:      "Satellite Channel 1 (VIS)",
		Min:       -35,
		Max:       250,
		Colormap:  "viridis",
		Invert:    false,
		DType:     "float32",
		FileBand:  "sat",
		BandIndex: 2,
	},
}

// fileBandToLogical maps a filename band suffix ("sat") to the logical bands
// it provides. Used when scanning the bucket for available timesteps.
var fileBandToLogical = func() map[string][]string {
	m := make(map[string][]string)
	for name, cfg := range BANDS {
		m[cfg.FileBand] = append(m[cfg.FileBand], name)
	}
	for _, v := range m {
		sort.Strings(v)
	}
	return m
}()

// Environment-driven configuration
var (
	BucketBaseURL = envOr("BUCKET_BASE_URL", "gs://inference_result_flashedges_forecast/forecasts")
	Port          = envOr("PORT", "3002")

	// Tile cache
	TileCacheMaxSize = atoiOr(envOr("TILE_CACHE_MAX_SIZE", "2000"), 2000)

	// COG dataset pool (keep GDAL datasets open for reuse)
	COGPoolMaxSize = atoiOr(envOr("COG_POOL_MAX_SIZE", "50"), 50)
)

func init() {
	// Allow per-band range overrides via env, e.g. SAT_CH0_MIN / SAT_CH0_MAX.
	// Useful to tune rendering without rebuilding the image.
	for name, cfg := range BANDS {
		envPrefix := "BAND_" + strings.ToUpper(name)
		if v := os.Getenv(envPrefix + "_MIN"); v != "" {
			if f, err := strconv.ParseFloat(v, 64); err == nil {
				cfg.Min = f
			}
		}
		if v := os.Getenv(envPrefix + "_MAX"); v != "" {
			if f, err := strconv.ParseFloat(v, 64); err == nil {
				cfg.Max = f
			}
		}
	}
}

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
// run_time format: "YYYYMMDD_HHMM" → "YYYYMMDD"
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
	sort.Strings(names)
	return names
}

// getBandConfig returns the config for a logical band, or an error.
func getBandConfig(band string) (*BandConfig, error) {
	cfg, ok := BANDS[band]
	if !ok {
		return nil, fmt.Errorf("invalid band: %s", band)
	}
	return cfg, nil
}

func sortStrings(s []string) {
	sort.Strings(s)
}
