const test = require('node:test');
const assert = require('node:assert/strict');

const {
  HistoricalCatalog,
  buildVersionCandidates,
  buildViewportSummary,
  refineDuplicateEntriesWithSignatures,
  updateDuplicateVerification,
} = require('../catalog');

test('buildVersionCandidates prefers the selected version for a path', () => {
  const entries = [{ iCode: 312 }, { iCode: 316 }, { iCode: 320 }];
  assert.deepEqual(buildVersionCandidates(entries, 316), [316, 320, 312]);
});

test('buildViewportSummary remains path-aware across the current bounds', () => {
  const summary = buildViewportSummary({
    bounds: { north: 1, south: 0, east: 1, west: 0 },
    zoom: 17,
    cells: [
      {
        path: '0200231',
        bounds: { north: 1, south: 0.5, east: 0.5, west: 0 },
        metadata: {
          sourcePath: '0200231',
          entries: [
            { date: '2022-06-11', iCode: 346, fToken: 'fcccb' },
            { date: '2022-01-09', iCode: 299, fToken: 'fcd21' },
          ],
        },
      },
      {
        path: '0200232',
        bounds: { north: 1, south: 0.5, east: 1, west: 0.5 },
        metadata: {
          sourcePath: '020023',
          entries: [
            { date: '2022-06-11', iCode: 347, fToken: 'fcccb' },
          ],
        },
      },
    ],
  });

  assert.equal(summary.pathCount, 2);
  assert.equal(summary.verification.ancestorFallbackCount, 1);
  assert.equal(summary.entries.length, 3);

  const exactEntry = summary.entries.find(entry => entry.id === '2022-06-11|346|fcccb');
  assert.equal(exactEntry.pathCount, 1);
  assert.deepEqual(exactEntry.paths, ['0200231']);
});

test('buildViewportSummary annotates coverage-equivalent duplicate versions conservatively', () => {
  const summary = buildViewportSummary({
    bounds: { north: 1, south: 0, east: 1, west: 0 },
    zoom: 15,
    cells: [
      {
        path: '0200231',
        bounds: { north: 1, south: 0.5, east: 0.5, west: 0 },
        metadata: {
          sourcePath: '0200231',
          entries: [
            { date: '2024-04-06', iCode: 344, fToken: 'fd086' },
            { date: '2024-04-06', iCode: 346, fToken: 'fd086' },
          ],
        },
      },
      {
        path: '0200232',
        bounds: { north: 1, south: 0.5, east: 1, west: 0.5 },
        metadata: {
          sourcePath: '0200232',
          entries: [
            { date: '2024-04-06', iCode: 344, fToken: 'fd086' },
            { date: '2024-04-06', iCode: 346, fToken: 'fd086' },
          ],
        },
      },
    ],
  });

  const first = summary.entries.find(entry => entry.id === '2024-04-06|344|fd086');
  const second = summary.entries.find(entry => entry.id === '2024-04-06|346|fd086');

  assert.deepEqual(first.duplicateCandidate.versions, [346, 344]);
  assert.deepEqual(second.duplicateCandidate.otherVersions, [344]);
  assert.equal(summary.verification.duplicateCandidateCount, 2);
});

test('refineDuplicateEntriesWithSignatures upgrades duplicate annotations when visible-tile signatures match', async () => {
  const summary = buildViewportSummary({
    bounds: { north: 1, south: 0, east: 1, west: 0 },
    zoom: 15,
    cells: [
      { path: '0200231121011100', bounds: { north: 1, south: 0.5, east: 0.5, west: 0 } },
      { path: '0200231121011101', bounds: { north: 1, south: 0.5, east: 1, west: 0.5 } },
    ].map(cell => ({
      ...cell,
      metadata: {
        sourcePath: cell.path,
        entries: [
          { date: '2025-07-02', iCode: 364, fToken: 'fd2e2' },
          { date: '2025-07-02', iCode: 362, fToken: 'fd2e2' },
        ],
        parser: { mode: 'stub', acceptedCount: 2 },
      },
    })),
  });

  await refineDuplicateEntriesWithSignatures(summary.entries, async entry => ({
    signature: 'sig-a',
    representativePath: entry.paths[0],
  }));
  updateDuplicateVerification(summary);

  const duplicate = summary.entries.find(entry => entry.id === '2025-07-02|364|fd2e2');

  assert.equal(duplicate.duplicateCandidate.mode, 'visible-tile-signature');
  assert.equal(summary.verification.duplicateModes['visible-tile-signature'], 2);
});

