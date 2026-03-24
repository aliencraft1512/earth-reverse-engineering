
const express = require('express');
const fs = require('fs');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const Jimp = require('jimp');
const cors = require('cors');
const zlib = require('zlib');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Config ---
const DBROOT_PATH = path.resolve(__dirname, 'dbRoot.v5');
const secretKey = fs.existsSync(DBROOT_PATH) ? fs.readFileSync(DBROOT_PATH) : null;
const CACHE_DIR = path.join(__dirname, 'tile_cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const REQUEST_HEADERS = {
  'User-Agent': 'GoogleEarth/7.3.6.9796(Windows;Microsoft Windows (6.2.9200.0);el;kml:2.2;client:Pro;type:default)',
  'Accept-Encoding': 'gzip, deflate, gfe'
};

const PROBE_TIMEOUT_MS = 15000;
//const BASE_URL = 'https://khmdb.google.com/flatfile?db=tm';
const BASE_URL = 'https://cmpmap.com/flatfile?db=tm';


// --- Decryption & Decoding Helpers ---

function encodeFToken(year, month, day) {
  const code = ((year - 1920) << 9) | (month << 5) | day;
  return 'f' + code.toString(16);
}

function decodeDate(val) {
    const year = val >> 9;
    const month = (val >> 5) & 0x0F;
    const day = val & 0x1F;
    if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function decryptXOR(buffer) {
  if (!secretKey) return buffer;
  const out = Buffer.alloc(buffer.length);
  let j = 16;
  for (let i = 0; i < buffer.length; i++) {
    const keyByte = secretKey[(j + 8) % secretKey.length];
    out[i] = buffer[i] ^ keyByte;
    j++;
    if (j % 8 === 0) j += 16;
    if (j >= 1016) j = (j + 8) % 24;
  }
  return out;
}

function readVarint(buffer, offset) {
  let result = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buffer.length) {
    const b = BigInt(buffer[i++]);
    result |= (b & 0x7fn) << shift;
    if ((b & 0x80n) === 0n) return { value: Number(result), next: i };
    shift += 7n;
  }
  return { value: Number(result), next: i, error: 'EOF' };
}

// --- Coordinate to Path Logic ---

const ZeroTileGeoSize = 360;
const ValidBoundRc = [-180.0, 180.0, 180.0, -180.0];

function getTileGeoSize(nLevelIndex) {
  return ZeroTileGeoSize / Math.pow(2, nLevelIndex);
}

function getRowColInfoChar(rowIndex, colIndex) {
  const nRowLeft = rowIndex % 2;
  const nColLeft = colIndex % 2;
  if (nRowLeft > 0 && nColLeft > 0) return '2';
  if (nRowLeft > 0 && nColLeft === 0) return '3';
  if (nRowLeft === 0 && nColLeft === 0) return '0';
  return '1';
}

function latLonToPath(lat, lon, zoom) {
  let pathStr = '';
  for (let i = 0; i <= zoom; i++) {
    const size = getTileGeoSize(i);
    const col = Math.floor((lon - ValidBoundRc[0]) / size);
    const row = Math.floor((lat - ValidBoundRc[3]) / size);
    pathStr += getRowColInfoChar(row, col);
  }
  return pathStr;
}

// --- Metadata Discovery ---

async function getAvailableDatesForPath(pathCode, rootVersion = 366) {
    const url = `${BASE_URL}&qp-${pathCode}-q.${rootVersion}`;
    try {
        console.log(`[Discovery] Fetching metadata: ${url}`);
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            headers: REQUEST_HEADERS,
            timeout: 10000,
            validateStatus: s => s === 200
        });
        const decrypted = decryptXOR(Buffer.from(response.data));
        const payload = decrypted.slice(8);
        const buffer = zlib.inflateSync(payload);
        
        const results = [];
        for (let i = 0; i < buffer.length - 5; i++) {
            if (buffer[i] === 0x0A && buffer[i+2] === 0x08) {
                const { value: dateVal, next: afterDate } = readVarint(buffer, i + 3);
                const dateStr = decodeDate(dateVal);
                if (dateStr && buffer[afterDate] === 0x10) {
                    const { value: iCode } = readVarint(buffer, afterDate + 1);
                    results.push({
                        date: dateStr,
                        iCode: iCode,
                        fToken: encodeFToken(...dateStr.split('-').map(Number))
                    });
                }
            }
        }
        const seen = new Set();
        return results.filter(r => {
            const key = `${r.date}|${r.iCode}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).sort((a, b) => b.date.localeCompare(a.date));
    } catch (err) {
        if (pathCode.length > 4) {
            return getAvailableDatesForPath(pathCode.slice(0, -1), rootVersion);
        }
        return [];
    }
}

// --- API Endpoints ---

app.get('/api/dates', async (req, res) => {
    try {
        const { lat, lon, zoom = 17 } = req.query;
        if (!lat || !lon) return res.status(400).json({ error: "lat and lon required" });
        const pathCode = latLonToPath(parseFloat(lat), parseFloat(lon), parseInt(zoom));
        const dates = await getAvailableDatesForPath(pathCode);
        res.json({ path: pathCode, dates });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

function isJpeg(buffer) {
    if (!buffer || buffer.length < 2) return false;
    return buffer[0] === 0xFF && buffer[1] === 0xD8;
}

app.get('/api/tile/:z/:x/:y/:iCode/:fToken', async (req, res) => {
    const { z, x, y, iCode, fToken } = req.params;
    
    const n = Math.PI - 2 * Math.PI * parseInt(y) / Math.pow(2, parseInt(z));
    const lat = (180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))));
    const lon = (parseInt(x) / Math.pow(2, parseInt(z)) * 360 - 180);

    let currentZoom = parseInt(z);
    
    while (currentZoom > 4) {
        const pathCode = latLonToPath(lat, lon, currentZoom);
        const cacheKey = `${pathCode}_${iCode}_${fToken}.jpg`;
        const cachePath = path.join(CACHE_DIR, cacheKey);

        if (fs.existsSync(cachePath)) {
            return res.sendFile(cachePath);
        }

        const url = `${BASE_URL}&f1-${pathCode}-i.${iCode}-${fToken}`;
        try {
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                headers: REQUEST_HEADERS,
                timeout: 5000,
                validateStatus: s => s === 200
            });
            
            let data = Buffer.from(response.data);
            
            // IF ALREADY JPEG, DON'T XOR.
            // IF NOT JPEG, XOR AND CHECK AGAIN.
            if (!isJpeg(data)) {
                const decrypted = decryptXOR(data);
                if (isJpeg(decrypted)) {
                    data = decrypted;
                } else {
                    // It might be a different format or still encrypted
                    // Attempt Jimp conversion as a last resort
                    const image = await Jimp.read(decrypted).catch(() => Jimp.read(data));
                    data = await image.getBufferAsync(Jimp.MIME_JPEG);
                }
            }
            
            fs.writeFileSync(cachePath, data);
            return res.set('Content-Type', 'image/jpeg').send(data);
        } catch (err) {
            console.log(`[Tile] Failed for ${pathCode} at z${currentZoom}, trying parent...`);
            currentZoom--;
        }
    }
    
    res.status(404).send("No tile found in the hierarchy.");
});

const server = app.listen(PORT, () => {
    console.log(`Historical Server running at http://localhost:${PORT}`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Error: Port ${PORT} is already in use.`);
    } else {
        console.error('Server error:', err);
    }
    process.exit(1);
});
