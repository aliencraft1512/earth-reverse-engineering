
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const zlib = require('zlib');

// --- Constants & Config ---
const DBROOT_PATH = path.join(__dirname, 'dbRoot.v5');
const REQUEST_HEADERS = {
  'User-Agent': 'GoogleEarth/7.3.6.9796(Windows;Microsoft Windows (6.2.9200.0);el;kml:2.2;client:Pro;type:default)',
  'Accept-Encoding': 'gzip, deflate, gfe'
};

let secretKey = fs.existsSync(DBROOT_PATH) ? fs.readFileSync(DBROOT_PATH) : null;

// --- Helpers ---

function encodeFToken(year, month, day) {
  const code = ((year - 1920) << 9) | (month << 5) | day;
  return 'f' + code.toString(16);
}

function decodeDate(val) {
    // val is year << 9 | month << 5 | day
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
    if (shift > 64n) throw new Error('Varint too long');
  }
  return { value: Number(result), next: i, error: 'EOF' };
}

function parseProtobuf(buffer, offset = 0, limit = buffer.length) {
    const fields = [];
    let i = offset;
    while (i < limit) {
        try {
            const { value: key, next: afterKey, error } = readVarint(buffer, i);
            if (error) break;
            i = afterKey;
            const field = key >> 3;
            const wireType = key & 7;

            if (wireType === 0) {
                const { value, next } = readVarint(buffer, i);
                fields.push({ field, wireType, value });
                i = next;
            } else if (wireType === 2) {
                const { value: length, next: afterLen } = readVarint(buffer, i);
                i = afterLen;
                const value = buffer.subarray(i, i + length);
                fields.push({ field, wireType, length, value });
                i += length;
            } else {
                break;
            }
        } catch (e) {
            break;
        }
    }
    return fields;
}

// --- Metadata Core ---

async function fetchMetadataPacket(pathCode, version) {
    const url = `https://cmpmap.com/flatfile?db=tm&qp-${pathCode}-q.${version}`;
    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: REQUEST_HEADERS,
        timeout: 10000,
        validateStatus: s => s === 200
    });
    const decrypted = decryptXOR(Buffer.from(response.data));
    const payload = decrypted.slice(8);
    return zlib.inflateSync(payload);
}

function extractCatalogFromPacket(buffer) {
    const results = [];
    
    // We saw the pattern in hex: 0A-09-08-[DATE]-10-[iCode]-18-04
    // 08 is Field 1, wire 0
    // 10 is Field 2, wire 0
    // 18 is Field 3, wire 0
    
    // Let's scan for any Varint that looks like a date,
    // and then check if it's followed by another Varint (the iCode).
    
    for (let i = 0; i < buffer.length - 8; i++) {
        try {
            const { value: v1, next: n1 } = readVarint(buffer, i);
            const dateStr = decodeDate(v1);
            if (dateStr) {
                // Potential date found. Check next varint.
                const { value: v2, next: n2 } = readVarint(buffer, n1);
                if (v2 > 0 && v2 < 2000) { // iCode is usually < 2000
                    results.push({
                        date: dateStr,
                        iCode: v2,
                        fToken: encodeFToken(...dateStr.split('-').map(Number))
                    });
                }
            }
        } catch (e) {}
    }
    
    // Deduplicate
    const seen = new Set();
    return results.filter(r => {
        const key = `${r.date}|${r.iCode}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// --- Public API ---

async function getHistoricalMetadataForPath(pathCode, rootVersion = 366) {
    console.log(`[HistoricalCataloger] Fetching metadata for path ${pathCode}...`);
    try {
        const buffer = await fetchMetadataPacket(pathCode, rootVersion);
        const entries = extractCatalogFromPacket(buffer);
        console.log(`[HistoricalCataloger] Found ${entries.length} historical dates.`);
        return entries;
    } catch (err) {
        console.error(`[HistoricalCataloger] Error fetching for ${pathCode}:`, err.message);
        return [];
    }
}

// --- CLI / Execution ---

if (require.main === module) {
    const pathCode = process.argv[2] || "0200231121100202";
    getHistoricalMetadataForPath(pathCode).then(entries => {
        console.log(JSON.stringify(entries, null, 2));
    });
}
