package main

// ============================================================================
// gdal_cgo.go — Minimal cgo wrapper for GDAL C API
// ----------------------------------------------------------------------------
// We hand-write this instead of using github.com/airbusgeo/gdal because that
// binding is incompatible with Go 1.23+ (cgo _Ctype_ identifier conflicts).
// This wrapper covers exactly the GDAL functions needed for COG tile serving:
//
//   - GDALAllRegister / GDALOpen (open dataset from /vsigs/ URL)
//   - Raster size, geotransform, projection
//   - Band IO (windowed read with resampling — GDAL picks overviews)
//   - Nodata value
//   - Overview count/sizes
//   - GDALClose
//
// Compile requirement: libgdal-dev installed (see Dockerfile).
// ----------------------------------------------------------------------------

/*
#cgo pkg-config: gdal
#include "gdal.h"
#include "cpl_conv.h"
#include "cpl_error.h"
#include "ogr_srs_api.h"

// Error callback: store last error message in a thread-local-ish global.
// (CPL error handling is thread-local in GDAL, so this is safe per-goroutine
// as long as GDAL calls are on the same OS thread. We use runtime.LockOSThread
// in the callers to guarantee this.)
static char last_gdal_error[1024];
static int  last_gdal_error_set = 0;

static void goCPLErrorHandler(CPLErr errClass, int errNum, const char *msg) {
    if (msg) {
        strncpy(last_gdal_error, msg, sizeof(last_gdal_error) - 1);
        last_gdal_error[sizeof(last_gdal_error) - 1] = '\0';
        last_gdal_error_set = 1;
    }
}

static void installErrorHandler(void) {
    CPLSetErrorHandler(goCPLErrorHandler);
}

static const char *getLastError(void) {
    if (last_gdal_error_set) {
        last_gdal_error_set = 0;
        return last_gdal_error;
    }
    return NULL;
}

// Open a dataset. Returns NULL on failure (error captured by handler).
static GDALDatasetH goGDALOpen(const char *filename) {
    return GDALOpen(filename, GA_ReadOnly);
}

// GeoTransform helper: returns 0 on success, -1 on failure.
static int goGDALGetGeoTransform(GDALDatasetH ds, double *gt) {
    return GDALGetGeoTransform(ds, gt);
}

// RasterIO helper: read a window into a float32 buffer with resampling.
static CPLErr goGDALRasterIO(GDALRasterBandH band,
    int xOff, int yOff, int xSize, int ySize,
    float *buf, int bufXSize, int bufYSize) {
    return GDALRasterIO(band, GF_Read,
        xOff, yOff, xSize, ySize,
        buf, bufXSize, bufYSize, GDT_Float32, 0, 0);
}
*/
import "C"

import (
	"errors"
	"runtime"
	"sync"
	"unsafe"
)

// GdalDataset wraps a GDALDatasetH handle.
//
// GDAL/libtiff is NOT thread-safe: concurrent GDALRasterIO calls on the
// same dataset corrupt libtiff's internal buffer (TIFF_MYBUFFER) and crash
// with SIGABRT. The mu mutex serializes all IO on this dataset. Different
// datasets can still be read concurrently (different mutexes).
type GdalDataset struct {
	handle C.GDALDatasetH
	mu     sync.Mutex
}

// GdalBand wraps a GDALRasterBandH handle and a back-pointer to its parent
// dataset so IO calls can acquire the dataset lock.
type GdalBand struct {
	handle C.GDALRasterBandH
	ds     *GdalDataset
}

// gdalGlobalMu protects GDALOpen and GDALClose. The /vsigs/ virtual
// filesystem and CPL error handling share global state that is not safe
// for concurrent access during open/close. Reads on already-open datasets
// use the per-dataset mutex instead (allowing concurrency across files).
var gdalGlobalMu sync.Mutex

// gdalInited ensures GDALAllRegister and error handler are installed once.
var gdalInited = false

func gdalInit() {
	if gdalInited {
		return
	}
	C.GDALAllRegister()
	C.installErrorHandler()
	gdalInited = true
}

// gdalOpen opens a dataset from a URL/path (e.g. /vsigs/bucket/file.tif).
// Thread-safe: serialized via gdalGlobalMu because /vsigs/ and CPL are
// not safe for concurrent opens.
func gdalOpen(url string) (*GdalDataset, error) {
	gdalInit()

	gdalGlobalMu.Lock()
	defer gdalGlobalMu.Unlock()

	cURL := C.CString(url)
	defer C.free(unsafe.Pointer(cURL))

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	C.getLastError() // clear stale error
	ds := C.goGDALOpen(cURL)
	if ds == nil {
		errMsg := C.getLastError()
		if errMsg != nil {
			return nil, errors.New(C.GoString(errMsg))
		}
		return nil, errors.New("GDALOpen returned NULL")
	}
	return &GdalDataset{handle: ds}, nil
}

