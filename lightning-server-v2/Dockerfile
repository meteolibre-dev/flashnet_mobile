# Lightning Server V2 - TiTiler-based COG server
# Optimized for Google Cloud Run deployment

FROM python:3.11-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gdal-bin \
    libgdal-dev \
    libproj-dev \
    libgeos-dev \
    libspatialindex-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV PORT=8080
ENV BUCKET_BASE_URL=gs://inference_result_meteolibre_forecast/forecasts
# GDAL optimization for Cloud Run
ENV GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR
ENV GDAL_CACHEMAX=500
ENV RASTERIO_BLOCK_CACHE=1GB

# Set working directory
WORKDIR /app

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create cache directory
RUN mkdir -p /app/cache

# Expose port (Cloud Run uses 8080)
EXPOSE 8080

# Run the server
CMD ["python", "main_optimized.py"]
