const MetadataManager = require('./MetadataManager');
const path = require('path');
const fs = require('fs-extra');

async function crawlWorld() {
    console.log("=== Global Historical Imagery Crawler ===");
    const manager = new MetadataManager(__dirname);
    await manager.init();

    const MAX_ZOOM = 4; // Z4 = 512 tiles. Covers the whole world at decent resolution.
    const worldTimeline = new Map(); // Date -> Set of pathCodes
    const queue = ["0", "1"]; // Root tiles for Plate Carree
    const processed = new Set();

    let count = 0;
    console.log(`Starting crawl Z0 to Z${MAX_ZOOM}...`);

    while (queue.length > 0) {
        const pathCode = queue.shift();
        if (processed.has(pathCode)) continue;
        processed.add(pathCode);

        try {
            process.stdout.write(`\rCrawling ${pathCode} (${count++}/${processed.size + queue.length})... `);
            const metadata = await manager.fetchMetadata(pathCode);
            
            if (metadata.entries) {
                metadata.entries.forEach(e => {
                    if (!worldTimeline.has(e.date)) worldTimeline.set(e.date, new Set());
                    worldTimeline.get(e.date).add(pathCode);
                });
            }

            if (pathCode.length <= MAX_ZOOM) {
                for (let i = 0; i < 4; i++) {
                    queue.push(pathCode + i);
                }
            }
        } catch (e) {
            console.error(`\nFailed for ${pathCode}: ${e.message}`);
        }
    }

    console.log("\n\nAggregating results...");
    const result = {};
    const sortedDates = [...worldTimeline.keys()].sort().reverse();
    
    sortedDates.forEach(date => {
        result[date] = [...worldTimeline.get(date)];
    });

    const outputPath = path.join(__dirname, 'public', 'world_index.json');
    fs.writeJsonSync(outputPath, {
        generatedAt: new Date().toISOString(),
        zoomLevel: MAX_ZOOM,
        dates: result
    });

    console.log(`SUCCESS: World index saved to ${outputPath}`);
    console.log(`Total unique dates found: ${sortedDates.length}`);
}

crawlWorld().catch(console.error);
