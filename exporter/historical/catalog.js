const crypto = require('crypto');

const { makeEntryId } = require('./dateCodec');
const { fetchMetadataPacket } = require('./metadata');
const { buildPathCellsForBounds, normalizeBounds } = require('./pathUtils');

const DEFAULT_ROOT_VERSION = 366;
const DEFAULT_MIN_METADATA_PATH_LENGTH = 6;

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

function buildViewportSummary({ bounds, zoom, cells }) {
  const entriesById = new Map();
  let resolvedPathCount = 0;
  let ancestorFallbackCount = 0;

  for (const cell of cells) {
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

  const entries = [...entriesById.values()].sort((left, right) => {
    const byDate = right.date.localeCompare(left.date);
    if (byDate !== 0) {
      return byDate;
    }

    return right.iCode - left.iCode;
  });

  return {
    bounds,
    zoom,
    pathCount: cells.length,
    resolvedPathCount,
    entries,
    paths: cells.map(cell => ({
      path: cell.path,
      sourcePath: cell.metadata.sourcePath,
      bounds: cell.bounds,
      entryCount: cell.metadata.entries.length,
      entries: cell.metadata.entries,
    })),
    verification: {
      requestedPathCount: cells.length,
      resolvedPathCount,
      ancestorFallbackCount,
      unresolvedPathCount: cells.length - resolvedPathCount,
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
    this.metadataCache = new Map();
    this.boundsCatalogCache = new Map();
  }

  getBoundsCacheKey(bounds, zoom) {
    return `${zoom}:${hashObject(bounds)}`;
  }

  async fetchMetadataForPath(pathCode) {
    if (this.metadataCache.has(pathCode)) {
      return this.metadataCache.get(pathCode);
    }

    const request = this.fetchMetadataForPathUncached(pathCode);
    this.metadataCache.set(pathCode, request);
    return request;
  }

  async fetchMetadataForPathUncached(pathCode) {
    for (let length = pathCode.length; length >= this.minMetadataPathLength; length -= 1) {
      const sourcePath = pathCode.slice(0, length);

      try {
        const packet = await fetchMetadataPacket({
          baseUrl: this.baseUrl,
          pathCode: sourcePath,
          rootVersion: this.rootVersion,
          requestHeaders: this.requestHeaders,
          timeoutMs: this.timeoutMs,
          secretKey: this.secretKey,
        });

        if (packet.entries.length > 0) {
          return {
            requestedPath: pathCode,
            sourcePath,
            url: packet.url,
            entries: packet.entries,
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
    };
  }

  async buildBoundsCatalog(rawBounds, zoom) {
    const bounds = normalizeBounds(rawBounds);
    const cacheKey = this.getBoundsCacheKey(bounds, zoom);

    if (this.boundsCatalogCache.has(cacheKey)) {
      return this.boundsCatalogCache.get(cacheKey);
    }

    const request = this.buildBoundsCatalogUncached(bounds, zoom);
    this.boundsCatalogCache.set(cacheKey, request);
    return request;
  }

  async buildBoundsCatalogUncached(bounds, zoom) {
    const cells = buildPathCellsForBounds(bounds, zoom);
    const cellsWithMetadata = [];

    for (const cell of cells) {
      const metadata = await this.fetchMetadataForPath(cell.path);
      cellsWithMetadata.push({
        ...cell,
        metadata,
      });
    }

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
}

module.exports = {
  DEFAULT_MIN_METADATA_PATH_LENGTH,
  DEFAULT_ROOT_VERSION,
  HistoricalCatalog,
  buildVersionCandidates,
  buildViewportSummary,
  summarizeEntries,
};
