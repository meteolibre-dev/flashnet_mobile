package main

// ============================================================================
// main.go — Server entry point, GDAL environment setup, startup
// ============================================================================

import (
	"log"
	"net/http"
	"os"
	"runtime"
	"time"
)

func main() {
	// ── GDAL environment (must be set before any GDAL call) ────────────
	// These mirror the Python server's os.environ setup, with /vsigs/
	// read caching ENABLED (see notes below).
	os.Setenv("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", "tif,tiff")
	os.Setenv("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")

	// /vsigs/ read caching. COG files are immutable once written, so caching
	// range reads is safe and avoids re-fetching overview blocks from GCS on
	// every tile read. The old behavior (VSI_CACHE=FALSE + NON_CACHED=/vsigs/)
	// refetched every block per request. Restore it with:
	//   VSI_CACHE=FALSE CPL_VSIL_CURL_NON_CACHED=/vsigs/
	os.Setenv("VSI_CACHE", envOr("VSI_CACHE", "TRUE"))
	os.Setenv("VSI_CACHE_SIZE", envOr("VSI_CACHE_SIZE", "50000000")) // 50 MB
	os.Setenv("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")
	os.Setenv("GDAL_HTTP_MULTIRANGE", envOr("GDAL_HTTP_MULTIRANGE", "YES"))
	os.Setenv("CPL_VSIL_CURL_CHUNK_SIZE", envOr("CPL_VSIL_CURL_CHUNK_SIZE", "65536")) // 4× default
	os.Setenv("GDAL_HTTP_MAX_RETRY", envOr("GDAL_HTTP_MAX_RETRY", "3"))
	os.Setenv("GDAL_HTTP_RETRY_DELAY", envOr("GDAL_HTTP_RETRY_DELAY", "1"))
	os.Setenv("GDAL_CACHEMAX", envOr("GDAL_CACHEMAX", "500"))

	// GCS auth for GDAL's /vsigs/ filesystem
	setupGDALGCSAuth()

	// Observed-radar (OPERA) manifest index — background refresh, non-fatal
	startObsIndexRefresher()

	log.Printf("Starting Lightning Server Go on port %s", Port)
	log.Printf("Data source: %s", BucketBaseURL)
	log.Printf("Bucket name: %s", getBucketName())
	log.Printf("GOMAXPROCS: %d", runtime.GOMAXPROCS(0))

	// ── HTTP server ────────────────────────────────────────────────────
	mux := http.NewServeMux()
	registerRoutes(mux)

	handler := recoveryMiddleware(corsMiddleware(loggingMiddleware(mux)))

	server := &http.Server{
		Addr:              ":" + Port,
		Handler:           handler,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
		ReadHeaderTimeout: 10 * time.Second,
		MaxHeaderBytes:    1 << 20, // 1 MB
	}

	log.Printf("Listening on 0.0.0.0:%s", Port)
	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}

// loggingMiddleware logs each request with method, path, status, and duration.
func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()

		// Wrap ResponseWriter to capture status code
		wrapped := &statusWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(wrapped, r)

		log.Printf("%s %s → %d (%v)", r.Method, r.URL.Path, wrapped.status, time.Since(start))
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (sw *statusWriter) WriteHeader(code int) {
	sw.status = code
	sw.ResponseWriter.WriteHeader(code)
}
