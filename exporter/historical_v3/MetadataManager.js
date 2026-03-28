const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { Jimp } = require('jimp');

const { HistoricalCatalog } = require('../historical/catalog');
const { latLonToPath, slippyTileToCenter } = require('../historical/pathUtils');

const DBROOT_URLS = ["https://kh.google.com/dbRoot.v5?hl=el&gl=cy&output=proto&cv=7.3.6.10201&ct=pro"];
const BASE_URLS = [
    "https://khmdb.google.com/flatfile?db=tm",
    "https://cmpmap.com/flatfile?db=tm"
];

const REQUEST_HEADERS = {
  'User-Agent': 'GoogleEarth/7.3.6.9796(Windows;Microsoft Windows (6.2.9200.0);el;kml:2.2;client:Pro;type:default)',
  'Accept-Encoding': 'gzip, deflate, gfe',
};

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
        console.log("Initializing Streaming Metadata Engine...");
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
            const res = await axios.get(DBROOT_URLS[0], { responseType: 'arraybuffer', headers: REQUEST_HEADERS });
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

    decryptXOR(source) {
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

    md5(s) {
        return crypto.createHash("md5").update(s).digest("hex");
    }

    async fetchMetadata(pathCode) {
        const cacheFile = path.join(this.cacheDir, `qp-${pathCode}.json`);
        if (fs.existsSync(cacheFile)) return fs.readJsonSync(cacheFile);
        const result = await this.catalog.fetchMetadataForPath(pathCode);
        fs.writeJson(cacheFile, result, () => {});
        return result;
    }

    async fetchTile(z, x, y, iCode, fToken, forcedSourcePath = null) {
        // 1. IMMEDIATE HIT: Processed small tile (FASTEST)
        const processedName = `proc-${z}-${x}-${y}-${iCode}-${fToken}.jpg`;
        const processedPath = path.join(this.tileCacheDir, processedName);
        if (fs.existsSync(processedPath)) return fs.readFileSync(processedPath);

        const center = slippyTileToCenter(z, x, y);
        const fullPath = latLonToPath(center.lat, center.lon, z);
        let startLen = forcedSourcePath ? Math.min(forcedSourcePath.length, fullPath.length) : fullPath.length;

        for (let len = startLen; len >= 5; len--) {
            const currentPath = fullPath.slice(0, len);
            const isAncestor = len < fullPath.length;
            
            // 2. CACHE CHECK: Raw Large Tile
            const version = `i.${iCode}`;
            const tileUrl = `${BASE_URLS[0]}&f1-${currentPath}-${version}-${fToken}`;
            const cacheName = this.md5(tileUrl) + ".jpg";
            const rawTilePath = path.join(this.tileCacheDir, cacheName);

            let buffer;
            if (fs.existsSync(rawTilePath)) {
                buffer = fs.readFileSync(rawTilePath);
            } else {
                // Racing Mirrors for maximum network speed
                try {
                    const data = await Promise.any(BASE_URLS.map(base => {
                        const url = `${base}&f1-${currentPath}-${version}-${fToken}`;
                        return axios.get(url, { responseType: 'arraybuffer', headers: REQUEST_HEADERS, timeout: 4000 }).then(r => r.data);
                    }));
                    buffer = this.decryptXOR(Buffer.from(data));
                    fs.writeFile(rawTilePath, buffer, () => {});
                } catch (e) {
                    if (len === 5) throw new Error("404");
                    continue; 
                }
            }

            if (isAncestor) {
                // If we need to crop, do it asynchronously and return the buffer immediately
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
                
                image.crop({ x: Math.round(left), y: Math.round(top), w: Math.max(1, Math.round(size)), h: Math.max(1, Math.round(size)) });
                image.resize({ w: 256, h: 256 });
                const processedBuffer = await image.getBuffer("image/jpeg");
                fs.writeFile(processedPath, processedBuffer, () => {}); // Async background write
                return processedBuffer;
            }
            
            return buffer;
        }
        throw new Error("404");
    }

    latLonToPath(lat, lon, zoom) {
        const { latLonToPath: actual } = require('../historical/pathUtils');
        return actual(lat, lon, zoom);
    }
}

module.exports = MetadataManager;
