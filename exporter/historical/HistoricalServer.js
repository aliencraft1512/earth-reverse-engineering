const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { loadDependency } = require('./dependencyLoader');
const { HistoricalCatalog, buildVersionCandidates, mapWithConcurrency } = require('./catalog');
const { readSecretKey, DEFAULT_REQUEST_HEADERS, decryptXOR, fetchBuffer, fetchFirstSuccessfulBuffer } = require('./metadata');
const { buildPathCellsForBounds, latLonToPath, normalizeBounds, slippyTileToCenter } = require('./pathUtils');
const {
  createViewStatsRecord,
  pruneViewStatsCache,
  summarizeTileResults,
  summarizeViewStats,
  upsertViewTileResult,
} = require('./renderProvenance');
const { cropBufferToSuffix } = require('./tileCropper');

const express = loadDependency('express');
const { Jimp, JimpMime } = require('jimp');

const app = express();
const PORT = 3001;

const DBROOT_PATH = path.resolve(__dirname, 'dbRoot.v5');
const CACHE_DIR = path.join(__dirname, 'tile_cache');
const METADATA_CACHE_DIR = path.join(__dirname, 'metadata_cache');
const BASE_URLS = [
  'https://kh.google.com/flatfile?db=tm',
  'https://cmpmap.com/flatfile?db=tm',
];
const BASE_URL = BASE_URLS[0];
const ROOT_VERSION = 366;
const REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_FIDELITY_MODE = 'allow-ancestor-derived';
const OVERLAY_FETCH_CONCURRENCY = 4;
const ENTRY_RENDERABILITY_CONCURRENCY = 3;
const ENTRY_RENDERABILITY_MAX_PATHS = 6;
const VIEW_STATS_TTL_MS = 5 * 60 * 1000;

fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(METADATA_CACHE_DIR, { recursive: true });

const secretKey = readSecretKey(DBROOT_PATH);
const historicalCatalog = new HistoricalCatalog({
  baseUrl: BASE_URL,
  baseUrls: BASE_URLS,
  requestHeaders: DEFAULT_REQUEST_HEADERS,
  rootVersion: ROOT_VERSION,
  resolveEntrySignature,
  secretKey,
  timeoutMs: REQUEST_TIMEOUT_MS,
  metadataCacheDir: METADATA_CACHE_DIR,
});
const viewStatsCache = new Map();
const tileSignatureCache = new Map();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/tile_cache', express.static(CACHE_DIR));