test('refineDuplicateEntriesWithSignatures clears duplicate annotations when visible-tile signatures differ', async () => {
  const summary = buildViewportSummary({
    bounds: { north: 1, south: 0, east: 1, west: 0 },
    zoom: 15,
    cells: [
      { path: '0200231121011100', bounds: { north: 1, south: 0.5, east: 0.5, west: 0 } },
      { path: '0200231121011101', bounds: { north: 1, south: 0.5, east: 1, west: 0.5 } },
    ].map(cell => ({
      ...cell,
      metadata: {
        sourcePath: cell.path,
        entries: [
          { date: '2025-07-02', iCode: 364, fToken: 'fd2e2' },
          { date: '2025-07-02', iCode: 362, fToken: 'fd2e2' },
        ],
        parser: { mode: 'stub', acceptedCount: 2 },
      },
    })),
  });

  await refineDuplicateEntriesWithSignatures(summary.entries, async entry => ({
    signature: `sig-${entry.iCode}`,
    representativePath: entry.paths[0],
  }));
  updateDuplicateVerification(summary);

  assert.equal(summary.entries.some(entry => entry.duplicateCandidate), false);
  assert.equal(summary.verification.duplicateCandidateCount, 0);
});

test('buildBoundsCatalogUncached fetches visible-path metadata concurrently with a cap', async () => {
  const catalog = new HistoricalCatalog({
    baseUrl: 'https://example.com',
    metadataConcurrency: 3,
    requestHeaders: {},
    rootVersion: 366,
    secretKey: null,
  });
  let active = 0;
  let maxActive = 0;

  catalog.fetchMetadataForPath = async pathCode => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active -= 1;
    return {
      sourcePath: pathCode,
      entries: [{ date: '2024-01-01', iCode: 350, fToken: 'fd000' }],
      parser: { mode: 'stub', acceptedCount: 1 },
    };
  };

  const cells = ['a', 'b', 'c', 'd', 'e'].map((path, index) => ({
    path,
    bounds: { north: index + 1, south: index, east: index + 1, west: index },
  }));

  const summary = await catalog.buildBoundsCatalogUncached(
    { north: 1, south: 0, east: 1, west: 0 },
    12,
    cells
  );

  assert.equal(summary.pathCount, 5);
  assert.ok(maxActive > 1, 'expected metadata fetches to overlap');
  assert.ok(maxActive <= 3, 'expected metadata concurrency cap to be respected');
});

test('buildBoundsCatalog performs a live rebuild for repeated bounds requests', async () => {
  class StubCatalog extends HistoricalCatalog {
    constructor() {
      super({
        baseUrl: 'https://example.com',
        metadataConcurrency: 2,
        requestHeaders: {},
        rootVersion: 366,
        secretKey: null,
      });
      this.buildCount = 0;
    }

    async buildBoundsCatalogUncached(bounds, zoom, cells) {
      this.buildCount += 1;
      return {
        bounds,
        zoom,
        pathCount: cells.length,
        resolvedPathCount: cells.length,
        entries: [],
        paths: cells.map(cell => ({
          path: cell.path,
          bounds: cell.bounds,
          entryCount: 0,
          entries: [],
          parser: { mode: 'none', acceptedCount: 0 },
          sourcePath: null,
        })),
        verification: {
          requestedPathCount: cells.length,
          resolvedPathCount: cells.length,
          ancestorFallbackCount: 0,
          unresolvedPathCount: 0,
          parserModes: { none: cells.length },
        },
      };
    }
  }

  const catalog = new StubCatalog();
  const firstBounds = { north: 10.12, south: 10.08, east: 10.12, west: 10.08 };
  const secondBounds = { north: 10.13, south: 10.09, east: 10.13, west: 10.09 };

  const first = await catalog.buildBoundsCatalog(firstBounds, 10);
  const second = await catalog.buildBoundsCatalog(secondBounds, 10);

  assert.equal(catalog.buildCount, 2);
  assert.equal(first.pathCount, second.pathCount);
  assert.deepEqual(second.bounds, secondBounds);
  assert.equal(first.timing.cacheStatus, 'live');
  assert.equal(second.timing.cacheStatus, 'live');
});

