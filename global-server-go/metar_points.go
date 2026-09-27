package main

// ============================================================================
// metar_points.go — /airports primary source: preprocessing pipeline pq
// ----------------------------------------------------------------------------
// Reads the hourly METAR point snapshot that the preprocessing pipeline
// uploads to gs://eumetsat_mtg_preprocess/inference_h5_global/
// global_live_<YYYYMMDD_HH00>.pq (configure with METAR_PQ_BUCKET /
// METAR_PQ_PREFIX). This is the exact station set that fed the live metar
// COGs, so /airports only offers points with a real forecast behind them.
//
// The parquet schema is the dataset generator's (results_metar/
// metar_global_*.parquet — see meteolibre_datasetgen
// src/metar/download_metar_global.py): station, lat, lon, timestamp,
// tmpc, dwpc, mslp, cloud_cover, skyc, p01m, wdir, wspd. Only the four
// placement columns are read; the rest are ignored by the projection.
//
// lat/lon come from the parquet rows (newest observation wins per
// station); names/countries come from the embedded registry in
// airports.go. Rows with junk coordinates (the -99.99 sentinel / null /
// out-of-range) fall back to registry coordinates. When the bucket is
// unreachable — or the newest snapshot is older than METAR_PQ_MAX_AGE —
// airports.go falls back to the AWC bulk cache.
// ============================================================================

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"math"
	"regexp"
	"strings"
	"time"

	"github.com/parquet-go/parquet-go"
)

var (
	metarPqBucket = envOr("METAR_PQ_BUCKET", "eumetsat_mtg_preprocess")
	metarPqPrefix = strings.Trim(envOr("METAR_PQ_PREFIX", "inference_h5_global"), "/")
	metarPqMaxAge = metarPqMaxAgeOr(envOr("METAR_PQ_MAX_AGE", "6h"))
)

func metarPqMaxAgeOr(v string) time.Duration {
	d, err := time.ParseDuration(v)
	if err != nil || d < 0 {
		log.Printf("[airports] invalid METAR_PQ_MAX_AGE %q — using 6h", v)
		return 6 * time.Hour
	}
	return d
}

// global_live_YYYYMMDD_HHMM.pq — the minute is normally 00 (run hour).
var metarPqNameRe = regexp.MustCompile(`global_live_(\d{8}_\d{4})\.pq$`)

// metarPqRow is the subset of the parquet schema we need; the remaining
// columns are ignored by the projection. lat/lon are nullable (pandas
// writes NaN as null), hence the pointers.
type metarPqRow struct {
	Station   string    `parquet:"station"`
	Lat       *float64  `parquet:"lat"`
	Lon       *float64  `parquet:"lon"`
	Timestamp time.Time `parquet:"timestamp"`
}

