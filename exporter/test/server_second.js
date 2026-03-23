const express = require('express');
const fs = require('fs');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

const ZeroTileGeoSize = 360;
const ValidBoundRc = [-180.0, 180.0, 180.0, -180.0];
const CACHE_DIR = path.join(__dirname, 'tile_cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const PROBE_TIMEOUT_MS = 12000;

// Optional: keep if you already use local decryption material
const TMPROTO_PATH = path.join(__dirname, 'dbRoot.v5');
const secretKey = fs.existsSync(TMPROTO_PATH) ? fs.readFileSync(TMPROTO_PATH) : null;

const TM_HEADERS = {
  'User-Agent': 'GoogleEarth/7.3.6.9796(Windows;Microsoft Windows (6.2.9200.0);el;kml:2.2;client:Pro;type:default)',
  'Accept-Encoding': 'gzip, deflate, gfe',
};

// -----------------------------------------------------------------------------
// 1) YOUR CHRONOLOGY TABLE
//    Keep extending this with your known date -> fToken knowledge.
//    IMPORTANT:
//      - `version` is now only a HINT
//      - the real valid i.xxx is discovered per (path, fToken)
// -----------------------------------------------------------------------------
const dateVersionMapping = {
  "2008-04-23": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.10",  "hex_code": "fb097" },
  "2008-07-09": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.97",  "hex_code": "fb0e9" },
  "2010-07-02": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fb4e2" },
  "2011-06-20": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fb6d4" },
  "2012-07-29": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fb8fd" },
  "2012-12-31": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fba9d" },
  "2013-04-29": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fba9d" },
  "2013-10-24": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.115", "hex_code": "fbb58" },
  "2013-10-30": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fbb5e" },
  "2014-03-21": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fbc75" },
  "2014-10-07": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fbd47" },
  "2015-01-24": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fbe38" },
  "2015-03-10": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fbe6a" },
  "2015-03-22": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fbe76" },
  "2015-04-05": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.281", "hex_code": "fbe85" },
  "2015-04-13": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fbe8d" },
  "2016-04-05": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.152", "hex_code": "fc085" },
  "2016-06-07": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fc0c7" },
  "2016-09-28": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fc13c" },
  "2016-11-24": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fc178" },
  "2017-04-11": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fc28b" },
  "2018-04-06": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fc486" },
  "2018-04-16": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fc490" },
  "2018-05-05": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fc4a5" },
  "2019-06-23": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fc6d7" },
  "2019-08-10": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fc70a" },
  "2019-08-13": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fc70d" },
  "2019-08-15": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fc70f" },
  "2019-08-26": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fc71a" },
  "2019-12-02": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fc782" },
  "2020-04-13": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fc88d" },
  "2020-05-21": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.288", "hex_code": "fc8b5" },
  "2020-06-09": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.272", "hex_code": "fc8c9" },
  "2020-10-16": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.271", "hex_code": "fc950" },
  "2022-01-09": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.299", "hex_code": "fcd21" },
  "2022-06-11": { "base_url": "https://cmpmap.com/flatfile?db=tm", "version": "i.346", "hex_code": "fcccb" },

  // optional direct kh.google historical layers if you want to keep them
  "2023-05-14": { "base_url": "https://kh.google.com/flatfile", "version": "i.970", "hex_code": "" },
  "2024-07-16": { "base_url": "https://kh.google.com/flatfile", "version": "i.1007", "hex_code": "" }
};

const STATIC_VERSION_POOL = [
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

// -----------------------------------------------------------------------------
// 2) HELPERS
// -----------------------------------------------------------------------------
function toUniqueSortedNumbers(values) {
  return [...new Set(values.filter(Number.isFinite))].sort((a, b) => a - b);
}

function buildChronologyCatalog() {
  return Object.entries(dateVersionMapping)
    .map(([date, info]) => {
      const versionHint = Number(String(info.version || '').replace(/^i\./, ''));
      return {
        date,
        baseUrl: info.base_url || 'https://cmpmap.com/flatfile?db=tm',
        fToken: info.hex_code || '',
        versionHint: Number.isFinite(versionHint) ? versionHint : null,
      };
    })
    .filter(entry => entry.fToken); // tm historical entries only
}

function buildVersionPool() {
  const fromMap = Object.values(dateVersionMapping)
    .map(v => Number(String(v.version || '').replace(/^i\./, '')))
    .filter(Number.isFinite);
  return toUniqueSortedNumbers([...STATIC_VERSION_POOL, ...fromMap]);
}

const CHRONOLOGY_CATALOG = buildChronologyCatalog();
const VERSION_POOL = buildVersionPool();

const probeCache = new Map();
const bboxCatalogCache = new Map();

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function md5Hex(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

// Optional tile decryption
function decryptTile(buffer) {
  if (!secretKey) return Buffer.from(buffer);

  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const decryptedBuffer = Buffer.alloc(source.length);
  let j = 16;

  for (let i = 0; i < source.length; i++) {
    const oriChar = source[i];
    const keyChar = secretKey[(j + 8) % secretKey.length];
    decryptedBuffer[i] = oriChar ^ keyChar;
    j++;
    if (j % 8 === 0) j += 16;
    if (j >= 1016) j = (j + 8) % 24;
  }

  return decryptedBuffer;
}

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

function getRowColInfoStr(lat, lon, nLevel) {
  let strRowColInfo = '';
  for (let nLevelIndex = 0; nLevelIndex <= nLevel; nLevelIndex++) {
    const nTileGeoSize = getTileGeoSize(nLevelIndex);
    const nColIndex = Math.floor((lon - ValidBoundRc[0]) / nTileGeoSize);
    const nRowIndex = Math.floor((lat - ValidBoundRc[3]) / nTileGeoSize);
    strRowColInfo += getRowColInfoChar(nRowIndex, nColIndex);
  }
  return strRowColInfo;
}

function getBoundsCacheKey(bounds, zoom, datesKey = 'ALL', versionKey = 'AUTO') {
  return [
    bounds.north, bounds.south, bounds.east, bounds.west,
    zoom,
    datesKey,
    versionKey
  ].join('|');
}

// -----------------------------------------------------------------------------
// 3) BUILD PATHS FOR BBOX
// -----------------------------------------------------------------------------
function buildTileCellsForBounds(bounds, zoom) {
  const tileSize = getTileGeoSize(zoom);
  const nColLeft = Math.floor((bounds.west - ValidBoundRc[0]) / tileSize);
  const nColRight = Math.floor((bounds.east - ValidBoundRc[0]) / tileSize);
  const nRowBottom = Math.floor((bounds.south - ValidBoundRc[3]) / tileSize);
  const nRowTop = Math.floor((bounds.north - ValidBoundRc[3]) / tileSize);

  const cells = [];
  const dedupe = new Set();

  for (let row = nRowBottom; row <= nRowTop; row++) {
    for (let col = nColLeft; col <= nColRight; col++) {
      const tileSouth = row * tileSize + ValidBoundRc[3];
      const tileWest = col * tileSize + ValidBoundRc[0];
      const tileNorth = tileSouth + tileSize;
      const tileEast = tileWest + tileSize;

      const centerLat = (tileSouth + tileNorth) / 2;
      const centerLon = (tileWest + tileEast) / 2;
      const pathCode = getRowColInfoStr(centerLat, centerLon, zoom);

      if (dedupe.has(pathCode)) continue;
      dedupe.add(pathCode);

      cells.push({
        path: pathCode,
        row,
        col,
        bounds: {
          north: tileNorth,
          south: tileSouth,
          east: tileEast,
          west: tileWest,
        },
      });
    }
  }

  return cells;
}

// -----------------------------------------------------------------------------
// 4) URL BUILDING + PROBING
// -----------------------------------------------------------------------------
function buildUrl(baseUrl, pathCode, iCode, fToken) {
  return `${baseUrl}&f1-${pathCode}-i.${iCode}-${fToken}`;
}

function prioritiseVersions(versionHint, customVersions) {
  const basePool = customVersions?.length
    ? toUniqueSortedNumbers(customVersions.map(Number))
    : VERSION_POOL;

  if (!Number.isFinite(versionHint)) return basePool;

  const aroundHint = [
    versionHint,
    versionHint - 1,
    versionHint + 1,
    versionHint - 2,
    versionHint + 2,
    versionHint - 5,
    versionHint + 5,
    versionHint - 10,
    versionHint + 10,
  ].filter(v => Number.isFinite(v) && v >= 0);

  return [...new Set([...aroundHint, ...basePool])];
}

async function probeFlatfile(url) {
  if (probeCache.has(url)) return probeCache.get(url);

  const promise = axios.get(url, {
    responseType: 'arraybuffer',
    headers: TM_HEADERS,
    timeout: PROBE_TIMEOUT_MS,
    validateStatus: status => status === 200 || status === 404,
  })
    .then(response => {
      const buffer = Buffer.from(response.data || []);
      return {
        url,
        status: response.status,
        size: buffer.length,
        sha256: sha256Hex(buffer),
        contentType: response.headers['content-type'] || '',
        isValid: response.status === 200 && buffer.length > 114
      };
    })
    .catch(error => ({
      url,
      status: error.response?.status || 0,
      size: 0,
      sha256: null,
      contentType: '',
      isValid: false,
      error: error.message
    }));

  probeCache.set(url, promise);
  return promise;
}

async function discoverValidVersionsForPath(entry, pathCode, customVersions) {
  const orderedVersions = prioritiseVersions(entry.versionHint, customVersions);
  const validVersions = [];

  for (const iCode of orderedVersions) {
    const url = buildUrl(entry.baseUrl, pathCode, iCode, entry.fToken);
    const probe = await probeFlatfile(url);
    if (probe.isValid) {
      validVersions.push({
        iCode,
        url,
        size: probe.size,
        sha256: probe.sha256,
        contentType: probe.contentType
      });
    }
  }

  return validVersions;
}

// -----------------------------------------------------------------------------
// 5) BUILD BBOX CATALOG
// -----------------------------------------------------------------------------
async function buildBBoxCatalog(bounds, zoom, selectedDates = null, customVersions = null) {
  const datesKey = selectedDates?.length ? selectedDates.join(',') : 'ALL';
  const versionKey = customVersions?.length ? customVersions.join(',') : 'AUTO';
  const cacheKey = getBoundsCacheKey(bounds, zoom, datesKey, versionKey);

  if (bboxCatalogCache.has(cacheKey)) {
    return bboxCatalogCache.get(cacheKey);
  }

  const tileCells = buildTileCellsForBounds(bounds, zoom);

  const activeCatalog = selectedDates?.length
    ? CHRONOLOGY_CATALOG.filter(entry => selectedDates.includes(entry.date))
    : CHRONOLOGY_CATALOG;

  const result = {
    bbox: bounds,
    zoom,
    pathCount: tileCells.length,
    paths: tileCells.map(c => c.path),
    availableDates: [],
    dates: {}
  };

  for (const entry of activeCatalog) {
    const datePaths = [];

    for (const cell of tileCells) {
      const validVersions = await discoverValidVersionsForPath(entry, cell.path, customVersions);
      if (validVersions.length) {
        datePaths.push({
          path: cell.path,
          row: cell.row,
          col: cell.col,
          bounds: cell.bounds,
          validVersions
        });
      }
    }

    if (datePaths.length) {
      result.availableDates.push(entry.date);
      result.dates[entry.date] = {
        fToken: entry.fToken,
        versionHint: entry.versionHint,
        paths: datePaths,
        constructedUrls: datePaths.flatMap(p => p.validVersions.map(v => v.url))
      };
    }
  }

  bboxCatalogCache.set(cacheKey, result);
  return result;
}

// -----------------------------------------------------------------------------
// 6) FETCH + CACHE VALID TILES
// -----------------------------------------------------------------------------
async function fetchAndCacheTile(imageUrl) {
  const cacheName = md5Hex(imageUrl) + '.jpg';
  const cachePath = path.join(CACHE_DIR, cacheName);

  if (fs.existsSync(cachePath)) {
    return cachePath;
  }

  const response = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    headers: TM_HEADERS,
    timeout: PROBE_TIMEOUT_MS,
    validateStatus: status => status === 200,
  });

  const decrypted = decryptTile(Buffer.from(response.data));
  await sharp(decrypted).jpeg().toFile(cachePath);
  return cachePath;
}

// -----------------------------------------------------------------------------
// 7) API
// -----------------------------------------------------------------------------

// Return what dates are actually available for the bbox,
// and the valid URLs discovered internally.
app.post('/available-dates', async (req, res) => {
  try {
    const { bounds, zoom, dates, candidateVersions } = req.body || {};
    if (!bounds || typeof zoom !== 'number') {
      return res.status(400).json({ error: 'bounds and zoom are required.' });
    }

    const catalog = await buildBBoxCatalog(
      bounds,
      zoom,
      Array.isArray(dates) ? dates : null,
      candidateVersions
    );

    return res.json({
      availableDates: catalog.availableDates,
      byDate: Object.fromEntries(
        Object.entries(catalog.dates).map(([date, info]) => [
          date,
          {
            fToken: info.fToken,
            versionHint: info.versionHint,
            pathCount: info.paths.length,
            constructedUrls: info.constructedUrls,
            paths: info.paths.map(p => ({
              path: p.path,
              bounds: p.bounds,
              validVersions: p.validVersions
            }))
          }
        ])
      )
    });
  } catch (error) {
    console.error('Error in /available-dates:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Return the full valid catalog for one date.
app.post('/catalog-for-date', async (req, res) => {
  try {
    const { date, bounds, zoom, candidateVersions } = req.body || {};
    if (!date || !bounds || typeof zoom !== 'number') {
      return res.status(400).json({ error: 'date, bounds and zoom are required.' });
    }

    const catalog = await buildBBoxCatalog(bounds, zoom, [date], candidateVersions);
    const dateInfo = catalog.dates[date];

    if (!dateInfo) {
      return res.status(404).json({ error: 'No valid (path, fToken, iCode) combinations were found.' });
    }

    return res.json(dateInfo);
  } catch (error) {
    console.error('Error in /catalog-for-date:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Fetch usable tiles for one date from the discovered valid URLs.
app.post('/tiles', async (req, res) => {
  try {
    const {
      date,
      bounds,
      zoom,
      preferredVersion = 'hint-first', // hint-first | highest | lowest
      candidateVersions
    } = req.body || {};

    if (!date || !bounds || typeof zoom !== 'number') {
      return res.status(400).json({ error: 'date, bounds and zoom are required.' });
    }

    const catalog = await buildBBoxCatalog(bounds, zoom, [date], candidateVersions);
    const dateInfo = catalog.dates[date];

    if (!dateInfo) {
      return res.status(404).json({
        error: 'No valid historical combinations were found for the requested bbox/date.'
      });
    }

    const overlays = [];

    for (const pathInfo of dateInfo.paths) {
      let selected = null;

      if (preferredVersion === 'highest') {
        selected = [...pathInfo.validVersions].sort((a, b) => b.iCode - a.iCode)[0];
      } else if (preferredVersion === 'lowest') {
        selected = [...pathInfo.validVersions].sort((a, b) => a.iCode - b.iCode)[0];
      } else {
        // hint-first ordering from prioritiseVersions
        selected = pathInfo.validVersions[0];
      }

      const cachePath = await fetchAndCacheTile(selected.url);

      overlays.push({
        path: pathInfo.path,
        iCode: selected.iCode,
        fToken: dateInfo.fToken,
        sourceUrl: selected.url,
        url: `http://localhost:${PORT}/tile_cache/${path.basename(cachePath)}`,
        bounds: pathInfo.bounds
      });
    }

    return res.json({
      date,
      fToken: dateInfo.fToken,
      tileCount: overlays.length,
      tiles: overlays
    });
  } catch (error) {
    console.error('Error in /tiles:', error);
    return res.status(500).json({ error: error.message });
  }
});

app.post('/clear-caches', (req, res) => {
  probeCache.clear();
  bboxCatalogCache.clear();
  return res.json({ ok: true });
});

app.use('/tile_cache', express.static(CACHE_DIR));

app.use((req, res) => {
  res.status(404).send('Endpoint not found');
});

app.listen(PORT, () => {
  console.log(`Historical tile server is running at http://localhost:${PORT}`);
});