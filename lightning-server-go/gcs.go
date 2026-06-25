package main

// ============================================================================
// gcs.go — Google Cloud Storage operations (listing, URL building, auth)
// ============================================================================

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	storagev1 "google.golang.org/api/storage/v1"
)

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

var (
	gcsBucketName     string
	gcsBucketNameOnce sync.Once
	tsToH5Subfolder   = sync.Map{} // map[timestamp]string
	gcsService        *storagev1.Service
	gcsServiceOnce    sync.Once
)

func getBucketName() string {
	gcsBucketNameOnce.Do(func() {
		url := BucketBaseURL
		if strings.HasPrefix(url, "gs://") {
			gcsBucketName = strings.SplitN(strings.TrimPrefix(url, "gs://"), "/", 2)[0]
		} else if strings.Contains(url, "storage.googleapis.com/") {
			gcsBucketName = strings.SplitN(strings.TrimPrefix(url, "https://storage.googleapis.com/"), "/", 2)[0]
		} else {
			gcsBucketName = url
		}
	})
	return gcsBucketName
}

func getGCSService() *storagev1.Service {
	gcsServiceOnce.Do(func() {
		ctx := context.Background()
		svc, err := storagev1.NewService(ctx)
		if err != nil {
			log.Fatalf("Failed to create GCS service: %v", err)
		}
		gcsService = svc
	})
	return gcsService
}

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

var forecastFileRe = regexp.MustCompile(`forecast_(\d{12})_([^.]+)\.tiff$`)
var forecastFileReFlat = regexp.MustCompile(`forecasts/[^/]+/forecast_(\d{12})_([^.]+)\.tiff$`)

// getCOGUrl generates the /vsigs/ URL for a given timestamp and band.
// When run_time is provided, it builds the path directly (skipping GCS scan).
func getCOGUrl(timestamp, band, runTime string) string {
	bucket := getBucketName()

	if runTime != "" {
		runDate := extractRunDate(runTime)
		return fmt.Sprintf("/vsigs/%s/forecasts/%s/%s/forecast_%s_%s.tiff",
			bucket, runDate, runTime, timestamp, band)
	}

	// Fallback: discover subfolder via GCS scan
	if h5Sub, ok := findH5Subfolder(timestamp); ok {
		runDate := extractRunDate(h5Sub)
		return fmt.Sprintf("/vsigs/%s/forecasts/%s/%s/forecast_%s_%s.tiff",
			bucket, runDate, h5Sub, timestamp, band)
	}

	// Fallback to flat layout
	dateFolder := fmt.Sprintf("%s-%s-%s", timestamp[:4], timestamp[4:6], timestamp[6:8])
	return fmt.Sprintf("/vsigs/%s/forecasts/%s/forecast_%s_%s.tiff",
		bucket, dateFolder, timestamp, band)
}

// findH5Subfolder finds the H5 datetime subfolder for a given forecast timestamp.
// Searches the timestamp's date folder and the two previous days.
func findH5Subfolder(timestamp string) (string, bool) {
	if v, ok := tsToH5Subfolder.Load(timestamp); ok {
		return v.(string), true
	}

	tsDate := fmt.Sprintf("%s-%s-%s", timestamp[:4], timestamp[4:6], timestamp[6:8])
	tsDt, err := time.Parse("2006-01-02", tsDate)
	if err != nil {
		return "", false
	}

	bucket := getBucketName()
	svc := getGCSService()
	ctx := context.Background()

	// Search timestamp's own date and two previous days
	for offset := 0; offset < 3; offset++ {
		dateFolder := tsDt.AddDate(0, 0, -offset).Format("2006-01-02")
		prefix := fmt.Sprintf("forecasts/%s/", dateFolder)

		resp, err := svc.Objects.List(bucket).Prefix(prefix).MaxResults(1000).Context(ctx).Do()
		if err != nil {
			log.Printf("Warning: GCS list error for %s: %v", prefix, err)
			continue
		}

		for _, obj := range resp.Items {
			m := forecastFileReFlat.FindStringSubmatch(obj.Name)
			if m != nil && m[1] == timestamp {
				// Extract subfolder
				rest := strings.TrimPrefix(obj.Name, prefix)
				parts := strings.SplitN(rest, "/", 2)
				if len(parts) > 1 {
					sub := parts[0]
					tsToH5Subfolder.Store(timestamp, sub)
					return sub, true
				}
			}
		}
	}

	return "", false
}

