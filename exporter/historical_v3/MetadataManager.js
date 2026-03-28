const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const { HistoricalCatalog } = require('../historical/catalog');
const { readSecretKey, decryptXOR } = require('../historical/metadata');
const { slippyTileToCenter, latLonToPath } = require('../historical/pathUtils');

const BASE_URLS = ["https://khmdb.google.com/flatfile?db=tm", "https://cmpmap.com/flatfile?db=tm"];
const REQUEST_HEADERS = {
  'User-Agent': 'GoogleEarth/7.3.6.9796(Windows;Microsoft Windows (6.2.9200.0);el;kml:2.2;client:Pro;type:default)',
  'Accept-Encoding': 'gzip, deflate, gfe',
};

const DBROOT_URL = "https://kh.google.com/dbRoot.v5?hl=el&gl=cy&output=proto&cv=7.3.6.10201&ct=pro";

const ZeroTileGeoSize = 360;
const ValidBoundRc = [-180.0, 180.0, 180.0, -180.0];

class MetadataManager {
    constructor(workDir) {
        this.workDir = workDir;
        this.cacheDir = path.join(workDir, 'cache');
        this.tileCacheDir = path.join(this.cacheDir, 'tiles');
        this.secretKey = null;
        this.catalog = null;
        fs.ensureDirSync(this.tileCacheDir);
    }

    async init() {
        console.log("Initializing Stable V3 Engine...");
        await this.refreshDbRoot();
        this.catalog = new HistoricalCatalog({
            baseUrls: BASE_URLS,
            rootVersion: 366,
            secretKey: this.secretKey,
            requestHeaders: REQUEST_HEADERS
        });
    }

    async refreshDbRoot() {
        const dbRootPath = path.join(this.workDir, 'dbRoot.v5');
        
        // 1. Always try to fetch the LATEST dbRoot first
        try {
            console.log("[MetadataManager] Fetching latest dbRoot.v5...");
            const res = await axios.get(DBROOT_URL, { 
                responseType: 'arraybuffer', 
                headers: REQUEST_HEADERS,
                timeout: 5000 
            });
            const raw = Buffer.from(res.data);
            fs.writeFileSync(dbRootPath, raw);
            console.log("[MetadataManager] Latest dbRoot.v5 saved locally.");
        } catch (e) {
            console.warn("[MetadataManager] Remote fetch failed, using local fallback:", e.message);
        }

        // 2. Extract key from the best available file
        if (fs.existsSync(dbRootPath)) {
            this.secretKey = readSecretKey(dbRootPath);
            if (this.secretKey && this.secretKey.length === 1016) {
                console.log("[MetadataManager] Successfully extracted 1016-byte key.");
                return;
            }
        }

        // 3. Final fallback to parent directory if local extraction failed
        const parentDbRoot = path.join(this.workDir, '..', 'dbRoot.v5');
        if (fs.existsSync(parentDbRoot)) {
            this.secretKey = readSecretKey(parentDbRoot);
            if (this.secretKey && this.secretKey.length === 1016) {
                console.log("[MetadataManager] Found valid key in parent directory.");
            }
        }
        
        if (!this.secretKey) {
            console.error("[MetadataManager] CRITICAL: No valid XOR key could be obtained!");
        }
    }

    decryptTile(buffer) {
        return decryptXOR(buffer, this.secretKey);
    }

    md5(s) { return crypto.createHash("md5").update(s).digest("hex"); }
    getTileGeoSize(level) { return ZeroTileGeoSize / Math.pow(2, level); }
    
    getRowColInfoStr(lat, lon, zoom) {
        return latLonToPath(lat, lon, zoom);
    }

    async fetchMetadata(pathCode) {
        const cacheFile = path.join(this.cacheDir, `qp-${pathCode}.json`);
        if (fs.existsSync(cacheFile)) {
            const data = fs.readJsonSync(cacheFile);
            if (data.entries && data.entries.length > 0) return data;
        }
        const result = await this.catalog.fetchMetadataForPath(pathCode);
        fs.writeJson(cacheFile, result, () => {});
        return result;
    }

    async fetchTileWithCropping(zoom, x, y, iCode, fToken, sourcePath = null) {
        const center = slippyTileToCenter(zoom, x, y);
        const fullPath = this.getRowColInfoStr(center.lat, center.lon, zoom);

        const versionStr = `i.${iCode}`;
        const buildUrl = (base, p) => `&f1-${p}-${versionStr}-${fToken}`;
        
        const procName = `tile-${zoom}-${x}-${y}-${iCode}-${fToken}.jpg`;
        const procPath = path.join(this.tileCacheDir, procName);
        if (fs.existsSync(procPath)) return fs.readFileSync(procPath);

        // 1. DIRECT FETCH
        try {
            const directUrl = buildUrl(BASE_URLS[0], fullPath);
            const rawCacheName = this.md5(directUrl) + ".jpg";
            const rawPath = path.join(this.tileCacheDir, rawCacheName);

            let buffer;
            if (fs.existsSync(rawPath)) {
                buffer = fs.readFileSync(rawPath);
            } else {
                const data = await Promise.any(BASE_URLS.map(base => {
                    const url = buildUrl(base, fullPath);
                    return axios.get(url, { responseType: 'arraybuffer', headers: REQUEST_HEADERS, timeout: 2500 }).then(r => r.data);
                }));
                buffer = this.decryptTile(Buffer.from(data));
                fs.writeFileSync(rawPath, buffer);
            }
            fs.writeFileSync(procPath, buffer);
            return buffer;
        } catch (e) { }

        // 2. ANCESTOR FETCH
        let targetDepth = sourcePath ? Math.min(sourcePath.length, fullPath.length) : fullPath.length;
        if (targetDepth > 21) targetDepth = 21;

        for (let len = targetDepth - 1; len >= 5; len--) {
            const currentPath = fullPath.slice(0, len);
            const isAncestor = len < fullPath.length;

            const ancestorUrl = buildUrl(BASE_URLS[0], currentPath);
            const rawCacheName = this.md5(ancestorUrl) + ".jpg";
            const rawPath = path.join(this.tileCacheDir, rawCacheName);

            let buffer;
            if (fs.existsSync(rawPath)) {
                buffer = fs.readFileSync(rawPath);
            } else {
                try {
                    const data = await Promise.any(BASE_URLS.map(base => {
                        const url = buildUrl(base, currentPath);
                        return axios.get(url, { responseType: 'arraybuffer', headers: REQUEST_HEADERS, timeout: 4000 }).then(r => r.data);
                    }));
                    buffer = this.decryptTile(Buffer.from(data));
                    fs.writeFileSync(rawPath, buffer);
                } catch (e) { continue; }
            }

            const diff = fullPath.length - len;
            let top = 0, left = 0, size = 256;
            for (let i = 0; i < diff; i++) {
                const char = fullPath[len + i];
                size /= 2;
                if (char === '1') left += size;
                else if (char === '2') { left += size; top += size; }
                else if (char === '3') top += size;
            }
            const out = await sharp(buffer)
                .extract({ left: Math.round(left), top: Math.round(top), width: Math.max(1, Math.round(size)), height: Math.max(1, Math.round(size)) })
                .resize(256, 256, { kernel: 'nearest' })
                .toBuffer();
            fs.writeFileSync(procPath, out);
            return out;
        }
        throw new Error("404");
    }
    
    latLonToPath(lat, lon, zoom) {
        return this.getRowColInfoStr(lat, lon, zoom);
    }
}

module.exports = MetadataManager;