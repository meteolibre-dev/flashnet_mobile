package main

// ============================================================================
// handlers.go — HTTP request handlers (all endpoints)
// ============================================================================

import (
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var tileCache = NewLRUCache(TileCacheMaxSize)

// Cache-Control header helpers
func setCacheHeaders(w http.ResponseWriter, maxAge int) {
	w.Header().Set("Cache-Control", fmt.Sprintf("public, max-age=%d", maxAge))
}

func setNoStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
}

// JSON helper
func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"detail": msg})
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

func registerRoutes(mux *http.ServeMux) {
	// Health & info
	mux.HandleFunc("/", handleRoot)
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/bands", handleBands)

	// Discovery
	mux.HandleFunc("/times", handleTimes)
	mux.HandleFunc("/available", handleAvailableHTTP)
	mux.HandleFunc("/history/dates", handleHistoryDatesHTTP)
	mux.HandleFunc("/history/dates/", handleHistoryDateRunsHTTP)
	mux.HandleFunc("/times/", handleCheckTimestamp)

	// Tiles & raster
	mux.HandleFunc("/tiles/", handleTilePNG)
	mux.HandleFunc("/tilejson", handleTileJSON)
	mux.HandleFunc("/bounds", handleBounds)
	mux.HandleFunc("/info", handleInfo)
	mux.HandleFunc("/point", handlePoint)
	mux.HandleFunc("/preview", handlePreview)

	// Cache management
	mux.HandleFunc("/cache/stats", handleCacheStats)
	mux.HandleFunc("/cache/clear", handleCacheClear)
}

// ---------------------------------------------------------------------------
// CORS middleware
// ---------------------------------------------------------------------------

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "*")
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Recovery middleware — catches panics from GDAL and returns 500
func recoveryMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("PANIC: %v (path=%s)", rec, r.URL.Path)
				writeError(w, 500, fmt.Sprintf("internal error: %v", rec))
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// ---------------------------------------------------------------------------
// Health & info endpoints
// ---------------------------------------------------------------------------

func handleRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	setNoStore(w)
	writeJSON(w, 200, map[string]interface{}{
		"name":        "Lightning Server Go",
		"version":     "1.0.0",
		"description": "COG-based tile server for weather forecasting (Go rewrite)",
		"bands":       bandNames(),
		"data_source": BucketBaseURL,
		"endpoints": []string{
			"/health", "/bands", "/times", "/available",
			"/tiles/{z}/{x}/{y}.png", "/tilejson", "/bounds",
			"/info", "/point", "/preview", "/cache/stats",
		},
	})
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	setNoStore(w)
	writeJSON(w, 200, map[string]string{
		"status":  "ok",
		"service": "lightning-server-go",
	})
}

func handleBands(w http.ResponseWriter, r *http.Request) {
	setCacheHeaders(w, 300)
	result := make(map[string]interface{})
	for name, cfg := range BANDS {
		result[name] = map[string]interface{}{
			"name":      cfg.Name,
			"min":       cfg.Min,
			"max":       cfg.Max,
			"colormap":  cfg.Colormap,
			"invert":    cfg.Invert,
			"dtype":     cfg.DType,
		}
	}
	writeJSON(w, 200, result)
}

func handleTimes(w http.ResponseWriter, r *http.Request) {
	setCacheHeaders(w, 60)
	hours := clampInt(queryInt(r, "hours", 24), 1, 72)
	now := time.Now().UTC()

	timestamps := make([]map[string]string, hours)
	for i := 0; i < hours; i++ {
		d := now.Add(-time.Duration(i) * time.Hour)
		timestamps[i] = map[string]string{
			"timestamp": d.Format("200601021504"),
			"datetime":  d.Format("2006-01-02T15:04:05Z"),
		}
	}
	writeJSON(w, 200, map[string]interface{}{
		"timestamps": timestamps,
		"count":      len(timestamps),
	})
}

// ---------------------------------------------------------------------------
// /available
// ---------------------------------------------------------------------------