// verifyCogFileReady checks that a COG file exists and has a reasonable size.
func verifyCogFileReady(timestamp, band string) bool {
	bucket := getBucketName()
	svc := getGCSService()
	ctx := context.Background()

	var blobName string
	if h5Sub, ok := findH5Subfolder(timestamp); ok {
		runDate := extractRunDate(h5Sub)
		blobName = fmt.Sprintf("forecasts/%s/%s/forecast_%s_%s.tiff", runDate, h5Sub, timestamp, band)
	} else {
		dateFolder := fmt.Sprintf("%s-%s-%s", timestamp[:4], timestamp[4:6], timestamp[6:8])
		blobName = fmt.Sprintf("forecasts/%s/forecast_%s_%s.tiff", dateFolder, timestamp, band)
	}

	for attempt := 0; attempt < 3; attempt++ {
		obj, err := svc.Objects.Get(bucket, blobName).Context(ctx).Do()
		if err == nil && obj.Size >= 1000 {
			return true
		}
		if attempt < 2 {
			time.Sleep(1 * time.Second)
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Bucket listing types
// ---------------------------------------------------------------------------

type TimestampInfo struct {
	Timestamp      string   `json:"timestamp"`
	Datetime       string   `json:"datetime"`
	DateFolder     string   `json:"date_folder,omitempty"`
	AvailableBands []string `json:"available_bands"`
	RunTime        string   `json:"run_time,omitempty"`
	TiffURL        string   `json:"tiff_url,omitempty"`
}

type AvailableResponse struct {
	Timestamps []TimestampInfo `json:"timestamps"`
	Count      int             `json:"count"`
	AllBands   []string        `json:"all_bands"`
	RunTime    string          `json:"run_time,omitempty"`
}

type HistoryDateInfo struct {
	Date        string `json:"date"`
	DisplayDate string `json:"display_date"`
	DayOfWeek   string `json:"day_of_week"`
	ShortDate   string `json:"short_date"`
}

type HistoryDatesResponse struct {
	Dates []HistoryDateInfo `json:"dates"`
	Count int               `json:"count"`
}

type HistoryRunTimestamp struct {
	Timestamp      string   `json:"timestamp"`
	Datetime       string   `json:"datetime"`
	RunTime        string   `json:"run_time,omitempty"`
	DateFolder     string   `json:"date_folder,omitempty"`
	AvailableBands []string `json:"available_bands"`
	TiffURL        string   `json:"tiff_url,omitempty"`
}

type HistoryRun struct {
	RunTime         string               `json:"run_time"`
	DateFolder      string               `json:"date_folder"`
	Timestamps      []HistoryRunTimestamp `json:"timestamps"`
	Count           int                  `json:"count"`
	AvailableBands  []string             `json:"available_bands"`
}

type HistoryDateResponse struct {
	Date         string        `json:"date"`
	Runs         []HistoryRun  `json:"runs"`
	TotalRuns    int           `json:"total_runs"`
	TotalTimesteps int         `json:"total_timesteps"`
}

// ---------------------------------------------------------------------------
// /available — scan bucket for latest run's timesteps
// ---------------------------------------------------------------------------

func handleAvailable(ctx context.Context, days int, band string) (*AvailableResponse, error) {
	bucket := getBucketName()
	svc := getGCSService()
	now := time.Now().UTC()

	// Step 1: collect all run subfolders across the scanned day range
	var allRunSubfolders []string
	var flatPrefixFallback string

	for i := -1; i < days; i++ {
		d := now.AddDate(0, 0, i)
		dateFolder := d.Format("2006-01-02")
		datePrefix := fmt.Sprintf("forecasts/%s/", dateFolder)

		// Use delimiter to list ALL subfolders (runs) for this date.
		// No MaxResults limit here — we need every run subfolder so we can
		// pick the globally-latest one. (MaxResults(1) is only safe for
		// /history/dates where we just check existence.)
		resp, err := svc.Objects.List(bucket).Prefix(datePrefix).Delimiter("/").MaxResults(1000).Context(ctx).Do()
		if err != nil {
			log.Printf("Warning: GCS list error for %s: %v", datePrefix, err)
			continue
		}

		for _, p := range resp.Prefixes {
			sub := strings.TrimSuffix(strings.TrimSuffix(p, "/"), "")
			if idx := strings.LastIndex(sub, "/"); idx >= 0 {
				sub = sub[idx+1:]
			}
			allRunSubfolders = append(allRunSubfolders, sub)
		}

		if len(resp.Prefixes) == 0 && len(resp.Items) == 0 {
			flatPrefixFallback = datePrefix
		}
	}

	timestampBands := make(map[string]map[string]bool) // timestamp → set of bands
	var latestSub string

	// Step 2: pick the latest run and list its files
	if len(allRunSubfolders) > 0 {
		sort.Sort(sort.Reverse(sort.StringSlice(allRunSubfolders)))
		latestSub = allRunSubfolders[0]
		log.Printf("/available: using latest run '%s'", latestSub)

		// Evict stale cache entries
		tileCache.InvalidateRun(latestSub)

		// Find which date folder this run is under
		runDate := extractRunDate(latestSub)
		runPrefix := fmt.Sprintf("forecasts/%s/%s/", runDate, latestSub)

		resp, err := svc.Objects.List(bucket).Prefix(runPrefix).MaxResults(1000).Context(ctx).Do()
		if err != nil {
			return nil, fmt.Errorf("error listing run files: %v", err)
		}

		for _, obj := range resp.Items {
			m := forecastFileRe.FindStringSubmatch(obj.Name)
			if m == nil {
				continue
			}
			ts, foundBand := m[1], m[2]
			tsToH5Subfolder.Store(ts, latestSub)
			if timestampBands[ts] == nil {
				timestampBands[ts] = make(map[string]bool)
			}
			timestampBands[ts][foundBand] = true
		}
	} else if flatPrefixFallback != "" {
		resp, err := svc.Objects.List(bucket).Prefix(flatPrefixFallback).MaxResults(1000).Context(ctx).Do()
		if err != nil {
			return nil, fmt.Errorf("error listing flat files: %v", err)
		}

		for _, obj := range resp.Items {
			m := forecastFileReFlat.FindStringSubmatch(obj.Name)
			if m == nil {
				continue
			}
			ts, foundBand := m[1], m[2]
			if timestampBands[ts] == nil {
				timestampBands[ts] = make(map[string]bool)
			}
			timestampBands[ts][foundBand] = true
		}
	}

	// Convert to sorted list
	var timestamps []string
	for ts := range timestampBands {
		timestamps = append(timestamps, ts)
	}
	sort.Strings(timestamps)

	var result []TimestampInfo
	for _, ts := range timestamps {
		bands := make([]string, 0, len(timestampBands[ts]))
		for b := range timestampBands[ts] {
			bands = append(bands, b)
		}
		sort.Strings(bands)

		dt, err := parseTimestamp(ts)
		if err != nil {
			continue
		}

		var tiffURL string
		if latestSub != "" {
			runDate := extractRunDate(latestSub)
			tiffURL = fmt.Sprintf("https://storage.googleapis.com/%s/forecasts/%s/%s/forecast_%s_{band}.tiff",
				bucket, runDate, latestSub, ts)
		} else {
			dateFolder := fmt.Sprintf("%s-%s-%s", ts[:4], ts[4:6], ts[6:8])
			tiffURL = fmt.Sprintf("https://storage.googleapis.com/%s/forecasts/%s/forecast_%s_{band}.tiff",
				bucket, dateFolder, ts)
		}

		result = append(result, TimestampInfo{
			Timestamp:      ts,
			Datetime:       dt.Format("2006-01-02T15:04:05Z"),
			AvailableBands: bands,
			RunTime:        latestSub,
			TiffURL:        tiffURL,
		})
	}

	return &AvailableResponse{
		Timestamps: result,
		Count:      len(result),
		AllBands:   bandNames(),
		RunTime:    latestSub,
	}, nil
}

// ---------------------------------------------------------------------------
// /history/dates — list dates that have data
// ---------------------------------------------------------------------------

func handleHistoryDates(ctx context.Context, days int) (*HistoryDatesResponse, error) {
	bucket := getBucketName()
	svc := getGCSService()
	now := time.Now().UTC()

	var dates []HistoryDateInfo

	for i := -1; i < days; i++ {
		d := now.AddDate(0, 0, -i)
		dateFolder := d.Format("2006-01-02")
		datePrefix := fmt.Sprintf("forecasts/%s/", dateFolder)

		resp, err := svc.Objects.List(bucket).Prefix(datePrefix).Delimiter("/").MaxResults(1).Context(ctx).Do()
		if err != nil {
			continue
		}

		hasData := len(resp.Items) > 0 || len(resp.Prefixes) > 0
		if hasData {
			dates = append(dates, HistoryDateInfo{
				Date:        dateFolder,
				DisplayDate: d.Format("Monday 02 January 2006"),
				DayOfWeek:   d.Format("Mon"),
				ShortDate:   d.Format("02/01"),
			})
		}
	}

	return &HistoryDatesResponse{
		Dates: dates,
		Count: len(dates),
	}, nil
}

// ---------------------------------------------------------------------------
// /history/dates/{date} — get runs for a specific date
// ---------------------------------------------------------------------------

func handleHistoryDateRuns(ctx context.Context, date, band string) (*HistoryDateResponse, error) {
	bucket := getBucketName()
	svc := getGCSService()

	reqDt, err := time.Parse("2006-01-02", date)
	if err != nil {
		return nil, fmt.Errorf("invalid date")
	}

	// Scan requested date + 2 previous days
	var scanDates []string
	for offset := 0; offset < 3; offset++ {
		scanDates = append(scanDates, reqDt.AddDate(0, 0, -offset).Format("2006-01-02"))
	}

	var runs []HistoryRun

	for _, scanDate := range scanDates {
		datePrefix := fmt.Sprintf("forecasts/%s/", scanDate)

		// List subfolders
		resp, err := svc.Objects.List(bucket).Prefix(datePrefix).Delimiter("/").MaxResults(100).Context(ctx).Do()
		if err != nil {
			continue
		}

		if len(resp.Prefixes) == 0 {
			// Flat layout
			runTimestamps, allBands := scanRunTimestamps(ctx, svc, bucket, datePrefix, date, band, "", scanDate)
			if len(runTimestamps) > 0 {
				runs = append(runs, HistoryRun{
					RunTime:        "",
					DateFolder:     scanDate,
					Timestamps:     runTimestamps,
					Count:          len(runTimestamps),
					AvailableBands: allBands,
				})
			}
		} else {
			// New layout: each prefix is a run
			subs := make([]string, len(resp.Prefixes))
			for i, p := range resp.Prefixes {
				sub := strings.TrimSuffix(p, "/")
				if idx := strings.LastIndex(sub, "/"); idx >= 0 {
					sub = sub[idx+1:]
				}
				subs[i] = sub
			}
			sort.Strings(subs)

			for _, sub := range subs {
				runPrefix := fmt.Sprintf("forecasts/%s/%s/", scanDate, sub)
				runTimestamps, allBands := scanRunTimestamps(ctx, svc, bucket, runPrefix, date, band, sub, scanDate)
				if len(runTimestamps) > 0 {
					runs = append(runs, HistoryRun{
						RunTime:        sub,
						DateFolder:     scanDate,
						Timestamps:     runTimestamps,
						Count:          len(runTimestamps),
						AvailableBands: allBands,
					})
				}
			}
		}
	}

	totalTimesteps := 0
	for _, r := range runs {
		totalTimesteps += r.Count
	}

	return &HistoryDateResponse{
		Date:           date,
		Runs:           runs,
		TotalRuns:      len(runs),
		TotalTimesteps: totalTimesteps,
	}, nil
}

// scanRunTimestamps lists files under a prefix and extracts timestamps for the requested date.
func scanRunTimestamps(ctx context.Context, svc *storagev1.Service, bucket, prefix, reqDate, band, runTime, scanDate string) ([]HistoryRunTimestamp, []string) {
	resp, err := svc.Objects.List(bucket).Prefix(prefix).MaxResults(1000).Context(ctx).Do()
	if err != nil {
		return nil, nil
	}

	tsBands := make(map[string]map[string]bool)
	for _, obj := range resp.Items {
		m := forecastFileRe.FindStringSubmatch(obj.Name)
		if m == nil {
			continue
		}
		ts, foundBand := m[1], m[2]

		// Only include timestamps on the requested date
		tsDate := fmt.Sprintf("%s-%s-%s", ts[:4], ts[4:6], ts[6:8])
		if tsDate != reqDate {
			continue
		}
		if band != "any" && foundBand != band {
			continue
		}
		if tsBands[ts] == nil {
			tsBands[ts] = make(map[string]bool)
		}
		tsBands[ts][foundBand] = true
	}

	var tsList []string
	for ts := range tsBands {
		tsList = append(tsList, ts)
	}
	sort.Strings(tsList)

	var result []HistoryRunTimestamp
	allBandsSet := make(map[string]bool)
	for _, ts := range tsList {
		dt, err := parseTimestamp(ts)
		if err != nil {
			continue
		}
		bands := make([]string, 0, len(tsBands[ts]))
		for b := range tsBands[ts] {
			bands = append(bands, b)
			allBandsSet[b] = true
		}
		sort.Strings(bands)

		tiffURL := fmt.Sprintf("https://storage.googleapis.com/%s/forecasts/%s/%s/forecast_%s_{band}.tiff",
			bucket, scanDate, runTime, ts)

		if runTime != "" {
			tsToH5Subfolder.Store(ts, runTime)
		}

		result = append(result, HistoryRunTimestamp{
			Timestamp:      ts,
			Datetime:       dt.Format("2006-01-02T15:04:05Z"),
			RunTime:        runTime,
			DateFolder:     scanDate,
			AvailableBands: bands,
			TiffURL:        tiffURL,
		})
	}

	allBands := make([]string, 0, len(allBandsSet))
	for b := range allBandsSet {
		allBands = append(allBands, b)
	}
	sort.Strings(allBands)

	return result, allBands
}

// ---------------------------------------------------------------------------
// GDAL GCS auth setup (mirrors the Python _get_gcs_access_token)
// ---------------------------------------------------------------------------

func setupGDALGCSAuth() {
	// Option 1: GCP_CREDENTIALS_B64
	if credsB64 := os.Getenv("GCP_CREDENTIALS_B64"); credsB64 != "" {
		credsJSON, err := base64.StdEncoding.DecodeString(credsB64)
		if err == nil {
			setupFromCredsJSON(credsJSON)
			return
		}
		log.Printf("[INIT] Failed to decode GCP_CREDENTIALS_B64: %v", err)
	}

	// Option 2: GCP_CREDENTIALS (raw JSON)
	if credsJSON := os.Getenv("GCP_CREDENTIALS"); credsJSON != "" {
		setupFromCredsJSON([]byte(credsJSON))
		return
	}

	// Option 3: Try metadata server (Workload Identity)
	token, ok := getMetadataToken()
	if ok {
		os.Setenv("GS_ACCESS_TOKEN", token)
		log.Println("[INIT] Set GS_ACCESS_TOKEN from metadata server")
		return
	}

	log.Println("[INIT] No explicit credentials found — relying on ADC/default")
}

func setupFromCredsJSON(credsJSON []byte) {
	var creds struct {
		ClientEmail string `json:"client_email"`
		PrivateKey  string `json:"private_key"`
	}
	if err := json.Unmarshal(credsJSON, &creds); err != nil {
		log.Printf("[INIT] Failed to parse credentials JSON: %v", err)
		return
	}
	if creds.PrivateKey == "" || creds.ClientEmail == "" {
		log.Println("[INIT] Credentials missing private_key or client_email")
		return
	}

	// Write private key to temp file for GDAL
	tmpFile, err := os.CreateTemp("", "gdal-key-*.pem")
	if err != nil {
		log.Printf("[INIT] Failed to create temp key file: %v", err)
		return
	}
	tmpFile.WriteString(creds.PrivateKey)
	tmpFile.Close()

	os.Setenv("GS_OAUTH2_PRIVATE_KEY_FILE", tmpFile.Name())
	os.Setenv("GS_OAUTH2_CLIENT_EMAIL", creds.ClientEmail)
	log.Printf("[INIT] Configured GDAL with service account: %s", creds.ClientEmail)
}

func getMetadataToken() (string, bool) {
	client := &http.Client{Timeout: 5 * time.Second}
	req, err := http.NewRequest("GET", "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", nil)
	if err != nil {
		return "", false
	}
	req.Header.Set("Metadata-Flavor", "Google")

	resp, err := client.Do(req)
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return "", false
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", false
	}

	var tokenData struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(body, &tokenData); err != nil {
		return "", false
	}
	return tokenData.AccessToken, true
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func parseTimestamp(ts string) (time.Time, error) {
	return time.Parse("200601021504", ts)
}
