# Lightning Server Go — High-performance COG tile server
# Uses GDAL via cgo for Cloud Optimized GeoTIFF reading.

# ── Build stage ──────────────────────────────────────────────────────────────
FROM golang:1.22-bookworm AS builder

# Install GDAL development libraries (required for cgo)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgdal-dev \
    gdal-bin \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Cache module downloads
COPY go.mod go.sum ./
RUN go mod download

# Copy source and build
COPY . .
RUN CGO_ENABLED=1 go build -o lightning-server-go .

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM debian:bookworm-slim

# Install GDAL runtime libraries (no -dev needed)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgdal32 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /build/lightning-server-go .

# Environment defaults (overridable at runtime)
ENV PORT=8080
ENV BUCKET_BASE_URL=gs://inference_result_meteolibre_forecast/forecasts
ENV GOMAXPROCS=4

# GDAL optimizations (same as Python server)
ENV CPL_VSIL_CURL_ALLOWED_EXTENSIONS=tif,tiff
ENV GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR
ENV VSI_CACHE=FALSE
ENV GDAL_HTTP_MERGE_CONSECUTIVE_RANGES=YES
ENV GDAL_CACHEMAX=500

EXPOSE 8080

CMD ["./lightning-server-go"]
