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

const ZeroTileGeoSize = 360;
const ValidBoundRc = [-180.0, 180.0, 180.0, -180.0];

class MetadataManager {
    constructor(workDir) {
        this.workDir = workDir;
        this.cacheDir = path.join(workDir, 'cache');
        this.tileCacheDir = path.join(this.cacheDir, 'tiles');
        this.secretKey = null;
        this.catalog = null;
        this.probeCache = new Map();
        fs.ensureDirSync(this.tileCacheDir);
    }

    async init() {
        console.log("Initializing Lightning-Fast Engine...");
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
        try {
            const res = await axios.get("https://kh.google.com/dbRoot.v5?hl=el&gl=cy&output=proto&cv=7.3.6.10201&ct=pro", { responseType: 'arraybuffer', headers: REQUEST_HEADERS });
            const raw = Buffer.from(res.data);
            fs.writeFileSync(dbRootPath, raw);
            this.secretKey = readSecretKey(dbRootPath);
        } catch (e) {
            if (fs.existsSync(dbRootPath)) {
                this.secretKey = readSecretKey(dbRootPath);
            }
        }
    }

    decryptTile(buffer) { return decryptXOR(buffer, this.secretKey); }

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

    getRowColInfoStr(lat, lon, zoom) { return latLonToPath(lat, lon, zoom); }

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

        const procName = `p-${zoom}-${x}-${y}-${iCode}-${fToken}.jpg`;
        const procPath = path.join(this.tileCacheDir, procName);
        if (fs.existsSync(procPath)) return fs.readFileSync(procPath);

        let targetDepth = sourcePath ? Math.min(sourcePath.length, fullPath.length) : fullPath.length;

        
        console.log('[FetchTile] Center Path: ' + fullPath + ' Target Depth: ' + targetDepth + ' URL: &f1-' + fullPath + '-i.' + iCode + '-' + fToken);
        for (let len = targetDepth; len >= 5; len--) {
            const currentPath = fullPath.slice(0, len);
            const isAncestor = len < fullPath.length;

            const tileUrl = `&f1-${currentPath}-i.${iCode}-${fToken}`;
            const rawCacheName = this.md5(tileUrl) + ".jpg";
            const rawPath = path.join(this.tileCacheDir, rawCacheName);

            let buffer;
            if (fs.existsSync(rawPath)) {
                buffer = fs.readFileSync(rawPath);
            } else {
                                try {
                    const data = await Promise.any(BASE_URLS.map(base => {
                        const url = `&f1--i.-`;
                        return axios.get(url, { responseType: 'arraybuffer', headers: REQUEST_HEADERS, timeout: 5000 }).then(r => r.data);
                    }));
                    buffer = this.decryptTile(Buffer.from(data));
                    fs.writeFile(rawPath, buffer, () => {});
                } catch (e) {
                    if (len === 5) throw new Error("404");
                    continue;
                }
            }

            if (isAncestor) {
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
                fs.writeFile(procPath, out, () => {});
                return out;
            }
            return buffer;
        }
        throw new Error("404");
    }
    latLonToPath(lat, lon, zoom) {
        return this.getRowColInfoStr(lat, lon, zoom);
    }
}

module.exports = MetadataManager;