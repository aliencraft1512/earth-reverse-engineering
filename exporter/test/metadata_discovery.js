
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const zlib = require('zlib');

// --- Configuration ---
const DBROOT_PATH = path.join(__dirname, 'dbRoot.v5');
const REQUEST_HEADERS = {
  'User-Agent': 'GoogleEarth/7.3.6.9796(Windows;Microsoft Windows (6.2.9200.0);el;kml:2.2;client:Pro;type:default)',
  'Accept-Encoding': 'gzip, deflate, gfe'
};

// --- fToken Encoding (1920-offset rule) ---
function encodeFToken(year, month, day) {
  const code = ((year - 1920) << 9) | (month << 5) | day;
  return 'f' + code.toString(16);
}

function decodeFToken(fToken) {
  const hex = fToken.startsWith('f') ? fToken.slice(1) : fToken;
  const code = parseInt(hex, 16);
  const year = (code >> 9) + 1920;
  const month = (code >> 5) & 0x0f;
  const day = code & 0x1f;
  return { year, month, day, dateStr: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
}

// --- XOR Decryption ---
let secretKey = null;
if (fs.existsSync(DBROOT_PATH)) {
  secretKey = fs.readFileSync(DBROOT_PATH);
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

// --- Probing ---
async function probeMetadata(pathCode, version) {
  const url = `https://cmpmap.com/flatfile?db=tm&qp-${pathCode}-q.${version}`;
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: REQUEST_HEADERS,
      timeout: 10000,
      validateStatus: status => status === 200
    });
    return { ok: true, data: Buffer.from(response.data), url };
  } catch (err) {
    return { ok: false, error: err.message, url };
  }
}

// --- Main Discovery Task ---
async function runDiscovery() {
  console.log("--- Metadata Discovery ---");
  
  // Example path for Cyprus (from your sources)
  const samplePath = "0200231121100202";
  const knownVersion = 366;
  
  console.log(`Probing qp packet for path ${samplePath} at version ${knownVersion}...`);
  const result = await probeMetadata(samplePath, knownVersion);
  
  if (result.ok) {
    console.log("Success! Received", result.data.length, "bytes.");
    const decrypted = decryptXOR(result.data);
    fs.writeFileSync('qp_decrypted_raw.bin', decrypted);
    console.log("Wrote decrypted data to qp_decrypted_raw.bin");
    
    // Try common decompression
    try {
        const payload = decrypted.slice(8);
        const inflated = zlib.inflateSync(payload);
        console.log("Decompression success (inflate)! Size:", inflated.length);
        fs.writeFileSync('qp_decompressed.bin', inflated);
    } catch (e) {
        console.log("Decompression failed (inflate). Error:", e.message);
    }
  } else {
    console.log("Failed to fetch qp packet:", result.error);
  }
}

// Export for use if needed
module.exports = { encodeFToken, decodeFToken, decryptXOR };

if (require.main === module) {
  runDiscovery();
}