func handleAvailableHTTP(w http.ResponseWriter, r *http.Request) {
	setCacheHeaders(w, 60)
	days := clampInt(queryInt(r, "days", 2), 1, 7)
	band := queryString(r, "band", "lightning")

	resp, err := handleAvailable(r.Context(), days, band)
	if err != nil {
		writeError(w, 500, fmt.Sprintf("Error scanning bucket: %s", err))
		return
	}
	writeJSON(w, 200, resp)
}

// ---------------------------------------------------------------------------
// /history/dates and /history/dates/{date}
// ---------------------------------------------------------------------------

func handleHistoryDatesHTTP(w http.ResponseWriter, r *http.Request) {
	setCacheHeaders(w, 60)
	days := clampInt(queryInt(r, "days", 30), 1, 90)

	resp, err := handleHistoryDates(r.Context(), days)
	if err != nil {
		writeError(w, 500, fmt.Sprintf("Error scanning dates: %s", err))
		return
	}
	writeJSON(w, 200, resp)
}

var dateRe = regexp.MustCompile(`^/history/dates/(\d{4}-\d{2}-\d{2})/?$`)

func handleHistoryDateRunsHTTP(w http.ResponseWriter, r *http.Request) {
	setCacheHeaders(w, 60)

	m := dateRe.FindStringSubmatch(r.URL.Path)
	if m == nil {
		writeError(w, 400, "Date must be in path as YYYY-MM-DD")
		return
	}
	date := m[1]
	if _, err := time.Parse("2006-01-02", date); err != nil {
		writeError(w, 400, "Invalid date")
		return
	}

	band := queryString(r, "band", "lightning")
	resp, err := handleHistoryDateRuns(r.Context(), date, band)
	if err != nil {
		writeError(w, 500, fmt.Sprintf("Error scanning date %s: %s", date, err))
		return
	}
	writeJSON(w, 200, resp)
}

// ---------------------------------------------------------------------------
// /times/{timestamp}
// ---------------------------------------------------------------------------

func handleCheckTimestamp(w http.ResponseWriter, r *http.Request) {
	setNoStore(w)
	parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/times/"), "/", 2)
	if len(parts) == 0 || parts[0] == "" {
		writeError(w, 400, "Timestamp required")
		return
	}
	ts := parts[0]

	results := make(map[string]interface{})
	for band := range BANDS {
		url := getCOGUrl(ts, band, "")
		results[band] = map[string]interface{}{
			"url":     url,
			"checked": false,
		}
	}
	writeJSON(w, 200, map[string]interface{}{
		"timestamp": ts,
		"bands":     results,
	})
}

// ---------------------------------------------------------------------------
// /tiles/{z}/{x}/{y}.png — THE HOT PATH
// ---------------------------------------------------------------------------

var tilePathRe = regexp.MustCompile(`^/tiles/(\d+)/(\d+)/(\d+)\.png$`)

