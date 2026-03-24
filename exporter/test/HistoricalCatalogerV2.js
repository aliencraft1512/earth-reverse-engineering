
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const zlib = require('zlib');

const DBROOT_PATH = path.join(__dirname, 'dbRoot.v5');
const REQUEST_HEADERS = {
  'User-Agent': 'GoogleEarth/7.3.6.9796(Windows;Microsoft Windows (6.2.9200.0);el;kml:2.2;client:Pro;type:default)',
  'Accept-Encoding': 'gzip, deflate, gfe'
};

let secretKey = fs.existsSync(DBROOT_PATH) ? fs.readFileSync(DBROOT_PATH) : null;

function encodeFToken(year, month, day) {
  const code = ((year - 1920) << 9) | (month << 5) | day;
  return 'f' + code.toString(16);
}

function decodeDate(val) {
    // val is year << 9 | month << 5 | day (NO OFFSET)
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
    // Pattern: 0A [len] 08 [date] 10 [iCode]
    for (let i = 0; i < buffer.length - 5; i++) {
        if (buffer[i] === 0x0A && buffer[i+2] === 0x08) {
            const { value: dateVal, next: afterDate } = readVarint(buffer, i + 3);
            const dateStr = decodeDate(dateVal);
            if (dateStr && buffer[afterDate] === 0x10) {
                const { value: iCode, next: afterVersion } = readVarint(buffer, afterDate + 1);
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
    });
}

async function getHistoricalMetadataForPath(pathCode, rootVersion = 366) {
    try {
        const buffer = await fetchMetadataPacket(pathCode, rootVersion);
        return extractCatalogFromPacket(buffer);
    } catch (err) {
        return [];
    }
}

if (require.main === module) {
    const pathCode = process.argv[2] || "0200231121100202";
    getHistoricalMetadataForPath(pathCode).then(entries => {
        console.log(JSON.stringify(entries, null, 2));
    });
}

module.exports = { getHistoricalMetadataForPath, encodeFToken, decodeDate };
