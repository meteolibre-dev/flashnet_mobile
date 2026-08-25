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
	Colormap string  `json:"colormap"` // "viridis", "plasma", "greyscale", "ir_enhanced"
	Invert   bool    `json:"invert"`
	DType    string  `json:"dtype"`

	FileBand  string `json:"-"` // filename suffix, e.g. "sat" → forecast_{ts}_sat.tif
	BandIndex int    `json:"-"` // 1-based raster band within the file

	// SplitValue: for two-segment colormaps (ir_enhanced): the data value
	// where the warm greys segment ends and the cold spectral segment begins.
	SplitValue float64 `json:"-"`

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

// BANDS maps logical band name → config.
//
// Satellite channels come from the forecast_{ts}_sat.tif COG:
// raster band 1 = IR (sat_ch0), raster band 2 = VIS (sat_ch1).
//
// The GMGSI channels are stored on a dimensionless 0–255 source imagery
// scale (digital counts / scaled radiance, per NOAA GMGSI docs; the dataset
// stats agree — lwir mean is 123 ± 43, not Kelvin-like). For LWIR the counts
// follow the display convention: low value = warm surface, high value =
// cold/bright cloud top (verified empirically on forecast data: Sahara ≈ 20,
// Congo ITCZ tops ≈ 220). sat_ch1 (VIS) is reflectance-like: high value =
// bright cloud. Rendering accordingly:
//   - sat_ch0: 10 … 230 counts over the enhanced-IR palette, mapped in two
//     segments like trollimage's `spectral + greys` example: values ≤ Split
//     (default 150 — light cloud / surface) render on the greyscale ramp,
//     values > Split (cold cloud tops) on the spectral ramp (black/red at the
//     coldest). Values < 10 are polar-night/sensor fill → rendered
//     transparent by the min-clamp.
//   - sat_ch1: −35 … 250 reflectance counts, greyscale with bright clouds
//     rendered white (Invert flips the white→black base LUT).
//
// METAR channels come from the forecast_{ts}_metar.tif COG (7 raster bands,
// channel order mirrors METAR_FEATURES in the dataset generator):
//   1=tmpc(°C), 2=dwpc(°C), 3=mslp(hPa), 4=cloud_cover(0..1),
//   5=p01m(dBZ), 6=wind_u(m/s), 7=wind_v(m/s)
// Values outside real METAR ranges (e.g. the -10000 NaN sentinel) are simply
// clamped by the renderers; /point returns them raw.
var BANDS = map[string]*BandConfig{
	"sat_ch0": {
		Name:      "Satellite Channel 0 (IR)",
		Min:       10,
		Max:       230,
		Colormap:  "ir_enhanced",
		Invert:    false, // LUT is built in data orientation (see palette.go)
		DType:     "float32",
		FileBand:  "sat",
		BandIndex: 1,
		SplitValue: 150, // greys ≤ 150 counts ≤ spectral (cold tops)
	},
	"sat_ch1": {
		Name:      "Satellite Channel 1 (VIS)",
		Min:       -35,
		Max:       250,
		Colormap:  "greyscale",
		Invert:    true, // high reflectance (bright clouds) → white
		DType:     "float32",
		FileBand:  "sat",
		BandIndex: 2,
	},
	"metar_tmpc": {
		Name:      "METAR Temperature (°C)",
		Min:       -50,
		Max:       50,
		Colormap:  "viridis",
		Invert:    false,
		DType:     "float32",
		FileBand:  "metar",
		BandIndex: 1,
	},
	"metar_dwpc": {
		Name:      "METAR Dew Point (°C)",
		Min:       -50,
		Max:       50,
		Colormap:  "viridis",
		Invert:    false,
		DType:     "float32",
		FileBand:  "metar",
		BandIndex: 2,
	},
	"metar_mslp": {
		Name:      "METAR Mean Sea Level Pressure (hPa)",
		Min:       950,
		Max:       1050,
		Colormap:  "viridis",
		Invert:    false,
		DType:     "float32",
		FileBand:  "metar",
		BandIndex: 3,
	},
	"metar_cloud_cover": {
		Name:      "METAR Cloud Cover (0-1)",
		Min:       0,
		Max:       1,
		Colormap:  "viridis",
		Invert:    false,
		DType:     "float32",
		FileBand:  "metar",
		BandIndex: 4,
	},
	"metar_p01m": {
		Name:      "METAR Precipitation (dBZ)",
		Min:       -5,
		Max:       70,
		Colormap:  "plasma",
		Invert:    false,
		DType:     "float32",
		FileBand:  "metar",
		BandIndex: 5,
	},
	"metar_wind_u": {
		Name:      "METAR Wind U Component (m/s)",
		Min:       -40,
		Max:       40,
		Colormap:  "viridis",
		Invert:    false,
		DType:     "float32",
		FileBand:  "metar",
		BandIndex: 6,
	},
	"metar_wind_v": {
		Name:      "METAR Wind V Component (m/s)",
		Min:       -40,
		Max:       40,
		Colormap:  "viridis",
		Invert:    false,
		DType:     "float32",
		FileBand:  "metar",
		BandIndex: 7,
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
	// Allow per-band overrides via env, e.g. SAT_CH0_MIN / SAT_CH0_MAX (also
	// _COLORMAP / _INVERT). Useful to tune rendering without rebuilding the
	// image.
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
		if v := os.Getenv(envPrefix + "_SPLIT"); v != "" {
			if f, err := strconv.ParseFloat(v, 64); err == nil {
				cfg.SplitValue = f
			}
		}
		if v := os.Getenv(envPrefix + "_COLORMAP"); v != "" {
			cfg.Colormap = v
		}
		if v := os.Getenv(envPrefix + "_INVERT"); v != "" {
			b, err := strconv.ParseBool(v)
			cfg.Invert = err == nil && b
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
