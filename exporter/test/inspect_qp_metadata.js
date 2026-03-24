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
  let result = 0n, shift = 0n, i = offset;
  while (i < buffer.length) {
    const b = BigInt(buffer[i++]);
    result |= (b & 0x7fn) << shift;
    if ((b & 0x80n) === 0n) return { value: Number(result), next: i };
    shift += 7n;
  }
  return { value: Number(result), next: i };
}

function decodeDate(val) {
    const year = val >> 9;
    const month = (val >> 5) & 0x0F;
    const day = val & 0x1F;
    if (year < 1940 || year > 2030 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

async function inspect() {
    const pathCode = "02020023"; // Cyprus Zoom 6
    const url = `https://khmdb.google.com/flatfile?db=tm&qp-${pathCode}-q.366`;
    console.log(`Inspecting metadata from: ${url}`);
    
    try {
        const res = await axios.get(url, { responseType: 'arraybuffer', headers: REQUEST_HEADERS });
        const dec = decryptXOR(Buffer.from(res.data));
        const inf = zlib.inflateSync(dec.slice(8));
        
        console.log(`Decompressed size: ${inf.length} bytes`);
        console.log(`Hex preview: ${inf.slice(0, 64).toString('hex')}`);

        const results = [];
        // Use the pattern scanning approach but more carefully
        for (let i = 0; i < inf.length - 10; i++) {
            if (inf[i] === 0x08) { // Field 1: Date
                const { value: v1, next: n1 } = readVarint(inf, i + 1);
                const ds = decodeDate(v1);
                if (ds && inf[n1] === 0x10) { // Field 2: iCode
                    const { value: v2 } = readVarint(inf, n1 + 1);
                    results.push({ offset: i, date: ds, iCode: v2 });
                }
            }
        }

        console.log(`Found ${results.length} matches.`);
        results.slice(0, 10).forEach(r => {
            console.log(`Offset ${r.offset}: ${r.date} (i.${r.iCode})`);
        });
        
    } catch (e) {
        console.error("Inspection failed:", e.message);
    }
}

inspect();
