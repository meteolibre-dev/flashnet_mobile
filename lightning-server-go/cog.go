package main

// ============================================================================
// cog.go — COG reading, tile/preview/point generation via our GDAL cgo wrapper
// ============================================================================

import (
	"fmt"
	"math"
	"sync"
)

// ---------------------------------------------------------------------------
// Constants — Web Mercator tile math
// ---------------------------------------------------------------------------

const webMercatorExtent = 20037508.342789244 // half-extent of EPSG:3857

// tileBoundsMercator returns the EPSG:3857 bounding box for a given z/x/y tile.
func tileBoundsMercator(z, x, y int) (minX, minY, maxX, maxY float64) {
	n := math.Pow(2, float64(z))
	tileSize := 2 * webMercatorExtent / n
	minX = -webMercatorExtent + float64(x)*tileSize
	maxX = minX + tileSize
	maxY = webMercatorExtent - float64(y)*tileSize
	minY = maxY - tileSize
	return
}

// mercatorToWGS84 converts EPSG:3857 coordinates to EPSG:4326 (lon/lat).
func mercatorToWGS84(x, y float64) (lon, lat float64) {
	lon = x / webMercatorExtent * 180.0
	lat = y / webMercatorExtent * 180.0
	lat = 180.0 / math.Pi * (2*math.Atan(math.Exp(lat*math.Pi/180.0)) - math.Pi/2)
	return
}

// tileBoundsWGS84 returns the geographic (EPSG:4326) bounding box for z/x/y.
func tileBoundsWGS84(z, x, y int) (minLon, minLat, maxLon, maxLat float64) {
	mMinX, mMinY, mMaxX, mMaxY := tileBoundsMercator(z, x, y)
	minLon, minLat = mercatorToWGS84(mMinX, mMinY)
	maxLon, maxLat = mercatorToWGS84(mMaxX, mMaxY)
	return
}

// ---------------------------------------------------------------------------
// COG dataset pool — keeps GDAL datasets open for fast reuse
// ---------------------------------------------------------------------------

type cogEntry struct {
	ds *GdalDataset
}

type COGPool struct {
	mu      sync.Mutex
	maxSize int
	entries map[string]*cogEntry
}

var cogPool = &COGPool{
	maxSize: COGPoolMaxSize,
	entries: make(map[string]*cogEntry),
}

