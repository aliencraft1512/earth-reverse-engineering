const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const zlib = require('zlib');

const app = express();
const PORT = 3001;
const CACHE_DIR = path.join(__dirname, 'tile_cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

let serverLogs = [];
function log(msg) { 
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    serverLogs.push(line);
    if (serverLogs.length > 100) serverLogs.shift();
}

const REQUEST_HEADERS = {
  'User-Agent': 'GoogleEarth/7.3.6.9796(Windows;Microsoft Windows (6.2.9200.0);el;kml:2.2;client:Pro;type:default)',
  'Accept-Encoding': 'gzip, deflate, gfe',
};

const DBROOT_PATH = path.join(__dirname, 'dbRoot.v5');
const secretKey = fs.existsSync(DBROOT_PATH) ? fs.readFileSync(DBROOT_PATH) : null;

let xorKey = null;
if (secretKey) {
    xorKey = secretKey.slice(5, 5 + 1016);
    log(`XOR Key ready (${xorKey.length} bytes)`);
}

function decrypt(buffer) {
    if (!xorKey) return buffer;
    const out = Buffer.alloc(buffer.length);
    let j = 16;
    for (let i = 0; i < buffer.length; i++) {
        const keyByte = xorKey[(j + 8) % xorKey.length];
        out[i] = buffer[i] ^ keyByte;
        j++;
        if (j % 8 === 0) j += 16;
        if (j >= 1016) j = (j + 8) % 24;
    }
    return out;
}

function readVarint(buffer, offset) {
    let result = 0, shift = 0, i = offset;
    while (i < buffer.length) {
        const b = buffer[i++];
        result |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) return { value: result >>> 0, next: i };
        shift += 7;
        if (shift > 56) break;
    }
    return { value: result >>> 0, next: i };
}

