# Tile Job - Cloud Run Job for generating PNG tiles from COG files
# Optimized for Google Cloud Run job deployment

FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    gdal-bin \
    libgdal-dev \
    libproj-dev \
    libgeos-dev \
    libspatialindex-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1
ENV TILES_BUCKET=inference_result
ENV BUCKET_BASE_URL=gs://inference_result/forecasts
ENV TILES_PREFIX=tiles

WORKDIR /app

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python", "tile_generator.py", "--all"]