func handleTilePNG(w http.ResponseWriter, r *http.Request) {
	m := tilePathRe.FindStringSubmatch(r.URL.Path)
	if m == nil {
		http.NotFound(w, r)
		return
	}

	z, _ := strconv.Atoi(m[1])
	x, _ := strconv.Atoi(m[2])
	y, _ := strconv.Atoi(m[3])
	band := queryString(r, "band", "")
	timeStr := queryString(r, "time", "")
	runTime := queryString(r, "run_time", "")

	if band == "" || timeStr == "" {
		writeError(w, 400, "band and time are required")
		return
	}

	if _, ok := BANDS[band]; !ok {
		writeError(w, 400, fmt.Sprintf("Invalid band: %s", band))
		return
	}

	cacheKey := CacheKey{Z: z, X: x, Y: y, Band: band, Time: timeStr, RunTime: runTime}

	// Check LRU cache
	if cached, ok := tileCache.Get(cacheKey); ok {
		setCacheHeaders(w, 300)
		w.Header().Set("X-Cache", "HIT")
		w.Header().Set("Content-Type", "image/png")
		w.Write(cached)
		return
	}

	// Generate tile
	url := getCOGUrl(timeStr, band, runTime)

	// Retry logic for transient GCS/network errors
	var rgba *[256 * 256 * 4]byte
	maxRetries := 3

	for attempt := 0; attempt < maxRetries; attempt++ {
		data, nodata, err := readTile(url, z, x, y, 256)
		if err != nil {
			if attempt < maxRetries-1 {
				log.Printf("Retry %d for tile %d/%d/%d band=%s: %v", attempt+1, z, x, y, band, err)
				time.Sleep(time.Duration(500*(attempt+1)) * time.Millisecond)
				continue
			}
			// On final failure, return empty tile
			pngBytes := encodeEmptyPNG(256)
			tileCache.Put(cacheKey, pngBytes)
			setCacheHeaders(w, 300)
			w.Header().Set("X-Cache", "MISS")
			w.Header().Set("Content-Type", "image/png")
			w.Write(pngBytes)
			return
		}

		rgba = generateTileRGBA(data, band, nodata, 256)
		break
	}

	var pngBytes []byte
	if rgba == nil {
		pngBytes = encodeEmptyPNG(256)
	} else {
		pngBytes, _ = encodePNG(rgba[:256*256*4], 256, 256)
	}

	// Cache it
	tileCache.Put(cacheKey, pngBytes)

		// Compute ETag (only for non-empty tiles)
	if rgba != nil {
		hash := md5.Sum(rgba[:256*256*4])
		etag := hex.EncodeToString(hash[:])
		w.Header().Set("ETag", fmt.Sprintf(`"%s"`, etag))
	}

	setCacheHeaders(w, 300)
	w.Header().Set("X-Cache", "MISS")
	w.Header().Set("Content-Type", "image/png")
	w.Write(pngBytes)
}

// ---------------------------------------------------------------------------
// /tilejson
// ---------------------------------------------------------------------------

func handleTileJSON(w http.ResponseWriter, r *http.Request) {
	setCacheHeaders(w, 300)
	band := queryString(r, "band", "")
	timeStr := queryString(r, "time", "")
	runTime := queryString(r, "run_time", "")

	if _, ok := BANDS[band]; !ok {
		writeError(w, 400, fmt.Sprintf("Invalid band: %s", band))
		return
	}

	url := getCOGUrl(timeStr, band, runTime)
	info, err := getCOGInfo(url)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}

	bounds := info.Bounds
	if !allFinite(bounds[:]) {
		bounds = defaultBounds
	}

	writeJSON(w, 200, map[string]interface{}{
		"tilejson": "2.1.0",
		"name":     fmt.Sprintf("%s - %s", BANDS[band].Name, timeStr),
		"version":  "1.0.0",
		"scheme":   "xyz",
		"tiles":    []string{fmt.Sprintf("/tiles/{z}/{x}/{y}.png?band=%s&time=%s", band, timeStr)},
		"bounds":   []float64{bounds[0], bounds[1], bounds[2], bounds[3]},
		"center":   []float64{(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2, 4},
		"minzoom":  0,
		"maxzoom":  12,
	})
}

// ---------------------------------------------------------------------------
// /bounds
// ---------------------------------------------------------------------------

func handleBounds(w http.ResponseWriter, r *http.Request) {
	setCacheHeaders(w, 300)
	band := queryString(r, "band", "")
	timeStr := queryString(r, "time", "")
	runTime := queryString(r, "run_time", "")

	if _, ok := BANDS[band]; !ok {
		writeError(w, 400, fmt.Sprintf("Invalid band: %s", band))
		return
	}

	url := getCOGUrl(timeStr, band, runTime)
	info, err := getCOGInfo(url)
	if err != nil {
		writeJSON(w, 200, map[string]interface{}{
			"url":      url,
			"bounds":   defaultBounds[:],
			"crs":      "EPSG:4326",
			"size":     nil,
			"nodata":   nil,
			"overviews": []int{},
			"error":    "File not found, using default bounds",
		})
		return
	}

	bounds := info.Bounds
	if !allFinite(bounds[:]) {
		bounds = defaultBounds
	}

	writeJSON(w, 200, map[string]interface{}{
		"url":       url,
		"bounds":    []float64{bounds[0], bounds[1], bounds[2], bounds[3]},
		"crs":       "EPSG:4326",
		"size":      []int{info.Width, info.Height},
		"nodata":    info.Nodata,
		"overviews": info.Overviews,
	})
}