// Open opens a COG dataset, using the pool if available.
func (p *COGPool) Open(url string) (*GdalDataset, error) {
	p.mu.Lock()
	if entry, ok := p.entries[url]; ok {
		ds := entry.ds
		p.mu.Unlock()
		return ds, nil
	}
	p.mu.Unlock()

	// Open outside the lock
	ds, err := gdalOpen(url)
	if err != nil {
		return nil, err
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	// Evict if at capacity (simple eviction — could be smarter)
	if len(p.entries) >= p.maxSize {
		for k, v := range p.entries {
			v.ds.Close()
			delete(p.entries, k)
			break
		}
	}

	p.entries[url] = &cogEntry{ds: ds}
	return ds, nil
}

// ---------------------------------------------------------------------------
// COG metadata
// ---------------------------------------------------------------------------

type COGInfo struct {
	Width        int        `json:"width"`
	Height       int        `json:"height"`
	GeoTransform [6]float64 `json:"-"`
	Projection   string     `json:"-"`
	Nodata       *float64   `json:"nodata"`
	Bounds       [4]float64 `json:"bounds"` // [west, south, east, north]
	Overviews    []int      `json:"overviews"`
}

// getCOGInfo reads metadata from a COG.
func getCOGInfo(url string) (*COGInfo, error) {
	ds, err := cogPool.Open(url)
	if err != nil {
		return nil, err
	}

	info := &COGInfo{
		Width:        ds.Width(),
		Height:       ds.Height(),
		GeoTransform: ds.GeoTransform(),
		Projection:   ds.Projection(),
	}

	band := ds.Band(1)
	if band != nil {
		nodata, hasNodata := band.NodataValue()
		if hasNodata && !math.IsNaN(nodata) && !math.IsInf(nodata, 0) {
			n := nodata
			info.Nodata = &n
		}

		gt := info.GeoTransform
		info.Bounds = [4]float64{
			gt[0],                                    // west
			gt[3] + gt[5]*float64(info.Height),       // south
			gt[0] + gt[1]*float64(info.Width),        // east
			gt[3],                                    // north
		}

		// Overviews
		ovCount := band.OverviewCount()
		overviews := make([]int, 0, ovCount)
		for i := 0; i < ovCount; i++ {
			ov := band.Overview(i)
			if ov != nil && ov.XSize() > 0 {
				factor := info.Width / ov.XSize()
				if factor < 1 {
					factor = 1
				}
				overviews = append(overviews, factor)
			}
		}
		info.Overviews = overviews
	}

	return info, nil
}

// ---------------------------------------------------------------------------
// Tile reading — extract a 256×256 float32 array for z/x/y
// ---------------------------------------------------------------------------

// readTile reads a tileSize×tileSize float32 window from the COG covering z/x/y.
// GDAL handles overview selection and resampling automatically via GDALRasterIO.
//
// For tiles that partially overlap the raster, we read ONLY the valid portion
// at its proportional output size and place it at the correct offset within
// the tileSize×tileSize buffer. The rest is filled with NaN (transparent).
// This avoids the "stretching" bug where clamped data gets stretched to fill
// the entire tile, and avoids passing negative offsets to GDAL (which fails).
func readTile(url string, z, x, y, tileSize int) ([]float32, *float64, error) {
	ds, err := cogPool.Open(url)
	if err != nil {
		return nil, nil, err
	}

	width := ds.Width()
	height := ds.Height()
	gt := ds.GeoTransform()

	// Get tile bounds in WGS84
	minLon, minLat, maxLon, maxLat := tileBoundsWGS84(z, x, y)

	// Convert geographic bounds → pixel coordinates
	srcX1 := (minLon - gt[0]) / gt[1]
	srcX2 := (maxLon - gt[0]) / gt[1]
	srcY1 := (maxLat - gt[3]) / gt[5]
	srcY2 := (minLat - gt[3]) / gt[5]

	fullXOff := math.Floor(math.Min(srcX1, srcX2))
	fullYOff := math.Floor(math.Min(srcY1, srcY2))
	fullXEnd := math.Ceil(math.Max(srcX1, srcX2))
	fullYEnd := math.Ceil(math.Max(srcY1, srcY2))
	fullW := fullXEnd - fullXOff
	fullH := fullYEnd - fullYOff

	// Initialize the full output buffer with NaN (transparent)
	buf := make([]float32, tileSize*tileSize)
	for i := range buf {
		buf[i] = float32(math.NaN())
	}

	// Check if tile is entirely outside the raster
	if fullXEnd <= 0 || fullYEnd <= 0 || fullXOff >= float64(width) || fullYOff >= float64(height) {
		return buf, nil, nil
	}

	// Compute the valid (clamped) region within the raster
	validXOff := math.Max(0, fullXOff)
	validYOff := math.Max(0, fullYOff)
	validXEnd := math.Min(float64(width), fullXEnd)
	validYEnd := math.Min(float64(height), fullYEnd)
	validW := validXEnd - validXOff
	validH := validYEnd - validYOff

	if validW <= 0 || validH <= 0 {
		return buf, nil, nil
	}

	// Scale factor: how many output pixels per source pixel
	scaleX := float64(tileSize) / fullW
	scaleY := float64(tileSize) / fullH

	// Where in the output buffer does the valid region start?
	outXOff := int(math.Round((validXOff - fullXOff) * scaleX))
	outYOff := int(math.Round((validYOff - fullYOff) * scaleY))
	// How many output pixels does the valid region cover?
	outW := int(math.Round(validW * scaleX))
	outH := int(math.Round(validH * scaleY))
	if outW < 1 {
		outW = 1
	}
	if outH < 1 {
		outH = 1
	}
	// Clamp output region to tile bounds
	if outXOff < 0 {
		outW += outXOff
		outXOff = 0
	}
	if outYOff < 0 {
		outH += outYOff
		outYOff = 0
	}
	if outXOff+outW > tileSize {
		outW = tileSize - outXOff
	}
	if outYOff+outH > tileSize {
		outH = tileSize - outYOff
	}

	if outW <= 0 || outH <= 0 {
		return buf, nil, nil
	}

	band := ds.Band(1)
	if band == nil {
		return nil, nil, fmt.Errorf("no band 1 in %s", url)
	}

	// Read the valid source region, resampled to outW×outH
	tempBuf := make([]float32, outW*outH)
	err = band.ReadWindowInto(tempBuf,
		int(validXOff), int(validYOff), int(validW), int(validH),
		outW, outH)
	if err != nil {
		return nil, nil, fmt.Errorf("GDAL band IO error: %v", err)
	}

	// Copy tempBuf into the correct position within the full tileSize buffer
	for row := 0; row < outH; row++ {
		srcStart := row * outW
		dstStart := (outYOff+row)*tileSize + outXOff
		copy(buf[dstStart:dstStart+outW], tempBuf[srcStart:srcStart+outW])
	}

	// Get nodata
	var nodata *float64
	nd, hasNd := band.NodataValue()
	if hasNd && !math.IsNaN(nd) && !math.IsInf(nd, 0) {
		n := nd
		nodata = &n
	}

	return buf, nodata, nil
}

// ---------------------------------------------------------------------------
// Preview reading — full-extent image at a target size
// ---------------------------------------------------------------------------

func readPreview(url string, targetW, targetH int) ([]float32, int, int, *float64, error) {
	ds, err := cogPool.Open(url)
	if err != nil {
		return nil, 0, 0, nil, err
	}

	width := ds.Width()
	height := ds.Height()
	band := ds.Band(1)
	if band == nil {
		return nil, 0, 0, nil, fmt.Errorf("no band 1")
	}

	// Pick the overview closest to (but ≥) the target size
	srcW, srcH := width, height
	ovCount := band.OverviewCount()
	for i := 0; i < ovCount; i++ {
		ov := band.Overview(i)
		if ov == nil {
			break
		}
		if ov.XSize() >= targetW && ov.YSize() >= targetH {
			srcW = ov.XSize()
			srcH = ov.YSize()
		} else {
			break
		}
	}

	buf := make([]float32, targetW*targetH)
	err = band.ReadWindowInto(buf, 0, 0, srcW, srcH, targetW, targetH)
	if err != nil {
		return nil, 0, 0, nil, fmt.Errorf("GDAL preview IO error: %v", err)
	}

	var nodata *float64
	nd, hasNd := band.NodataValue()
	if hasNd && !math.IsNaN(nd) && !math.IsInf(nd, 0) {
		n := nd
		nodata = &n
	}

	return buf, targetW, targetH, nodata, nil
}

// ---------------------------------------------------------------------------
// Point query — read a single pixel value
// ---------------------------------------------------------------------------

func readPoint(url string, lat, lon float64) (float64, error) {
	ds, err := cogPool.Open(url)
	if err != nil {
		return 0, err
	}

	gt := ds.GeoTransform()
	col := int((lon - gt[0]) / gt[1])
	row := int((lat - gt[3]) / gt[5])

	if col < 0 || col >= ds.Width() || row < 0 || row >= ds.Height() {
		return 0, fmt.Errorf("point out of bounds")
	}

	band := ds.Band(1)
	if band == nil {
		return 0, fmt.Errorf("no band 1")
	}

	val, err := band.ReadPoint(col, row)
	if err != nil {
		return 0, err
	}

	v := float64(val)
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, fmt.Errorf("nodata")
	}

	nd, hasNd := band.NodataValue()
	if hasNd && v == nd {
		return 0, fmt.Errorf("nodata")
	}

	return v, nil
}