// Close releases the dataset. Thread-safe via gdalGlobalMu.
func (ds *GdalDataset) Close() {
	gdalGlobalMu.Lock()
	defer gdalGlobalMu.Unlock()

	if ds.handle != nil {
		C.GDALClose(ds.handle)
		ds.handle = nil
	}
}

// Width returns the raster width in pixels.
func (ds *GdalDataset) Width() int {
	return int(C.GDALGetRasterXSize(ds.handle))
}

// Height returns the raster height in pixels.
func (ds *GdalDataset) Height() int {
	return int(C.GDALGetRasterYSize(ds.handle))
}

// RasterCount returns the number of raster bands.
func (ds *GdalDataset) RasterCount() int {
	return int(C.GDALGetRasterCount(ds.handle))
}

// GeoTransform returns the affine geotransform [originX, pixelW, rotX, originY, rotY, pixelH].
func (ds *GdalDataset) GeoTransform() [6]float64 {
	var gt [6]C.double
	C.goGDALGetGeoTransform(ds.handle, &gt[0])
	return [6]float64{float64(gt[0]), float64(gt[1]), float64(gt[2]),
		float64(gt[3]), float64(gt[4]), float64(gt[5])}
}

// Projection returns the WKT projection string.
func (ds *GdalDataset) Projection() string {
	return C.GoString(C.GDALGetProjectionRef(ds.handle))
}

// Band returns the raster band at the given 1-based index.
func (ds *GdalDataset) Band(index int) *GdalBand {
	h := C.GDALGetRasterBand(ds.handle, C.int(index))
	if h == nil {
		return nil
	}
	return &GdalBand{handle: h, ds: ds}
}

// NodataValue returns the nodata value and whether one is set.
func (b *GdalBand) NodataValue() (float64, bool) {
	var hasNodata C.int
	val := C.GDALGetRasterNoDataValue(b.handle, &hasNodata)
	return float64(val), hasNodata != 0
}

// XSize returns the band width (may differ from dataset if this is an overview).
func (b *GdalBand) XSize() int {
	return int(C.GDALGetRasterBandXSize(b.handle))
}

// YSize returns the band height.
func (b *GdalBand) YSize() int {
	return int(C.GDALGetRasterBandYSize(b.handle))
}

// OverviewCount returns the number of overviews.
func (b *GdalBand) OverviewCount() int {
	return int(C.GDALGetOverviewCount(b.handle))
}

// Overview returns the overview band at the given 0-based index.
func (b *GdalBand) Overview(index int) *GdalBand {
	h := C.GDALGetOverview(b.handle, C.int(index))
	if h == nil {
		return nil
	}
	return &GdalBand{handle: h}
}

// ReadWindow reads a window of pixels into a float32 slice with resampling.
// GDAL automatically selects overviews when reading at lower resolution.
// srcXOff, srcYOff: pixel offset in the band
// srcW, srcH: window size in band pixels
// outW, outH: output size (GDAL resamples)
// Returns the float32 buffer or an error.
func (b *GdalBand) ReadWindow(srcXOff, srcYOff, srcW, srcH, outW, outH int) ([]float32, error) {
	buf := make([]float32, outW*outH)
	err := b.ReadWindowInto(buf, srcXOff, srcYOff, srcW, srcH, outW, outH)
	return buf, err
}

// ReadWindowInto reads a window into the provided buffer.
// Thread-safe: acquires the dataset mutex so concurrent goroutines
// don't corrupt libtiff's internal state.
func (b *GdalBand) ReadWindowInto(buf []float32, srcXOff, srcYOff, srcW, srcH, outW, outH int) error {
	if len(buf) < outW*outH {
		return errors.New("buffer too small")
	}

	b.ds.mu.Lock()
	defer b.ds.mu.Unlock()

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	// Clear any previous error
	C.getLastError()

	rc := C.goGDALRasterIO(b.handle,
		C.int(srcXOff), C.int(srcYOff), C.int(srcW), C.int(srcH),
		(*C.float)(unsafe.Pointer(&buf[0])),
		C.int(outW), C.int(outH))

	if rc != 0 {
		errMsg := C.getLastError()
		if errMsg != nil {
			return errors.New(C.GoString(errMsg))
		}
		return errors.New("GDALRasterIO failed")
	}
	return nil
}

// ReadPoint reads a single pixel value at (col, row).
func (b *GdalBand) ReadPoint(col, row int) (float32, error) {
	buf := make([]float32, 1)
	err := b.ReadWindowInto(buf, col, row, 1, 1, 1, 1)
	return buf[0], err
}
