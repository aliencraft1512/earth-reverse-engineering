const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveTileImage } = require('../HistoricalServer');

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
