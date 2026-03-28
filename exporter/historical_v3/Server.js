const express = require('express');
const path = require('path');
const fs = require('fs-extra');
const MetadataManager = require('./MetadataManager');
const SyncEngine = require('./SyncEngine');

const app = express();
const PORT = 3003;
const manager = new MetadataManager(__dirname);
const syncEngine = new SyncEngine(__dirname);

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, 'public')));

// serve cached tiles directly if requested by old index.js logic
app.use("/tile_cache", express.static(path.join(__dirname, "cache/tiles"), {
  setHeaders(res) { res.setHeader("Content-Type", "image/jpeg"); }
}));

app.get('/api/world-index', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'world_index.json');
    if (fs.existsSync(indexPath)) res.json(fs.readJsonSync(indexPath));
    else res.status(404).json({ error: "No index." });
});

// --- NEW HIGH-SPEED BATCH ENDPOINT (FOR PREVIOUS MECHANISM) ---
app.post("/tiles", async (req, res) => {
    const { date, bounds, zoom, iCode, fToken, sourcePath } = req.body || {};
    if (!bounds || !zoom) return res.status(400).send("Missing data");

    const { north, south, east, west } = bounds;
    const tileSize = manager.getTileGeoSize(zoom);
    const colLeft = Math.floor((west - (-180.0)) / tileSize);
    const colRight = Math.floor((east - (-180.0)) / tileSize);
    const rowBottom = Math.floor((south - (-180.0)) / tileSize);
    const rowTop = Math.floor((north - (-180.0)) / tileSize);

    const tileResults = [];
    const promises = [];

    for (let row = rowBottom; row <= rowTop; row++) {
        for (let col = colLeft; col <= colRight; col++) {
            const s = row * tileSize - 180.0;
            const w = col * tileSize - 180.0;
            const n = s + tileSize;
            const e = w + tileSize;

            // Generate slippy coords for fetchTileWithCropping
            const centerLat = (s + n) / 2;
            const centerLon = (w + e) / 2;
            const n_slippy = Math.pow(2, zoom);
            const sx = Math.floor((centerLon + 180) / 360 * n_slippy);
            const sy = Math.floor((1 - Math.log(Math.tan(centerLat * Math.PI / 180) + 1 / Math.cos(centerLat * Math.PI / 180)) / Math.PI) / 2 * n_slippy);

            // We use our existing high-speed fetch but wrap it for batch output
            const p = manager.fetchTileWithCropping(zoom, sx, sy, iCode, fToken, sourcePath).then(() => {
                // Return URL to the cached file
                // We recreate the same URL logic as socket.js for the MD5
                const version = `i.${iCode}`;
                const rowColStr = manager.getRowColInfoStr((s+n)/2, (w+e)/2, zoom);
                const tileUrl = `https://khmdb.google.com/flatfile?db=tm&f1-${rowColStr}-${version}-${fToken}`;
                const cacheName = manager.md5(tileUrl) + ".jpg";
                
                tileResults.push({
                    url: `/tile_cache/${cacheName}`,
                    bounds: { north: n, south: s, east: e, west: w }
                });
            }).catch(() => {});
            promises.push(p);
        }
    }

    await Promise.all(promises);
    res.json(tileResults);
});

app.get('/api/metadata-at', async (req, res) => {
    const { lat, lon, zoom } = req.query;
    const pathCode = manager.latLonToPath(parseFloat(lat), parseFloat(lon), parseInt(zoom));
    const data = await manager.fetchMetadata(pathCode);
    const enriched = data.entries.map(e => ({ ...e, sourcePath: data.sourcePath || pathCode }));
    res.json({ pathCode, ...data, entries: enriched });
});

app.get('/api/tile/:z/:x/:y', async (req, res) => {
    try {
        const buffer = await manager.fetchTileWithCropping(parseInt(req.params.z), parseInt(req.params.x), parseInt(req.params.y), req.query.iCode, req.query.fToken, req.query.sourcePath);
        res.set('Content-Type', 'image/jpeg').send(buffer);
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/log', (req, res) => {
    const { type, message, data } = req.body;
    const logPath = path.join(__dirname, 'session_log.txt');
    const logEntry = `[${new Date().toISOString()}] [${type}] ${message} ${data ? JSON.stringify(data) : ''}\n`;
    
    try {
        if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, "");
        fs.appendFileSync(logPath, logEntry);
        res.json({ status: "ok" });
    } catch (e) {
        console.error("Log error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

async function start() {
    await manager.init();
    
    // Startup check for log file
    const logPath = path.join(__dirname, 'session_log.txt');
    try {
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] Server Started\n`);
        console.log(`[BOOT] Logging active at: ${logPath}`);
    } catch (e) {
        console.error(`[BOOT] Logging disabled: ${e.message}`);
    }

    syncEngine.startBackgroundSync();
    app.listen(PORT, () => {
        console.log(`Universal Historical Server at http://localhost:${PORT}`);
    });
}
start().catch(console.error);
