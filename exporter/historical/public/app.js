let map;
let historicalLayer = null;
let currentCatalog = null;
let selectedEntryId = null;
let requestNonce = 0;
let renderRequestNonce = 0;
let catalogAbortController = null;
let overlayAbortController = null;
let selectionDiagnosticsAbortController = null;
let currentSelectionDiagnostics = null;
let currentDownloadLog = [];

const DEFAULT_CENTER = [35.1723, 33.3667];
const DEFAULT_ZOOM = 15;
const FIXED_FIDELITY_MODE = 'allow-ancestor-derived';

const { makeEntryId, reconcileSelection } = window.HistoricalSelection;

initMap();

function initMap() {
  map = L.map('map').setView(DEFAULT_CENTER, DEFAULT_ZOOM);

  L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
    maxZoom: 20,
    attribution: '&copy; Google Maps',
  }).addTo(map);

  for (const elementId of ['sidebar', 'dateList', 'pathDebugList', 'downloadLogList']) {
    const element = document.getElementById(elementId);

    if (!element || !L.DomEvent) {
      continue;
    }

    L.DomEvent.disableClickPropagation(element);
    L.DomEvent.disableScrollPropagation(element);
  }

  map.on('moveend', updateCatalogForCurrentBounds);
  map.on('zoomstart', handleZoomStart);
  updateCatalogForCurrentBounds();
}

function getCatalogZoom() {
  return Math.min(18, Math.max(10, Math.round(map.getZoom())));
}

