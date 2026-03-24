#!/usr/bin/env node
'use strict';

/**
 * tm_metadata_probe.js
 *
 * Purpose:
 *  1) Inspect dbRoot.v5 bootstrap files for the historical tm database.
 *  2) Attempt heuristic decryption / unpacking of qp-...-q.xxx payloads.
 *  3) Build an offline catalog of valid (path, fToken, iCode) combinations for a bbox.
 *
 * Honest limitation:
 *  - The exact tm protobuf/schema for qp/dbRoot payloads is still unknown.
 *  - So the "decrypt" step is heuristic: it extracts likely key material,
 *    tries XOR-family transforms and common container checks, and dumps results.
 *  - The catalog builder is the reliable part today: it uses the experimentally
 *    proven validity rule (path, fToken, iCode) by probing and caching results.
 *
 * Usage examples:
 *   node tm_metadata_probe.js inspect-root --dbroot ./D2_dbRoot_v5_tm.proto --out ./tm_probe
 *   node tm_metadata_probe.js inspect-qp --dbroot ./D2_dbRoot_v5_tm.proto --qp ./D1_qp_q366.bin --out ./tm_probe
 *   node tm_metadata_probe.js build-catalog --config ./tm_catalog_config.json --out ./catalog_out
 *
 * Config example for build-catalog:
 * {
 *   "bounds": {"north":35.19,"south":35.18,"east":33.39,"west":33.37},
 *   "zoom": 17,
 *   "dates": [
 *     {"date":"2022-01-09","base_url":"https://khmdb.google.com/flatfile?db=tm","fToken":"fcd21","versionHint":299},
 *     {"date":"2022-06-11","base_url":"https://khmdb.google.com/flatfile?db=tm","fToken":"fcccb","versionHint":346}
 *   ],
 *   "candidateVersions": [288,298,299,305,318,344,350,359,360,361,362]
 * }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const axios = require('axios');

const REQUEST_HEADERS = {
  'User-Agent': 'GoogleEarth/7.3.6.9796(Windows;Microsoft Windows (6.2.9200.0);el;kml:2.2;client:Pro;type:default)',
  'Accept-Encoding': 'gzip, deflate, gfe'
};

const DEFAULT_PROBE_TIMEOUT_MS = 15000;
const DEFAULT_VERSION_POOL = [
  10, 73, 84, 97, 103, 105, 115, 119, 120, 122, 123, 124, 125, 126,
  128, 130, 136, 138, 140, 141, 142, 143, 144, 146, 148, 152, 157, 160,
  161, 165, 166, 169, 172, 173, 176, 182, 195, 197, 200, 201, 206, 212,
  219, 228, 232, 233, 240, 245, 246, 248, 249, 253, 256, 257, 258, 261,
  262, 264, 266, 267, 270, 271, 272, 273, 274, 275, 276, 277, 278, 279,
  280, 281, 282, 285, 286, 288, 294, 295, 296, 297, 298, 299, 303, 304,
  305, 307, 308, 312, 313, 316, 317, 318, 321, 322, 334, 335, 336, 339,
  341, 342, 343, 344, 345, 346, 347, 348, 350, 351, 352, 353, 354, 357,
  358, 359, 360, 361, 362, 365, 366, 379, 382, 394, 970, 1007, 1030
];

const ZeroTileGeoSize = 360;
const ValidBoundRc = [-180.0, 180.0, 180.0, -180.0];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readFile(p) {
  return fs.readFileSync(p);
}

function writeJson(outPath, data) {
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
}

function writeBin(outPath, data) {
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, data);
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function md5Hex(text) {
  return crypto.createHash('md5').update(String(text)).digest('hex');
}

function entropy(buffer) {
  if (!buffer.length) return 0;
  const freq = new Map();
  for (const b of buffer) freq.set(b, (freq.get(b) || 0) + 1);
  let ent = 0;
  for (const count of freq.values()) {
    const p = count / buffer.length;
    ent -= p * Math.log2(p);
  }
  return ent;
}

function printableRatio(buffer) {
  if (!buffer.length) return 0;
  let c = 0;
  for (const b of buffer) {
    if ((b >= 32 && b < 127) || b === 9 || b === 10 || b === 13) c++;
  }
  return c / buffer.length;
}

function extractAsciiStrings(buffer, minLen = 4) {
  const out = [];
  let cur = [];
  for (const b of buffer) {
    if (b >= 32 && b < 127) cur.push(b);
    else {
      if (cur.length >= minLen) out.push(Buffer.from(cur).toString('ascii'));
      cur = [];
    }
  }
  if (cur.length >= minLen) out.push(Buffer.from(cur).toString('ascii'));
  return out;
}

function toHexPreview(buffer, count = 64) {
  return buffer.subarray(0, count).toString('hex');
}

function readVarint(buffer, offset) {
  let result = 0;
  let shift = 0;
  let i = offset;
  while (i < buffer.length) {
    const b = buffer[i++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: result >>> 0, next: i };
    shift += 7;
    if (shift > 56) throw new Error('Varint too long');
  }
  throw new Error('Unexpected EOF while reading varint');
}

function parseSimpleProtobuf(buffer) {
  const fields = [];
  let i = 0;
  while (i < buffer.length) {
    const { value: key, next: afterKey } = readVarint(buffer, i);
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
      throw new Error(`Unsupported wire type ${wireType} at field ${field}`);
    }
  }
  return fields;
}

function xorScheduleTransform(source, keyBuf) {
  const out = Buffer.alloc(source.length);
  let j = 16;
  for (let i = 0; i < source.length; i++) {
    const keyByte = keyBuf[(j + 8) % keyBuf.length];
    out[i] = source[i] ^ keyByte;
    j++;
    if (j % 8 === 0) j += 16;
    if (j >= 1016) j = (j + 8) % 24;
  }
  return out;
}

function tryInflate(buffer) {
  const attempts = [];
  const modes = [
    ['gunzip', () => zlib.gunzipSync(buffer)],
    ['inflate', () => zlib.inflateSync(buffer)],
    ['inflateRaw', () => zlib.inflateRawSync(buffer)]
  ];
  for (const [name, fn] of modes) {
    try {
      const out = fn();
      attempts.push({ ok: true, mode: name, output: out });
    } catch (err) {
      attempts.push({ ok: false, mode: name, error: err.message });
    }
  }
  return attempts;
}

function protobufSummary(buffer, maxFields = 20) {
  try {
    const fields = parseSimpleProtobuf(buffer);
    return fields.slice(0, maxFields).map(f => ({
      field: f.field,
      wireType: f.wireType,
      value: f.wireType === 0 ? f.value : undefined,
      length: f.wireType === 2 ? f.length : undefined,
      sha256: f.wireType === 2 ? sha256Hex(f.value) : undefined,
      asciiPreview: f.wireType === 2 ? extractAsciiStrings(f.value, 5).slice(0, 5) : undefined
    }));
  } catch (err) {
    return { error: err.message };
  }
}

function describeBuffer(buffer) {
  return {
    size: buffer.length,
    sha256: sha256Hex(buffer),
    entropy: entropy(buffer),
    printableRatio: printableRatio(buffer),
    hexPreview: toHexPreview(buffer, 64),
    asciiStrings: extractAsciiStrings(buffer, 5).slice(0, 40),
    protobufSummary: protobufSummary(buffer)
  };
}

function inspectDbRoot(dbrootPath, outDir) {
  const dbroot = readFile(dbrootPath);
  const report = {
    dbrootPath,
    raw: describeBuffer(dbroot)
  };

  let fields;
  try {
    fields = parseSimpleProtobuf(dbroot);
    report.fields = fields.map(f => {
      if (f.wireType === 0) return { field: f.field, wireType: 0, value: f.value };
      return {
        field: f.field,
        wireType: 2,
        length: f.length,
        sha256: sha256Hex(f.value),
        entropy: entropy(f.value),
        printableRatio: printableRatio(f.value),
        asciiStrings: extractAsciiStrings(f.value, 5).slice(0, 20),
        protobufSummary: protobufSummary(f.value)
      };
    });

    for (const f of fields) {
      if (f.wireType === 2) {
        writeBin(path.join(outDir, `dbroot_field_${f.field}.bin`), f.value);
      }
    }
  } catch (err) {
    report.parseError = err.message;
  }

  writeJson(path.join(outDir, 'dbroot_report.json'), report);
  return report;
}

function inspectQp(dbrootPath, qpPath, outDir) {
  const dbroot = readFile(dbrootPath);
  const qp = readFile(qpPath);
  const fields = parseSimpleProtobuf(dbroot);
  const keyed = Object.fromEntries(fields.map(f => [f.field, f.wireType === 2 ? f.value : f.value]));

  const candidates = [
    { name: 'raw_qp', buffer: qp },
    { name: 'xor_with_dbroot_full', buffer: xorScheduleTransform(qp, dbroot) }
  ];
  if (Buffer.isBuffer(keyed[2])) candidates.push({ name: 'xor_with_dbroot_field2_1016', buffer: xorScheduleTransform(qp, keyed[2]) });
  if (Buffer.isBuffer(keyed[3])) candidates.push({ name: 'xor_with_dbroot_field3', buffer: xorScheduleTransform(qp, keyed[3]) });

  const report = {
    dbrootPath,
    qpPath,
    qpRaw: describeBuffer(qp),
    attempts: []
  };

  for (const attempt of candidates) {
    const desc = describeBuffer(attempt.buffer);
    const inflateAttempts = tryInflate(attempt.buffer).map(x => {
      if (!x.ok) return x;
      return {
        ok: true,
        mode: x.mode,
        description: describeBuffer(x.output)
      };
    });

    report.attempts.push({
      name: attempt.name,
      description: desc,
      inflateAttempts
    });

    writeBin(path.join(outDir, `${attempt.name}.bin`), attempt.buffer);
    for (const inf of inflateAttempts) {
      if (inf.ok) {
        const mode = inf.mode;
        const inflBuf = tryInflate(attempt.buffer).find(x => x.ok && x.mode === mode).output;
        writeBin(path.join(outDir, `${attempt.name}.${mode}.bin`), inflBuf);
      }
    }
  }

  writeJson(path.join(outDir, 'qp_report.json'), report);
  return report;
}

function getTileGeoSize(level) {
  return ZeroTileGeoSize / Math.pow(2, level);
}

function getRowColInfoChar(rowIndex, colIndex) {
  const rowOdd = rowIndex % 2;
  const colOdd = colIndex % 2;
  if (rowOdd > 0 && colOdd > 0) return '2';
  if (rowOdd > 0 && colOdd === 0) return '3';
  if (rowOdd === 0 && colOdd === 0) return '0';
  return '1';
}

function getRowColInfoStr(lat, lon, level) {
  let out = '';
  for (let i = 0; i <= level; i++) {
    const geoSize = getTileGeoSize(i);
    const col = Math.floor((lon - ValidBoundRc[0]) / geoSize);
    const row = Math.floor((lat - ValidBoundRc[3]) / geoSize);
    out += getRowColInfoChar(row, col);
  }
  return out;
}

function buildTileCellsForBounds(bounds, zoom) {
  const tileSize = getTileGeoSize(zoom);
  const colLeft = Math.floor((bounds.west - ValidBoundRc[0]) / tileSize);
  const colRight = Math.floor((bounds.east - ValidBoundRc[0]) / tileSize);
  const rowBottom = Math.floor((bounds.south - ValidBoundRc[3]) / tileSize);
  const rowTop = Math.floor((bounds.north - ValidBoundRc[3]) / tileSize);

  const dedupe = new Set();
  const cells = [];
  for (let row = rowBottom; row <= rowTop; row++) {
    for (let col = colLeft; col <= colRight; col++) {
      const south = row * tileSize + ValidBoundRc[3];
      const west = col * tileSize + ValidBoundRc[0];
      const north = south + tileSize;
      const east = west + tileSize;
      const centerLat = (south + north) / 2;
      const centerLon = (west + east) / 2;
      const pathCode = getRowColInfoStr(centerLat, centerLon, zoom);
      if (dedupe.has(pathCode)) continue;
      dedupe.add(pathCode);
      cells.push({
        path: pathCode,
        row,
        col,
        bounds: { north, south, east, west }
      });
    }
  }
  return cells;
}

function buildUrl(baseUrl, pathCode, iCode, fToken) {
  return `${baseUrl}&f1-${pathCode}-i.${iCode}-${fToken}`;
}

function prioritiseVersions(versionHint, candidateVersions) {
  const pool = Array.isArray(candidateVersions) && candidateVersions.length
    ? [...new Set(candidateVersions.map(Number).filter(Number.isFinite))].sort((a, b) => a - b)
    : DEFAULT_VERSION_POOL;

  if (!Number.isFinite(versionHint)) return pool;
  const aroundHint = [
    versionHint,
    versionHint - 1,
    versionHint + 1,
    versionHint - 2,
    versionHint + 2,
    versionHint - 5,
    versionHint + 5,
    versionHint - 10,
    versionHint + 10
  ].filter(v => Number.isFinite(v) && v >= 0);

  return [...new Set([...aroundHint, ...pool])];
}

async function probeFlatfile(url, timeoutMs, cache) {
  if (cache.has(url)) return cache.get(url);
  const promise = axios.get(url, {
    responseType: 'arraybuffer',
    headers: REQUEST_HEADERS,
    timeout: timeoutMs,
    validateStatus: status => status === 200 || status === 404
  }).then(response => {
    const buffer = Buffer.from(response.data || []);
    return {
      url,
      status: response.status,
      size: buffer.length,
      sha256: sha256Hex(buffer),
      contentType: response.headers['content-type'] || '',
      isValid: response.status === 200 && buffer.length > 114
    };
  }).catch(err => ({
    url,
    status: err.response?.status || 0,
    size: 0,
    sha256: null,
    contentType: '',
    isValid: false,
    error: err.message
  }));

  cache.set(url, promise);
  return promise;
}

async function buildCatalog(configPath, outDir) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config.bounds || typeof config.zoom !== 'number' || !Array.isArray(config.dates)) {
    throw new Error('Config must include bounds, zoom, and dates[]');
  }

  const cells = buildTileCellsForBounds(config.bounds, config.zoom);
  const timeoutMs = Number(config.timeoutMs) || DEFAULT_PROBE_TIMEOUT_MS;
  const cache = new Map();
  const result = {
    generatedAt: new Date().toISOString(),
    bounds: config.bounds,
    zoom: config.zoom,
    pathCount: cells.length,
    paths: cells.map(c => c.path),
    dates: {}
  };

  for (const dateEntry of config.dates) {
    const date = dateEntry.date;
    const baseUrl = dateEntry.base_url || dateEntry.baseUrl || 'https://khmdb.google.com/flatfile?db=tm';
    const fToken = dateEntry.fToken || dateEntry.hex_code;
    const versionHint = Number(dateEntry.versionHint);
    const versions = prioritiseVersions(Number.isFinite(versionHint) ? versionHint : null, config.candidateVersions);

    const dateOut = {
      date,
      fToken,
      versionHint: Number.isFinite(versionHint) ? versionHint : null,
      paths: {}
    };

    for (const cell of cells) {
      const valid = [];
      for (const iCode of versions) {
        const url = buildUrl(baseUrl, cell.path, iCode, fToken);
        const probe = await probeFlatfile(url, timeoutMs, cache);
        if (probe.isValid) {
          valid.push({
            iCode,
            url,
            size: probe.size,
            sha256: probe.sha256,
            contentType: probe.contentType
          });
        }
      }
      if (valid.length) {
        dateOut.paths[cell.path] = {
          bounds: cell.bounds,
          validVersions: valid
        };
      }
    }

    result.dates[date] = dateOut;
  }

  writeJson(path.join(outDir, 'catalog.json'), result);
  return result;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else {
      args._.push(a);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const outDir = path.resolve(args.out || './tm_probe_out');
  ensureDir(outDir);

  if (cmd === 'inspect-root') {
    if (!args.dbroot) throw new Error('--dbroot is required');
    const report = inspectDbRoot(args.dbroot, outDir);
    console.log('Wrote:', path.join(outDir, 'dbroot_report.json'));
    console.log(JSON.stringify({ fields: report.fields?.map(f => ({ field: f.field, length: f.length, value: f.value })) || null }, null, 2));
    return;
  }

  if (cmd === 'inspect-qp') {
    if (!args.dbroot || !args.qp) throw new Error('--dbroot and --qp are required');
    const report = inspectQp(args.dbroot, args.qp, outDir);
    console.log('Wrote:', path.join(outDir, 'qp_report.json'));
    console.log(JSON.stringify(report.attempts.map(a => ({
      name: a.name,
      size: a.description.size,
      entropy: a.description.entropy,
      printableRatio: a.description.printableRatio,
      inflateModes: a.inflateAttempts.filter(x => x.ok).map(x => x.mode)
    })), null, 2));
    return;
  }

  if (cmd === 'build-catalog') {
    if (!args.config) throw new Error('--config is required');
    const result = await buildCatalog(args.config, outDir);
    console.log('Wrote:', path.join(outDir, 'catalog.json'));
    console.log(JSON.stringify({
      pathCount: result.pathCount,
      dates: Object.keys(result.dates)
    }, null, 2));
    return;
  }

  console.log(`
Usage:
  node tm_metadata_probe.js inspect-root --dbroot ./D2_dbRoot_v5_tm.proto --out ./tm_probe
  node tm_metadata_probe.js inspect-qp --dbroot ./D2_dbRoot_v5_tm.proto --qp ./D1_qp_q366.bin --out ./tm_probe
  node tm_metadata_probe.js build-catalog --config ./tm_catalog_config.json --out ./catalog_out
`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