function normalizeCatalogZoom(rawZoom) {
  const zoom = Number.parseInt(rawZoom, 10);

  if (!Number.isFinite(zoom)) {
    return 17;
  }

  return Math.min(14, Math.max(10, zoom));
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

function buildTileCacheFileName(kind, parts) {
  return `${kind}__${parts.join('__')}.jpg`;
}

function getRawTileCachePath(pathCode, iCode, fToken) {
  return path.join(CACHE_DIR, buildTileCacheFileName('raw', [pathCode, String(iCode), fToken]));
}

function getDerivedTileCachePath(requestedPath, resolvedPath, iCode, fToken) {
  return path.join(CACHE_DIR, buildTileCacheFileName('derived', [requestedPath, resolvedPath, String(iCode), fToken]));
}

function getLegacyRawTileCachePath(pathCode, iCode, fToken) {
  return path.join(CACHE_DIR, 'raw', `${pathCode}_${iCode}_${fToken}.jpg`);
}

function getLegacyDerivedTileCachePath(requestedPath, resolvedPath, iCode, fToken) {
  return path.join(CACHE_DIR, 'derived', `${requestedPath}__${resolvedPath}_${iCode}_${fToken}.jpg`);
}

function getLegacyFlatRawTileCachePath(pathCode, iCode, fToken) {
  return path.join(CACHE_DIR, `raw__${pathCode}_${iCode}_${fToken}.jpg`);
}

function getLegacyFlatDerivedTileCachePath(requestedPath, resolvedPath, iCode, fToken) {
  return path.join(CACHE_DIR, `derived__${requestedPath}__${resolvedPath}_${iCode}_${fToken}.jpg`);
}

function parseLegacyRawCacheName(fileName) {
  const match = /^([0-9]+)_(\d+)_([^.]+)\.jpg$/i.exec(fileName);

  if (!match) {
    return null;
  }

  return {
    pathCode: match[1],
    iCode: Number.parseInt(match[2], 10),
    fToken: match[3],
  };
}

function parseLegacyDerivedCacheName(fileName) {
  const match = /^([0-9]+)__([0-9]+)_(\d+)_([^.]+)\.jpg$/i.exec(fileName);

  if (!match) {
    return null;
  }

  return {
    requestedPath: match[1],
    resolvedPath: match[2],
    iCode: Number.parseInt(match[3], 10),
    fToken: match[4],
  };
}

function migrateLegacyCacheFile(legacyPath, cachePath) {
  if (!fs.existsSync(legacyPath)) {
    return false;
  }

  if (!fs.existsSync(cachePath)) {
    fs.renameSync(legacyPath, cachePath);
  }

  return true;
}

function migrateLegacyTileCache() {
  const legacyDirectories = [
    path.join(CACHE_DIR, 'raw'),
    path.join(CACHE_DIR, 'derived'),
  ];

  for (const legacyDirectory of legacyDirectories) {
    if (!fs.existsSync(legacyDirectory)) {
      continue;
    }

    for (const entry of fs.readdirSync(legacyDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }

      const sourcePath = path.join(legacyDirectory, entry.name);
      const isDerivedDirectory = path.basename(legacyDirectory) === 'derived';
      const parsed = isDerivedDirectory
        ? parseLegacyDerivedCacheName(entry.name)
        : parseLegacyRawCacheName(entry.name);

      if (!parsed) {
        continue;
      }

      const targetPath = isDerivedDirectory
        ? getDerivedTileCachePath(parsed.requestedPath, parsed.resolvedPath, parsed.iCode, parsed.fToken)
        : getRawTileCachePath(parsed.pathCode, parsed.iCode, parsed.fToken);

      if (!fs.existsSync(targetPath)) {
        fs.renameSync(sourcePath, targetPath);
      }
    }

    try {
      fs.rmdirSync(legacyDirectory);
    } catch (error) {
      // Ignore non-empty legacy directories.
    }
  }

  for (const entry of fs.readdirSync(CACHE_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }

    const sourcePath = path.join(CACHE_DIR, entry.name);
    let targetPath = null;

    if (entry.name.startsWith('raw__')) {
      const parsed = parseLegacyRawCacheName(entry.name.slice('raw__'.length));
      if (parsed) {
        targetPath = getRawTileCachePath(parsed.pathCode, parsed.iCode, parsed.fToken);
      }
    } else if (entry.name.startsWith('derived__')) {
      const parsed = parseLegacyDerivedCacheName(entry.name.slice('derived__'.length));
      if (parsed) {
        targetPath = getDerivedTileCachePath(parsed.requestedPath, parsed.resolvedPath, parsed.iCode, parsed.fToken);
      }
    }

    if (!targetPath || targetPath === sourcePath || fs.existsSync(targetPath)) {
      continue;
    }

    fs.renameSync(sourcePath, targetPath);
  }
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

  const response = await fetchFirstSuccessfulBuffer({
    baseUrl: BASE_URL,
    baseUrls: BASE_URLS,
    buildUrl: candidateBaseUrl => `${candidateBaseUrl}&f1-${pathCode}-i.${iCode}-${fToken}`,
    headers: DEFAULT_REQUEST_HEADERS,
    timeoutMs: REQUEST_TIMEOUT_MS,
  metadataCacheDir: METADATA_CACHE_DIR,
    validateStatus: status => status === 200,
    fetchBufferImpl: fetchBuffer,
  });
  const sourceUrl = response.url;
  const normalizedBuffer = await normalizeTileBuffer(response.buffer);

  fs.writeFileSync(cachePath, normalizedBuffer);

  return {
    buffer: normalizedBuffer,
    cachePath,
    sourceUrl,
    cacheHit: false,
  };
}

function getTileSignatureCacheKey(pathCode, iCode, fToken) {
  return `${pathCode}_${iCode}_${fToken}`;
}

function toTileCacheUrl(cachePath) {
  const relativePath = path.relative(CACHE_DIR, cachePath).replace(/\\/g, '/');
  return `/tile_cache/${relativePath}`;
}

async function fetchVisibleTileSignature(pathCode, iCode, fToken) {
  const cacheKey = `native:${getTileSignatureCacheKey(pathCode, iCode, fToken)}`;

  if (tileSignatureCache.has(cacheKey)) {
    return tileSignatureCache.get(cacheKey);
  }

  const request = (async () => {
    try {
      const rawTile = await fetchOrCacheRawTile(pathCode, iCode, fToken);
      return {
        mode: 'visible-tile-signature',
        signature: crypto.createHash('sha1').update(rawTile.buffer).digest('hex'),
        representativePath: pathCode,
        sourceUrl: rawTile.sourceUrl,
      };
    } catch (error) {
      tileSignatureCache.delete(cacheKey);
      return null;
    }
  })();

  tileSignatureCache.set(cacheKey, request);
  return request;
}

async function fetchRenderedTileSignature(pathCode, iCode, fToken) {
  const cacheKey = `rendered:${getTileSignatureCacheKey(pathCode, iCode, fToken)}`;

  if (tileSignatureCache.has(cacheKey)) {
    return tileSignatureCache.get(cacheKey);
  }

  const request = (async () => {
    try {
      const renderedTile = await resolveTileImage({
        requestedPath: pathCode,
        fToken,
        candidateVersions: [iCode],
        allowAncestorDerived: true,
      });

      if (!renderedTile) {
        tileSignatureCache.delete(cacheKey);
        return null;
      }

      return {
        mode: 'rendered-tile-signature',
        signature: crypto.createHash('sha1').update(renderedTile.buffer).digest('hex'),
        representativePath: pathCode,
        sourceUrl: renderedTile.sourceUrl,
        resolvedPath: renderedTile.resolvedPath,
      };
    } catch (error) {
      tileSignatureCache.delete(cacheKey);
      return null;
    }
  })();

  tileSignatureCache.set(cacheKey, request);
  return request;
}

async function resolveEntrySignature(entry, group = []) {
  const candidatePaths = [...new Set(
    [
      ...group.flatMap(item => item.paths || []),
      ...group.flatMap(item => item.sourcePaths || []),
      ...(entry.paths || []),
      ...(entry.sourcePaths || []),
    ].filter(Boolean)
  )].sort();

  for (const pathCode of candidatePaths) {
    const nativeSignature = await fetchVisibleTileSignature(pathCode, entry.iCode, entry.fToken);

    if (nativeSignature) {
      return nativeSignature;
    }

    const renderedSignature = await fetchRenderedTileSignature(pathCode, entry.iCode, entry.fToken);

    if (renderedSignature) {
      return renderedSignature;
    }
  }

  return null;
}

async function resolveTileImage({
  requestedPath,
  fToken,
  candidateVersions,
  allowAncestorDerived = true,
  minimumResolvedPathLength = null,
  fetchRawTile = fetchOrCacheRawTile,
  attemptLog = null,
}) {
  const minimumLength = allowAncestorDerived
    ? Math.max(
        5,
        Math.min(
          requestedPath.length,
          Number.isFinite(minimumResolvedPathLength) ? minimumResolvedPathLength : requestedPath.length
        )
      )
    : requestedPath.length;

  for (let length = requestedPath.length; length >= minimumLength; length -= 1) {
    const resolvedPath = requestedPath.slice(0, length);
    const suffix = requestedPath.slice(length);

    for (const iCode of candidateVersions) {
      const sourceUrl = `${BASE_URL}&f1-${resolvedPath}-i.${iCode}-${fToken}`;

      try {
        const rawTile = await fetchRawTile(resolvedPath, iCode, fToken);

        if (!suffix) {
          attemptLog?.push({
            requestedPath,
            resolvedPath,
            iCode,
            fToken,
            sourceUrl: rawTile.sourceUrl || sourceUrl,
            status: 'ok',
            cacheHit: Boolean(rawTile.cacheHit),
            derivedCacheHit: false,
            croppedFromParent: false,
          });
          return {
            buffer: rawTile.buffer,
            requestedPath,
            resolvedPath,
            iCode,
            sourceUrl: rawTile.sourceUrl,
            cachePath: rawTile.cachePath,
            croppedFromParent: false,
            cacheHit: Boolean(rawTile.cacheHit),
            derivedCacheHit: false,
          };
        }

        const derivedCachePath = getDerivedTileCachePath(requestedPath, resolvedPath, iCode, fToken);
        
        

        if (fs.existsSync(derivedCachePath)) {
          attemptLog?.push({
            requestedPath,
            resolvedPath,
            iCode,
            fToken,
            sourceUrl: rawTile.sourceUrl || sourceUrl,
            status: 'ok',
            cacheHit: Boolean(rawTile.cacheHit),
            derivedCacheHit: true,
            croppedFromParent: true,
          });
          return {
            buffer: fs.readFileSync(derivedCachePath),
            requestedPath,
            resolvedPath,
            iCode,
            sourceUrl: rawTile.sourceUrl,
            cachePath: derivedCachePath,
            croppedFromParent: true,
            cacheHit: Boolean(rawTile.cacheHit),
            derivedCacheHit: true,
          };
        }

        const croppedBuffer = await cropBufferToSuffix(rawTile.buffer, suffix);
        fs.writeFileSync(derivedCachePath, croppedBuffer);

        attemptLog?.push({
          requestedPath,
          resolvedPath,
          iCode,
          fToken,
          sourceUrl: rawTile.sourceUrl || sourceUrl,
          status: 'ok',
          cacheHit: Boolean(rawTile.cacheHit),
          derivedCacheHit: false,
          croppedFromParent: true,
        });

        return {
          buffer: croppedBuffer,
          requestedPath,
          resolvedPath,
          iCode,
          sourceUrl: rawTile.sourceUrl,
          cachePath: derivedCachePath,
          croppedFromParent: true,
          cacheHit: Boolean(rawTile.cacheHit),
          derivedCacheHit: false,
        };
      } catch (error) {
        attemptLog?.push({
          requestedPath,
          resolvedPath,
          iCode,
          fToken,
          sourceUrl: error?.sourceUrl || sourceUrl,
          status: error?.status === 404 ? 'missing' : 'error',
          cacheHit: false,
          derivedCacheHit: false,
          croppedFromParent: Boolean(suffix),
          message: error?.message || 'Tile request failed.',
        });
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

function parseFidelityMode(query) {
  if (query.fidelityMode === 'native-only') {
    return 'native-only';
  }

  return DEFAULT_FIDELITY_MODE;
}

function getVersionMode(selection) {
  return Number.isFinite(selection.preferredVersion) ? 'exact-preferred' : 'best-valid-per-path';
}

function buildSelectionDecision(matches, preferredVersion = null) {
  const availableVersions = [...new Set(matches.map(entry => entry.iCode).filter(Number.isFinite))]
    .sort((left, right) => right - left);
  let candidateVersions = buildVersionCandidates(matches, preferredVersion);

  if (candidateVersions.length === 0 && Number.isFinite(preferredVersion)) {
    candidateVersions = [preferredVersion];
  }

  if (availableVersions.length === 0) {
    return {
      availableVersions,
      candidateVersions,
      selectedVersion: null,
      reason: Number.isFinite(preferredVersion) ? 'preferred-version-unavailable' : 'no-valid-version',
    };
  }

  if (Number.isFinite(preferredVersion) && availableVersions.includes(preferredVersion)) {
    return {
      availableVersions,
      candidateVersions,
      selectedVersion: preferredVersion,
      reason: 'preferred-version',
    };
  }

  if (Number.isFinite(preferredVersion)) {
    return {
      availableVersions,
      candidateVersions,
      selectedVersion: candidateVersions[0] || availableVersions[0],
      reason: 'alternate-version',
    };
  }

  return {
    availableVersions,
    candidateVersions,
    selectedVersion: candidateVersions[0] || availableVersions[0],
    reason: 'best-valid-version',
  };
}

function normalizeOverlayPath(pathInfo) {
  if (!pathInfo || typeof pathInfo.path !== 'string' || !pathInfo.path) {
    throw new Error('Overlay path entries require a path.');
  }

  return {
    path: pathInfo.path,
    sourcePath: typeof pathInfo.sourcePath === 'string' && pathInfo.sourcePath ? pathInfo.sourcePath : pathInfo.path,
    bounds: normalizeBounds(pathInfo.bounds),
    availableVersions: [...new Set((pathInfo.availableVersions || []).filter(Number.isFinite))].sort((left, right) => right - left),
    candidateVersions: [...new Set((pathInfo.candidateVersions || []).filter(Number.isFinite))],
    selectedVersion: Number.isFinite(pathInfo.selectedVersion) ? pathInfo.selectedVersion : null,
    reason: typeof pathInfo.reason === 'string' && pathInfo.reason ? pathInfo.reason : null,
  };
}

function normalizeOverlayPaths(pathInfos = []) {
  if (!Array.isArray(pathInfos) || pathInfos.length === 0) {
    return null;
  }

  return pathInfos.map(normalizeOverlayPath);
}

async function checkEntryRenderable(entry, catalog, options = {}) {
  const validatePathLimit = options.validatePathLimit || ENTRY_RENDERABILITY_MAX_PATHS;
  const resolveTileImageImpl = options.resolveTileImageImpl || resolveTileImage;
  const matchingPaths = (catalog.paths || []).filter(pathInfo =>
    (pathInfo.entries || []).some(candidate =>
      candidate.date === entry.date &&
      candidate.fToken === entry.fToken &&
      candidate.iCode === entry.iCode
    )
  );

  if (matchingPaths.length === 0) {
    return {
      renderable: false,
      checkedPaths: 0,
      reason: 'no-visible-paths',
    };
  }

  if (matchingPaths.length > validatePathLimit) {
    return {
      renderable: true,
      checkedPaths: 0,
      reason: 'skipped-high-coverage',
    };
  }

  for (const pathInfo of matchingPaths) {
    const resolvedTile = await resolveTileImageImpl({
      requestedPath: pathInfo.path,
      fToken: entry.fToken,
      candidateVersions: [entry.iCode],
      allowAncestorDerived: true,
      minimumResolvedPathLength: (pathInfo.sourcePath || pathInfo.path).length,
    });

    if (resolvedTile) {
      return {
        renderable: true,
        checkedPaths: matchingPaths.length,
        reason: 'validated-tile',
      };
    }
  }

  return {
    renderable: false,
    checkedPaths: matchingPaths.length,
    reason: 'validated-missing',
  };
}

async function filterRenderableEntriesFromCatalog(catalog, options = {}) {
  const entries = catalog.entries || [];

  if (!entries.length) {
    catalog.verification = {
      ...(catalog.verification || {}),
      filteredNonRenderableCount: 0,
    };
    return catalog;
  }

  const validations = await mapWithConcurrency(
    entries,
    options.concurrency || ENTRY_RENDERABILITY_CONCURRENCY,
    async entry => ({
      entry,
      validation: await checkEntryRenderable(entry, catalog, options),
    })
  );

  const filteredOut = validations
    .filter(result => result.validation.renderable === false)
    .map(result => result.entry.id);

  catalog.entries = validations.map(result => ({
    ...result.entry,
    renderability: result.validation,
  }));

  catalog.verification = {
    ...(catalog.verification || {}),
    filteredNonRenderableCount: filteredOut.length,
  };

  return catalog;
}

function getViewStatsRecord(viewToken, selection, fidelityMode) {
  if (!viewToken) {
    return null;
  }

  pruneViewStatsCache(viewStatsCache, VIEW_STATS_TTL_MS);

  if (!viewStatsCache.has(viewToken)) {
    viewStatsCache.set(
      viewToken,
      createViewStatsRecord({
        viewToken,
        selection,
        fidelityMode,
        renderStrategy: 'xyz-tiles',
        versionMode: getVersionMode(selection),
      })
    );
  }

  return viewStatsCache.get(viewToken);
}

function recordTileProvenance(viewToken, selection, fidelityMode, tileResult) {
  const record = getViewStatsRecord(viewToken, selection, fidelityMode);

  if (!record) {
    return null;
  }

  upsertViewTileResult(record, tileResult);
  return summarizeViewStats(record);
}

function buildDownloadLogEntry(selection, cellPath, selectionDecision, attempt) {
  return {
    date: selection.date || null,
    path: cellPath,
    requestedPath: attempt.requestedPath || cellPath,
    resolvedPath: attempt.resolvedPath || null,
    iCode: Number.isFinite(attempt.iCode) ? attempt.iCode : null,
    fToken: attempt.fToken || selection.fToken || null,
    sourceUrl: attempt.sourceUrl || null,
    status: attempt.status || 'missing',
    cacheHit: Boolean(attempt.cacheHit),
    derivedCacheHit: Boolean(attempt.derivedCacheHit),
    croppedFromParent: Boolean(attempt.croppedFromParent),
    selectionReason: selectionDecision.reason,
    availableVersions: selectionDecision.availableVersions,
    message: attempt.message || null,
  };
}

function logOverlayDownloadEntries(selection, entries) {
  for (const entry of entries) {
    const cacheLabel = entry.derivedCacheHit
      ? 'derived-cache'
      : entry.cacheHit
        ? 'tile-cache'
        : 'network';
    const versionLabel = Number.isFinite(entry.iCode) ? `i.${entry.iCode}` : 'i.none';
    const resolvedLabel = entry.resolvedPath || 'none';
    const extra = entry.message ? ` | ${entry.message}` : '';
    console.log(
      `[historical-overlay] ${entry.status.toUpperCase()} date=${selection.date || 'unknown'} path=${entry.path} requested=${entry.requestedPath} resolved=${resolvedLabel} version=${versionLabel} via=${cacheLabel}${entry.croppedFromParent ? ' parent-derived' : ''}${extra}`
    );
  }
}

async function buildSelectionDiagnostics({ bounds, zoom, selection }) {
  const normalizedBounds = normalizeBounds(bounds);
  const renderZoom = normalizeCatalogZoom(zoom);
  const cells = buildPathCellsForBounds(normalizedBounds, renderZoom);
  const requestContext = historicalCatalog.createRequestContext();
  const paths = await mapWithConcurrency(cells, OVERLAY_FETCH_CONCURRENCY, async cell => {
    let selectionInfo;

    try {
      selectionInfo = await historicalCatalog.findSelectionEntries(cell.path, selection, requestContext);
    } catch (error) {
      return {
        path: cell.path,
        sourcePath: null,
        bounds: cell.bounds,
        availableVersions: [],
        candidateVersions: [],
        selectedVersion: null,
        reason: 'metadata-error',
        error: error.message,
      };
    }

    const decision = buildSelectionDecision(selectionInfo.matches, selection.preferredVersion);

    return {
      path: cell.path,
      sourcePath: selectionInfo.metadata.sourcePath,
      bounds: cell.bounds,
      availableVersions: decision.availableVersions,
      candidateVersions: decision.candidateVersions,
      selectedVersion: decision.selectedVersion,
      reason: decision.reason,
    };
  });
  const summary = {
    totalPaths: paths.length,
    matchedPaths: paths.filter(pathInfo => pathInfo.selectedVersion !== null).length,
    missingPaths: paths.filter(pathInfo => pathInfo.selectedVersion === null).length,
    preferredVersionPaths: paths.filter(pathInfo => pathInfo.reason === 'preferred-version').length,
    alternateVersionPaths: paths.filter(pathInfo => pathInfo.reason === 'alternate-version').length,
    bestValidVersionPaths: paths.filter(pathInfo => pathInfo.reason === 'best-valid-version').length,
    versionsUsed: [...new Set(paths.map(pathInfo => pathInfo.selectedVersion).filter(Number.isFinite))]
      .sort((left, right) => right - left),
  };

  return {
    bounds: normalizedBounds,
    zoom: renderZoom,
    selection: {
      date: selection.date || null,
      fToken: selection.fToken || null,
      preferredVersion: Number.isFinite(selection.preferredVersion) ? selection.preferredVersion : null,
    },
    summary,
    paths,
  };
}

async function buildOverlayPayload({ bounds, zoom, selection, fidelityMode, paths: rawPaths = null }) {
  const normalizedBounds = normalizeBounds(bounds);
  const renderZoom = normalizeCatalogZoom(zoom);
  const overlayPaths = normalizeOverlayPaths(rawPaths);
  const cells = overlayPaths || buildPathCellsForBounds(normalizedBounds, renderZoom);
  const downloadLog = [];
  const requestContext = overlayPaths ? null : historicalCatalog.createRequestContext();
  const tiles = await mapWithConcurrency(cells, OVERLAY_FETCH_CONCURRENCY, async cell => {
    let sourcePath = cell.sourcePath || cell.path;
    let decision;
    let candidateVersions;

    if (overlayPaths) {
      candidateVersions = cell.candidateVersions || [];
      decision = {
        availableVersions: cell.availableVersions || [],
        candidateVersions,
        selectedVersion: cell.selectedVersion ?? null,
        reason: cell.reason || (candidateVersions.length ? 'preferred-version' : 'preferred-version-unavailable'),
      };
    } else {
      let selectionInfo;

      try {
        selectionInfo = await historicalCatalog.findSelectionEntries(cell.path, selection, requestContext);
      } catch (error) {
        const metadataErrorDecision = {
          availableVersions: [],
          reason: 'metadata-error',
        };
        const metadataErrorLog = buildDownloadLogEntry(selection, cell.path, metadataErrorDecision, {
          requestedPath: cell.path,
          status: 'error',
          message: `Metadata fetch failed: ${error.message}`,
        });
        downloadLog.push(metadataErrorLog);
        logOverlayDownloadEntries(selection, [metadataErrorLog]);

        return {
          path: cell.path,
          bounds: cell.bounds,
          requestedPath: cell.path,
          status: 'error',
          selectionReason: 'metadata-error',
          availableVersions: [],
        };
      }

      sourcePath = selectionInfo.metadata.sourcePath || cell.path;
      decision = buildSelectionDecision(selectionInfo.matches, selection.preferredVersion);
      candidateVersions = decision.candidateVersions;
    }

    if (candidateVersions.length === 0) {
      const noMatchLog = buildDownloadLogEntry(selection, cell.path, decision, {
        requestedPath: cell.path,
        status: 'missing',
        message: 'No live metadata match for the selected date in this visible cell.',
      });
      downloadLog.push(noMatchLog);
      logOverlayDownloadEntries(selection, [noMatchLog]);
      return {
        path: cell.path,
        bounds: cell.bounds,
        requestedPath: cell.path,
        status: 'missing',
        selectionReason: decision.reason,
        availableVersions: decision.availableVersions,
      };
    }

    const attemptLog = [];
    const resolvedTile = await resolveTileImage({
      requestedPath: cell.path,
      fToken: selection.fToken,
      candidateVersions,
      allowAncestorDerived: fidelityMode !== 'native-only',
      minimumResolvedPathLength: sourcePath.length,
      attemptLog,
    });
    const loggedAttempts = attemptLog.map(attempt => buildDownloadLogEntry(selection, cell.path, decision, attempt));
    downloadLog.push(...loggedAttempts);
    logOverlayDownloadEntries(selection, loggedAttempts);

    if (!resolvedTile) {
      return {
        path: cell.path,
        bounds: cell.bounds,
        requestedPath: cell.path,
        status: 'missing',
      };
    }

    return {
      path: cell.path,
      bounds: cell.bounds,
      requestedPath: cell.path,
      resolvedPath: resolvedTile.resolvedPath,
      url: toTileCacheUrl(resolvedTile.cachePath),
      status: 'ok',
      sourceUrl: resolvedTile.sourceUrl,
      version: resolvedTile.iCode,
      croppedFromParent: resolvedTile.croppedFromParent,
      cacheHit: resolvedTile.cacheHit,
      derivedCacheHit: resolvedTile.derivedCacheHit,
      selectionReason: decision.reason,
      availableVersions: decision.availableVersions,
    };
  });

  return {
    bounds: normalizedBounds,
    fidelityMode,
    renderStrategy: 'bounds-overlay',
    tiles: tiles.filter(tile => tile.status === 'ok'),
    downloadLog,
    summary: summarizeTileResults(tiles, {
      fidelityMode,
      renderStrategy: 'bounds-overlay',
      selection: {
        date: selection.date || null,
        fToken: selection.fToken || null,
        preferredVersion: Number.isFinite(selection.preferredVersion) ? selection.preferredVersion : null,
      },
      versionMode: getVersionMode(selection),
    }),
    zoom: renderZoom,
  };
}

app.post('/api/catalog', async (req, res) => {
  try {
    const { bounds: rawBounds, zoom: rawZoom } = req.body || {};
    const bounds = normalizeBounds(rawBounds);
    const zoom = normalizeCatalogZoom(rawZoom);
    const catalog = await filterRenderableEntriesFromCatalog(
      await historicalCatalog.buildBoundsCatalog(bounds, zoom)
    );

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
    const catalog = await filterRenderableEntriesFromCatalog(
      await historicalCatalog.buildBoundsCatalog(bounds, zoom)
    );

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
    const catalog = await filterRenderableEntriesFromCatalog(
      await historicalCatalog.buildBoundsCatalog(bounds, zoom)
    );
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
    const fidelityMode = parseFidelityMode(req.query);
    const tileKey = `${req.params.z}/${req.params.x}/${req.params.y}`;

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
    const selectionInfo = await historicalCatalog.findSelectionEntries(
      requestedPath,
      selection,
      historicalCatalog.createRequestContext()
    );
    const decision = buildSelectionDecision(selectionInfo.matches, selection.preferredVersion);
    const candidateVersions = decision.candidateVersions;

    if (candidateVersions.length === 0) {
      recordTileProvenance(req.query.viewToken, selection, fidelityMode, {
        tileKey,
        status: 'missing',
        requestedPath,
        selectionReason: decision.reason,
        availableVersions: decision.availableVersions,
      });
      return res.status(404).json({
        error: 'The selected date is not available for the requested path.',
        requestedPath,
      });
    }

    const resolvedTile = await resolveTileImage({
      requestedPath,
      fToken: selection.fToken,
      candidateVersions,
      allowAncestorDerived: fidelityMode !== 'native-only',
      minimumResolvedPathLength: selectionInfo.metadata.sourcePath?.length || requestedPath.length,
    });

    if (!resolvedTile) {
      recordTileProvenance(req.query.viewToken, selection, fidelityMode, {
        tileKey,
        status: 'missing',
        requestedPath,
      });
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
    res.set('X-Historical-Fidelity-Mode', fidelityMode);
    res.set('X-Historical-Selection-Reason', decision.reason);
    res.set('X-Historical-Available-Versions', decision.availableVersions.join(','));
    recordTileProvenance(req.query.viewToken, selection, fidelityMode, {
      tileKey,
      status: 'ok',
      requestedPath,
      resolvedPath: resolvedTile.resolvedPath,
      version: resolvedTile.iCode,
      croppedFromParent: resolvedTile.croppedFromParent,
      selectionReason: decision.reason,
      availableVersions: decision.availableVersions,
    });
    return res.send(resolvedTile.buffer);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/selection-diagnostics', async (req, res) => {
  try {
    const { bounds, zoom } = req.body || {};
    const selection = buildSelectionFromQuery(req.body || {});

    if (!selection.date || !selection.fToken) {
      return res.status(400).json({ error: 'date and fToken are required.' });
    }

    if (!bounds) {
      return res.status(400).json({ error: 'bounds are required.' });
    }

    const diagnostics = await buildSelectionDiagnostics({
      bounds,
      zoom,
      selection,
    });

    return res.json(diagnostics);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/overlays', async (req, res) => {
  try {
    const { bounds, zoom } = req.body || {};
    const selection = buildSelectionFromQuery(req.body || {});
    const fidelityMode = parseFidelityMode(req.body || {});

    if (!selection.date || !selection.fToken) {
      return res.status(400).json({ error: 'date and fToken are required.' });
    }

    if (!bounds) {
      return res.status(400).json({ error: 'bounds are required.' });
    }

    const payload = await buildOverlayPayload({
      bounds,
      zoom,
      selection,
      fidelityMode,
      paths: req.body?.paths || null,
    });

    return res.json(payload);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get('/api/view-stats/:viewToken', (req, res) => {
  pruneViewStatsCache(viewStatsCache, VIEW_STATS_TTL_MS);
  const record = viewStatsCache.get(req.params.viewToken);

  if (!record) {
    return res.status(404).json({ error: 'Unknown or expired view token.' });
  }

  return res.json(summarizeViewStats(record));
});

app.post('/api/clear-caches', (req, res) => {
  historicalCatalog.clearCaches();
  tileSignatureCache.clear();
  viewStatsCache.clear();
  res.json({ ok: true });
});

let server = null;

function startServer(options = {}) {
  const port = Number.isFinite(options.port) ? options.port : PORT;
  const host = options.host || '127.0.0.1';
  const exitOnError = options.exitOnError !== false;
  server = app.listen(port, host, () => {
    const address = server.address();
    const resolvedPort = typeof address === 'object' && address ? address.port : port;
    console.log(`Historical Server running at http://${host}:${resolvedPort}`);
  });

  server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Error: Port ${port} is already in use.`);
    } else {
      console.error('Server error:', error);
    }
    if (exitOnError) {
      process.exit(1);
    }
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  buildSelectionDecision,
  buildSelectionDiagnostics,
  checkEntryRenderable,
  filterRenderableEntriesFromCatalog,
  historicalCatalog,
  buildOverlayPayload,
  normalizeCatalogZoom,
  getDerivedTileCachePath,
  getRawTileCachePath,
  resolveEntrySignature,
  resolveTileImage,
  startServer,
};
orts = {
  app,
  buildSelectionDecision,
  buildSelectionDiagnostics,
  checkEntryRenderable,
  filterRenderableEntriesFromCatalog,
  historicalCatalog,
  buildOverlayPayload,
  normalizeCatalogZoom,
  getDerivedTileCachePath,
  getRawTileCachePath,
  resolveEntrySignature,
  resolveTileImage,
  startServer,
};
ge,
  startServer,
};
