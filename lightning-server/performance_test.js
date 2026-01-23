const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const BASE_URL = 'http://localhost:3000';
const CACHE_DIR = path.join(__dirname, 'cache');
const DATE_STR = '2026-01-20';
const TIMESTAMP = '202601201040';

const CHANNELS = [
    { id: 'lightning', name: 'Thunder (Lightning)', suffix: 'lightning' },
    { id: 'sat_ch0', name: 'Satellite CH0', suffix: 'sat_ch0' },
    { id: 'sat_ch1', name: 'Satellite CH1', suffix: 'sat_ch1' }
];

async function clearCache(filename) {
    const files = [
        path.join(CACHE_DIR, filename),
        path.join(CACHE_DIR, `${filename}_lightning.png`),
        path.join(CACHE_DIR, `${filename}_sat_ch0.png`),
        path.join(CACHE_DIR, `${filename}_sat_ch1.png`),
    ];
    files.forEach(f => {
        if (fs.existsSync(f)) {
            try {
                fs.unlinkSync(f);
            } catch (e) {
                console.error(`Failed to delete ${f}: ${e.message}`);
            }
        }
    });
}

async function measure(url) {
    const start = performance.now();
    try {
        const res = await fetch(url);
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
        }
        await res.buffer();
        const end = performance.now();
        return end - start;
    } catch (error) {
        console.error(`Fetch error: ${error.message}`);
        return null;
    }
}

async function runScenario(name, url, filename, iterations = 3) {
    console.log(`\n  Scenario: ${name}`);

    // 1. Cold Cache (Uncached)
    await clearCache(filename);
    const coldTime = await measure(url);
    console.log(`    Cold Cache: ${coldTime ? coldTime.toFixed(2) + 'ms' : 'FAILED'}`);

    // 2. Warm Cache (Cached)
    let totalWarm = 0;
    let warmCounts = 0;
    for (let i = 0; i < iterations; i++) {
        const warmTime = await measure(url);
        if (warmTime) {
            totalWarm += warmTime;
            warmCounts++;
        }
    }
    const avgWarm = warmCounts > 0 ? (totalWarm / warmCounts).toFixed(2) : 'FAILED';
    console.log(`    Warm Cache (avg of ${iterations}): ${avgWarm}ms`);
}

async function runTests() {
    console.log('=========================================');
    console.log('Backend Latency Performance Tests');
    console.log(`Target: ${BASE_URL}`);
    console.log('=========================================');

    try {
        // Verify server is up with a simple health check or metadata call
        const firstChan = CHANNELS[0];
        const testFilename = `forecast_${TIMESTAMP}_${firstChan.suffix}.tiff`;
        const testUrl = `https://storage.googleapis.com/inference_result/forecasts/${DATE_STR}/${testFilename}`;

        await fetch(`${BASE_URL}/metadata?url=${testUrl}`).catch(() => {
            throw new Error(`Server is not running at ${BASE_URL}. Please start it first.`);
        });

        for (const channel of CHANNELS) {
            console.log(`\nCHANNEL: ${channel.name} (${channel.id})`);
            const filename = `forecast_${TIMESTAMP}_${channel.suffix}.tiff`;
            const sourceUrl = `https://storage.googleapis.com/inference_result/forecasts/${DATE_STR}/${filename}`;

            await runScenario('Metadata (/metadata) - Frontend Init', `${BASE_URL}/metadata?url=${sourceUrl}`, filename);
            await runScenario('Full Image Overlay (/image) - Europe View', `${BASE_URL}/image?url=${sourceUrl}&channel=${channel.id}`, filename);
            await runScenario('Tile Extraction (/tiles/6/34/22.png) - Central Europe', `${BASE_URL}/tiles/6/34/22.png?url=${sourceUrl}&channel=${channel.id}`, filename);
        }

    } catch (error) {
        console.error(`\nTest Suite Failed: ${error.message}`);
        process.exit(1);
    }
}

runTests();
