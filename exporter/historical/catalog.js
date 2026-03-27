const crypto = require('crypto');
const { performance } = require('perf_hooks');

const { makeEntryId } = require('./dateCodec');
const { fetchMetadataPacket } = require('./metadata');
const { buildPathCellsForBounds, normalizeBounds } = require('./pathUtils');

const DEFAULT_ROOT_VERSION = 366;
const DEFAULT_MIN_METADATA_PATH_LENGTH = 6;
const DEFAULT_METADATA_CONCURRENCY = 6;
const DEFAULT_DUPLICATE_SIGNATURE_CONCURRENCY = 3;

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

function buildDuplicateCoverageGroups(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = getDuplicateCoverageKey(entry);

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(entry);
  }

  return groups;
}

function getDuplicateCoverageKey(entry) {
  return JSON.stringify({
    date: entry.date,
    fToken: entry.fToken,
    paths: getUniqueSortedValues(entry.paths),
    sourcePaths: getUniqueSortedValues(entry.sourcePaths),
  });
}

function getDuplicateSignatureGroupKey(group) {
  if (!group.length) {
    return '[]';
  }

  return JSON.stringify({
    coverage: getDuplicateCoverageKey(group[0]),
    versions: group.map(entry => entry.iCode).sort((left, right) => right - left),
  });
}

function countDuplicateModes(entries) {
  const duplicateModes = {};

  for (const entry of entries) {
    const mode = entry.duplicateCandidate?.mode;

    if (!mode) {
      continue;
    }

    duplicateModes[mode] = (duplicateModes[mode] || 0) + 1;
  }

  return duplicateModes;
}

function updateDuplicateVerification(summary) {
  summary.verification.duplicateCandidateCount = summary.entries.filter(entry => entry.duplicateCandidate).length;
  summary.verification.duplicateModes = countDuplicateModes(summary.entries);
  return summary;
}