function getBoundsPayload() {
  const bounds = map.getBounds();

  return {
    north: bounds.getNorth(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    west: bounds.getWest(),
  };
}

function getSelectedEntry() {
  if (!currentCatalog || !selectedEntryId) {
    return null;
  }

  return currentCatalog.entries.find(entry => makeEntryId(entry) === selectedEntryId) || null;
}

function getPreferredVersion(selectedEntry = getSelectedEntry()) {
  if (!selectedEntry) {
    return null;
  }

  return selectedEntry.iCode;
}

function ensureEntriesVisible() {
  const entriesPanel = document.getElementById('entriesPanel');

  if (entriesPanel) {
    entriesPanel.open = true;
  }
}

window.__historicalDebug = {
  getCatalog: () => currentCatalog,
  getHistoricalLayer: () => historicalLayer,
  getMap: () => map,
  getRequestNonce: () => requestNonce,
  getSelectionDiagnostics: () => currentSelectionDiagnostics,
  getSelectedEntry: () => getSelectedEntry(),
  getDownloadLog: () => currentDownloadLog,
};

function setStatus(message, tone = 'neutral') {
  const status = document.getElementById('status');
  status.innerText = message;
  status.dataset.tone = tone;
}

function getCatalogErrorSummary(catalog) {
  const errorPaths = (catalog.paths || []).filter(pathInfo => pathInfo.parser?.mode === 'error');

  return {
    errorPathCount: errorPaths.length,
    sampleMessage: errorPaths[0]?.parser?.message || null,
  };
}

function renderVerification(catalog) {
  const summary = document.getElementById('verificationSummary');
  const bounds = catalog.bounds;
  const parserModes = Object.entries(catalog.verification.parserModes || {})
    .map(([mode, count]) => `${mode}:${count}`)
    .join(', ');
  const errorSummary = getCatalogErrorSummary(catalog);

  summary.innerHTML = '';

  const lines = [
    `Live metadata response ${catalog.timing?.durationMs ?? 'n/a'} ms`,
    `Visible paths ${catalog.verification.resolvedPathCount}/${catalog.verification.requestedPathCount}`,
    `Unique historical entries ${catalog.entries.length}`,
    `Parent metadata fallbacks ${catalog.verification.ancestorFallbackCount}`,
    `Parser modes ${parserModes || 'n/a'}`,
    `Metadata fetch errors ${errorSummary.errorPathCount}`,
    `Bounds ${bounds.south.toFixed(4)}, ${bounds.west.toFixed(4)} -> ${bounds.north.toFixed(4)}, ${bounds.east.toFixed(4)}`,
  ];

  if (errorSummary.sampleMessage) {
    lines.push(`Sample live error ${errorSummary.sampleMessage}`);
  }

  for (const line of lines) {
    const div = document.createElement('div');
    div.className = 'verification-line';
    div.innerText = line;
    summary.appendChild(div);
  }
}

function renderCoverageSummary(summary, message = null) {
  const container = document.getElementById('renderSummary');
  container.innerHTML = '';

  const lines = message
    ? [message]
    : [
        `Tiles loaded ${summary.totalTiles - summary.missingCount}/${summary.totalTiles} visible cells`,
        `Direct tiles ${summary.exactCount}  |  Parent-derived ${summary.ancestorDerivedCount}  |  Missing ${summary.missingCount}`,
        `Versions used ${summary.versionsUsed.length ? summary.versionsUsed.map(version => `i.${version}`).join(', ') : 'none'}`,
        `Selection handling preferred ${summary.preferredVersionCount || 0}  |  alternate ${summary.alternateVersionCount || 0}  |  best-valid ${summary.bestValidVersionCount || 0}`,
      ];

  for (const line of lines) {
    const div = document.createElement('div');
    div.className = 'verification-line';
    div.innerText = line;
    container.appendChild(div);
  }
}

function renderDownloadLog(logEntries = [], message = 'No tile download attempts yet.') {
  const container = document.getElementById('downloadLogList');
  container.innerHTML = '';

  if (!logEntries.length) {
    const empty = document.createElement('div');
    empty.className = 'download-log-empty';
    empty.innerText = message;
    container.appendChild(empty);
    return;
  }

  for (const entry of logEntries) {
    const item = document.createElement('div');
    item.className = 'download-log-entry';
    item.dataset.status = entry.status || 'missing';

    const title = document.createElement('div');
    title.className = 'download-log-title';
    const versionLabel = Number.isFinite(entry.iCode) ? `i.${entry.iCode}` : 'no version';
    const cacheLabel = entry.derivedCacheHit
      ? 'derived cache'
      : entry.cacheHit
        ? 'tile cache'
        : 'network';
    title.innerText = `${String(entry.status || 'missing').toUpperCase()}  |  ${entry.path}  |  ${versionLabel}  |  ${cacheLabel}`;
    item.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'download-log-meta';
    meta.innerText = `requested ${entry.requestedPath || entry.path}  ->  ${entry.resolvedPath || 'none'}${entry.croppedFromParent ? '  |  parent-derived crop' : ''}`;
    item.appendChild(meta);

    if (entry.sourceUrl) {
      const source = document.createElement('div');
      source.className = 'download-log-source';
      source.innerText = entry.sourceUrl;
      item.appendChild(source);
    }

    if (entry.message) {
      const detail = document.createElement('div');
      detail.className = 'download-log-detail';
      detail.innerText = entry.message;
      item.appendChild(detail);
    }

    container.appendChild(item);
  }
}

function renderPathDebug(catalog) {
  const container = document.getElementById('pathDebugList');
  container.innerHTML = '';
  const diagnosticsByPath = new Map((currentSelectionDiagnostics?.paths || []).map(pathInfo => [pathInfo.path, pathInfo]));

  if (!catalog.paths.length) {
    container.innerHTML = '<div class="path-debug-empty">No visible paths were cataloged for the current bounds.</div>';
    return;
  }

  for (const pathInfo of catalog.paths) {
    const card = document.createElement('details');
    card.className = 'path-debug-card';

    const summary = document.createElement('summary');
    summary.className = 'path-debug-summary';
    summary.innerText = `${pathInfo.path}  |  ${pathInfo.parser?.mode || 'none'}  |  ${pathInfo.entryCount} tuples`;
    card.appendChild(summary);

    const rows = [
      `Source path: ${pathInfo.sourcePath || 'none'}`,
      `Packet: ${pathInfo.packetUrl || 'unavailable'}`,
      `Bounds: ${pathInfo.bounds.south.toFixed(4)}, ${pathInfo.bounds.west.toFixed(4)} -> ${pathInfo.bounds.north.toFixed(4)}, ${pathInfo.bounds.east.toFixed(4)}`,
      `Parser accepted: ${pathInfo.parser?.acceptedCount ?? 0}`,
    ];
    const diagnostics = diagnosticsByPath.get(pathInfo.path);

    if (diagnostics) {
      rows.push(`Selection: ${diagnostics.reason}`);
      rows.push(`Chosen version: ${diagnostics.selectedVersion ? `i.${diagnostics.selectedVersion}` : 'none'}`);
      rows.push(`Available versions: ${diagnostics.availableVersions.length ? diagnostics.availableVersions.map(version => `i.${version}`).join(', ') : 'none'}`);
    }

    for (const row of rows) {
      const div = document.createElement('div');
      div.className = 'path-debug-line';
      div.innerText = row;
      card.appendChild(div);
    }

    const tupleHeader = document.createElement('div');
    tupleHeader.className = 'path-debug-tuples-label';
    tupleHeader.innerText = 'Accepted tuples';
    card.appendChild(tupleHeader);

    const tupleList = document.createElement('div');
    tupleList.className = 'path-debug-tuples';
    const sampleEntries = pathInfo.entries.slice(0, 8);

    for (const entry of sampleEntries) {
      const tuple = document.createElement('div');
      tuple.className = 'path-debug-tuple';
      tuple.innerText = `${entry.date}  |  i.${entry.iCode}  |  ${entry.fToken}  |  ${entry.parser}`;
      tupleList.appendChild(tuple);
    }

    if (pathInfo.entries.length > sampleEntries.length) {
      const overflow = document.createElement('div');
      overflow.className = 'path-debug-more';
      overflow.innerText = `+${pathInfo.entries.length - sampleEntries.length} more tuples`;
      tupleList.appendChild(overflow);
    }

    card.appendChild(tupleList);
    container.appendChild(card);
  }
}

function getSelectionDiagnosticsSummary(selectedEntry) {
  if (!selectedEntry || !currentSelectionDiagnostics) {
    return null;
  }

  const diagnosticsSelection = currentSelectionDiagnostics.selection || {};
  const preferredVersion = getPreferredVersion(selectedEntry);

  if (
    diagnosticsSelection.date !== selectedEntry.date
    || diagnosticsSelection.fToken !== selectedEntry.fToken
    || (diagnosticsSelection.preferredVersion ?? null) !== (preferredVersion ?? null)
  ) {
    return null;
  }

  return currentSelectionDiagnostics.summary || null;
}

function syncSelectionStatus() {
  const selectedEntry = getSelectedEntry();
  const selectedLabel = document.getElementById('selectionStatus');

  if (!selectedEntry) {
    selectedLabel.innerText = 'Pick a date to load historical imagery for the current map view.';
    return;
  }

  const diagnosticsSummary = getSelectionDiagnosticsSummary(selectedEntry);
  const coverageText = diagnosticsSummary
    ? ` Coverage ${diagnosticsSummary.matchedPaths}/${diagnosticsSummary.totalPaths} visible cells. Alternate version cells ${diagnosticsSummary.alternateVersionPaths}. Missing cells ${diagnosticsSummary.missingPaths}.`
    : '';

  selectedLabel.innerText = `Showing ${selectedEntry.date}. The server prefers i.${selectedEntry.iCode} and only switches version when that preferred tile is not valid for a visible cell.${coverageText}`;
}

function renderDateList(entries, emptyMessage = 'No historical data found for the current bounds.') {
  const list = document.getElementById('dateList');
  list.innerHTML = '';

  if (!entries.length) {
    list.innerHTML = `<div class="date-item empty">${emptyMessage}</div>`;
    return;
  }

  for (const entry of entries) {
    const entryId = makeEntryId(entry);
    const button = document.createElement('button');
    button.className = 'date-item';
    button.type = 'button';
    button.dataset.entryId = entryId;

    if (entryId === selectedEntryId) {
      button.classList.add('active');
    }

    const title = document.createElement('div');
    title.className = 'date-title';
    title.innerText = entry.date;

    const meta = document.createElement('div');
    meta.className = 'date-meta';
    let duplicateText = '';

    if (entry.duplicateCandidate?.otherVersions?.length) {
      duplicateText = `  |  also seen as ${entry.duplicateCandidate.otherVersions.map(version => `i.${version}`).join(', ')}`;
    }

    meta.innerText = `Preferred i.${entry.iCode}  |  ${entry.pathCount} visible cells  |  ${entry.fToken}${duplicateText}`;

    button.appendChild(title);
    button.appendChild(meta);
    button.addEventListener('click', () => {
      selectedEntryId = entryId;
      renderDateList(entries);
      syncSelectionStatus();
      void refreshHistoricalLayer();
    });

    list.appendChild(button);
  }
}

function clearHistoricalLayer(message = 'No historical imagery loaded.') {
  if (historicalLayer) {
    map.removeLayer(historicalLayer);
    historicalLayer = null;
  }

  overlayAbortController?.abort();
  overlayAbortController = null;
  currentDownloadLog = [];
  renderCoverageSummary(null, message);
  renderDownloadLog([], 'No tile download attempts yet.');
}

async function refreshSelectionDiagnostics(selectedEntry) {
  selectionDiagnosticsAbortController?.abort();
  selectionDiagnosticsAbortController = null;

  if (!selectedEntry) {
    currentSelectionDiagnostics = null;
    if (currentCatalog) {
      renderPathDebug(currentCatalog);
    }
    syncSelectionStatus();
    return;
  }

  try {
    const requestController = new AbortController();
    selectionDiagnosticsAbortController = requestController;
    const response = await fetch('/api/selection-diagnostics', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: requestController.signal,
      body: JSON.stringify({
        bounds: getBoundsPayload(),
        zoom: currentCatalog?.zoom || getCatalogZoom(),
        date: selectedEntry.date,
        fToken: selectedEntry.fToken,
        preferredVersion: getPreferredVersion(selectedEntry),
      }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Selection diagnostics request failed.');
    }

    if (selectionDiagnosticsAbortController !== requestController) {
      return;
    }

    currentSelectionDiagnostics = payload;
    renderPathDebug(currentCatalog);
    syncSelectionStatus();
    selectionDiagnosticsAbortController = null;
  } catch (error) {
    if (error.name === 'AbortError') {
      return;
    }

    currentSelectionDiagnostics = null;

    if (currentCatalog) {
      renderPathDebug(currentCatalog);
    }
  }
}

function handleZoomStart() {
  if (!historicalLayer) {
    return;
  }

  clearHistoricalLayer('Refreshing historical imagery for the new zoom...');
}

async function refreshBoundsOverlay(selectedEntry, renderNonce) {
  const requestController = new AbortController();
  overlayAbortController = requestController;
  const response = await fetch('/api/overlays', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    signal: requestController.signal,
    body: JSON.stringify({
      bounds: getBoundsPayload(),
      date: selectedEntry.date,
      fToken: selectedEntry.fToken,
      preferredVersion: getPreferredVersion(selectedEntry),
      fidelityMode: FIXED_FIDELITY_MODE,
      zoom: map.getZoom(),
    }),
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || 'Overlay request failed.');
  }

  if (renderNonce !== renderRequestNonce || overlayAbortController !== requestController) {
    return;
  }

  const overlays = payload.tiles.map(tile => L.imageOverlay(tile.url, [
    [tile.bounds.south, tile.bounds.west],
    [tile.bounds.north, tile.bounds.east],
  ]));
  historicalLayer = L.layerGroup(overlays);
  historicalLayer.addTo(map);

  currentDownloadLog = payload.downloadLog || [];
  renderCoverageSummary(payload.summary);
  renderDownloadLog(currentDownloadLog);

  const loadedCount = payload.summary.totalTiles - payload.summary.missingCount;
  if (payload.summary.missingCount > 0) {
    setStatus(`Loaded ${loadedCount}/${payload.summary.totalTiles} visible cells for ${selectedEntry.date}. Some cells could not be resolved.`, 'warn');
  } else {
    setStatus(`Loaded ${loadedCount}/${payload.summary.totalTiles} visible cells for ${selectedEntry.date}.`, 'ok');
  }

  overlayAbortController = null;
}

async function refreshHistoricalLayer() {
  const selectedEntry = getSelectedEntry();
  const renderNonce = ++renderRequestNonce;

  clearHistoricalLayer('Preparing historical imagery for the selected date...');

  if (!selectedEntry) {
    syncSelectionStatus();
    return;
  }

  void refreshSelectionDiagnostics(selectedEntry);
  renderDownloadLog([], `Waiting for tile download attempts for ${selectedEntry.date}...`);
  setStatus(`Downloading historical tiles for ${selectedEntry.date}...`);

  try {
    await refreshBoundsOverlay(selectedEntry, renderNonce);

    if (renderNonce === renderRequestNonce) {
      syncSelectionStatus();
    }
  } catch (error) {
    if (renderNonce !== renderRequestNonce || error.name === 'AbortError') {
      return;
    }

    clearHistoricalLayer();
    renderDownloadLog([], 'No tile download attempts were recorded for this request.');
    setStatus(`Error rendering historical imagery: ${error.message}`, 'error');
    syncSelectionStatus();
  }
}

async function updateCatalogForCurrentBounds() {
  const currentRequest = ++requestNonce;
  const zoom = getCatalogZoom();
  const bounds = getBoundsPayload();
  setStatus(`Verifying live historical metadata for the current bounds at zoom ${zoom}...`);
  catalogAbortController?.abort();
  catalogAbortController = new AbortController();

  try {
    const response = await fetch('/api/catalog', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: catalogAbortController.signal,
      body: JSON.stringify({ bounds, zoom }),
    });
    const catalog = await response.json();

    if (!response.ok) {
      throw new Error(catalog.error || 'Catalog request failed.');
    }

    if (currentRequest !== requestNonce) {
      return;
    }

    catalogAbortController = null;

    currentCatalog = catalog;
    const previousSelection = selectedEntryId;
    selectedEntryId = reconcileSelection(selectedEntryId, catalog.entries, {
      preferExactVersion: false,
    });

    ensureEntriesVisible();
    renderVerification(catalog);
    currentSelectionDiagnostics = null;
    renderPathDebug(catalog);
    const errorSummary = getCatalogErrorSummary(catalog);
    const hasCompleteMetadataFailure = errorSummary.errorPathCount === catalog.verification.requestedPathCount && errorSummary.errorPathCount > 0;

    if (hasCompleteMetadataFailure) {
      renderDateList([], `Live metadata fetch failed for the current bounds. ${errorSummary.sampleMessage || 'Unknown upstream error.'}`);
    } else {
      renderDateList(catalog.entries);
    }

    if (hasCompleteMetadataFailure) {
      clearHistoricalLayer();
      setStatus(
        `Live metadata fetch failed for all visible paths: ${errorSummary.sampleMessage || 'unknown upstream error'}`,
        'error'
      );
    } else if (previousSelection && !selectedEntryId) {
      clearHistoricalLayer();
      setStatus('The previously selected historical entry is not valid for the current bounds.', 'warn');
    } else if (errorSummary.errorPathCount > 0) {
      setStatus(
        `Resolved ${catalog.verification.resolvedPathCount}/${catalog.verification.requestedPathCount} visible paths, but ${errorSummary.errorPathCount} live metadata requests failed.`,
        'warn'
      );
    } else {
      setStatus(
        `Verified ${catalog.verification.resolvedPathCount}/${catalog.verification.requestedPathCount} visible paths and found ${catalog.entries.length} live entries in ${catalog.timing?.durationMs ?? 'n/a'} ms.`,
        'ok'
      );
    }

    syncSelectionStatus();

    if (selectedEntryId) {
      void refreshHistoricalLayer();
    }
  } catch (error) {
    if (currentRequest !== requestNonce) {
      return;
    }

    if (error.name === 'AbortError') {
      return;
    }

    catalogAbortController = null;
    setStatus(`Error verifying historical metadata: ${error.message}`, 'error');
    document.getElementById('verificationSummary').innerHTML = '';
    document.getElementById('pathDebugList').innerHTML = '';
  }
}
