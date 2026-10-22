FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    gdal-bin \
    libgdal-dev \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1
ENV PORT=8080

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# eMudhra CA compromise (Oct 2026): refresh trust store
RUN pip install --no-cache-dir -U certifi

COPY . .

EXPOSE 8080

CMD ["python", "main.py"]
