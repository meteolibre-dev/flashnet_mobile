# lightning-server-v2

High-performance TiTiler-based COG server for lightning and satellite weather forecasting data.

## Overview

This server uses [TiTiler](https://developmentseed.org/titiler/) (built on [rio-tiler](https://cogeo.org/)) to serve Cloud Optimized GeoTIFFs (COGs) as XYZ tiles. This provides significant performance improvements over the original custom server:

- **Fast tile generation**: Uses COG overviews for instant low-zoom tiles
- **Efficient I/O**: Only reads required bytes from the file
- **Built-in caching**: Leverages HTTP caching and GDAL's internal caching
- **Multi-band support**: Handles multi-band COGs efficiently

## Data Structure

Your data consists of 18 temporal timesteps × 3 channels:

- **lightning**: Lightning detection data (0-4 scale)
- **sat_ch0**: Satellite channel 0 (visible, -2 to 15)
- **sat_ch1**: Satellite channel 1 (infrared, -3 to 120)

File naming: `forecast_YYYYMMDDHHMM_channel.tiff`

## Quick Start

### Installation

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # Linux/Mac
# or: venv\Scripts\activate  # Windows

# Install dependencies
pip install -r requirements.txt
```

### Running

```bash
# Development mode
python main_optimized.py

# Or with uvicorn
uvicorn main_optimized:app --reload --port 3001

# Run tests
python test_client.py
```

### Docker

```bash
# Build and run with Docker
docker build -t lightning-server-v2 .
docker run -p 3001:3001 lightning-server-v2

# Or with docker-compose
docker-compose up -d
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | API info |
| `GET /health` | Health check |
| `GET /bands` | List available bands |
| `GET /times` | List available timestamps |
| `GET /tiles/{z}/{x}/{y}.png` | Get XYZ tile |
| `GET /tilejson` | Get TileJSON |
| `GET /bounds` | Get geographic bounds |
| `GET /info` | Get COG metadata |
| `GET /statistics/{band}/{time}` | Get band statistics |

## Query Parameters

### Tiles Endpoint

```
GET /tiles/{z}/{x}/{y}.png?band=lightning&time=202601190100
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| band | string | Yes | Band name: `lightning`, `sat_ch0`, `sat_ch1` |
| time | string | Yes | Timestamp in `YYYYMMDDHHMM` format |

### TileJSON Endpoint

```
GET /tilejson?band=lightning&time=202601190100
```

Returns a TileJSON document for use with MapLibre, Mapbox, etc.

## Client Integration

### MapLibre GL JS

```javascript
const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      lightning: {
        type: 'raster',
        tiles: [
          'http://localhost:3001/tiles/{z}/{x}/{y}.png?band=lightning&time=202601190100'
        ],
        tileSize: 256
      }
    },
    layers: [{
      id: 'lightning-layer',
      type: 'raster',
      source: 'lightning',
      minzoom: 0,
      maxzoom: 12
    }]
  }
});
```

### React Native / Expo

```javascript
// Use with react-native-maps or expo-map
const tileUrl = `http://your-server:3001/tiles/${z}/${x}/${y}.png?band=lightning&time=${timestamp}`;
```

## Performance Tips

1. **Use COG format**: Ensure your TIFF files are converted to Cloud Optimized GeoTIFF format
2. **Overview levels**: Create overviews at levels [2, 4, 8, 16, 32]
3. **Compression**: Use DEFLATE compression for smaller files
4. **GDAL cache**: Increase GDAL cache for better performance:
   ```bash
   export GDAL_CACHEMAX=2000  # MB
   ```

## Converting to COG

If your TIFFs are not in COG format:

```bash
python -m pip install rio-cogeo

# Convert a single file
python cog_utils.py convert input.tif output_cog.tif

# Batch convert
python cog_utils.py convert /path/to/tiffs /path/to/cogs
```

## Configuration

Copy `.env.example` to `.env` and adjust:

```bash
cp .env.example .env
# Edit .env with your settings
```

Key settings:
- `BUCKET_BASE_URL`: GCS bucket URL
- `PORT`: Server port
- `CACHE_DIR`: Tile cache directory
- `MAX_CACHE_SIZE_GB`: Maximum cache size

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Client (App/Map)                     │
└─────────────────────┬───────────────────────────────────┘
                      │ HTTP XYZ Tiles
                      ▼
┌─────────────────────────────────────────────────────────┐
│              Lightning Server V2 (TiTiler)             │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐   │
│  │  FastAPI    │  │  rio-tiler  │  │  Custom      │   │
│  │  Endpoints  │──│  COG Reader │──│  Colormaps   │   │
│  └─────────────┘  └─────────────┘  └──────────────┘   │
└─────────────────────┬───────────────────────────────────┘
                      │ Direct HTTP Range Requests
                      ▼
┌─────────────────────────────────────────────────────────┐
│           Google Cloud Storage (GCS)                    │
│    forecast_YYYYMMDDHHMM_{lightning|sat_ch0|ch1}.tiff  │
└─────────────────────────────────────────────────────────┘
```

## Comparison with V1

| Feature | V1 (Custom) | V2 (TiTiler) |
|---------|-------------|---------------|
| Tile generation | Manual | COG native |
| Performance | Slower | ~10x faster |
| Caching | Custom | HTTP + GDAL |
| Multi-band | Manual | Native |
| Deployment | Node.js | Python/Docker |

## License

ISC
