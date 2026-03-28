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

// --- REFRESH DBROOT ---
app.post('/api/refresh-dbroot', async (req, res) => {
    try {
        const success = await manager.refreshDbRoot();
        if (success) res.json({ status: "ok", message: "dbRoot updated and key re-extracted" });
        else res.status(500).json({ error: "Failed to refresh from remote" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/world-index', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'world_index.json');
    if (fs.existsSync(indexPath)) res.json(fs.readJsonSync(indexPath));
    else res.status(404).json({ error: "No index." });
});

app.get('/api/regions', (req, res) => {
    res.json([
        { name: "Nicosia", lat: 35.1856, lon: 33.3823, z: 15 },
        { name: "Athens", lat: 37.9838, lon: 23.7275, z: 15 },
        { name: "London", lat: 51.5074, lon: -0.1278, z: 15 }
    ]);
});

// --- HIGH-SPEED BATCH ENDPOINT (FOR PREVIOUS MECHANISM) ---
app.post("/tiles", async (req, res) => {
    const { date, bounds, zoom } = req.body || {};
    if (!bounds || !zoom) return res.status(400).send("Missing data");

    const mapping = manager.dateVersionMapping[date] || { iCode: 366, fToken: "f1" };
    const { iCode, fToken } = mapping;

    const { north, south, east, west } = bounds;
    const tileSize = manager.getTileGeoSize(zoom);
    
    const colLeft = Math.floor((west - (-180.0)) / tileSize);
    const colRight = Math.floor((east - (-180.0)) / tileSize);
    const rowBottom = Math.floor((south - (-180.0)) / tileSize);
    const rowTop = Math.floor((north - (-180.0)) / tileSize);

    console.log(`[Batch] Z${zoom} Cols:${colLeft}-${colRight} Rows:${rowBottom}-${rowTop}`);

    const tileResults = [];
    const promises = [];

    for (let row = rowBottom; row <= rowTop; row++) {
        for (let col = colLeft; col <= colRight; col++) {
            const tileSouth = row * tileSize - 180.0;
            const tileWest = col * tileSize - 180.0;
            const tileNorth = tileSouth + tileSize;
            const tileEast = tileWest + tileSize;

            const centerLat = (tileSouth + tileNorth) / 2;
            const centerLon = (tileWest + tileEast) / 2;
            
            const p = (async () => {
                const n_slippy = Math.pow(2, zoom);
                const sx = Math.floor((centerLon + 180) / 360 * n_slippy);
                const sy = Math.floor((1 - Math.log(Math.tan(centerLat * Math.PI / 180) + 1 / Math.cos(centerLat * Math.PI / 180)) / Math.PI) / 2 * n_slippy);

                try {
                    await manager.fetchTile(zoom, sx, sy, iCode, fToken);
                    const version = `i.${iCode}`;
                    const rowColStr = manager.getRowColInfoStr(centerLat, centerLon, zoom);
                    const tileUrl = `https://khmdb.google.com/flatfile?db=tm&f1-${rowColStr}-${version}-${fToken}`;
                    const cacheName = manager.md5(tileUrl) + ".jpg";
                    
                    tileResults.push({
                        url: `/tile_cache/${cacheName}`,
                        bounds: { north: tileNorth, south: tileSouth, east: tileEast, west: tileWest }
                    });
                } catch (err) {
                    console.error(`Batch fetch error at ${row},${col}:`, err.message);
                }
            })();
            promises.push(p);
        }
    }

    await Promise.all(promises);
    res.json(tileResults);
});

// --- DISCOVERY ENDPOINT ---
app.post("/available-dates", async (req, res) => {
    const { bounds, zoom } = req.body || {};
    if (!bounds || !zoom) return res.status(400).send("Missing data");
    
    try {
        const centerLat = (bounds.north + bounds.south) / 2;
        const centerLon = (bounds.east + bounds.west) / 2;
        const pathCode = manager.latLonToPath(centerLat, centerLon, zoom);
        const metadata = await manager.fetchMetadata(pathCode);
        
        const dates = metadata.entries.map(e => e.date);
        res.json({ availableDates: [...new Set(dates)] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/metadata-at', async (req, res) => {
    const { lat, lon, zoom } = req.query;
    const pathCode = manager.latLonToPath(parseFloat(lat), parseFloat(lon), parseInt(zoom));
    const data = await manager.fetchMetadata(pathCode);
    const enriched = (data.entries || []).map(e => ({ ...e, sourcePath: data.sourcePath || pathCode }));
    res.json({ pathCode, ...data, entries: enriched });
});

app.get('/api/tile/:z/:x/:y', async (req, res) => {
    try {
        const iCode = req.query.iCode ? parseInt(req.query.iCode) : null;
        const buffer = await manager.fetchTile(parseInt(req.params.z), parseInt(req.params.x), parseInt(req.params.y), iCode, req.query.fToken, req.query.sourcePath);
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
