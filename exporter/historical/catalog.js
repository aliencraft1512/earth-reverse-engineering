const crypto = require('crypto');
const { performance } = require('perf_hooks');

const { makeEntryId } = require('./dateCodec');
const { fetchMetadataPacket } = require('./metadata');
const { buildPathCellsForBounds, normalizeBounds } = require('./pathUtils');

const DEFAULT_ROOT_VERSION = 366;
const DEFAULT_MIN_METADATA_PATH_LENGTH = 6;
const DEFAULT_METADATA_CONCURRENCY = 6;

function hashObject(value) {
  return crypto.createHash('md5').update(JSON.stringify(value)).digest('hex');
}

function summarizeEntries(entries) {
  const byId = new Map();

  for (const entry of entries) {
    const id = makeEntryId(entry);

    if (!byId.has(id)) {
      byId.set(id, {
        id,
        date: entry.date,
        iCode: entry.iCode,
        fToken: entry.fToken,
        pathCount: 0,
        paths: [],
        sourcePaths: [],
      });
    }
  }

  return byId;
}

function roundDuration(durationMs) {
  return Math.round(durationMs * 10) / 10;
}

function mapWithConcurrency(items, concurrency, worker) {
  if (!items.length) {
    return Promise.resolve([]);
  }

  const results = new Array(items.length);
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;

  async function consume() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  return Promise.all(Array.from({ length: limit }, () => consume())).then(() => results);
}

function buildCellSetCacheKey(cells, zoom) {
  return `${zoom}:${cells.map(cell => cell.path).join(',')}`;
}

function hydrateCatalogForBounds(catalog, bounds, durationMs, cacheStatus) {
  return {
    ...catalog,
    bounds,
    timing: {
      durationMs: roundDuration(durationMs),
      cacheStatus,
    },
  };
}

function getUniqueSortedValues(values) {
  return [...new Set(values)].sort();
}

function annotateDuplicateEntries(entries) {
  const groups = new Map();

  for (const entry of entries) {
    const key = JSON.stringify({
      date: entry.date,
      fToken: entry.fToken,
      paths: getUniqueSortedValues(entry.paths),
      sourcePaths: getUniqueSortedValues(entry.sourcePaths),
    });

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(entry);
  }

  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }

    const versions = group.map(entry => entry.iCode).sort((left, right) => right - left);

    for (const entry of group) {
      entry.duplicateCandidate = {
        mode: 'coverage-equivalent',
        versions,
        otherVersions: versions.filter(version => version !== entry.iCode),
      };
    }
  }

  return entries;
}

function buildViewportSummary({ bounds, zoom, cells }) {
  const entriesById = new Map();
  let resolvedPathCount = 0;
  let ancestorFallbackCount = 0;
  const parserModes = {};

  for (const cell of cells) {
    const parserMode = cell.metadata.parser?.mode || 'none';
    parserModes[parserMode] = (parserModes[parserMode] || 0) + 1;

    if (!cell.metadata.entries.length) {
      continue;
    }

    resolvedPathCount += 1;

    if (cell.metadata.sourcePath && cell.metadata.sourcePath !== cell.path) {
      ancestorFallbackCount += 1;
    }

    for (const entry of cell.metadata.entries) {
      const id = makeEntryId(entry);

      if (!entriesById.has(id)) {
        entriesById.set(id, {
          id,
          date: entry.date,
          iCode: entry.iCode,
          fToken: entry.fToken,
          pathCount: 0,
          paths: [],
          sourcePaths: [],
        });
      }

      const summary = entriesById.get(id);
      summary.pathCount += 1;
      summary.paths.push(cell.path);

      if (cell.metadata.sourcePath && !summary.sourcePaths.includes(cell.metadata.sourcePath)) {
        summary.sourcePaths.push(cell.metadata.sourcePath);
      }
    }
  }

  const entries = annotateDuplicateEntries([...entriesById.values()].sort((left, right) => {
    const byDate = right.date.localeCompare(left.date);
    if (byDate !== 0) {
      return byDate;
    }

    return right.iCode - left.iCode;
  }));

  return {
    bounds,
    zoom,
    pathCount: cells.length,
    resolvedPathCount,
    entries,
    paths: cells.map(cell => ({
      path: cell.path,
      sourcePath: cell.metadata.sourcePath,
      packetUrl: cell.metadata.url,
      bounds: cell.bounds,
      entryCount: cell.metadata.entries.length,
      parser: cell.metadata.parser,
      entries: cell.metadata.entries,
    })),
    verification: {
      requestedPathCount: cells.length,
      resolvedPathCount,
      ancestorFallbackCount,
      unresolvedPathCount: cells.length - resolvedPathCount,
      duplicateCandidateCount: entries.filter(entry => entry.duplicateCandidate).length,
      parserModes,
    },
  };
}

function buildVersionCandidates(entries, preferredVersion = null) {
  const versions = [...new Set(entries.map(entry => entry.iCode).filter(Number.isFinite))];

  if (!Number.isFinite(preferredVersion)) {
    return versions.sort((left, right) => right - left);
  }

  return versions.sort((left, right) => {
    if (left === preferredVersion) return -1;
    if (right === preferredVersion) return 1;

    const leftDistance = Math.abs(left - preferredVersion);
    const rightDistance = Math.abs(right - preferredVersion);

    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance;
    }

    return right - left;
  });
}