function decodeDate(val) {
    let y = val >> 9, m = (val >> 5) & 0x0F, d = val & 0x1F;
    if (y < 200) y += 1920; 
    if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function encodeFToken(y, m, d) {
    const code = ((y - 1920) << 9) | (m << 5) | d;
    return 'f' + code.toString(16);
}

function extractMetadataDeep(buffer, results = [], seen = new Set()) {
    let i = 0;
    while (i < buffer.length) {
        try {
            const { value: key, next: afterKey } = readVarint(buffer, i);
            i = afterKey;
            const field = key >> 3;
            const wireType = key & 7;
            if (wireType === 0) {
                const { value, next } = readVarint(buffer, i);
                const ds = decodeDate(value);
                if (ds && buffer[next] === 0x10) {
                    const { value: iCode } = readVarint(buffer, next + 1);
                    const k = `${ds}_${iCode}`;
                    if (!seen.has(k)) {
                        results.push({ date: ds, iCode, fToken: encodeFToken(...ds.split('-').map(Number)) });
                        seen.add(k);
                    }
                }
                i = next;
            } else if (wireType === 2) {
                const { value: length, next: afterLen } = readVarint(buffer, i);
                i = afterLen;
                extractMetadataDeep(buffer.subarray(i, i + length), results, seen);
                i += length;
            } else if (wireType === 1) i += 8; else if (wireType === 5) i += 4; else break;
        } catch (e) { break; }
    }
}

async function fetchMetadata(pathCode, version = 366) {
    const urls = [
        `https://khmdb.google.com/flatfile?db=tm&qp-${pathCode}-q.${version}`,
        `https://cmpmap.com/flatfile?db=tm&qp-${pathCode}-q.${version}`
    ];
    for (const url of urls) {
        try {
            const res = await axios.get(url, { responseType: 'arraybuffer', headers: REQUEST_HEADERS, timeout: 3000 });
            const dec = decrypt(Buffer.from(res.data));
            const inf = zlib.inflateSync(dec.slice(8));
            const results = [];
            extractMetadataDeep(inf, results);
            if (results.length > 0) return results;
        } catch (e) {
            if (e.message.includes('RESET')) await new Promise(r => setTimeout(r, 500));
        }
    }
    return [];
}

function getPathCode(lat, lon, zoom) {
    const ValidBoundRc = [-180, 180, 180, -180];
    let out = '0'; 
    for (let i = 0; i < zoom; i++) {
        const geoSize = 360 / Math.pow(2, i);
        const col = Math.floor((lon - ValidBoundRc[0]) / geoSize);
        const row = Math.floor((lat - ValidBoundRc[3]) / geoSize);
        if (row % 2 !== 0 && col % 2 !== 0) out += '2';
        else if (row % 2 !== 0 && col % 2 === 0) out += '3';
        else if (row % 2 === 0 && col % 2 === 0) out += '0';
        else out += '1';
    }
    return out;
}

app.get('/logs', (req, res) => {
    res.send(`<html><body style="background:#000;color:#0f0;font-family:monospace"><h3>Server Logs</h3>${serverLogs.slice().reverse().join('<br>')}</body></html>`);
});

app.post('/discover', async (req, res) => {
    try {
        const { bounds } = req.body;
        const lat = (bounds.ne.lat + bounds.sw.lat) / 2;
        const lon = (bounds.ne.lon + bounds.sw.lon) / 2;
        const startPath = getPathCode(lat, lon, 18);
        const allMetadata = [];
        const seen = new Set();
        const paths = [];
        for (let len = startPath.length; len >= 2; len--) paths.push(startPath.slice(0, len));
        for (let i = 0; i < paths.length; i += 2) {
            const batch = paths.slice(i, i + 2);
            const resArray = await Promise.all(batch.flatMap(p => [fetchMetadata(p, 366), fetchMetadata(p, 1030)]));
            resArray.flat().forEach(m => {
                const k = `${m.date}_${m.iCode}`;
                if (!seen.has(k)) { allMetadata.push(m); seen.add(k); }
            });
            if (allMetadata.length > 30) break;
            await new Promise(r => setTimeout(r, 200)); // Be gentle
        }
        res.json(allMetadata.sort((a,b) => b.date.localeCompare(a.date)));
    } catch (e) { res.json([]); }
});

app.get('/tile', async (req, res) => {
    const { path: p, i, f } = req.query;
    if (!p) return res.status(400).send('Path required');
    const cacheKey = crypto.createHash('md5').update(`tile-${p}-${i}-${f}`).digest('hex') + '.jpg';
    const cachePath = path.join(CACHE_DIR, cacheKey);
    if (fs.existsSync(cachePath)) return res.sendFile(cachePath);
    const baseI = parseInt(i);
    const versions = [baseI, baseI+1, 366, 1030, 288, 273];
    for (const v of versions) {
        if (isNaN(v)) continue;
        const urls = [
            `https://khmdb.google.com/flatfile?db=tm&f1-${p}-i.${v}-${f}`,
            `https://cmpmap.com/flatfile?db=tm&f1-${p}-i.${v}-${f}`
        ];
        for (const url of urls) {
            try {
                const r = await axios.get(url, { responseType: 'arraybuffer', headers: REQUEST_HEADERS, timeout: 2000 });
                let dec = decrypt(Buffer.from(r.data));
                if (dec[0] === 0xFF && dec[1] === 0xD8) {
                    fs.writeFileSync(cachePath, dec);
                    return res.sendFile(cachePath);
                }
                const simpleKey = [0x50, 0x4B, 0x03, 0x04];
                let simpleDec = Buffer.from(r.data);
                for (let k = 0; k < simpleDec.length; k++) simpleDec[k] ^= simpleKey[k % 4];
                if (simpleDec[0] === 0xFF && simpleDec[1] === 0xD8) {
                    fs.writeFileSync(cachePath, simpleDec);
                    return res.sendFile(cachePath);
                }
            } catch (e) { if (e.message.includes('RESET')) await new Promise(r => setTimeout(r, 500)); }
        }
    }
    res.status(404).send('Not found');
});

app.listen(PORT, () => log(`Historical Discovery Server on http://localhost:${PORT}`));
