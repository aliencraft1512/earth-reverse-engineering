const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { Jimp } = require('jimp');

const { HistoricalCatalog } = require('../historical/catalog');

// In-line helper since pathUtils might be missing/inaccessible
function slippyTileToCenter(z, x, y) {
    const n = Math.pow(2, z);
    const lon = x / n * 360 - 180;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
    const lat = latRad * 180 / Math.PI;
    
    // For Plate Carree, we need to adjust slightly to get the center of the tile
    const nextLon = (x + 1) / n * 360 - 180;
    const nextLatRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n)));
    const nextLat = nextLatRad * 180 / Math.PI;
    
    return {
        lat: (lat + nextLat) / 2,
        lon: (lon + nextLon) / 2
    };
}

const BASE_URLS = [
    "https://khmdb.google.com/flatfile?db=tm",
    "https://kh.google.com/flatfile",
    "https://cmpmap.com/flatfile?db=tm"
];
const REQUEST_HEADERS = {
  'User-Agent': 'GoogleEarth/7.3.6.9796(Windows;Microsoft Windows (6.2.9200.0);el;kml:2.2;client:Pro;type:default)',
  'Accept-Encoding': 'gzip, deflate, gfe',
};

const ZeroTileGeoSize = 360;
const ValidBoundRc = [-180.0, 180.0, 180.0, -180.0];

// PRIORITY MAPPING FROM OLD SOCKET.JS
const LEGACY_MAPPING = {
  "2008-04-23": { v: 10,  token: "fb097" },
  "2013-10-24": { v: 115, token: "fbb58" },
  "2016-04-05": { v: 152, token: "fc085" },
  "2020-06-09": { v: 272, token: "fc8c9" },
  "2022-06-11": { v: 346, token: "fcccb" }
};

class MetadataManager {
    constructor(workDir) {
        this.workDir = workDir;
        this.cacheDir = path.join(workDir, 'cache');
        this.tileCacheDir = path.join(this.cacheDir, 'tiles');
        this.secretKey = null;
        this.catalog = null;
        this.dateVersionMapping = {}; // For fast batch lookups
        fs.ensureDirSync(this.tileCacheDir);
    }

    async init() {
        console.log("Initializing Universal Hybrid Engine...");
        await this.loadSecretKey();
        this.catalog = new HistoricalCatalog({
            baseUrls: BASE_URLS,
            rootVersion: 366,
            secretKey: this.secretKey,
            requestHeaders: REQUEST_HEADERS
        });
        console.log(`[BOOT] Engine ready. Key length: ${this.secretKey ? this.secretKey.length : 'NULL'}`);
    }

    async loadSecretKey() {
        const keyProbePath = path.join(this.workDir, 'probe_out', 'dbroot_field_2.bin');
        const fallbackPath = path.join(this.workDir, 'dbRoot.v5');
        
        try {
            if (fs.existsSync(keyProbePath)) {
                const rawKey = fs.readFileSync(keyProbePath);
                if (rawKey.length >= 1016) {
                    this.secretKey = Buffer.alloc(1016);
                    rawKey.copy(this.secretKey, 0, 0, 1016);
                    console.log("[MetadataManager] Loaded 1016-byte key from probe_out.");
                    return;
                }
            }
            
            const fallbackData = fs.readFileSync(fallbackPath);
            if (fallbackData.length === 1016) {
                this.secretKey = fallbackData;
                console.log("[MetadataManager] Loaded 1016-byte key from local dbRoot.v5.");
            } else {
                this.secretKey = Buffer.alloc(1016);
                fallbackData.copy(this.secretKey, 0, 0, Math.min(fallbackData.length, 1016));
                console.log("[MetadataManager] Warning: Using legacy key extraction fallback (truncated/padded to 1016).");
            }
        } catch (e) {
            console.error("[MetadataManager] CRITICAL: Failed to load XOR key:", e.message);
        }
    }

    async refreshDbRoot() {
        console.log("[MetadataManager] Fetching latest dbRoot.v5...");
        try {
            const res = await axios.get("https://kh.google.com/dbRoot.v5?hl=el&gl=cy&output=proto&cv=7.3.6.10201&ct=pro", { 
                responseType: 'arraybuffer', 
                headers: REQUEST_HEADERS,
                timeout: 10000 
            });
            const raw = Buffer.from(res.data);
            fs.writeFileSync(path.join(this.workDir, 'dbRoot.v5'), raw);
            console.log("[MetadataManager] dbRoot.v5 updated from remote.");
            await this.loadSecretKey(); // Re-extract
            return true;
        } catch (e) {
            console.error("[MetadataManager] Remote fetch failed, using local fallback:", e.message);
            return false;
        }
    }

    decryptTile(buffer) {
        if (!this.secretKey) throw new Error("secretKey not loaded");
        const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        const out = Buffer.alloc(buf.length);

        let j = 16;
        for (let i = 0; i < buf.length; i++) {
            const keyChar = this.secretKey[(j + 8) % this.secretKey.length];
            out[i] = buf[i] ^ keyChar;
            j++;
            if (j % 8 === 0) j += 16;
            if (j >= 1016) j = (j + 8) % 24;
        }
        return out;
    }

