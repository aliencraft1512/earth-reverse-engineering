const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const { HistoricalCatalog } = require('../historical/catalog');
const { slippyTileToCenter } = require('../historical/pathUtils');

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
        try {
            const res = await axios.get("https://kh.google.com/dbRoot.v5?hl=el&gl=cy&output=proto&cv=7.3.6.10201&ct=pro", { responseType: 'arraybuffer', headers: REQUEST_HEADERS });
            const raw = Buffer.from(res.data);
            let i = 0;
            const readVar = (b, o) => {
                let r = 0, s = 0, j = o;
                while (j < b.length) {
                    const x = b[j++];
                    r |= (x & 0x7f) << s;
                    if ((x & 0x80) === 0) return { v: r >>> 0, n: j };
                    s += 7;
                }
                return { v: r, n: j };
            };
            while (i < raw.length) {
                const { v: key, n: next } = readVar(raw, i);
                if ((key >> 3) === 2) {
                    const { v: len, n: start } = readVar(raw, next);
                    this.secretKey = Buffer.concat([Buffer.alloc(8), raw.subarray(start, start + len)]);
                    break;
                }
                i = (key & 7) === 2 ? readVar(raw, next).n + readVar(raw, next).v : next + 1;
            }
            fs.writeFile(path.join(this.workDir, 'dbRoot.v5'), raw, () => {});
        } catch (e) {
            const dbRootPath = path.join(this.workDir, 'dbRoot.v5');
            if (fs.existsSync(dbRootPath)) {
                this.secretKey = Buffer.concat([Buffer.alloc(8), fs.readFileSync(dbRootPath).subarray(0, 1016)]);
            }
        }
    }

    decryptTile(buffer) {
        const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        const out = Buffer.alloc(source.length);
        let j = 16;
        for (let i = 0; i < source.length; i++) {
            out[i] = source[i] ^ this.secretKey[(j + 8) % this.secretKey.length];
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
        const worldSize = Math.pow(2, zoom);
        let col = Math.floor((lon + 180) / 360 * worldSize);
        let row = Math.floor((180 - lat) / 360 * worldSize); 
        let path = "";
        for (let i = 0; i <= zoom; i++) {
            const sizeAtLevel = Math.pow(2, zoom - i);
            const r = Math.floor(row / sizeAtLevel) % 2;
            const c = Math.floor(col / sizeAtLevel) % 2;
            if (r > 0 && c > 0) path += "2";
            else if (r > 0 && c === 0) path += "3";
            else if (r === 0 && c === 0) path += "0";
            else path += "1";
        }
        return path;
    }

    async fetchMetadata(pathCode) {
        const cacheFile = path.join(this.cacheDir, `qp-${pathCode}.json`);
        if (fs.existsSync(cacheFile)) return fs.readJsonSync(cacheFile);
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

        for (let len = targetDepth; len >= 5; len--) {
            const currentPath = fullPath.slice(0, len);
            const isAncestor = len < fullPath.length;
            
            const tileUrl = `${BASE_URLS[0]}&f1-${currentPath}-i.${iCode}-${fToken}`;
            const rawCacheName = this.md5(tileUrl) + ".jpg";
            const rawPath = path.join(this.tileCacheDir, rawCacheName);

            let buffer;
            if (fs.existsSync(rawPath)) {
                buffer = fs.readFileSync(rawPath);
            } else {
                try {
                    const res = await axios.get(tileUrl, { responseType: 'arraybuffer', headers: REQUEST_HEADERS, timeout: 5000 });
                    buffer = this.decryptTile(Buffer.from(res.data));
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
