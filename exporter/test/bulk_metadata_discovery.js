#!/usr/bin/env node
'use strict';

/**
 * bulk_metadata_discovery.js
 *
 * Purpose:
 * Discover all available historical imagery dates and versions (iCodes) for a given bounding box.
 * Uses the qp-packet metadata discovery method, which is much faster than tile probing.
 *
 * Logic based on AGENT_DIES.TXT findings:
 * 1. Fetch qp-[path]-q.[rootVersion]
 * 2. Decrypt with XOR key from dbRoot.v5
 * 3. Skip 8-byte header, then decompress with Zlib.
 * 4. Parse Protobuf for Tag 1 (Date) and Tag 2 (iCode).
 * 5. Encode fToken using the 1920-offset rule.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const zlib = require('zlib');
const crypto = require('crypto');

// --- Configuration ---
const DBROOT_PATH = path.join(__dirname, 'dbRoot.v5');
const DEFAULT_HEADERS = {
  'User-Agent': 'GoogleEarth/7.3.6.9796(Windows;Microsoft Windows (6.2.9200.0);el;kml:2.2;client:Pro;type:default)',
  'Accept-Encoding': 'gzip, deflate, gfe'
};

if (!fs.existsSync(DBROOT_PATH)) {
    console.error(`ERROR: ${DBROOT_PATH} not found.`);
    process.exit(1);
}
const secretKey = fs.readFileSync(DBROOT_PATH);

// --- Core Decryption & Parsing ---

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
  return { value: Number(result), next: i, error: 'EOF' };
}

function decodeDate(val) {
    // Finding from AGENT_DIES.TXT: Some packets use absolute year, some use 1920 offset.
    // We try to handle both.
    let year = val >> 9;
    const month = (val >> 5) & 0x0F;
    const day = val & 0x1F;
    
    if (year < 200) year += 1920; // Handle offset year
    
    if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function encodeFToken(dateStr) {
    const [year, month, day] = dateStr.split('-').map(Number);
    const code = ((year - 1920) << 9) | (month << 5) | day;
    return 'f' + code.toString(16);
}

// --- Protobuf Scanner ---

function extractMetadataFromBuffer(buffer) {
    const results = [];
    // Pattern: 08 [DateVarint] 10 [iCodeVarint]
    // Tag 1 (Date) is 0x08, Tag 2 (iCode) is 0x10
    for (let i = 0; i < buffer.length - 10; i++) {
        if (buffer[i] === 0x08) {
            try {
                const { value: v1, next: n1 } = readVarint(buffer, i + 1);
                const dateStr = decodeDate(v1);
                if (dateStr && buffer[n1] === 0x10) {
                    const { value: v2 } = readVarint(buffer, n1 + 1);
                    if (v2 > 0 && v2 < 10000) {
                        results.push({ date: dateStr, iCode: v2, fToken: encodeFToken(dateStr) });
                    }
                }
            } catch (e) {}
        }
    }
    return results;
}

async function fetchMetadataForPath(pathCode, rootVersion = 366) {
    const url = `https://cmpmap.com/flatfile?db=tm&qp-${pathCode}-q.${rootVersion}`;
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer', headers: DEFAULT_HEADERS, timeout: 5000 });
        const decrypted = decryptXOR(Buffer.from(response.data));
        if (decrypted.length < 10) return [];
        const payload = decrypted.slice(8); // Skip 8-byte header
        const inflated = zlib.inflateSync(payload);
        return extractMetadataFromBuffer(inflated);
    } catch (e) {
        return [];
    }
}

// --- Bounding Box Scanner ---

function getPathCode(lat, lon, zoom) {
    const ValidBoundRc = [-180.0, 180.0, 180.0, -180.0];
    let out = '';
    for (let i = 0; i <= zoom; i++) {
        const geoSize = 360 / Math.pow(2, i);
        const col = Math.floor((lon - ValidBoundRc[0]) / geoSize);
        const row = Math.floor((lat - ValidBoundRc[3]) / geoSize);
        const rowOdd = row % 2;
        const colOdd = col % 2;
        if (rowOdd > 0 && colOdd > 0) out += '2';
        else if (rowOdd > 0 && colOdd === 0) out += '3';
        else if (rowOdd === 0 && colOdd === 0) out += '0';
        else out += '1';
    }
    return out;
}

async function runBulkDiscovery(bounds, zoom = 12) {
    console.log(`Starting discovery for bounds: ${JSON.stringify(bounds)} at zoom ${zoom}`);
    
    // We sample level 12 paths across the bounding box
    const latStep = (bounds.north - bounds.south) / 5;
    const lonStep = (bounds.east - bounds.west) / 5;
    
    const pathSet = new Set();
    for (let lat = bounds.south; lat <= bounds.north; lat += latStep) {
        for (let lon = bounds.west; lon <= bounds.east; lon += lonStep) {
            pathSet.add(getPathCode(lat, lon, zoom));
        }
    }
    
    const uniquePaths = Array.from(pathSet);
    console.log(`Unique paths to check: ${uniquePaths.length}`);
    
    const allMetadata = [];
    const seen = new Set();
    
    for (const p of uniquePaths) {
        process.stdout.write(`Checking ${p}... `);
        const results = await fetchMetadataForPath(p);
        console.log(`Found ${results.length} entries.`);
        for (const m of results) {
            const key = `${m.date}_${m.iCode}`;
            if (!seen.has(key)) {
                allMetadata.push(m);
                seen.add(key);
            }
        }
    }
    
    allMetadata.sort((a,b) => b.date.localeCompare(a.date));
    return allMetadata;
}

// --- CLI ---

const args = process.argv.slice(2);
if (args.length < 4) {
    console.log("Usage: node bulk_metadata_discovery.js <north> <south> <east> <west> [zoom]");
    console.log("Example: node bulk_metadata_discovery.js 35.5 34.4 34.6 32.2 12");
    process.exit(1);
}

const bounds = {
    north: parseFloat(args[0]),
    south: parseFloat(args[1]),
    east: parseFloat(args[2]),
    west: parseFloat(args[3])
};
const zoom = parseInt(args[4]) || 12;

runBulkDiscovery(bounds, zoom).then(results => {
    const outPath = 'discovery_results.json';
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log(`\nSuccess! Found ${results.length} unique historical imagery versions.`);
    console.log(`Results saved to ${outPath}`);
    console.log("\nTop 10 results:");
    console.table(results.slice(0, 10));
}).catch(err => {
    console.error(err);
});
