const DEFAULT_VIEW_STATS_TTL_MS = 5 * 60 * 1000;

function summarizeTileResults(tiles, meta = {}) {
  const exactCount = tiles.filter(tile => tile.status === 'ok' && !tile.croppedFromParent).length;
  const ancestorDerivedCount = tiles.filter(tile => tile.status === 'ok' && tile.croppedFromParent).length;
  const missingCount = tiles.filter(tile => tile.status !== 'ok').length;
  const versionsUsed = [...new Set(tiles.map(tile => tile.version).filter(Number.isFinite))].sort((left, right) => right - left);
  const preferredVersionCount = tiles.filter(tile => tile.selectionReason === 'preferred-version').length;
  const alternateVersionCount = tiles.filter(tile => tile.selectionReason === 'alternate-version').length;
  const bestValidVersionCount = tiles.filter(tile => tile.selectionReason === 'best-valid-version').length;

  return {
    fidelityMode: meta.fidelityMode,
    renderStrategy: meta.renderStrategy || 'xyz-tiles',
    versionMode: meta.versionMode,
    selection: meta.selection,
    totalTiles: tiles.length,
    exactCount,
    ancestorDerivedCount,
    missingCount,
    mixedVersion: versionsUsed.length > 1,
    preferredVersionCount,
    alternateVersionCount,
    bestValidVersionCount,
    versionsUsed,
    updatedAt: meta.updatedAt || Date.now(),
  };
}

function createViewStatsRecord({ viewToken, selection, fidelityMode, renderStrategy, versionMode }) {
  return {
    viewToken,
    selection: {
      date: selection.date || null,
      fToken: selection.fToken || null,
      preferredVersion: Number.isFinite(selection.preferredVersion) ? selection.preferredVersion : null,
    },
    fidelityMode,
    renderStrategy: renderStrategy || 'xyz-tiles',
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
  return {
    ...summarizeTileResults([...record.tiles.values()], {
      fidelityMode: record.fidelityMode,
      renderStrategy: record.renderStrategy,
      versionMode: record.versionMode,
      selection: record.selection,
      updatedAt: record.updatedAt,
    }),
    viewToken: record.viewToken,
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
  summarizeTileResults,
  summarizeViewStats,
  upsertViewTileResult,
};
