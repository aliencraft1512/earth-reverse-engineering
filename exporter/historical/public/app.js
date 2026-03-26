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

function setStatus(message, tone = 'neutral') {
  const status = document.getElementById('status');
  status.innerText = message;
  status.dataset.tone = tone;
}

function renderVerification(catalog) {
  const summary = document.getElementById('verificationSummary');
  const bounds = catalog.bounds;

  summary.innerHTML = '';

  const lines = [
    `Catalog zoom ${catalog.zoom}`,
    `Visible paths ${catalog.verification.resolvedPathCount}/${catalog.verification.requestedPathCount}`,
    `Ancestor fallbacks ${catalog.verification.ancestorFallbackCount}`,
    `Bounds ${bounds.south.toFixed(4)}, ${bounds.west.toFixed(4)} -> ${bounds.north.toFixed(4)}, ${bounds.east.toFixed(4)}`,
  ];

  for (const line of lines) {
    const div = document.createElement('div');
    div.className = 'verification-line';
    div.innerText = line;
    summary.appendChild(div);
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
  }
}
