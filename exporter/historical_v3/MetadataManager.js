const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const zlib = require('zlib');

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

// Utility to sleep
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class MetadataManager {
    constructor(workDir) {
        this.workDir = workDir;
        this.cacheDir = path.join(workDir, 'cache');
        this.secretKey = null;
        fs.ensureDirSync(this.cacheDir);
    }

    async init() {
        console.log("Initializing MetadataManager...");
        await this.refreshDbRoot();
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
                        console.log(`[Rate Limit/Block] on ${url}. Retrying in ${attempt * 2}s...`);
                        await sleep(attempt * 2000);
                    } else if (e.response && e.response.status === 404) {
                        break; // Not found, don't retry same URL
                    } else {
                        await sleep(500); // Small delay for network hiccups
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
            console.error("Failed to download dbRoot. Using cached version if available.");
            const dbRootPath = path.join(this.workDir, 'dbRoot.v5');
            if (fs.existsSync(dbRootPath)) {
                raw = fs.readFileSync(dbRootPath);
            } else {
                throw new Error("No dbRoot available and download failed.");
            }
        }
        
        let i = 0;
        while (i < raw.length) {
            const { value: key, next: afterKey } = this.readVarint(raw, i);
            const field = key >> 3;
            const wireType = key & 7;
            if (field === 2 && wireType === 2) {
                const { value: len, next: afterLen } = this.readVarint(raw, afterKey);
                this.secretKey = raw.subarray(afterLen, afterLen + len);
                break;
            }
            if (wireType === 0) i = this.readVarint(raw, afterKey).next;
            else if (wireType === 2) i = this.readVarint(raw, afterKey).next + this.readVarint(raw, afterKey).value;
            else i++;
        }

        if (!this.secretKey) this.secretKey = raw;

        fs.writeFileSync(path.join(this.workDir, 'dbRoot.v5'), raw);
    }

    decryptXOR(buffer) {
        const out = Buffer.alloc(buffer.length);
        let j = 16;
        for (let i = 0; i < buffer.length; i++) {
            const keyByte = this.secretKey[j % this.secretKey.length];
            out[i] = buffer[i] ^ keyByte;
            j++;
            if (j % 8 === 0) j += 16;
            if (j >= 1016) j = (j + 8) % 24; 
        }
        return out;
    }

    readVarint(buffer, offset) {
        let result = 0, shift = 0, i = offset;
        while (i < buffer.length) {
            const b = buffer[i++];
            result |= (b & 0x7f) << shift;
            if ((b & 0x80) === 0) return { value: result >>> 0, next: i };
            shift += 7;
        }
        return { value: result, next: i };
    }

    decodeDate(val) {
        const year = val >> 9;
        const month = (val >> 5) & 0x0F;
        const day = val & 0x1F;
        if (year < 1920 || year > 2030 || month < 1 || month > 12 || day < 1 || day > 31) return null;
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    encodeFToken(dateStr) {
        const [year, month, day] = dateStr.split('-').map(Number);
        const code = ((year - 1920) << 9) | (month << 5) | day;
        return 'f' + code.toString(16);
    }

    async fetchMetadata(pathCode) {
        const cacheFile = path.join(this.cacheDir, `qp-${pathCode}.json`);
        if (fs.existsSync(cacheFile)) {
            return fs.readJsonSync(cacheFile);
        }

        const urls = BASE_URLS.map(base => `${base}&qp-${pathCode}-q.${ROOT_VERSION}`);
        console.log(`Fetching metadata for ${pathCode}`);
        
        try {
            const data = await this.fetchWithRetry(urls);
            const decrypted = this.decryptXOR(Buffer.from(data));
            if (decrypted.length <= 8) return { pathCode, entries: [] };
            
            const inflated = zlib.inflateSync(decrypted.slice(8));
            const entries = [];
            const seen = new Set();

            for (let i = 0; i < inflated.length - 10; i++) {
                if (inflated[i] === 0x08) {
                    const { value: dVal, next: afterDate } = this.readVarint(inflated, i + 1);
                    const ds = this.decodeDate(dVal);
                    if (ds && inflated[afterDate] === 0x10) {
                        const { value: iCode } = this.readVarint(inflated, afterDate + 1);
                        const id = `${ds}|${iCode}`;
                        if (!seen.has(id)) {
                            seen.add(id);
                            entries.push({ date: ds, iCode, fToken: this.encodeFToken(ds) });
                        }
                    }
                }
            }

            const result = { pathCode, entries: entries.sort((a, b) => b.date.localeCompare(a.date)) };
            fs.writeJsonSync(cacheFile, result);
            return result;
        } catch (e) {
            console.error(`Failed to fetch metadata for ${pathCode}: ${e.message}`);
            return { pathCode, entries: [], error: e.message };
        }
    }

    async fetchTile(z, x, y, iCode, fToken) {
        const pathCode = this.latLonToPath(this.slippyToCenter(z, x, y), z);
        const tileName = `tile-${z}-${x}-${y}-${iCode}-${fToken}.jpg`;
        const tileCacheDir = path.join(this.cacheDir, 'tiles');
        fs.ensureDirSync(tileCacheDir);
        const tilePath = path.join(tileCacheDir, tileName);

        if (fs.existsSync(tilePath)) {
            return tilePath;
        }

        // Construct URL: f1-PATH-i.ICODE-FTOKEN
        const urls = BASE_URLS.map(base => `${base}&f1-${pathCode}-i.${iCode}-${fToken}`);
        console.log(`Fetching tile ${z}/${x}/${y} (i.${iCode})`);

        try {
            const data = await this.fetchWithRetry(urls);
            const decrypted = this.decryptXOR(Buffer.from(data));
            fs.writeFileSync(tilePath, decrypted);
            return tilePath;
        } catch (e) {
            console.error(`Failed to fetch tile ${z}/${x}/${y}: ${e.message}`);
            throw e;
        }
    }

    latLonToPath(latLon, zoom) {
        const ValidBoundRc = [-180, 180, 180, -180];
        let out = '0';
        for (let i = 0; i < zoom; i++) {
            const geoSize = 360 / Math.pow(2, i);
            const col = Math.floor((latLon.lon - ValidBoundRc[0]) / geoSize);
            const row = Math.floor((latLon.lat - ValidBoundRc[3]) / geoSize);
            if (row % 2 !== 0 && col % 2 !== 0) out += '2';
            else if (row % 2 !== 0 && col % 2 === 0) out += '3';
            else if (row % 2 === 0 && col % 2 === 0) out += '0';
            else out += '1';
        }
        return out;
    }

    slippyToCenter(z, x, y) {
        const n = Math.pow(2, z);
        const lon = x / n * 360 - 180;
        const lat_rad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
        const lat = lat_rad * 180 / Math.PI;
        return { lat, lon };
    }
}

module.exports = MetadataManager;
