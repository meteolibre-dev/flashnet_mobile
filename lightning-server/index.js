const express = require('express');
const cors = require('cors');
const GeoTIFF = require('geotiff');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { ensureDir } = require('fs-extra');
const fetch = require('node-fetch'); // Need to install this or use built-in if Node 18+

// If node-fetch is not available in the environment (Node < 18), we might need to install it. 
// Standard 'fetch' is available in Node 18+. I'll assume Node 18+.
// If not, I'll install node-fetch.

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const CACHE_DIR = path.join(__dirname, 'cache');

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR);
}

// Math Helpers for Web Mercator
const R = 6378137;
const MAX_LAT = 85.0511287798;

function project(lat, lon) {
    let d = Math.PI / 180;
    let max = MAX_LAT;
    let latVal = Math.max(Math.min(max, lat), -max);
    let sin = Math.sin(latVal * d);
    
    return [
        R * lon * d,
        R * Math.log((1 + sin) / (1 - sin)) / 2
    ];
}

function unproject(x, y) {
    let d = 180 / Math.PI;
    return [
        x * d / R, // Lon
        (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * d // Lat
    ];
}

// Convert Tile (z,x,y) to Web Mercator Bounds
function tileBounds(z, x, y) {
    const minX = -20037508.3427892;
    const maxY = 20037508.3427892;
    const span = (20037508.3427892 * 2) / Math.pow(2, z);

    const x0 = minX + x * span;
    const y1 = maxY - y * span; // Top
    const x1 = minX + (x + 1) * span;
    const y0 = maxY - (y + 1) * span; // Bottom

    return [x0, y0, x1, y1]; // minX, minY, maxX, maxY (Meters)
}

// Color Ranges and Palettes
const RANGES = {
    'lightning': { min: 0, max: 20 },
    'sat_ch0': { min: -2, max: 15 },
    'sat_ch1': { min: -3, max: 120 },
};

function getColor(val, channelId) {
    if (isNaN(val)) return [0, 0, 0, 0];

    // Ranges
    let { min, max } = RANGES[channelId] || { min: 0, max: 1 };
    
    // Normalize
    let c = val;
    if (c < min) c = min;
    if (c > max) c = max;
    let range = max - min;
    let normalized = range === 0 ? 0 : (c - min) / range;
    let pixelVal = Math.floor(normalized * 255);

    if (channelId === 'lightning') {
        if (pixelVal >= 5) {
            // Lightning Palette
            // r=255, g=255*(1-p), b=0, a=...
            const p = pixelVal / 255;
            const r = 255;
            const g = Math.floor(255 * (1 - p));
            const b = 0;
            const a = Math.floor(Math.min(255, 100 + pixelVal * 2));
            return [r, g, b, a];
        } else {
            return [0, 0, 0, 0];
        }
    } else {
        // Grayscale
        // In App.tsx: opacity 0.8
        return [pixelVal, pixelVal, pixelVal, 204]; // 204 is approx 0.8 * 255
    }
}

// In-memory cache for open TIFF files to avoid re-opening constantly?
// For now, let's keep it simple: Open, Read, Close.

app.get('/metadata', async (req, res) => {
    const fileUrl = req.query.url;
    if (!fileUrl) return res.status(400).send('Missing url');

    const filename = path.basename(new URL(fileUrl).pathname);
    const localPath = path.join(CACHE_DIR, filename);

    try {
        if (!fs.existsSync(localPath)) {
            const response = await fetch(fileUrl);
            if (!response.ok) throw new Error(`Failed to fetch ${fileUrl}`);
            const buffer = await response.buffer();
            fs.writeFileSync(localPath, buffer);
        }

        const tiff = await GeoTIFF.fromFile(localPath);
        const image = await tiff.getImage();
        const bbox = image.getBoundingBox(); // [minX, minY, maxX, maxY]
        
        // MapLibre expects: [ [minX, maxY], [maxX, maxY], [maxX, minY], [minX, minY] ] (TL, TR, BR, BL)
        const coordinates = [
            [bbox[0], bbox[3]], // TL
            [bbox[2], bbox[3]], // TR
            [bbox[2], bbox[1]], // BR
            [bbox[0], bbox[1]]  // BL
        ];

        res.json({ coordinates });
    } catch (error) {
        console.error('Metadata Error:', error);
        res.status(500).send(error.message);
    }
});

app.get('/image', async (req, res) => {
    const fileUrl = req.query.url;
    const channelId = req.query.channel || 'lightning';
    
    if (!fileUrl) return res.status(400).send('Missing url');

    const filename = path.basename(new URL(fileUrl).pathname);
    const localPath = path.join(CACHE_DIR, filename);
    const cachePngPath = path.join(CACHE_DIR, `${filename}_${channelId}.png`);

    try {
        // 0. Check PNG Cache
        if (fs.existsSync(cachePngPath)) {
             res.type('image/png');
             res.sendFile(cachePngPath);
             return;
        }

        // 1. Ensure file exists
        if (!fs.existsSync(localPath)) {
            const response = await fetch(fileUrl);
            if (!response.ok) throw new Error(`Failed to fetch ${fileUrl}`);
            const buffer = await response.buffer();
            fs.writeFileSync(localPath, buffer);
        }

        // 2. Open TIFF
        const tiff = await GeoTIFF.fromFile(localPath);
        const image = await tiff.getImage();
        const width = image.getWidth();
        const height = image.getHeight();
        
        // NoData check
        const fileDirectory = image.getFileDirectory();
        let noDataValue = null;
        if (fileDirectory.GDAL_NODATA) {
            const cleanStr = String(fileDirectory.GDAL_NODATA).replace(/\0/g, '').trim();
            noDataValue = cleanStr.toLowerCase() === 'nan' ? NaN : parseFloat(cleanStr);
        }

        // 3. Read All Rasters
        const rasters = await image.readRasters();
        const data = rasters[0];

        // 4. Generate Buffer
        const buffer = Buffer.alloc(width * height * 4);
        
        // Check for vertical flip requirement
        // Standard GeoTIFF (North Up) has scaleY < 0.
        // If scaleY > 0, it is South Up (bottom-to-top), so we need to flip rows for PNG (top-to-bottom).
        const [scaleX, scaleY] = image.getResolution();
        const needsFlip = scaleY > 0;

        let ptr = 0;
        for (let y = 0; y < height; y++) {
            const row = needsFlip ? (height - 1 - y) : y;
            const rowOffset = row * width;
            
            for (let x = 0; x < width; x++) {
                let val = data[rowOffset + x];
                
                if (noDataValue !== null && val === noDataValue) {
                    val = NaN;
                }

                const [r, g, b, a] = getColor(val, channelId);
                
                buffer[ptr++] = r;
                buffer[ptr++] = g;
                buffer[ptr++] = b;
                buffer[ptr++] = a;
            }
        }

        // 5. Compress to PNG and Save to Cache
        await sharp(buffer, { raw: { width, height, channels: 4 } })
            .png({ compressionLevel: 6 }) // Moderate compression
            .toFile(cachePngPath);

        res.type('image/png');
        res.sendFile(cachePngPath);

    } catch (error) {
        console.error('Image Render Error:', error);
        res.status(500).send(error.message);
    }
});

app.get('/tiles/:z/:x/:y.png', async (req, res) => {
    const { z, x, y } = req.params;
    const fileUrl = req.query.url;
    const channelId = req.query.channel || 'lightning';

    if (!fileUrl) {
        return res.status(400).send('Missing url query parameter');
    }

    // Generate local filename from URL
    const filename = path.basename(new URL(fileUrl).pathname);
    const localPath = path.join(CACHE_DIR, filename);

    try {
        // 1. Download if not exists
        if (!fs.existsSync(localPath)) {
            console.log(`Downloading ${filename}...`);
            const response = await fetch(fileUrl);
            if (!response.ok) throw new Error(`Failed to fetch ${fileUrl}`);
            const buffer = await response.buffer(); // node-fetch v2 api, or arrayBuffer in v3
            fs.writeFileSync(localPath, buffer);
        }

        // 2. Open TIFF
        const tiff = await GeoTIFF.fromFile(localPath);
        const image = await tiff.getImage();
        
        // Get TIFF Metadata
        const width = image.getWidth();
        const height = image.getHeight();
        const bbox = image.getBoundingBox(); // [minX, minY, maxX, maxY] in LatLon
        const tiffMinLon = bbox[0];
        const tiffMinLat = bbox[1];
        const tiffMaxLon = bbox[2];
        const tiffMaxLat = bbox[3];
        const tiffWidthLon = tiffMaxLon - tiffMinLon;
        const tiffHeightLat = tiffMaxLat - tiffMinLat;

        // NoData handling
        const fileDirectory = image.getFileDirectory();
        let noDataValue = null;
        if (fileDirectory.GDAL_NODATA) {
            const cleanStr = String(fileDirectory.GDAL_NODATA).replace(/\0/g, '').trim();
            noDataValue = cleanStr.toLowerCase() === 'nan' ? NaN : parseFloat(cleanStr);
        }

        // 3. Determine Tile Bounds (Web Mercator)
        const [tileMinX, tileMinY, tileMaxX, tileMaxY] = tileBounds(parseInt(z), parseInt(x), parseInt(y));
        
        // 4. Create Output Buffer (256x256 RGBA)
        const TILE_SIZE = 256;
        const outBuffer = Buffer.alloc(TILE_SIZE * TILE_SIZE * 4);

        // 5. Optimization: Read a window from TIFF instead of random access
        // Calculate the LatLon bounds of the Tile
        const [minLon, minLat] = unproject(tileMinX, tileMinY); // Bottom-Left of tile
        const [maxLon, maxLat] = unproject(tileMaxX, tileMaxY); // Top-Right of tile

        // Map these LatLon bounds to TIFF Pixel Coordinates
        // TIFF is likely standard: X goes right, Y goes DOWN (if scaleY < 0 in resolution) or UP?
        const getTiffPixel = (lat, lon) => {
            const px = ((lon - tiffMinLon) / tiffWidthLon) * width;
            // Assumes North-Up Image (Y decreases as we go down the pixels)
            const py = ((tiffMaxLat - lat) / tiffHeightLat) * height; 
            return [px, py];
        };

        const [p1x, p1y] = getTiffPixel(minLat, minLon); // BL
        const [p2x, p2y] = getTiffPixel(maxLat, maxLon); // TR
        const [p3x, p3y] = getTiffPixel(maxLat, minLon); // TL
        const [p4x, p4y] = getTiffPixel(minLat, maxLon); // BR

        const winMinX = Math.floor(Math.min(p1x, p2x, p3x, p4x));
        const winMaxX = Math.ceil(Math.max(p1x, p2x, p3x, p4x));
        const winMinY = Math.floor(Math.min(p1y, p2y, p3y, p4y));
        const winMaxY = Math.ceil(Math.max(p1y, p2y, p3y, p4y));

        // Clamping
        const readX = Math.max(0, winMinX);
        const readY = Math.max(0, winMinY);
        const readW = Math.min(width, winMaxX) - readX;
        const readH = Math.min(height, winMaxY) - readY;

        if (readW <= 0 || readH <= 0) {
            // Tile is outside TIFF
            const png = await sharp(outBuffer, { raw: { width: 256, height: 256, channels: 4 } }).png().toBuffer();
            res.type('image/png');
            res.send(png);
            return;
        }

        // Read Raster Window
        const rasters = await image.readRasters({
            window: [readX, readY, readX + readW, readY + readH],
            width: readW,
            height: readH
        });
        const data = rasters[0]; // Channel 0

        // 6. Fill Tile Pixels
        for (let ty = 0; ty < TILE_SIZE; ty++) {
            // Web Mercator Y is top-down in the tile image
            // Calculate world Y for this row
            // Interpolate between tileMaxY (top) and tileMinY (bottom)
            const worldY = tileMaxY - (ty / TILE_SIZE) * (tileMaxY - tileMinY);
            
            for (let tx = 0; tx < TILE_SIZE; tx++) {
                const worldX = tileMinX + (tx / TILE_SIZE) * (tileMaxX - tileMinX);
                
                // Unproject to Lat/Lon
                const [lon, lat] = unproject(worldX, worldY);

                // Map to Read Window Coordinates
                const [absPx, absPy] = getTiffPixel(lat, lon);
                
                const localPx = Math.floor(absPx - readX);
                const localPy = Math.floor(absPy - readY);

                let val = NaN;
                if (localPx >= 0 && localPx < readW && localPy >= 0 && localPy < readH) {
                    val = data[localPy * readW + localPx];
                }
                
                // Check NoData
                if (noDataValue !== null && val === noDataValue) {
                    val = NaN;
                }

                // Colorize
                const [r, g, b, a] = getColor(val, channelId);

                const idx = (ty * TILE_SIZE + tx) * 4;
                outBuffer[idx] = r;
                outBuffer[idx + 1] = g;
                outBuffer[idx + 2] = b;
                outBuffer[idx + 3] = a;
            }
        }

        // 7. Send PNG
        const png = await sharp(outBuffer, { raw: { width: 256, height: 256, channels: 4 } })
            .png()
            .toBuffer();

        res.type('image/png');
        res.send(png);

    } catch (error) {
        console.error('Tile Error:', error);
        res.status(500).send(error.message);
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Tile Server running on port ${PORT}`);
});