function annotateDuplicateEntries(entries) {
  const groups = buildDuplicateCoverageGroups(entries);

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

function applyDuplicateSignatureResult(group, duplicateResult) {
  for (const entry of group) {
    const candidate = duplicateResult.get(entry.id);

    if (candidate) {
      entry.duplicateCandidate = { ...candidate };
      continue;
    }

    delete entry.duplicateCandidate;
  }
}

async function refineDuplicateEntriesWithSignatures(
  entries,
  resolveEntrySignature,
  options = {}
) {
  if (typeof resolveEntrySignature !== 'function') {
    return entries;
  }

  const groups = [...buildDuplicateCoverageGroups(entries).values()].filter(group => group.length > 1);
  const concurrency = options.signatureConcurrency || DEFAULT_DUPLICATE_SIGNATURE_CONCURRENCY;

  await mapWithConcurrency(groups, concurrency, async group => {
    const signatureResults = await Promise.all(
      group.map(async entry => {
        try {
          const signature = await resolveEntrySignature(entry, group);
          return { entry, signature };
        } catch (error) {
          return { entry, signature: null };
        }
      })
    );

    const resolved = signatureResults.filter(result => result.signature?.signature);

    if (resolved.length === 0) {
      return;
    }

    const signatureGroups = new Map();

    for (const result of resolved) {
      const key = result.signature.signature;

      if (!signatureGroups.has(key)) {
        signatureGroups.set(key, []);
      }

      signatureGroups.get(key).push(result);
    }

    if (resolved.length === group.length) {
      for (const entry of group) {
        delete entry.duplicateCandidate;
      }
    }

    for (const [signatureKey, signatureGroup] of signatureGroups.entries()) {
      if (signatureGroup.length < 2) {
        continue;
      }

      const versions = signatureGroup
        .map(result => result.entry.iCode)
        .sort((left, right) => right - left);

      for (const result of signatureGroup) {
        result.entry.duplicateCandidate = {
          mode: result.signature.mode || 'visible-tile-signature',
          versions,
          otherVersions: versions.filter(version => version !== result.entry.iCode),
          representativePath: result.signature.representativePath,
          signature: signatureKey,
        };
      }
    }
  });

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
      duplicateModes: countDuplicateModes(entries),
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

function shouldContinueToParent(error) {
  return error?.status === 404;
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
    this.resolveEntrySignature = options.resolveEntrySignature || null;
    this.signatureConcurrency = options.signatureConcurrency || DEFAULT_DUPLICATE_SIGNATURE_CONCURRENCY;
    this.duplicateSignatureResults = new Map();
    this.signatureResolutionJobs = new Map();
  }

  createRequestContext() {
    return {
      metadataByPath: new Map(),
      packetsByPath: new Map(),
    };
  }

  getBoundsCacheKey(bounds, zoom, cells = null) {
    if (cells) {
      return buildCellSetCacheKey(cells, zoom);
    }

    return `${zoom}:${hashObject(bounds)}`;
  }

  async fetchMetadataForPath(pathCode, requestContext = null) {
    if (!requestContext) {
      return this.fetchMetadataForPathUncached(pathCode);
    }

    if (requestContext.metadataByPath.has(pathCode)) {
      return requestContext.metadataByPath.get(pathCode);
    }

    const request = this.fetchMetadataForPathUncached(pathCode, requestContext).catch(error => {
      requestContext.metadataByPath.delete(pathCode);
      throw error;
    });
    requestContext.metadataByPath.set(pathCode, request);
    return request;
  }

  async fetchPacketForPath(pathCode, requestContext = null) {
    if (!requestContext) {
      return this.fetchPacketForPathUncached(pathCode);
    }

    if (requestContext.packetsByPath.has(pathCode)) {
      return requestContext.packetsByPath.get(pathCode);
    }

    const request = this.fetchPacketForPathUncached(pathCode).catch(error => {
      requestContext.packetsByPath.delete(pathCode);
      throw error;
    });

    requestContext.packetsByPath.set(pathCode, request);
    return request;
  }

  async fetchPacketForPathUncached(pathCode) {
    return this.requestPacketFromUpstream(pathCode);
  }

  async requestPacketFromUpstream(pathCode) {
    return fetchMetadataPacket({
      baseUrl: this.baseUrl,
      pathCode,
      rootVersion: this.rootVersion,
      requestHeaders: this.requestHeaders,
      timeoutMs: this.timeoutMs,
      secretKey: this.secretKey,
    });
  }

  async fetchMetadataForPathUncached(pathCode, requestContext = null) {
    let lastError = null;

    for (let length = pathCode.length; length >= this.minMetadataPathLength; length -= 1) {
      const sourcePath = pathCode.slice(0, length);

      try {
        const packet = await this.fetchPacketForPath(sourcePath, requestContext);

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
        if (shouldContinueToParent(error)) {
          continue;
        }

        lastError = error;
        break;
      }
    }

    if (lastError) {
      throw lastError;
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
    const startedAt = performance.now();
    const catalog = await this.buildBoundsCatalogUncached(bounds, zoom, cells);
    return hydrateCatalogForBounds(catalog, bounds, performance.now() - startedAt, 'live');
  }

  async buildBoundsCatalogUncached(bounds, zoom, cells = buildPathCellsForBounds(bounds, zoom)) {
    const requestContext = this.createRequestContext();
    const cellsWithMetadata = await mapWithConcurrency(
      cells,
      this.metadataConcurrency,
      async cell => {
        let metadata;

        try {
          metadata = await this.fetchMetadataForPath(cell.path, requestContext);
        } catch (error) {
          metadata = {
            requestedPath: cell.path,
            sourcePath: null,
            url: null,
            entries: [],
            parser: {
              mode: 'error',
              acceptedCount: 0,
              message: error.message,
            },
          };
        }

        return {
          ...cell,
          metadata,
        };
      }
    );

    const summary = buildViewportSummary({
      bounds,
      zoom,
      cells: cellsWithMetadata,
    });
    this.applyResolvedDuplicateSignatures(summary);
    this.queueDuplicateSignatureRefinement(summary);

    return updateDuplicateVerification(summary);
  }

  async findSelectionEntries(pathCode, selection, requestContext = null) {
    const metadata = await this.fetchMetadataForPath(pathCode, requestContext);
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
    this.duplicateSignatureResults.clear();
    this.signatureResolutionJobs.clear();
  }

  applyResolvedDuplicateSignatures(summary) {
    const groups = [...buildDuplicateCoverageGroups(summary.entries).values()].filter(group => group.length > 1);

    for (const group of groups) {
      const groupKey = getDuplicateSignatureGroupKey(group);
      const duplicateResult = this.duplicateSignatureResults.get(groupKey);

      if (!duplicateResult) {
        continue;
      }

      applyDuplicateSignatureResult(group, duplicateResult);
    }

    return updateDuplicateVerification(summary);
  }

  queueDuplicateSignatureRefinement(summary) {
    if (typeof this.resolveEntrySignature !== 'function') {
      return;
    }

    const groups = [...buildDuplicateCoverageGroups(summary.entries).values()].filter(group => group.length > 1);

    for (const group of groups) {
      const groupKey = getDuplicateSignatureGroupKey(group);

      if (this.duplicateSignatureResults.has(groupKey) || this.signatureResolutionJobs.has(groupKey)) {
        continue;
      }

      const groupCopies = group.map(entry => ({
        ...entry,
        paths: [...entry.paths],
        sourcePaths: [...entry.sourcePaths],
      }));
      const job = refineDuplicateEntriesWithSignatures(groupCopies, this.resolveEntrySignature, {
        signatureConcurrency: this.signatureConcurrency,
      })
        .then(refinedGroup => {
          const duplicateResult = new Map(
            refinedGroup.map(entry => [entry.id, entry.duplicateCandidate ? { ...entry.duplicateCandidate } : null])
          );
          this.duplicateSignatureResults.set(groupKey, duplicateResult);
          applyDuplicateSignatureResult(group, duplicateResult);
          updateDuplicateVerification(summary);
        })
        .finally(() => {
          this.signatureResolutionJobs.delete(groupKey);
        });

      this.signatureResolutionJobs.set(groupKey, job);
    }
  }
}

module.exports = {
  DEFAULT_METADATA_CONCURRENCY,
  DEFAULT_DUPLICATE_SIGNATURE_CONCURRENCY,
  DEFAULT_MIN_METADATA_PATH_LENGTH,
  DEFAULT_ROOT_VERSION,
  HistoricalCatalog,
  buildVersionCandidates,
  buildViewportSummary,
  buildCellSetCacheKey,
  getDuplicateCoverageKey,
  getDuplicateSignatureGroupKey,
  buildDuplicateCoverageGroups,
  countDuplicateModes,
  hydrateCatalogForBounds,
  mapWithConcurrency,
  annotateDuplicateEntries,
  refineDuplicateEntriesWithSignatures,
  shouldContinueToParent,
  summarizeEntries,
  updateDuplicateVerification,
};