    md5(s) { return crypto.createHash("md5").update(s).digest("hex"); }
    getTileGeoSize(level) { return ZeroTileGeoSize / Math.pow(2, level); }
    
    getRowColInfoChar(rowIndex, colIndex) {
        const r = Math.abs(rowIndex) % 2;
        const c = Math.abs(colIndex) % 2;
        if (r > 0 && c > 0) return "2";
        if (r > 0 && c === 0) return "3";
        if (r === 0 && c === 0) return "0";
        return "1";
    }

    getRowColInfoStr(lat, lon, zoom) {
        let str = "";
        for (let i = 0; i <= zoom; i++) {
            const size = this.getTileGeoSize(i);
            const col = Math.floor((lon - ValidBoundRc[0]) / size);
            const row = Math.floor((lat - ValidBoundRc[3]) / size);
            str += this.getRowColInfoChar(row, col);
        }
        return str;
    }

    latLonToPath(lat, lon, zoom) {
        return this.getRowColInfoStr(lat, lon, zoom);
    }

    async fetchMetadata(pathCode) {
        const cacheFile = path.join(this.cacheDir, `qp-${pathCode}.json`);
        if (fs.existsSync(cacheFile)) {
            const data = fs.readJsonSync(cacheFile);
            this.updateMappingFromMetadata(data);
            return data;
        }
        
        console.log(`[MetadataManager] Fetching metadata for ${pathCode}...`);
        const result = await this.catalog.fetchMetadataForPath(pathCode);
        
        // Priority Overwrite: Use legacy mapping for known problematic dates
        result.entries = result.entries.map(e => {
            const legacy = LEGACY_MAPPING[e.date];
            if (legacy) return { ...e, iCode: legacy.v, fToken: legacy.token };
            return e;
        });

        this.updateMappingFromMetadata(result);
        fs.writeJson(cacheFile, result, () => {});
        return result;
    }

    updateMappingFromMetadata(metadata) {
        if (!metadata.entries) return;
        metadata.entries.forEach(e => {
            if (!this.dateVersionMapping[e.date]) {
                this.dateVersionMapping[e.date] = { iCode: e.iCode, fToken: e.fToken };
            }
        });
    }

    async fetchTile(z, x, y, iCode, fToken, sourcePath = null) {
        console.log(`[MetadataManager] Tile Request: ${z}/${x}/${y} i.${iCode} f.${fToken} src.${sourcePath}`);
        // Handle input normalization
        iCode = iCode || 366;
        fToken = fToken || "f1";

        const center = slippyTileToCenter(z, x, y);
        const fullPath = this.getRowColInfoStr(center.lat, center.lon, z);
        
        const procName = `proc-${z}-${x}-${y}-${iCode}-${fToken}.jpg`;
        const procPath = path.join(this.tileCacheDir, procName);
        if (fs.existsSync(procPath)) return fs.readFileSync(procPath);

        // Logic for fetching best available tile (original or ancestor)
        let targetDepth = sourcePath ? Math.min(sourcePath.length, fullPath.length) : fullPath.length;

        for (let len = targetDepth; len >= 4; len--) {
            const currentPath = fullPath.slice(0, len);
            const isAncestor = len < fullPath.length;
            
            const versionStr = isNaN(iCode) ? iCode : `i.${iCode}`;
            
            let buffer = null;
            let successBase = null;

            for (const base of BASE_URLS) {
                const sep = base.includes('?') ? '&' : '?';
                const tileUrl = `${base}${sep}f1-${currentPath}-${versionStr}-${fToken}`;
                const cacheName = this.md5(tileUrl) + ".jpg";
                const rawPath = path.join(this.tileCacheDir, cacheName);

                if (fs.existsSync(rawPath)) {
                    buffer = fs.readFileSync(rawPath);
                    successBase = base;
                    break;
                } else {
                    try {
                        console.log(`[MetadataManager] Trying: ${tileUrl}`);
                        const r = await axios.get(tileUrl, { 
                            responseType: 'arraybuffer', 
                            headers: REQUEST_HEADERS, 
                            timeout: 8000 
                        });
                        buffer = this.decryptTile(Buffer.from(r.data));
                        fs.writeFileSync(rawPath, buffer);
                        successBase = base;
                        break;
                    } catch (e) {
                        // try next base
                    }
                }
            }

            if (buffer) {
                if (isAncestor) {
                    const image = await Jimp.read(buffer);
                    const diff = fullPath.length - len;
                    let top = 0, left = 0, size = 256;
                    for (let i = 0; i < diff; i++) {
                        const char = fullPath[len + i];
                        size /= 2;
                        if (char === '1') left += size;
                        else if (char === '2') { left += size; top += size; }
                        else if (char === '3') top += size;
                    }
                    image.crop({ 
                        x: Math.round(left), 
                        y: Math.round(top), 
                        w: Math.max(1, Math.round(size)), 
                        h: Math.max(1, Math.round(size)) 
                    });
                    image.resize({ w: 256, h: 256 });
                    const out = await image.getBuffer("image/jpeg");
                    fs.writeFileSync(procPath, out);
                    return out;
                } else {
                    fs.writeFileSync(procPath, buffer);
                    return buffer;
                }
            }

            if (len === 4) throw new Error("404");
        }
        throw new Error("404");
    }
}

module.exports = MetadataManager;
