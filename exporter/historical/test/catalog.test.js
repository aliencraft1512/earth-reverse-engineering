const test = require('node:test');
const assert = require('node:assert/strict');

const { buildVersionCandidates, buildViewportSummary } = require('../catalog');

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
