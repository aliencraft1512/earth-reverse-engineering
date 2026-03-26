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

  function reconcileSelection(selectedEntryId, entries) {
    if (!selectedEntryId) {
      return null;
    }

    return entries.some(entry => makeEntryId(entry) === selectedEntryId) ? selectedEntryId : null;
  }

  return {
    makeEntryId,
    reconcileSelection,
  };
});
