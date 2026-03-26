const fs = require('fs');
const path = require('path');

const { loadDependency } = require('./dependencyLoader');
const { HistoricalCatalog, buildVersionCandidates } = require('./catalog');
const { readSecretKey, DEFAULT_REQUEST_HEADERS, decryptXOR, fetchBuffer } = require('./metadata');
const { latLonToPath, normalizeBounds, slippyTileToCenter } = require('./pathUtils');
const { cropBufferToSuffix } = require('./tileCropper');

const express = loadDependency('express');
const { Jimp, JimpMime } = require('jimp');

const app = express();
const PORT = 3001;

const DBROOT_PATH = path.resolve(__dirname, 'dbRoot.v5');
const CACHE_DIR = path.join(__dirname, 'tile_cache');
const RAW_CACHE_DIR = path.join(CACHE_DIR, 'raw');
const DERIVED_CACHE_DIR = path.join(CACHE_DIR, 'derived');
const BASE_URL = 'https://cmpmap.com/flatfile?db=tm';
const ROOT_VERSION = 366;
const REQUEST_TIMEOUT_MS = 10000;

for (const directory of [CACHE_DIR, RAW_CACHE_DIR, DERIVED_CACHE_DIR]) {
  fs.mkdirSync(directory, { recursive: true });
}

