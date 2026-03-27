const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Jimp, JimpMime } = require('jimp');

const {
  buildSelectionDecision,
  filterRenderableEntriesFromCatalog,
  getDerivedTileCachePath,
  getRawTileCachePath,
  resolveTileImage,
} = require('../HistoricalServer');

test('buildSelectionDecision explains preferred, alternate, and missing version outcomes', () => {
  const preferred = buildSelectionDecision([
    { iCode: 364 },
    { iCode: 362 },
  ], 364);
  const alternate = buildSelectionDecision([
    { iCode: 362 },
  ], 364);
  const missing = buildSelectionDecision([], 364);

  assert.equal(preferred.reason, 'preferred-version');
  assert.equal(preferred.selectedVersion, 364);
  assert.deepEqual(preferred.availableVersions, [364, 362]);

  assert.equal(alternate.reason, 'alternate-version');
  assert.equal(alternate.selectedVersion, 362);
  assert.deepEqual(alternate.candidateVersions, [362]);

  assert.equal(missing.reason, 'preferred-version-unavailable');
  assert.equal(missing.selectedVersion, null);
  assert.deepEqual(missing.candidateVersions, [364]);
});

test('resolveTileImage in native-only mode does not fall back to ancestor paths', async () => {
  const attemptedPaths = [];
  const resolved = await resolveTileImage({
    requestedPath: '0200231121011100',
    fToken: 'fd2e2',
    candidateVersions: [364],
    allowAncestorDerived: false,
    fetchRawTile: async pathCode => {
      attemptedPaths.push(pathCode);
      throw new Error('Not found');
    },
  });

  assert.equal(resolved, null);
  assert.deepEqual(attemptedPaths, ['0200231121011100']);
});

test('resolveTileImage records download attempts for missing and parent-derived resolutions', async () => {
  const tileBuffer = await new Jimp({ width: 2, height: 2, color: 0xffffffff }).getBuffer(JimpMime.jpeg);
  const attemptLog = [];
  const resolved = await resolveTileImage({
    requestedPath: '0200231121011101',
    fToken: 'fd2e2',
    candidateVersions: [364, 362],
    allowAncestorDerived: true,
    minimumResolvedPathLength: '020023112101110'.length,
    attemptLog,
    fetchRawTile: async (pathCode, iCode) => {
      if (pathCode === '0200231121011101') {
        const error = new Error('Unexpected status 404');
        error.status = 404;
        throw error;
      }

      return {
        buffer: tileBuffer,
        cachePath: 'derived.jpg',
        sourceUrl: `https://cmpmap.com/flatfile?db=tm&f1-${pathCode}-i.${iCode}-fd2e2`,
        cacheHit: true,
      };
    },
  });

  assert.equal(resolved.resolvedPath, '020023112101110');
  assert.equal(resolved.croppedFromParent, true);
  assert.equal(attemptLog.length, 3);
  assert.deepEqual(attemptLog.map(entry => entry.status), ['missing', 'missing', 'ok']);
  assert.equal(attemptLog[2].resolvedPath, '020023112101110');
  assert.equal(attemptLog[2].croppedFromParent, true);
});

test('resolveTileImage does not walk above the metadata source path cap', async () => {
  const attemptedPaths = [];
  const resolved = await resolveTileImage({
    requestedPath: '0200231121011101',
    fToken: 'fd2e2',
    candidateVersions: [364],
    allowAncestorDerived: true,
    minimumResolvedPathLength: '020023112101110'.length,
    fetchRawTile: async pathCode => {
      attemptedPaths.push(pathCode);
      const error = new Error('Unexpected status 404');
      error.status = 404;
      throw error;
    },
  });

  assert.equal(resolved, null);
  assert.deepEqual(attemptedPaths, ['0200231121011101', '020023112101110']);
});

test('tile cache paths stay flat inside the single tile_cache directory', () => {
  const rawPath = getRawTileCachePath('0200231121011100', 364, 'fd2e2');
  const derivedPath = getDerivedTileCachePath('0200231121011101', '020023112101110', 362, 'fd2e2');

  assert.equal(path.basename(path.dirname(rawPath)), 'tile_cache');
  assert.equal(path.basename(path.dirname(derivedPath)), 'tile_cache');
  assert.match(path.basename(rawPath), /^raw__/);
  assert.match(path.basename(derivedPath), /^derived__/);
  assert.ok(!rawPath.includes(`${path.sep}raw${path.sep}`));
  assert.ok(!derivedPath.includes(`${path.sep}derived${path.sep}`));
});

test('filterRenderableEntriesFromCatalog removes metadata-only entries with no resolvable tiles', async () => {
  const catalog = {
    entries: [
      {
        id: '1974-10-24|13|f6d58',
        date: '1974-10-24',
        iCode: 13,
        fToken: 'f6d58',
        pathCount: 4,
        paths: ['0310323113232110'],
        sourcePaths: ['0310323113232110'],
      },
      {
        id: '2025-09-11|365|fd32b',
        date: '2025-09-11',
        iCode: 365,
        fToken: 'fd32b',
        pathCount: 20,
        paths: ['0310323113232101'],
        sourcePaths: ['0310323113232101'],
      },
    ],
    paths: [
      {
        path: '0310323113232110',
        sourcePath: '0310323113232110',
        bounds: { north: 1, south: 0, east: 1, west: 0 },
        entries: [
          { date: '1974-10-24', iCode: 13, fToken: 'f6d58' },
        ],
      },
      {
        path: '0310323113232101',
        sourcePath: '0310323113232101',
        bounds: { north: 1, south: 0, east: 1, west: 0 },
        entries: [
          { date: '2025-09-11', iCode: 365, fToken: 'fd32b' },
        ],
      },
    ],
    verification: {},
  };

  const filtered = await filterRenderableEntriesFromCatalog(catalog, {
    validatePathLimit: 6,
    resolveTileImageImpl: async ({ requestedPath }) => {
      if (requestedPath === '0310323113232110') {
        return null;
      }

      return { resolvedPath: requestedPath, iCode: 365, croppedFromParent: false };
    },
  });

  assert.deepEqual(filtered.entries.map(entry => entry.id), ['2025-09-11|365|fd32b']);
  assert.equal(filtered.verification.filteredNonRenderableCount, 1);
});
