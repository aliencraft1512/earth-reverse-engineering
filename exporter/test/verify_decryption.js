const axios = require('axios');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const DBROOT_PATH = path.join(__dirname, 'dbRoot.v5');
const secretKey = fs.readFileSync(DBROOT_PATH);

const REQUEST_HEADERS = {
    'User-Agent': 'GoogleEarth/7.3.6.9796(Windows;Microsoft Windows (6.2.9200.0);el;kml:2.2;client:Pro;type:default)',
    'Accept-Encoding': 'gzip, deflate, gfe',
};

function decryptXOR(buffer) {
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
    return { value: Number(result), next: i };
}

function decodeDate(val) {
    let y = val >> 9, m = (val >> 5) & 0x0F, d = val & 0x1F;
    if (y < 200) y += 1920; 
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function getPathCode(lat, lon, zoom) {
    const ValidBoundRc = [-180, 180, 180, -180];
    let out = '0'; // Base '0'
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

async function verify() {
    const pathCode = "02020023"; // Known working path at Zoom 6
    const url = `https://cmpmap.com/flatfile?db=tm&qp-${pathCode}-q.366`;
    console.log(`Verifying via Gateway: ${url}`);
    
    try {
        const res = await axios.get(url, { responseType: 'arraybuffer', headers: REQUEST_HEADERS, timeout: 5000 });
        console.log(`Received ${res.data.byteLength} bytes`);
        const dec = decryptXOR(Buffer.from(res.data));
        const inf = zlib.inflateSync(dec.slice(8));
        console.log(`Decompressed size: ${inf.length}`);
        // ... rest of the extraction ...
    } catch (e) {
        console.error("Verification failed via cmpmap.com:", e.message);
        if (e.response) console.error("Status:", e.response.status);
    }
}

verify();