const secretKey = readSecretKey(DBROOT_PATH);
const historicalCatalog = new HistoricalCatalog({
  baseUrl: BASE_URL,
  requestHeaders: DEFAULT_REQUEST_HEADERS,
  rootVersion: ROOT_VERSION,
  secretKey,
  timeoutMs: REQUEST_TIMEOUT_MS,
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function normalizeCatalogZoom(rawZoom) {
  const zoom = Number.parseInt(rawZoom, 10);

  if (!Number.isFinite(zoom)) {
    return 17;
  }

  return Math.min(18, Math.max(10, zoom));
}

function isJpeg(buffer) {
  return buffer && buffer.length > 2 && buffer[0] === 0xff && buffer[1] === 0xd8;
}

async function normalizeTileBuffer(buffer) {
  if (isJpeg(buffer)) {
    return Buffer.from(buffer);
  }

  const decrypted = decryptXOR(buffer, secretKey);

  if (isJpeg(decrypted)) {
    return decrypted;
  }

  try {
    const image = await Jimp.read(decrypted);
    return image.getBuffer(JimpMime.jpeg);
  } catch (decryptError) {
    const image = await Jimp.read(buffer);
    return image.getBuffer(JimpMime.jpeg);
  }
}

function getRawTileCachePath(pathCode, iCode, fToken) {
  return path.join(RAW_CACHE_DIR, `${pathCode}_${iCode}_${fToken}.jpg`);
}

function getDerivedTileCachePath(requestedPath, resolvedPath, iCode, fToken) {
  return path.join(DERIVED_CACHE_DIR, `${requestedPath}__${resolvedPath}_${iCode}_${fToken}.jpg`);
}

async function fetchOrCacheRawTile(pathCode, iCode, fToken) {
  const cachePath = getRawTileCachePath(pathCode, iCode, fToken);

  if (fs.existsSync(cachePath)) {
    return {
      buffer: fs.readFileSync(cachePath),
      cachePath,
      sourceUrl: `${BASE_URL}&f1-${pathCode}-i.${iCode}-${fToken}`,
      cacheHit: true,
    };
  }

  const sourceUrl = `${BASE_URL}&f1-${pathCode}-i.${iCode}-${fToken}`;
  const response = await fetchBuffer(sourceUrl, {
    headers: DEFAULT_REQUEST_HEADERS,
    timeoutMs: REQUEST_TIMEOUT_MS,
    validateStatus: status => status === 200,
  });
  const normalizedBuffer = await normalizeTileBuffer(response.buffer);

  fs.writeFileSync(cachePath, normalizedBuffer);

  return {
    buffer: normalizedBuffer,
    cachePath,
    sourceUrl,
    cacheHit: false,
  };
}

async function resolveTileImage({ requestedPath, fToken, candidateVersions }) {
  for (let length = requestedPath.length; length >= 5; length -= 1) {
    const resolvedPath = requestedPath.slice(0, length);
    const suffix = requestedPath.slice(length);

    for (const iCode of candidateVersions) {
      try {
        const rawTile = await fetchOrCacheRawTile(resolvedPath, iCode, fToken);

        if (!suffix) {
          return {
            buffer: rawTile.buffer,
            requestedPath,
            resolvedPath,
            iCode,
            sourceUrl: rawTile.sourceUrl,
            cachePath: rawTile.cachePath,
            croppedFromParent: false,
          };
        }

        const derivedCachePath = getDerivedTileCachePath(requestedPath, resolvedPath, iCode, fToken);

        if (fs.existsSync(derivedCachePath)) {
          return {
            buffer: fs.readFileSync(derivedCachePath),
            requestedPath,
            resolvedPath,
            iCode,
            sourceUrl: rawTile.sourceUrl,
            cachePath: derivedCachePath,
            croppedFromParent: true,
          };
        }

        const croppedBuffer = await cropBufferToSuffix(rawTile.buffer, suffix);
        fs.writeFileSync(derivedCachePath, croppedBuffer);

        return {
          buffer: croppedBuffer,
          requestedPath,
          resolvedPath,
          iCode,
          sourceUrl: rawTile.sourceUrl,
          cachePath: derivedCachePath,
          croppedFromParent: true,
        };
      } catch (error) {
        // Try the next version or parent.
      }
    }
  }

  return null;
}

function buildSelectionFromQuery(query) {
  const preferredVersion = Number.parseInt(query.preferredVersion, 10);

  return {
    date: query.date || null,
    fToken: query.fToken || null,
    preferredVersion: Number.isFinite(preferredVersion) ? preferredVersion : null,
  };
}

app.post('/api/catalog', async (req, res) => {
  try {
    const { bounds: rawBounds, zoom: rawZoom } = req.body || {};
    const bounds = normalizeBounds(rawBounds);
    const zoom = normalizeCatalogZoom(rawZoom);
    const catalog = await historicalCatalog.buildBoundsCatalog(bounds, zoom);

    res.json(catalog);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/catalog-debug', async (req, res) => {
  try {
    const { bounds: rawBounds, zoom: rawZoom } = req.body || {};
    const bounds = normalizeBounds(rawBounds);
    const zoom = normalizeCatalogZoom(rawZoom);
    const catalog = await historicalCatalog.buildBoundsCatalog(bounds, zoom);

    res.json(catalog);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/dates', async (req, res) => {
  try {
    let bounds = null;

    if (
      req.query.north !== undefined &&
      req.query.south !== undefined &&
      req.query.east !== undefined &&
      req.query.west !== undefined
    ) {
      bounds = normalizeBounds({
        north: Number.parseFloat(req.query.north),
        south: Number.parseFloat(req.query.south),
        east: Number.parseFloat(req.query.east),
        west: Number.parseFloat(req.query.west),
      });
    } else if (req.query.lat !== undefined && req.query.lon !== undefined) {
      const lat = Number.parseFloat(req.query.lat);
      const lon = Number.parseFloat(req.query.lon);
      bounds = normalizeBounds({
        north: lat,
        south: lat,
        east: lon,
        west: lon,
      });
    } else {
      throw new Error('lat/lon or north/south/east/west are required.');
    }

    const zoom = normalizeCatalogZoom(req.query.zoom);
    const catalog = await historicalCatalog.buildBoundsCatalog(bounds, zoom);
    const centerPath = latLonToPath((bounds.north + bounds.south) / 2, (bounds.east + bounds.west) / 2, zoom);

    res.json({
      path: centerPath,
      dates: catalog.entries,
      verification: catalog.verification,
      pathCount: catalog.pathCount,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/tile/:z/:x/:y', async (req, res) => {
  try {
    const selection = buildSelectionFromQuery(req.query);

    if (!selection.date || !selection.fToken) {
      return res.status(400).json({ error: 'date and fToken are required.' });
    }

    const z = Number.parseInt(req.params.z, 10);
    const x = Number.parseInt(req.params.x, 10);
    const y = Number.parseInt(req.params.y, 10);

    if (![z, x, y].every(Number.isFinite)) {
      return res.status(400).json({ error: 'Invalid tile coordinates.' });
    }

    const tileCenter = slippyTileToCenter(z, x, y);
    const requestedPath = latLonToPath(tileCenter.lat, tileCenter.lon, z);
    const selectionInfo = await historicalCatalog.findSelectionEntries(requestedPath, selection);
    let candidateVersions = buildVersionCandidates(selectionInfo.matches, selection.preferredVersion);

    if (candidateVersions.length === 0 && Number.isFinite(selection.preferredVersion)) {
      candidateVersions = [selection.preferredVersion];
    }

    if (candidateVersions.length === 0) {
      return res.status(404).json({
        error: 'The selected date is not available for the requested path.',
        requestedPath,
      });
    }

    const resolvedTile = await resolveTileImage({
      requestedPath,
      fToken: selection.fToken,
      candidateVersions,
    });

    if (!resolvedTile) {
      return res.status(404).json({
        error: 'No tile found for the requested path/date combination.',
        requestedPath,
        candidateVersions,
      });
    }

    res.set('Content-Type', 'image/jpeg');
    res.set('X-Historical-Requested-Path', requestedPath);
    res.set('X-Historical-Resolved-Path', resolvedTile.resolvedPath);
    res.set('X-Historical-Version', String(resolvedTile.iCode));
    res.set('X-Historical-Cropped', String(resolvedTile.croppedFromParent));
    return res.send(resolvedTile.buffer);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/clear-caches', (req, res) => {
  historicalCatalog.clearCaches();
  res.json({ ok: true });
});

let server = null;

function startServer() {
  server = app.listen(PORT, () => {
    console.log(`Historical Server running at http://localhost:${PORT}`);
  });

  server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Error: Port ${PORT} is already in use.`);
    } else {
      console.error('Server error:', error);
    }
    process.exit(1);
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  historicalCatalog,
  normalizeCatalogZoom,
  resolveTileImage,
  startServer,
};
