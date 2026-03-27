const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const zlib = require('zlib');

const { HistoricalCatalog } = require('../historical/catalog');
const { latLonToPath, slippyTileToCenter } = require('../historical/pathUtils');

const DBROOT_URLS = [
    "https://kh.google.com/dbRoot.v5?hl=el&gl=cy&output=proto&cv=7.3.6.10201&ct=pro",
    "https://khmdb.google.com/dbRoot.v5?hl=el&gl=cy&output=proto&cv=7.3.6.10201&ct=pro"
];
const BASE_URLS = [
    "https://khmdb.google.com/flatfile?db=tm",
    "https://cmpmap.com/flatfile?db=tm",
    "https://kh.google.com/flatfile?db=tm"
];
const ROOT_VERSION = 366;

const REQUEST_HEADERS = {
  'User-Agent': 'GoogleEarth/7.3.6.9796(Windows;Microsoft Windows (6.2.9200.0);el;kml:2.2;client:Pro;type:default)',
  'Accept-Encoding': 'gzip, deflate, gfe',
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class MetadataManager {
    constructor(workDir) {
        this.workDir = workDir;
        this.cacheDir = path.join(workDir, 'cache');
        this.secretKey = null;
        this.catalog = null;
        fs.ensureDirSync(this.cacheDir);
    }

    async init() {
        console.log("Initializing MetadataManager...");
        await this.refreshDbRoot();
        
        this.catalog = new HistoricalCatalog({
            baseUrls: BASE_URLS,
            rootVersion: ROOT_VERSION,
            secretKey: this.secretKey,
            requestHeaders: REQUEST_HEADERS
        });
    }

    async fetchWithRetry(urls, responseType = 'arraybuffer') {
        let lastError = null;
        for (const url of urls) {
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    const res = await axios.get(url, { responseType, headers: REQUEST_HEADERS, timeout: 10000 });
                    if (res.status === 200) return res.data;
                } catch (e) {
                    lastError = e;
                    if (e.response && (e.response.status === 403 || e.response.status === 429)) {
                        await sleep(attempt * 2000);
                    } else if (e.response && e.response.status === 404) {
                        break; 
                    } else {
                        await sleep(500);
                    }
                }
            }
        }
        throw new Error(`All fetch attempts failed. Last error: ${lastError ? lastError.message : 'Unknown'}`);
    }

    async refreshDbRoot() {
        console.log(`Downloading fresh dbRoot...`);
        let raw;
        try {
            const data = await this.fetchWithRetry(DBROOT_URLS);
            raw = Buffer.from(data);
        } catch (e) {
            console.error("Failed to download dbRoot. Using cached version.");
            const dbRootPath = path.join(this.workDir, 'dbRoot.v5');
            if (fs.existsSync(dbRootPath)) raw = fs.readFileSync(dbRootPath);
            else throw new Error("No dbRoot available.");
        }
        
        // Extract secret key field 2
        let i = 0;
        const readVarint = (buf, off) => {
            let res = 0, shift = 0, j = off;
            while (j < buf.length) {
                const b = buf[j++];
                res |= (b & 0x7f) << shift;
                if ((b & 0x80) === 0) return { value: res >>> 0, next: j };
                shift += 7;
            }
            return { value: res, next: j };
        };

        while (i < raw.length) {
            const { value: key, next: afterKey } = readVarint(raw, i);
            const field = key >> 3;
            const wireType = key & 7;
            if (field === 2 && wireType === 2) {
                const { value: len, next: afterLen } = readVarint(raw, afterKey);
                this.secretKey = raw.subarray(afterLen, afterLen + len);
                break;
            }
            if (wireType === 0) i = readVarint(raw, afterKey).next;
            else if (wireType === 2) {
                const { value: len, next: afterLen } = readVarint(raw, afterKey);
                i = afterLen + len;
            } else i++;
        }
        if (this.secretKey && this.secretKey.length === 1016) {
            // Prepend 8 dummy bytes to align with the (j + 8) logic in the project's decryptXOR
            const legacyAlignedKey = Buffer.concat([Buffer.alloc(8), this.secretKey]);
            this.secretKey = legacyAlignedKey;
            console.log("Aligned secretKey to legacy format (1024 bytes)");
        } else if (!this.secretKey) {
            this.secretKey = raw;
        }
        fs.writeFileSync(path.join(this.workDir, 'dbRoot.v5'), raw);
    }

    async fetchMetadata(pathCode) {
        const cacheFile = path.join(this.cacheDir, `qp-${pathCode}.json`);
        if (fs.existsSync(cacheFile)) return fs.readJsonSync(cacheFile);

        try {
            const result = await this.catalog.fetchMetadataForPath(pathCode);
            fs.writeJsonSync(cacheFile, result);
            return result;
        } catch (e) {
            console.error(`[Metadata] Failed for ${pathCode}: ${e.message}`);
            return { requestedPath: pathCode, entries: [], error: e.message };
        }
    }

    async fetchTile(z, x, y, iCode, fToken) {
        const center = slippyTileToCenter(z, x, y);
        const fullPath = latLonToPath(center.lat, center.lon, z);
        const tileCacheDir = path.join(this.cacheDir, 'tiles');
        fs.ensureDirSync(tileCacheDir);

        for (let length = fullPath.length; length >= 5; length--) {
            const currentPath = fullPath.slice(0, length);
            const tileName = `tile-${currentPath}-i.${iCode}-${fToken}.jpg`;
            const tilePath = path.join(tileCacheDir, tileName);

            if (fs.existsSync(tilePath)) return tilePath;

            const urls = BASE_URLS.map(base => `${base}&f1-${currentPath}-i.${iCode}-${fToken}`);
            try {
                const data = await this.fetchWithRetry(urls);
                const decrypted = require('../historical/metadata').decryptXOR(Buffer.from(data), this.secretKey);
                fs.writeFileSync(tilePath, decrypted);
                return tilePath;
            } catch (e) {
                if (e.message.includes('404')) continue;
                throw e;
            }
        }
        throw new Error(`Tile not found for ${fullPath}`);
    }

    latLonToPath(lat, lon, zoom) {
        return latLonToPath(lat, lon, zoom);
    }
}

module.exports = MetadataManager;