// fetchMetarPointsSnapshot builds the /airports snapshot from the newest
// hourly parquet snapshot in the pipeline bucket. Called from the
// airports.go refresh loop (primary source, AWC is the fallback).
func fetchMetarPointsSnapshot(ctx context.Context) (*airportSnapshot, error) {
	name, token, err := latestMetarPqObject(ctx)
	if err != nil {
		return nil, err
	}
	dataTime, err := time.Parse("20060102_1504", token)
	if err != nil {
		return nil, fmt.Errorf("parse pq run hour %q: %w", token, err)
	}
	dataTime = dataTime.UTC()

	// A stale pq means the pipeline is down — prefer the fresh AWC fallback
	// over serving yesterday's station list as live. "0" disables the check.
	if metarPqMaxAge > 0 {
		if age := time.Since(dataTime); age > metarPqMaxAge {
			return nil, fmt.Errorf("newest pq %s is %s old (max %s)", name, age.Round(time.Minute), metarPqMaxAge)
		}
	}

	body, err := downloadMetarPq(ctx, name)
	if err != nil {
		return nil, err
	}
	rows, err := parseMetarPq(body)
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", name, err)
	}

	// Newest observation wins per station.
	type stEntry struct {
		obs       time.Time
		lat, lon  float64
		hasCoords bool
	}
	stations := make(map[string]stEntry, len(rows))
	var latestObs time.Time
	for _, r := range rows {
		icao := strings.TrimSpace(r.Station)
		if icao == "" || r.Timestamp.IsZero() {
			continue
		}
		obs := r.Timestamp.UTC()
		if prev, ok := stations[icao]; ok && !obs.After(prev.obs) {
			continue
		}
		st := stEntry{obs: obs}
		if r.Lat != nil && r.Lon != nil {
			lat, lon := *r.Lat, *r.Lon
			// -99.99 sentinel, NaN and other junk values are excluded by the
			// range check (mirrors the AWC path in airports.go).
			if !math.IsNaN(lat) && !math.IsNaN(lon) &&
				lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 {
				st.lat, st.lon, st.hasCoords = lat, lon, true
			}
		}
		stations[icao] = st
		if obs.After(latestObs) {
			latestObs = obs
		}
	}

	entries := make([]airportEntry, 0, len(stations))
	for icao, st := range stations {
		e := airportEntry{ICAO: icao, Name: icao}
		reg, hasReg := airportsRegistry[icao]
		if hasReg {
			e.Name = reg.Name
			e.Country = reg.Country
		}
		if st.hasCoords {
			e.Lat, e.Lon = st.lat, st.lon
		} else if hasReg {
			e.Lat, e.Lon = reg.Lat, reg.Lon
		} else {
			continue // cannot place the station at all
		}
		entries = append(entries, e)
	}

	if len(entries) < 100 {
		return nil, fmt.Errorf("suspiciously few stations (%d) in %s — keeping stale list", len(entries), name)
	}

	source := fmt.Sprintf("gs://%s/%s/%s", metarPqBucket, metarPqPrefix, name)
	return buildSnapshot(entries, latestObs, true, source, dataTime), nil
}

// latestMetarPqObject lists the pipeline bucket and returns the object
// name + run-hour token of the newest global_live_*.pq (by filename date,
// not GCS updated time — copies can skew it).
func latestMetarPqObject(ctx context.Context) (name, token string, err error) {
	svc := getGCSService()
	prefix := metarPqPrefix + "/"
	page := ""
	for {
		resp, err := svc.Objects.List(metarPqBucket).Prefix(prefix).
			MaxResults(1000).Context(ctx).PageToken(page).Do()
		if err != nil {
			return "", "", fmt.Errorf("list gs://%s%s: %w", metarPqBucket, prefix, err)
		}
		for _, obj := range resp.Items {
			if m := metarPqNameRe.FindStringSubmatch(obj.Name); m != nil && m[1] > token {
				token, name = m[1], obj.Name
			}
		}
		if resp.NextPageToken == "" {
			break
		}
		page = resp.NextPageToken
	}
	if name == "" {
		return "", "", fmt.Errorf("no global_live_*.pq under gs://%s%s", metarPqBucket, prefix)
	}
	return name, token, nil
}

// downloadMetarPq fetches one snapshot into memory (hourly snapshots are a
// few hundred KB — well under the 64 MB guard).
func downloadMetarPq(ctx context.Context, name string) ([]byte, error) {
	svc := getGCSService()
	resp, err := svc.Objects.Get(metarPqBucket, name).Context(ctx).Download()
	if err != nil {
		return nil, fmt.Errorf("download gs://%s/%s/%s: %w", metarPqBucket, metarPqPrefix, name, err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, fmt.Errorf("read gs://%s/%s/%s: %w", metarPqBucket, metarPqPrefix, name, err)
	}
	return b, nil
}

// parseMetarPq decodes the station/lat/lon/timestamp projection of a
// snapshot. All physical layouts the generator writes are supported
// (string/large_string, timestamp[ns|us|ms], nullable doubles).
func parseMetarPq(b []byte) ([]metarPqRow, error) {
	r := parquet.NewGenericReader[metarPqRow](bytes.NewReader(b))
	defer r.Close()
	rows := make([]metarPqRow, 0, 8192)
	buf := make([]metarPqRow, 512)
	for {
		n, err := r.Read(buf)
		rows = append(rows, buf[:n]...)
		if err != nil {
			if err != io.EOF {
				return nil, err
			}
			break
		}
	}
	return rows, nil
}
