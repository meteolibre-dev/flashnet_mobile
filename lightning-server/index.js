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
    'lightning': { min: 0, max: 4 },
    'sat_ch0': { min: -2, max: 15 },
    'sat_ch1': { min: -3, max: 120 },
};

// Gamma correction for increased contrast (values < 1 increase contrast)
const GAMMA = 0.5;

// Plasma colormap (256 entries) - from matplotlib
const PLASMA_COLORMAP = [
    [13, 8, 135], [16, 7, 138], [19, 7, 141], [22, 7, 144], [25, 6, 147], [27, 6, 150], [30, 5, 153], [33, 5, 156],
    [36, 4, 159], [38, 4, 161], [41, 4, 164], [44, 3, 166], [46, 3, 168], [49, 3, 170], [52, 3, 172], [54, 2, 174],
    [57, 2, 176], [60, 2, 177], [62, 2, 179], [65, 2, 180], [68, 1, 181], [70, 1, 182], [73, 1, 183], [76, 1, 184],
    [78, 1, 185], [81, 2, 186], [83, 2, 186], [86, 3, 187], [88, 4, 187], [91, 5, 187], [93, 6, 188], [96, 8, 188],
    [98, 9, 188], [100, 11, 188], [103, 13, 188], [105, 14, 188], [107, 16, 188], [110, 18, 188], [112, 20, 188],
    [114, 21, 188], [116, 23, 187], [118, 25, 187], [120, 27, 187], [122, 28, 186], [124, 30, 186], [126, 32, 185],
    [128, 33, 185], [130, 35, 184], [132, 37, 184], [134, 38, 183], [136, 40, 182], [137, 41, 182], [139, 43, 181],
    [141, 44, 180], [143, 46, 179], [144, 47, 178], [146, 49, 177], [148, 50, 176], [149, 52, 175], [151, 53, 174],
    [152, 55, 173], [154, 56, 172], [155, 57, 171], [157, 59, 170], [158, 60, 169], [160, 61, 168], [161, 63, 167],
    [162, 64, 165], [164, 65, 164], [165, 67, 163], [166, 68, 162], [168, 69, 160], [169, 71, 159], [170, 72, 158],
    [171, 73, 156], [172, 74, 155], [174, 76, 153], [175, 77, 152], [176, 78, 151], [177, 79, 149], [178, 81, 148],
    [179, 82, 146], [180, 83, 145], [181, 84, 143], [182, 85, 142], [183, 87, 140], [184, 88, 139], [185, 89, 137],
    [186, 90, 136], [187, 91, 134], [188, 92, 133], [188, 94, 131], [189, 95, 130], [190, 96, 128], [191, 97, 127],
    [192, 98, 125], [193, 99, 124], [193, 101, 122], [194, 102, 121], [195, 103, 119], [196, 104, 118], [196, 105, 116],
    [197, 106, 115], [198, 107, 113], [198, 108, 112], [199, 110, 110], [200, 111, 109], [200, 112, 107], [201, 113, 106],
    [201, 114, 104], [202, 115, 103], [203, 116, 101], [203, 117, 100], [204, 118, 99], [204, 120, 97], [205, 121, 96],
    [205, 122, 94], [206, 123, 93], [206, 124, 91], [207, 125, 90], [207, 126, 88], [208, 127, 87], [208, 128, 86],
    [208, 129, 84], [209, 131, 83], [209, 132, 81], [210, 133, 80], [210, 134, 79], [210, 135, 77], [211, 136, 76],
    [211, 137, 74], [212, 138, 73], [212, 139, 72], [212, 140, 70], [213, 142, 69], [213, 143, 68], [213, 144, 66],
    [214, 145, 65], [214, 146, 64], [214, 147, 62], [215, 148, 61], [215, 149, 60], [215, 150, 58], [215, 152, 57],
    [216, 153, 56], [216, 154, 55], [216, 155, 53], [216, 156, 52], [217, 157, 51], [217, 158, 49], [217, 159, 48],
    [217, 161, 47], [218, 162, 46], [218, 163, 45], [218, 164, 43], [218, 165, 42], [218, 166, 41], [219, 168, 40],
    [219, 169, 39], [219, 170, 37], [219, 171, 36], [219, 172, 35], [219, 174, 34], [219, 175, 33], [220, 176, 32],
    [220, 177, 31], [220, 178, 30], [220, 180, 29], [220, 181, 28], [220, 182, 27], [220, 183, 26], [220, 185, 25],
    [220, 186, 24], [220, 187, 24], [220, 188, 23], [220, 190, 22], [220, 191, 22], [220, 192, 21], [220, 193, 21],
    [220, 195, 20], [220, 196, 20], [220, 197, 20], [220, 199, 19], [220, 200, 19], [220, 201, 19], [220, 203, 19],
    [220, 204, 19], [220, 205, 19], [219, 207, 19], [219, 208, 20], [219, 209, 20], [219, 211, 21], [219, 212, 21],
    [218, 213, 22], [218, 215, 23], [218, 216, 24], [217, 217, 25], [217, 219, 26], [217, 220, 27], [216, 222, 29],
    [216, 223, 30], [215, 224, 32], [215, 226, 33], [214, 227, 35], [214, 228, 37], [213, 230, 39], [212, 231, 41],
    [212, 233, 43], [211, 234, 45], [211, 235, 47], [210, 237, 50], [209, 238, 52], [209, 239, 55], [208, 241, 57],
    [207, 242, 60], [207, 243, 63], [206, 245, 66], [205, 246, 69], [205, 247, 72], [204, 249, 75], [203, 250, 79],
    [203, 251, 82], [202, 252, 86], [201, 254, 89]
];

