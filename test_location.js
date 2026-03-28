const MetadataManager = require('./exporter/historical_v3/MetadataManager');
const path = require('path');

async function test() {
    const manager = new MetadataManager(path.join(__dirname, 'exporter/historical_v3'));
    await manager.init();

    // Random location: Athens
    const lat = 37.9838;
    const lon = 23.7275;
    const zoom = 15;

    console.log(`\n--- Testing Location: Lat ${lat}, Lon ${lon}, Zoom ${zoom} ---`);
    
    const pathCode = manager.latLonToPath(lat, lon, zoom);
    console.log(`Generated PathCode: ${pathCode}`);

    console.log(`Fetching Metadata...`);
    const metadata = await manager.fetchMetadata(pathCode);
    console.log(`Found ${metadata.entries?.length || 0} entries.`);

    if (metadata.entries?.length > 0) {
        const e = metadata.entries[0];
        const sourcePath = metadata.sourcePath || pathCode;
        console.log(`Testing Tile Fetch for Date: ${e.date}, iCode: ${e.iCode}, sourcePath: ${sourcePath}`);
        
        // Simulate slippy tile calculation from app.js
        const n_slippy = Math.pow(2, zoom);
        const sx = Math.floor((lon + 180) / 360 * n_slippy);
        const sy = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n_slippy);

        try {
            const buffer = await manager.fetchTile(zoom, sx, sy, e.iCode, e.fToken, sourcePath);
            console.log(`SUCCESS: Fetched tile buffer (${buffer.length} bytes)`);
        } catch (err) {
            console.error(`FAILURE: ${err.message}`);
        }
    }
}

test();
