const DEFAULT_VIEW_STATS_TTL_MS = 5 * 60 * 1000;

function createViewStatsRecord({ viewToken, selection, fidelityMode, versionMode }) {
  return {
    viewToken,
    selection: {
      date: selection.date || null,
      fToken: selection.fToken || null,
      preferredVersion: Number.isFinite(selection.preferredVersion) ? selection.preferredVersion : null,
    },
    fidelityMode,
    versionMode,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tiles: new Map(),
  };
}

function upsertViewTileResult(record, tileResult) {
  const tileKey = tileResult.tileKey || tileResult.requestedPath || `${record.tiles.size}`;

  record.tiles.set(tileKey, {
    ...tileResult,
    updatedAt: Date.now(),
  });
  record.updatedAt = Date.now();
  return record;
}

function summarizeViewStats(record) {
  const tiles = [...record.tiles.values()];
  const exactCount = tiles.filter(tile => tile.status === 'ok' && !tile.croppedFromParent).length;
  const ancestorDerivedCount = tiles.filter(tile => tile.status === 'ok' && tile.croppedFromParent).length;
  const missingCount = tiles.filter(tile => tile.status !== 'ok').length;
  const versionsUsed = [...new Set(tiles.map(tile => tile.version).filter(Number.isFinite))].sort((left, right) => right - left);

  return {
    viewToken: record.viewToken,
    fidelityMode: record.fidelityMode,
    versionMode: record.versionMode,
    selection: record.selection,
    totalTiles: tiles.length,
    exactCount,
    ancestorDerivedCount,
    missingCount,
    mixedVersion: versionsUsed.length > 1,
    versionsUsed,
    updatedAt: record.updatedAt,
  };
}

function pruneViewStatsCache(cache, ttlMs = DEFAULT_VIEW_STATS_TTL_MS, now = Date.now()) {
  for (const [viewToken, record] of cache.entries()) {
    if (now - record.updatedAt > ttlMs) {
      cache.delete(viewToken);
    }
  }
}

module.exports = {
  DEFAULT_VIEW_STATS_TTL_MS,
  createViewStatsRecord,
  pruneViewStatsCache,
  summarizeViewStats,
  upsertViewTileResult,
};