class HistoricalCatalog {
  constructor(options) {
    this.baseUrl = options.baseUrl;
    this.rootVersion = options.rootVersion || DEFAULT_ROOT_VERSION;
    this.requestHeaders = options.requestHeaders;
    this.secretKey = options.secretKey;
    this.timeoutMs = options.timeoutMs || 10000;
    this.minMetadataPathLength = options.minMetadataPathLength || DEFAULT_MIN_METADATA_PATH_LENGTH;
    this.metadataConcurrency = options.metadataConcurrency || DEFAULT_METADATA_CONCURRENCY;
    this.metadataCache = new Map();
    this.packetCache = new Map();
    this.boundsCatalogCache = new Map();
  }

  getBoundsCacheKey(bounds, zoom, cells = null) {
    if (cells) {
      return buildCellSetCacheKey(cells, zoom);
    }

    return `${zoom}:${hashObject(bounds)}`;
  }

  async fetchMetadataForPath(pathCode) {
    if (this.metadataCache.has(pathCode)) {
      return this.metadataCache.get(pathCode);
    }

    const request = this.fetchMetadataForPathUncached(pathCode).catch(error => {
      this.metadataCache.delete(pathCode);
      throw error;
    });
    this.metadataCache.set(pathCode, request);
    return request;
  }

  async fetchPacketForPath(pathCode) {
    if (this.packetCache.has(pathCode)) {
      return this.packetCache.get(pathCode);
    }

    const request = this.fetchPacketForPathUncached(pathCode).catch(error => {
      this.packetCache.delete(pathCode);
      throw error;
    });

    this.packetCache.set(pathCode, request);
    return request;
  }

  async fetchPacketForPathUncached(pathCode) {
    return fetchMetadataPacket({
      baseUrl: this.baseUrl,
      pathCode,
      rootVersion: this.rootVersion,
      requestHeaders: this.requestHeaders,
      timeoutMs: this.timeoutMs,
      secretKey: this.secretKey,
    });
  }

  async fetchMetadataForPathUncached(pathCode) {
    for (let length = pathCode.length; length >= this.minMetadataPathLength; length -= 1) {
      const sourcePath = pathCode.slice(0, length);

      try {
        const packet = await this.fetchPacketForPath(sourcePath);

        if (packet.entries.length > 0) {
          return {
            requestedPath: pathCode,
            sourcePath,
            url: packet.url,
            entries: packet.entries,
            parser: packet.parser,
          };
        }
      } catch (error) {
        // Continue upward through parent metadata paths.
      }
    }

    return {
      requestedPath: pathCode,
      sourcePath: null,
      entries: [],
      parser: {
        mode: 'none',
        acceptedCount: 0,
      },
    };
  }

  async buildBoundsCatalog(rawBounds, zoom) {
    const bounds = normalizeBounds(rawBounds);
    const cells = buildPathCellsForBounds(bounds, zoom);
    const cacheKey = this.getBoundsCacheKey(bounds, zoom, cells);
    const startedAt = performance.now();

    if (this.boundsCatalogCache.has(cacheKey)) {
      const cachedCatalog = await this.boundsCatalogCache.get(cacheKey);
      return hydrateCatalogForBounds(cachedCatalog, bounds, performance.now() - startedAt, 'bounds');
    }

    const request = this.buildBoundsCatalogUncached(bounds, zoom, cells).catch(error => {
      this.boundsCatalogCache.delete(cacheKey);
      throw error;
    });
    this.boundsCatalogCache.set(cacheKey, request);
    const catalog = await request;
    return hydrateCatalogForBounds(catalog, bounds, performance.now() - startedAt, 'miss');
  }

  async buildBoundsCatalogUncached(bounds, zoom, cells = buildPathCellsForBounds(bounds, zoom)) {
    const cellsWithMetadata = await mapWithConcurrency(
      cells,
      this.metadataConcurrency,
      async cell => {
        const metadata = await this.fetchMetadataForPath(cell.path);
        return {
        ...cell,
        metadata,
        };
      }
    );

    return buildViewportSummary({
      bounds,
      zoom,
      cells: cellsWithMetadata,
    });
  }

  async findSelectionEntries(pathCode, selection) {
    const metadata = await this.fetchMetadataForPath(pathCode);
    const matches = metadata.entries.filter(entry => {
      if (selection.date && entry.date !== selection.date) {
        return false;
      }

      if (selection.fToken && entry.fToken !== selection.fToken) {
        return false;
      }

      return true;
    });

    return {
      metadata,
      matches,
    };
  }

  clearCaches() {
    this.metadataCache.clear();
    this.packetCache.clear();
    this.boundsCatalogCache.clear();
  }
}

module.exports = {
  DEFAULT_METADATA_CONCURRENCY,
  DEFAULT_MIN_METADATA_PATH_LENGTH,
  DEFAULT_ROOT_VERSION,
  HistoricalCatalog,
  buildVersionCandidates,
  buildViewportSummary,
  buildCellSetCacheKey,
  hydrateCatalogForBounds,
  mapWithConcurrency,
  annotateDuplicateEntries,
  summarizeEntries,
};