test('fetchPacketForPath performs a fresh live request when no request context is supplied', async () => {
  class StubCatalog extends HistoricalCatalog {
    constructor() {
      super({
        baseUrl: 'https://example.com',
        requestHeaders: {},
        rootVersion: 366,
        secretKey: null,
      });
      this.packetFetchCount = 0;
    }

    async fetchPacketForPathUncached(pathCode) {
      this.packetFetchCount += 1;
      return {
        url: `https://example.com/${pathCode}`,
        entries: [{ date: '2024-01-01', iCode: 350, fToken: 'fd000' }],
        parser: { mode: 'stub', acceptedCount: 1 },
      };
    }
  }

  const catalog = new StubCatalog();
  const first = await catalog.fetchPacketForPath('0200231');
  const second = await catalog.fetchPacketForPath('0200231');

  assert.equal(catalog.packetFetchCount, 2);
  assert.equal(first.url, second.url);
});

test('fetchPacketForPath reuses a packet only within the current live request context', async () => {
  class StubCatalog extends HistoricalCatalog {
    constructor() {
      super({
        baseUrl: 'https://example.com',
        requestHeaders: {},
        rootVersion: 366,
        secretKey: null,
      });
      this.packetFetchCount = 0;
    }

    async fetchPacketForPathUncached(pathCode) {
      this.packetFetchCount += 1;
      return {
        url: `https://example.com/${pathCode}`,
        entries: [{ date: '2024-01-01', iCode: 350, fToken: 'fd000' }],
        parser: { mode: 'stub', acceptedCount: 1 },
      };
    }
  }

  const catalog = new StubCatalog();
  const requestContext = catalog.createRequestContext();
  const first = await catalog.fetchPacketForPath('0200231', requestContext);
  const second = await catalog.fetchPacketForPath('0200231', requestContext);

  assert.equal(catalog.packetFetchCount, 1);
  assert.equal(first.url, second.url);
});

test('fetchMetadataForPathUncached continues upward only when the live child packet is missing', async () => {
  class StubCatalog extends HistoricalCatalog {
    constructor() {
      super({
        baseUrl: 'https://example.com',
        requestHeaders: {},
        rootVersion: 366,
        secretKey: null,
      });
      this.packetAttempts = 0;
    }

    async fetchPacketForPathUncached(pathCode) {
      this.packetAttempts += 1;

      if (pathCode === '0200231121011102') {
        const error = new Error('missing');
        error.status = 404;
        throw error;
      }

      return {
        url: `https://example.com/${pathCode}`,
        entries: [{ date: '2025-07-02', iCode: 362, fToken: 'fd2e2' }],
        parser: { mode: 'framed', acceptedCount: 1 },
      };
    }
  }

  const catalog = new StubCatalog();
  const metadata = await catalog.fetchMetadataForPathUncached('0200231121011102');

  assert.equal(catalog.packetAttempts, 2);
  assert.equal(metadata.sourcePath, '020023112101110');
  assert.equal(metadata.parser.mode, 'framed');
  assert.deepEqual(metadata.entries, [
    { date: '2025-07-02', iCode: 362, fToken: 'fd2e2' },
  ]);
});

test('fetchMetadataForPathUncached surfaces live upstream errors instead of substituting cached metadata', async () => {
  class StubCatalog extends HistoricalCatalog {
    constructor() {
      super({
        baseUrl: 'https://example.com',
        requestHeaders: {},
        rootVersion: 366,
        secretKey: null,
      });
      this.packetAttempts = 0;
    }

    async fetchPacketForPathUncached() {
      this.packetAttempts += 1;
      const error = new Error('fetch failed');
      error.cause = { code: 'ECONNRESET' };
      throw error;
    }
  }

  const catalog = new StubCatalog();
  await assert.rejects(
    () => catalog.fetchMetadataForPathUncached('0200231121011102'),
    /fetch failed/
  );
  assert.equal(catalog.packetAttempts, 1);
});
