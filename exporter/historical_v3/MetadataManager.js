const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { Jimp } = require('jimp');

const { HistoricalCatalog } = require('../historical/catalog');
const { slippyTileToCenter } = require('../historical/pathUtils');

const BASE_URLS = ["https://khmdb.google.com/flatfile?db=tm", "https://cmpmap.com/flatfile?db=tm"];
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
        fs.ensureDirSync(this.tileCacheDir);
    }

    async init() {
        console.log("Initializing Universal Hybrid Engine...");
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
            this.secretKey = Buffer.concat([Buffer.alloc(8), fs.readFileSync(path.join(this.workDir, 'dbRoot.v5')).subarray(0, 1016)]);
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

    async fetchMetadata(pathCode) {
        const cacheFile = path.join(this.cacheDir, `qp-${pathCode}.json`);
        if (fs.existsSync(cacheFile)) return fs.readJsonSync(cacheFile);
        const result = await this.catalog.fetchMetadataForPath(pathCode);
        
        // Priority Overwrite: Use legacy mapping for known problematic dates
        result.entries = result.entries.map(e => {
            const legacy = LEGACY_MAPPING[e.date];
            if (legacy) return { ...e, iCode: legacy.v, fToken: legacy.token };
            return e;
        });

        fs.writeJson(cacheFile, result, () => {});
        return result;
    }

    async fetchTile(z, x, y, iCode, fToken, sourcePath = null) {
        const center = slippyTileToCenter(z, x, y);
        const fullPath = this.getRowColInfoStr(center.lat, center.lon, z);
        
        const procName = `proc-${z}-${x}-${y}-${fullPath}-${iCode}.jpg`;
        const procPath = path.join(this.tileCacheDir, procName);
        if (fs.existsSync(procPath)) return fs.readFileSync(procPath);

        let targetDepth = sourcePath ? Math.min(sourcePath.length, fullPath.length) : fullPath.length;

        for (let len = targetDepth; len >= 5; len--) {
            const currentPath = fullPath.slice(0, len);
            const isAncestor = len < fullPath.length;
            
            const tileUrl = `${BASE_URLS[0]}&f1-${currentPath}-i.${iCode}-${fToken}`;
            const rawPath = path.join(this.tileCacheDir, this.md5(tileUrl) + ".jpg");

            let buffer;
            if (fs.existsSync(rawPath)) {
                buffer = fs.readFileSync(rawPath);
            } else {
                try {
                    const data = await Promise.any(BASE_URLS.map(base => {
                        const url = `${base}&f1-${currentPath}-i.${iCode}-${fToken}`;
                        return axios.get(url, { responseType: 'arraybuffer', headers: REQUEST_HEADERS, timeout: 5000 }).then(r => r.data);
                    }));
                    buffer = this.decryptXOR(Buffer.from(data));
                    fs.writeFile(rawPath, buffer, () => {});
                } catch (e) {
                    if (len === 5) throw new Error("404");
                    continue; 
                }
            }

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
                image.crop({ x: Math.round(left), y: Math.round(top), w: Math.max(1, Math.round(size)), h: Math.max(1, Math.round(size)) });
                image.resize({ w: 256, h: 256 });
                const out = await image.getBuffer("image/jpeg");
                fs.writeFile(procPath, out, () => {});
                return out;
            }
            return buffer;
        }
        throw new Error("404");
    }
}

module.exports = MetadataManager;
