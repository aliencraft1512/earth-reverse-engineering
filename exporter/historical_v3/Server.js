const express = require('express');
const path = require('path');
const fs = require('fs-extra');
const MetadataManager = require('./MetadataManager');
const SyncEngine = require('./SyncEngine');

const app = express();
const PORT = 3003;
const manager = new MetadataManager(__dirname);
const syncEngine = new SyncEngine(__dirname);

// Predefined regions for the "Load-and-Index" hypothesis
const PREDEFINED_REGIONS = [
    { name: "Cyprus (Whole)", pathCode: "02020023" }, // Z6
    { name: "Nicosia", pathCode: "0202002311211002" }, // Z14
    { name: "Athens", pathCode: "0311222013132223" }, // Z14
    { name: "London", pathCode: "0211330120203222" }, // Z14
    { name: "New York", pathCode: "0310323113223003" } // Z14
];

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/world-index', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'world_index.json');
    if (fs.existsSync(indexPath)) {
        res.json(fs.readJsonSync(indexPath));
    } else {
        res.status(404).json({ error: "World index not generated yet." });
    }
});

app.get('/api/metadata/:pathCode', async (req, res) => {
    const data = await manager.fetchMetadata(req.params.pathCode);
    res.json(data);
});

app.get('/api/metadata-at', async (req, res) => {
    const { lat, lon, zoom } = req.query;
    if (!lat || !lon || !zoom) return res.status(400).json({ error: "Missing lat/lon/zoom" });
    const pathCode = manager.latLonToPath(parseFloat(lat), parseFloat(lon), parseInt(zoom));
    const data = await manager.fetchMetadata(pathCode);
    
    // Enrich entries with the sourcePath of the packet they came from
    const enrichedEntries = data.entries.map(e => ({
        ...e,
        sourcePath: data.sourcePath || pathCode
    }));

    res.json({ pathCode, ...data, entries: enrichedEntries });
});

app.get('/api/tile/:z/:x/:y', async (req, res) => {
    const { z, x, y } = req.params;
    const { iCode, fToken, sourcePath } = req.query; // Added sourcePath
    if (!iCode || !fToken) return res.status(400).send("Missing iCode or fToken");

    try {
        const tileBuffer = await manager.fetchTile(parseInt(z), parseInt(x), parseInt(y), iCode, fToken, sourcePath);
        res.set('Content-Type', 'image/jpeg');
        res.send(tileBuffer);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// Utility to refresh dbRoot manually
app.post('/api/refresh', async (req, res) => {
    try {
        await manager.refreshDbRoot();
        res.json({ status: "ok", message: "dbRoot refreshed from kh.google.com" });
    } catch (e) {
        res.status(500).json({ status: "error", message: e.message });
    }
});

async function start() {
    await manager.init();
    
    // Start background world sync (Don't await)
    syncEngine.startBackgroundSync().then(() => {
        console.log("[Sync] Background discovery task finished. Server remains active.");
    }).catch(e => {
        console.error("[Sync] Background discovery error:", e.message);
    });

    app.listen(PORT, () => {
        console.log(`Historical V3 Server running at http://localhost:${PORT}`);
        console.log(`Pre-indexing ${PREDEFINED_REGIONS.length} regions in background...`);
        
        // Use Promise.all to track pre-indexing completion
        const indexingPromises = PREDEFINED_REGIONS.map(async r => {
            try {
                await manager.fetchMetadata(r.pathCode);
                console.log(`[Cache] Indexed ${r.name}`);
            } catch (e) {
                console.warn(`[Cache] Failed for ${r.name}`);
            }
        });

        Promise.all(indexingPromises).then(() => {
            console.log("--- All pre-indexing complete. Server is fully ready. ---");
        });
    });
}

start().catch(console.error);
