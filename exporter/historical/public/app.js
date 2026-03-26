let map;
let historicalLayer = null;
let currentCatalog = null;
let selectedEntryId = null;
let requestNonce = 0;

const DEFAULT_CENTER = [35.1723, 33.3667];
const DEFAULT_ZOOM = 15;

const { makeEntryId, reconcileSelection } = window.HistoricalSelection;

initMap();

function initMap() {
  map = L.map('map').setView(DEFAULT_CENTER, DEFAULT_ZOOM);

  L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
    maxZoom: 20,
    attribution: '&copy; Google Maps',
  }).addTo(map);

  document.getElementById('preferExactVersion').addEventListener('change', () => {
    syncSelectionStatus();
    refreshHistoricalLayer();
  });

  for (const elementId of ['sidebar', 'dateList', 'pathDebugList']) {
    const element = document.getElementById(elementId);

    if (!element || !L.DomEvent) {
      continue;
    }

    L.DomEvent.disableClickPropagation(element);
    L.DomEvent.disableScrollPropagation(element);
  }

  map.on('moveend', updateCatalogForCurrentBounds);
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

window.__historicalDebug = {
  getCatalog: () => currentCatalog,
  getMap: () => map,
  getRequestNonce: () => requestNonce,
  getSelectedEntry: () => getSelectedEntry(),
};

function setStatus(message, tone = 'neutral') {
  const status = document.getElementById('status');
  status.innerText = message;
  status.dataset.tone = tone;
}

function renderVerification(catalog) {
  const summary = document.getElementById('verificationSummary');
  const bounds = catalog.bounds;
  const parserModes = Object.entries(catalog.verification.parserModes || {})
    .map(([mode, count]) => `${mode}:${count}`)
    .join(', ');

  summary.innerHTML = '';

  const lines = [
    `Catalog zoom ${catalog.zoom}`,
    `Visible paths ${catalog.verification.resolvedPathCount}/${catalog.verification.requestedPathCount}`,
    `Ancestor fallbacks ${catalog.verification.ancestorFallbackCount}`,
    `Parser modes ${parserModes || 'n/a'}`,
    `Bounds ${bounds.south.toFixed(4)}, ${bounds.west.toFixed(4)} -> ${bounds.north.toFixed(4)}, ${bounds.east.toFixed(4)}`,
  ];

  for (const line of lines) {
    const div = document.createElement('div');
    div.className = 'verification-line';
    div.innerText = line;
    summary.appendChild(div);
  }
}

function renderPathDebug(catalog) {
  const container = document.getElementById('pathDebugList');
  container.innerHTML = '';

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

function syncSelectionStatus() {
  const selectedEntry = getSelectedEntry();
  const selectedLabel = document.getElementById('selectionStatus');
  const exactPreferred = document.getElementById('preferExactVersion').checked;

  if (!selectedEntry) {
    selectedLabel.innerText = 'No historical entry selected.';
    return;
  }

  selectedLabel.innerText = exactPreferred
    ? `Selected ${selectedEntry.date} with i.${selectedEntry.iCode} as the preferred version.`
    : `Selected ${selectedEntry.date}; the server will choose the best valid version per path.`;
}

function renderDateList(entries) {
  const list = document.getElementById('dateList');
  list.innerHTML = '';

  if (!entries.length) {
    list.innerHTML = '<div class="date-item empty">No historical data found for the current bounds.</div>';
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
    title.innerText = `${entry.date}  i.${entry.iCode}`;

    const meta = document.createElement('div');
    meta.className = 'date-meta';
    meta.innerText = `${entry.pathCount} visible paths  |  ${entry.fToken}`;

    button.appendChild(title);
    button.appendChild(meta);
    button.addEventListener('click', () => {
      selectedEntryId = entryId;
      renderDateList(entries);
      syncSelectionStatus();
      refreshHistoricalLayer();
    });

    list.appendChild(button);
  }
}

function clearHistoricalLayer() {
  if (historicalLayer) {
    map.removeLayer(historicalLayer);
    historicalLayer = null;
  }
}

function refreshHistoricalLayer() {
  const selectedEntry = getSelectedEntry();

  clearHistoricalLayer();

  if (!selectedEntry) {
    syncSelectionStatus();
    return;
  }

  const params = new URLSearchParams({
    date: selectedEntry.date,
    fToken: selectedEntry.fToken,
  });

  if (document.getElementById('preferExactVersion').checked) {
    params.set('preferredVersion', selectedEntry.iCode);
  }

  historicalLayer = L.tileLayer(`/api/tile/{z}/{x}/{y}?${params.toString()}`, {
    maxZoom: 20,
    attribution: 'Historical Imagery',
  });

  historicalLayer.on('tileerror', () => {
    setStatus('Some visible tiles did not resolve for the selected date/path combination.', 'warn');
  });

  historicalLayer.addTo(map);
  syncSelectionStatus();
}

async function updateCatalogForCurrentBounds() {
  const currentRequest = ++requestNonce;
  const zoom = getCatalogZoom();
  const bounds = getBoundsPayload();
  setStatus(`Verifying historical metadata for the current bounds at zoom ${zoom}...`);

  try {
    const response = await fetch('/api/catalog', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ bounds, zoom }),
    });
    const catalog = await response.json();

    if (!response.ok) {
      throw new Error(catalog.error || 'Catalog request failed.');
    }

    if (currentRequest !== requestNonce) {
      return;
    }

    currentCatalog = catalog;
    const previousSelection = selectedEntryId;
    selectedEntryId = reconcileSelection(selectedEntryId, catalog.entries);

    renderVerification(catalog);
    renderPathDebug(catalog);
    renderDateList(catalog.entries);

    if (previousSelection && !selectedEntryId) {
      clearHistoricalLayer();
      setStatus('The previously selected historical entry is not valid for the current bounds.', 'warn');
    } else {
      setStatus(
        `Verified ${catalog.verification.resolvedPathCount}/${catalog.verification.requestedPathCount} visible paths and found ${catalog.entries.length} unique entries.`,
        'ok'
      );
    }

    syncSelectionStatus();

    if (selectedEntryId) {
      refreshHistoricalLayer();
    }
  } catch (error) {
    if (currentRequest !== requestNonce) {
      return;
    }

    setStatus(`Error verifying historical metadata: ${error.message}`, 'error');
    document.getElementById('verificationSummary').innerHTML = '';
    document.getElementById('pathDebugList').innerHTML = '';
  }
}