// ---------------------------------------------------------------------------
// /info
// ---------------------------------------------------------------------------

func handleInfo(w http.ResponseWriter, r *http.Request) {
	setCacheHeaders(w, 300)
	band := queryString(r, "band", "")
	timeStr := queryString(r, "time", "")
	runTime := queryString(r, "run_time", "")

	cfg, ok := BANDS[band]
	if !ok {
		writeError(w, 400, fmt.Sprintf("Invalid band: %s", band))
		return
	}

	url := getCOGUrl(timeStr, band, runTime)
	info, err := getCOGInfo(url)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}

	bounds := info.Bounds
	boundsCleaned := make([]*float64, 4)
	for i, v := range bounds {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			boundsCleaned[i] = nil
		} else {
			boundsCleaned[i] = &v
		}
	}

	writeJSON(w, 200, map[string]interface{}{
		"url":        url,
		"driver":     "GTiff",
		"crs":        "EPSG:4326",
		"bounds":     boundsCleaned,
		"size":       []int{info.Width, info.Height},
		"nodata":     info.Nodata,
		"overviews":  info.Overviews,
		"band_config": map[string]interface{}{
			"name":      cfg.Name,
			"min":       cfg.Min,
			"max":       cfg.Max,
			"colormap":  cfg.Colormap,
			"invert":    cfg.Invert,
		},
	})
}

// ---------------------------------------------------------------------------
// /point — time series at a coordinate
// ---------------------------------------------------------------------------

func handlePoint(w http.ResponseWriter, r *http.Request) {
	setNoStore(w)
	lat := queryFloat(r, "lat", 0)
	lon := queryFloat(r, "lon", 0)
	band := queryString(r, "band", "lightning")

	cfg, ok := BANDS[band]
	if !ok {
		writeError(w, 400, fmt.Sprintf("Invalid band: %s", band))
		return
	}

	// Validate coordinates
	if lat < Region.South || lat > Region.North || lon < Region.West || lon > Region.East {
		writeError(w, 400, fmt.Sprintf("Coordinates out of bounds. Region: W=%v S=%v E=%v N=%v",
			Region.West, Region.South, Region.East, Region.North))
		return
	}

	// Get available timestamps
	available, err := handleAvailable(r.Context(), 2, band)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}

	// Sample last 18 timesteps
	tsList := available.Timestamps
	startIdx := 0
	if len(tsList) > 18 {
		startIdx = len(tsList) - 18
	}

	isRadar := band == "radar"
	results := make([]map[string]interface{}, 0)
	for i := startIdx; i < len(tsList); i++ {
		ts := tsList[i].Timestamp

		url := getCOGUrl(ts, band, tsList[i].RunTime)
		val, err := readPoint(url, lat, lon)

		if err != nil {
			results = append(results, map[string]interface{}{
				"timestamp": ts,
				"value":     nil,
			})
			continue
		}

		if isRadar {
			val = dbzToMmh(val)
			// Round to 2 decimal places
			val = math.Round(val*100) / 100
		}

		results = append(results, map[string]interface{}{
			"timestamp": ts,
			"value":     val,
		})
	}

	_ = cfg // used for band validation

	writeJSON(w, 200, map[string]interface{}{
		"coordinates": map[string]float64{"lat": lat, "lon": lon},
		"band":        band,
		"timesteps":   results,
	})
}

// ---------------------------------------------------------------------------
// /preview — full-extent PNG image
// ---------------------------------------------------------------------------

