package main

// ============================================================================
// airports.go — static METAR airport list (embedded), served at /airports
// ----------------------------------------------------------------------------
// The list is generated from NOAA AWC's station cache by
// scripts/fetch_airports.py (only stations reporting METAR are kept) and
// embedded into the binary so the server has no runtime dependency on AWC.
// Regenerate with:  python3 scripts/fetch_airports.py
// ============================================================================

import (
	"bytes"
	"compress/gzip"
	_ "embed"
	"net/http"
	"strings"
	"sync"
)

//go:embed data/airports.json
var airportsJSON []byte

var (
	airportsGzOnce  sync.Once
	airportsGzBytes []byte
)

// airportsGzip returns the gzipped payload, computed once on first use.
func airportsGzip() []byte {
	airportsGzOnce.Do(func() {
		var buf bytes.Buffer
		w := gzip.NewWriter(&buf)
		w.Write(airportsJSON)
		w.Close()
		airportsGzBytes = buf.Bytes()
	})
	return airportsGzBytes
}

// handleAirports serves the embedded METAR airport list.
// Long cache: the list changes at the pace of station additions/removals —
// a 24h browser cache plus ETag is plenty.
func handleAirports(w http.ResponseWriter, r *http.Request) {
	etag := `"airports-v1"` // bump when regenerating data/airports.json

	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Encoding", "gzip")
		setCacheHeaders(w, 86400) // 24h
		w.Write(airportsGzip())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	setCacheHeaders(w, 86400) // 24h
	w.Write(airportsJSON)
}
