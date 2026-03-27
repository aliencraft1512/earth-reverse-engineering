(function initSelectionModule(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.HistoricalSelection = factory();
})(typeof self !== 'undefined' ? self : globalThis, function buildSelectionApi() {
  function makeEntryId(entry) {
    return `${entry.date}|${entry.iCode}|${entry.fToken}`;
  }

  function reconcileSelection(selectedEntryId, entries, options = {}) {
    if (!selectedEntryId) {
      return null;
    }

    if (entries.some(entry => makeEntryId(entry) === selectedEntryId)) {
      return selectedEntryId;
    }

    if (options.preferExactVersion !== false) {
      return null;
    }

    const [date, , fToken] = selectedEntryId.split('|');
    const compatibleEntries = entries
      .filter(entry => entry.date === date && entry.fToken === fToken)
      .sort((left, right) => {
        const leftPathCount = Number.isFinite(left.pathCount) ? left.pathCount : 0;
        const rightPathCount = Number.isFinite(right.pathCount) ? right.pathCount : 0;

        if (leftPathCount !== rightPathCount) {
          return rightPathCount - leftPathCount;
        }

        return right.iCode - left.iCode;
      });

    return compatibleEntries.length ? makeEntryId(compatibleEntries[0]) : null;
  }

  return {
    makeEntryId,
    reconcileSelection,
  };
});
