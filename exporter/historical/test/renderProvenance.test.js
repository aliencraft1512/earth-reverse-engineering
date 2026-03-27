const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createViewStatsRecord,
  summarizeViewStats,
  upsertViewTileResult,
} = require('../renderProvenance');

test('render provenance summarizes exact, ancestor-derived, missing, and mixed-version tiles', () => {
  const record = createViewStatsRecord({
    viewToken: 'view-1',
    selection: {
      date: '2025-07-02',
      fToken: 'fd2e2',
      preferredVersion: 364,
    },
    fidelityMode: 'allow-ancestor-derived',
    versionMode: 'exact-preferred',
  });

  upsertViewTileResult(record, {
    tileKey: '15/1/1',
    status: 'ok',
    requestedPath: '0200231121011100',
    resolvedPath: '0200231121011100',
    version: 364,
    croppedFromParent: false,
    selectionReason: 'preferred-version',
  });
  upsertViewTileResult(record, {
    tileKey: '15/1/2',
    status: 'ok',
    requestedPath: '0200231121011101',
    resolvedPath: '020023112101110',
    version: 362,
    croppedFromParent: true,
    selectionReason: 'alternate-version',
  });
  upsertViewTileResult(record, {
    tileKey: '15/1/3',
    status: 'missing',
    requestedPath: '0200231121011110',
    selectionReason: 'preferred-version-unavailable',
  });

  const summary = summarizeViewStats(record);

  assert.equal(summary.totalTiles, 3);
  assert.equal(summary.exactCount, 1);
  assert.equal(summary.ancestorDerivedCount, 1);
  assert.equal(summary.missingCount, 1);
  assert.equal(summary.mixedVersion, true);
  assert.equal(summary.preferredVersionCount, 1);
  assert.equal(summary.alternateVersionCount, 1);
  assert.equal(summary.bestValidVersionCount, 0);
  assert.deepEqual(summary.versionsUsed, [364, 362]);
});