function getPlasmaColor(normalized) {
    const idx = Math.min(223, Math.max(0, Math.floor(normalized * 255)));
    return PLASMA_COLORMAP[idx];
}

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

    // Apply gamma correction for increased contrast
    normalized = Math.pow(normalized, GAMMA);
    // Clamp to valid range after gamma correction
    normalized = Math.min(1, Math.max(0, normalized));

    if (channelId === 'lightning') {
        let pixelVal = Math.floor(normalized * 255);
        if (pixelVal >= 5) {
            // Lightning Palette (yellow to red)
            const p = pixelVal / 255;
            const r = 255;
            const g = Math.floor(255 * (1 - p));
            const b = 0;
            const a = Math.floor(Math.min(255, 100 + pixelVal * 2));
            return [r, g, b, a];
        } else {
            return [0, 0, 0, 0];
        }
    } else if (channelId === 'sat_ch1') {
        // Plasma colormap for satellite channels (inverted for IR)
        const [r, g, b] = getPlasmaColor(1 - normalized);
        return [r, g, b, 204]; // 204 is approx 0.8 * 255
    } else {
        // Plasma colormap for satellite channels (not inverted for VIS)
        const [r, g, b] = getPlasmaColor(normalized);
        return [r, g, b, 204];
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

        // Original geographic bounds
        const minLon = bbox[0];
        const minLat = bbox[1];
        const maxLon = bbox[2];
        const maxLat = bbox[3];

        // MapLibre expects: [ [minX, maxY], [maxX, maxY], [maxX, minY], [minX, minY] ] (TL, TR, BR, BL)
        const coordinates = [
            [minLon, maxLat], // TL
            [maxLon, maxLat], // TR
            [maxLon, minLat], // BR
            [minLon, minLat]  // BL
        ];

        console.log('Original bounds:', { minLat, maxLat });

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
        const bbox = image.getBoundingBox(); // [minX, minY, maxX, maxY]
        const minLat = bbox[1];
        const maxLat = bbox[3];

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

        // Check for vertical flip requirement
        // Standard GeoTIFF (North Up) has scaleY < 0.
        const [scaleX, scaleY] = image.getResolution();
        const needsSourceFlip = scaleY > 0;

        // 4. Generate Buffer with Mercator Reprojection
        // The source TIFF has pixels spaced linearly by latitude (WGS84)
        // The output image needs pixels spaced linearly by Mercator Y (Web Mercator)
        // This ensures the image aligns correctly when overlaid on the map
        const buffer = Buffer.alloc(width * height * 4);

        const toMercatorY = (lat) => {
            const latRad = lat * Math.PI / 180;
            return R * Math.log((1 + Math.sin(latRad)) / (1 - Math.sin(latRad))) / 2;
        };

        const fromMercatorY = (y) => {
            const exp = Math.exp(y / R);
            return (2 * Math.atan(exp) - Math.PI / 2) * 180 / Math.PI;
        };

        const yMaxMerc = toMercatorY(maxLat);
        const yMinMerc = toMercatorY(minLat);
        const mercHeight = yMaxMerc - yMinMerc;

        console.log(`Mercator reprojection: lat [${minLat.toFixed(4)}, ${maxLat.toFixed(4)}] -> Y [${yMinMerc.toFixed(0)}, ${yMaxMerc.toFixed(0)}]`);

        let ptr = 0;
        for (let y = 0; y < height; y++) {
            // Calculate which Latitude this target row corresponds to in Mercator space
            const v = y / height; // 0 at top, 1 at bottom
            const currentMercY = yMaxMerc - v * mercHeight;
            const currentLat = fromMercatorY(currentMercY);

            // Find corresponding row in source data (Linear Latitude)
            // sourceV goes 0 (Top/MaxLat) to 1 (Bottom/MinLat)
            const sourceV = (maxLat - currentLat) / (maxLat - minLat);
            let sourceRow = Math.floor(sourceV * height);
            sourceRow = Math.max(0, Math.min(height - 1, sourceRow));

            // Handle vertical flip if source is bottom-up
            if (needsSourceFlip) {
                sourceRow = height - 1 - sourceRow;
            }

            const rowOffset = sourceRow * width;

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

// Get lightning data for a specific point (lat, lon) across all timesteps
app.get('/point', async (req, res) => {
    const { lat, lon, channel } = req.query;
    const channelId = channel || 'lightning';

    if (!lat || !lon) {
        return res.status(400).json({ error: 'Missing lat or lon query parameter' });
    }

    const latNum = parseFloat(lat);
    const lonNum = parseFloat(lon);

    if (isNaN(latNum) || isNaN(lonNum)) {
        return res.status(400).json({ error: 'Invalid lat or lon values' });
    }

    // Find all cached TIFF files for the requested channel, sorted by time (most recent last in filename)
    const files = fs.readdirSync(CACHE_DIR)
        .filter(f => f.endsWith(`_${channelId}.tiff`))
        .sort()
        .reverse(); // Most recent first

    if (files.length === 0) {
        return res.status(404).json({ error: 'No cached TIFF files found' });
    }

    const results = [];

    for (const filename of files) {
        const localPath = path.join(CACHE_DIR, filename);

        try {
            const tiff = await GeoTIFF.fromFile(localPath);
            const image = await tiff.getImage();

            const bbox = image.getBoundingBox();
            const tiffMinLon = bbox[0];
            const tiffMinLat = bbox[1];
            const tiffMaxLon = bbox[2];
            const tiffMaxLat = bbox[3];
            const width = image.getWidth();
            const height = image.getHeight();

            // Check if point is within this TIFF's bounds
            if (lonNum >= tiffMinLon && lonNum <= tiffMaxLon &&
                latNum >= tiffMinLat && latNum <= tiffMaxLat) {

                // Calculate pixel coordinates
                const px = Math.floor(((lonNum - tiffMinLon) / (tiffMaxLon - tiffMinLon)) * width);
                const py = Math.floor(((tiffMaxLat - latNum) / (tiffMaxLat - tiffMinLat)) * height);

                // Read single pixel
                const rasters = await image.readRasters({
                    window: [px, py, px + 1, py + 1],
                    width: 1,
                    height: 1
                });
                const value = rasters[0][0];

                // Get NoData value
                const fileDirectory = image.getFileDirectory();
                let noDataValue = null;
                if (fileDirectory.GDAL_NODATA) {
                    const cleanStr = String(fileDirectory.GDAL_NODATA).replace(/\0/g, '').trim();
                    noDataValue = cleanStr.toLowerCase() === 'nan' ? NaN : parseFloat(cleanStr);
                }

                const isNoData = noDataValue !== null && value === noDataValue;

                // Extract timestamp from filename: forecast_YYYYMMDDHHMM_channel.tiff
                const timeMatch = filename.match(/forecast_(\d{12})_/);
                const timestamp = timeMatch ? timeMatch[1] : null;

                results.push({
                    timestamp,
                    filename,
                    value: isNoData ? null : value,
                    isNoData
                });
            }
        } catch (error) {
            console.error(`Error reading ${filename}:`, error.message);
            continue;
        }
    }

    if (results.length === 0) {
        return res.status(404).json({ error: 'Point not found in any cached TIFF file' });
    }

    res.json({
        channel: channelId,
        coordinates: { lat: latNum, lon: lonNum },
        count: results.length,
        timesteps: results
    });
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

app.get('/admin/clear-cache', (req, res) => {
    try {
        const files = fs.readdirSync(CACHE_DIR);
        for (const file of files) {
            fs.unlinkSync(path.join(CACHE_DIR, file));
        }
        console.log(`Manual cache clear: deleted ${files.length} files.`);
        res.json({ success: true, deletedCount: files.length });
    } catch (error) {
        console.error('Manual Cache Clear Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const BUCKET_BASE_URL = "https://storage.googleapis.com/inference_result/forecasts";

// Pre-cache the last 18 timesteps for all channels at startup
async function preCacheLatestTimesteps() {
    console.log('Pre-caching latest timesteps...');
    const now = new Date();
    const datesToCheck = [];
    for (let i = 0; i < 3; i++) {
        const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        datesToCheck.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
    }

    const availableTimesteps = [];
    const remoteMetadata = {}; // filename -> { updated, dateFolder }

    // Scan for available timesteps
    for (const dateFolder of datesToCheck) {
        const listUrl = `https://storage.googleapis.com/storage/v1/b/inference_result/o?prefix=forecasts/${dateFolder}/`;
        try {
            const response = await fetch(listUrl);
            if (response.ok) {
                const data = await response.json();
                if (data.items) {
                    for (const item of data.items) {
                        const match = item.name.match(/forecast_(\d{12})_(lightning|sat_ch0|sat_ch1)\.tiff$/);
                        if (match) {
                            const filenameTime = match[1];
                            const channel = match[2];
                            const filename = path.basename(item.name);

                            remoteMetadata[filename] = {
                                updated: new Date(item.updated),
                                dateFolder
                            };

                            if (channel === 'lightning' && !availableTimesteps.find(s => s.filenameTime === filenameTime)) {
                                availableTimesteps.push({ dateFolder, filenameTime });
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.error(`Error scanning ${dateFolder}:`, error.message);
        }
    }

    // Sort by time and take the last 18
    availableTimesteps.sort((a, b) => a.filenameTime.localeCompare(b.filenameTime));
    const latestTimesteps = availableTimesteps.slice(-18);

    console.log(`Found ${latestTimesteps.length} latest timesteps. Checking for updates...`);

    // Download all channels for each timestep
    const channels = ['lightning', 'sat_ch0', 'sat_ch1'];
    let downloaded = 0;
    let upToDate = 0;

    for (const ts of latestTimesteps) {
        for (const channel of channels) {
            const filename = `forecast_${ts.filenameTime}_${channel}.tiff`;
            const localPath = path.join(CACHE_DIR, filename);
            const url = `${BUCKET_BASE_URL}/${ts.dateFolder}/${filename}`;
            const remoteInfo = remoteMetadata[filename];

            let shouldDownload = false;

            if (!fs.existsSync(localPath)) {
                shouldDownload = true;
            } else if (remoteInfo) {
                const localStat = fs.statSync(localPath);
                // If remote is newer than local, re-download
                if (remoteInfo.updated > localStat.mtime) {
                    console.log(`  Update detected for ${filename} (Remote: ${remoteInfo.updated.toISOString()}, Local: ${localStat.mtime.toISOString()})`);
                    shouldDownload = true;
                }
            }

            if (shouldDownload) {
                try {
                    console.log(`  Downloading ${filename}...`);
                    const response = await fetch(url);
                    if (response.ok) {
                        const buffer = await response.buffer();
                        fs.writeFileSync(localPath, buffer);
                        downloaded++;
                    }
                } catch (error) {
                    console.error(`  Failed to download ${filename}:`, error.message);
                }
            } else {
                upToDate++;
            }
        }
    }

    console.log(`Pre-caching complete. Downloaded ${downloaded} files, ${upToDate} already up-to-date.`);
}

async function cleanImageCache() {
    console.log('Running image cache cleanup...');
    try {
        const files = fs.readdirSync(CACHE_DIR);
        const pngFiles = files.filter(f => f.endsWith('.png'));
        let deletedCount = 0;

        for (const pngFile of pngFiles) {
            const pngPath = path.join(CACHE_DIR, pngFile);

            // Expected format: filename.tiff_channel.png
            const lastUnderscoreIndex = pngFile.lastIndexOf('_');
            if (lastUnderscoreIndex === -1) continue;

            const tiffFilename = pngFile.substring(0, lastUnderscoreIndex);
            const tiffPath = path.join(CACHE_DIR, tiffFilename);

            if (!fs.existsSync(tiffPath)) {
                console.log(`  Deleting orphaned cache: ${pngFile} (Source TIFF missing)`);
                fs.unlinkSync(pngPath);
                deletedCount++;
            } else {
                const tiffStat = fs.statSync(tiffPath);
                const pngStat = fs.statSync(pngPath);

                if (tiffStat.mtime > pngStat.mtime) {
                    console.log(`  Deleting stale cache: ${pngFile} (Source TIFF updated)`);
                    fs.unlinkSync(pngPath);
                    deletedCount++;
                }
            }
        }
        if (deletedCount > 0) {
            console.log(`Cleanup complete. Deleted ${deletedCount} files.`);
        } else {
            console.log('Cleanup complete. No stale files found.');
        }
    } catch (error) {
        console.error('Error during cache cleanup:', error);
    }
}

// Start server
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Tile Server running on port ${PORT}`);

    // Run cleanup immediately and then every 10 minutes
    await cleanImageCache();
    setInterval(cleanImageCache, 10 * 60 * 1000);

    // Initial pre-cache and then check for updates every 1 minute
    await preCacheLatestTimesteps();
    setInterval(preCacheLatestTimesteps, 1 * 60 * 1000);
});
