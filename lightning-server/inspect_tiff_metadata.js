const GeoTIFF = require('geotiff');
const fs = require('fs');

async function inspect() {
    // Try to find a TIFF in the cache directory
    const cacheDir = './cache';
    if (!fs.existsSync(cacheDir)) {
        console.log('Cache dir not found');
        return;
    }
    const files = fs.readdirSync(cacheDir).filter(f => f.endsWith('.tiff'));
    if (files.length === 0) {
        console.log('No TIFF files in cache to inspect. Please run the app and let it download a TIFF first.');
        return;
    }

    const filename = files[0];
    console.log(`Inspecting ${filename}...`);
    const tiff = await GeoTIFF.fromFile(`${cacheDir}/${filename}`);
    const image = await tiff.getImage();

    console.log('Image Width:', image.getWidth());
    console.log('Image Height:', image.getHeight());
    console.log('Bounding Box:', image.getBoundingBox());
    console.log('Origin:', image.getOrigin());
    console.log('Resolution:', image.getResolution());
    console.log('GeoKeys:', image.getGeoKeys());
}

inspect().catch(console.error);
