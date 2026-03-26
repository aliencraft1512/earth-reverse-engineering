const test = require('node:test');
const assert = require('node:assert/strict');

const {
  HistoricalCatalog,
  buildVersionCandidates,
  buildViewportSummary,
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

test('buildBoundsCatalog reuses cache when slightly different bounds cover the same path set', async () => {
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

  assert.equal(catalog.buildCount, 1);
  assert.equal(first.pathCount, second.pathCount);
  assert.deepEqual(second.bounds, secondBounds);
  assert.equal(second.timing.cacheStatus, 'bounds');
});

test('fetchPacketForPath caches identical source-path lookups', async () => {
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

  assert.equal(catalog.packetFetchCount, 1);
  assert.equal(first.url, second.url);
});