func handlePreview(w http.ResponseWriter, r *http.Request) {
	setCacheHeaders(w, 300)
	band := queryString(r, "band", "")
	timeStr := queryString(r, "time", "")
	width := clampInt(queryInt(r, "width", 1024), 256, 4096)
	height := clampInt(queryInt(r, "height", 1024), 256, 4096)

	if _, ok := BANDS[band]; !ok {
		writeError(w, 400, fmt.Sprintf("Invalid band: %s", band))
		return
	}

	// Cap to 2048
	if width > 2048 {
		width = 2048
	}
	if height > 2048 {
		height = 2048
	}

	if !verifyCogFileReady(timeStr, band) {
		writeError(w, 404, "File not ready or still uploading")
		return
	}

	url := getCOGUrl(timeStr, band, "")
	data, imgW, imgH, nodata, err := readPreview(url, width, height)
	if err != nil {
		writeError(w, 500, fmt.Sprintf("Error generating preview: %s", err))
		return
	}

	rgba := generatePreviewRGBA(data, band, nodata, imgW, imgH)
	if rgba == nil {
		writeError(w, 500, "Failed to render preview")
		return
	}

	pngBytes, err := encodePNG(rgba, imgW, imgH)
	if err != nil {
		writeError(w, 500, "PNG encoding failed")
		return
	}

	w.Header().Set("Content-Type", "image/png")
	setCacheHeaders(w, 300)
	w.Write(pngBytes)
}

// generatePreviewRGBA is like generateTileRGBA but for arbitrary dimensions.
func generatePreviewRGBA(data []float32, band string, nodata *float64, width, height int) []byte {
	cfg, ok := BANDS[band]
	if !ok {
		return nil
	}

	rgba := make([]byte, len(data)*4)
	nodataMask := make([]bool, len(data))

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

	range_ := cfg.Max - cfg.Min
	if range_ == 0 {
		range_ = 1
	}

	lut := cfg.colormap

	for i, v := range data {
		off := i * 4
		if nodataMask[i] || v == 0 {
			rgba[off], rgba[off+1], rgba[off+2], rgba[off+3] = 0, 0, 0, 0
			continue
		}

		if band == "lightning" {
			c := LightningDefaultColor
			for _, e := range LightningColorEntries {
				if e.Val > 0 && float64(v) >= float64(e.Val) {
					c = e.Color
				}
			}
			rgba[off], rgba[off+1], rgba[off+2], rgba[off+3] = c[0], c[1], c[2], c[3]
			continue
		}

		if band == "radar" {
			if v > 0 {
				z := math.Pow(10.0, float64(v)/10.0)
				rainRate := math.Pow(z/200.0, 1.0/1.6)
				if rainRate < 0.01 {
					rainRate = 0.01
				}
				if rainRate > radarMaxRate {
					rainRate = radarMaxRate
				}
				logRate := math.Log(rainRate)
				dataNorm := (logRate - radarLogMin) / (radarLogMax - radarLogMin)
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
				rgba[off], rgba[off+1], rgba[off+2], rgba[off+3] = c[0], c[1], c[2], c[3]
			} else {
				rgba[off], rgba[off+1], rgba[off+2], rgba[off+3] = 0, 0, 0, 0
			}
			continue
		}

		// Generic bands (viridis/plasma)
		if lut != nil {
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
			rgba[off], rgba[off+1], rgba[off+2], rgba[off+3] = c[0], c[1], c[2], 255
		}
	}

	return rgba
}

// ---------------------------------------------------------------------------
// Cache management endpoints
// ---------------------------------------------------------------------------

func handleCacheStats(w http.ResponseWriter, r *http.Request) {
	setNoStore(w)
	writeJSON(w, 200, tileCache.Stats())
}

func handleCacheClear(w http.ResponseWriter, r *http.Request) {
	setNoStore(w)
	count := tileCache.InvalidateAll()
	writeJSON(w, 200, map[string]int{"cleared": count})
}

// ---------------------------------------------------------------------------
// Query parameter helpers
// ---------------------------------------------------------------------------

func queryString(r *http.Request, key, fallback string) string {
	v := r.URL.Query().Get(key)
	if v == "" {
		return fallback
	}
	return v
}

func queryInt(r *http.Request, key string, fallback int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}

func queryFloat(r *http.Request, key string, fallback float64) float64 {
	v := r.URL.Query().Get(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return fallback
	}
	return n
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func allFinite(vals []float64) bool {
	for _, v := range vals {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return false
		}
	}
	return true
}


