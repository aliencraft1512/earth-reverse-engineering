const map = L.map('map', {
  zoomControl: false,
}).setView([35.1856, 33.3823], 13);

L.control.zoom({ position: 'topright' }).addTo(map);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const statusEl = document.getElementById('status-text');
const dateDisplayEl = document.getElementById('active-date-display');
const sliderContainer = document.getElementById('ui-container');
const sliderElement = document.getElementById('timeline-slider');

let currentHistoricalLayerGroup = null;
let currentHistoricalLayerId = null;
let discoveredLayers = [];
let discoveredPathSummaries = [];
let activeSelectedLayerId = null; // Track selected logical layer across panning

// Initialize an empty disabled slider
noUiSlider.create(sliderElement, {
  start: 0,
  range: { 'min': 0, 'max': 100 },
  step: 1,
  connect: [true, false],
  tooltips: true,
  format: {
    to: () => 'No Data',
    from: Number
  }
});
sliderElement.setAttribute('disabled', true);
sliderContainer.classList.add('disabled-overlay');

function currentBoundsPayload() {
  const b = map.getBounds();
  return {
    north: b.getNorth(),
    south: b.getSouth(),
    east: b.getEast(),
    west: b.getWest(),
  };
}

function buildLayerLabels(layers) {
  const countsByDate = new Map();

  for (const layer of layers) {
    countsByDate.set(layer.date, (countsByDate.get(layer.date) || 0) + 1);
  }

  return layers.map(layer => {
    const duplicateDate = (countsByDate.get(layer.date) || 0) > 1;
    return duplicateDate ? `${layer.date} (i.${layer.iCode})` : layer.date;
  });
}

function hasMatchingEntry(pathSummary, layerInfo) {
  if (!Array.isArray(pathSummary?.entries)) return false;
  return pathSummary.entries.some(entry => entry.date === layerInfo.date && Number(entry.iCode) === Number(layerInfo.iCode));
}

function boundsToLeaflet(bounds) {
  if (!bounds) return null;
  if (![bounds.south, bounds.west, bounds.north, bounds.east].every(Number.isFinite)) return null;
  return [[bounds.south, bounds.west], [bounds.north, bounds.east]];
}

function buildOverlaySpecsForLayer(layerInfo) {
  const seen = new Set();
  const overlays = [];

  for (const pathSummary of discoveredPathSummaries) {
    if (!hasMatchingEntry(pathSummary, layerInfo)) continue;

    const resolvedPathCode = pathSummary.sourcePath || pathSummary.path;
    if (!resolvedPathCode || seen.has(resolvedPathCode)) continue;

    const bounds = pathSummary.sourceBounds || pathSummary.bounds;
    const leafletBounds = boundsToLeaflet(bounds);
    if (!leafletBounds) continue;

    seen.add(resolvedPathCode);
    overlays.push({
      key: resolvedPathCode,
      pathCode: resolvedPathCode,
      bounds: leafletBounds,
    });
  }

  return overlays;
}

// Request debounce timeout
let discoverTimeout = null;
let discoverAbortController = null;

async function discoverLayers() {
  const zoom = map.getZoom();
  if (zoom < 16) {
    statusEl.textContent = 'Zoom to level 16+ to load layers';
    disableTimeline();
    clearOverlays();
    return;
  }

  statusEl.textContent = 'Discovering layers in view...';

  if (discoverAbortController) {
    discoverAbortController.abort();
  }
  discoverAbortController = new AbortController();

  try {
    const discoveryZoom = Math.min(zoom, 17); // Cap metadata query resolution at 17 to find high-res passes

    const response = await fetch('/api/layers/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bounds: currentBoundsPayload(), zoom: discoveryZoom }),
      signal: discoverAbortController.signal
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Layer discovery failed');

    discoveredLayers = data.layers || [];
    discoveredPathSummaries = data.paths || [];

    if (discoveredLayers.length === 0) {
      statusEl.textContent = 'No historical layers found here.';
      disableTimeline();
      clearOverlays();
      return;
    }

    discoveredLayers.sort((a, b) => {
      if (a.date === b.date) return a.iCode - b.iCode;
      return a.date.localeCompare(b.date);
    });

    statusEl.textContent = `Found ${discoveredLayers.length} distinct passes.`;
    updateTimeline(discoveredLayers);

  } catch (error) {
    if (error.name === 'AbortError') return; // Ignore expected aborts
    statusEl.textContent = error.message;
    console.error(error);
  }
}

function queueDiscovery() {
  if (discoverTimeout) clearTimeout(discoverTimeout);
  discoverTimeout = setTimeout(discoverLayers, 400); // Slight delay increase to prevent rapid-fire while panning
}

function disableTimeline() {
  sliderElement.setAttribute('disabled', true);
  sliderContainer.classList.add('disabled-overlay');
}

function enableTimeline() {
  sliderElement.removeAttribute('disabled');
  sliderContainer.classList.remove('disabled-overlay');
}

function updateTimeline(layers) {
  enableTimeline();

  const labels = buildLayerLabels(layers);

  let targetIndex = layers.length - 1; // Default to most recent

  if (activeSelectedLayerId) {
    const foundIndex = layers.findIndex(layer => layer.id === activeSelectedLayerId);
    if (foundIndex !== -1) {
      targetIndex = foundIndex;
    }
  }

  sliderElement.noUiSlider.updateOptions({
    range: {
      'min': 0,
      'max': layers.length - 1
    },
    start: targetIndex,
    format: {
      to: (value) => labels[Math.round(value)],
      from: Number
    }
  });

  triggerLayerRender(targetIndex);
}

// SET fires when handle is released
sliderElement.noUiSlider.on('set', function () {
  const index = Math.round(Number(sliderElement.noUiSlider.get(true)));
  if (discoveredLayers[index]) {
    activeSelectedLayerId = discoveredLayers[index].id;
  }
  triggerLayerRender(index);
});

// UPDATE fires whenever slider is touched or dragged
sliderElement.noUiSlider.on('update', function () {
   if (sliderElement.hasAttribute('disabled')) return;

   const index = Math.round(Number(sliderElement.noUiSlider.get(true)));
   if (discoveredLayers[index]) {
      dateDisplayEl.innerHTML = `Active Pass: <strong>${discoveredLayers[index].date}</strong> <em>(i.${discoveredLayers[index].iCode})</em>`;
   }
});

function clearOverlays() {
  if (currentHistoricalLayerGroup) {
    map.removeLayer(currentHistoricalLayerGroup);
    currentHistoricalLayerGroup = null;
  }
  currentHistoricalLayerId = null;
  dateDisplayEl.textContent = 'Historical Imagery Timeline';
}

function nativeOverlayUrl(layerInfo, overlaySpec) {
  return `/tiles/native/${encodeURIComponent(layerInfo.date)}/${encodeURIComponent(layerInfo.iCode)}/${encodeURIComponent(overlaySpec.pathCode)}.jpg`;
}

function triggerLayerRender(index) {
  if (!discoveredLayers[index]) return;
  const layerInfo = discoveredLayers[index];

  if (currentHistoricalLayerId === layerInfo.id) {
    return; // Already rendering this layer
  }

  if (currentHistoricalLayerGroup) {
    map.removeLayer(currentHistoricalLayerGroup);
    currentHistoricalLayerGroup = null;
  }

  const overlaySpecs = buildOverlaySpecsForLayer(layerInfo);
  if (!overlaySpecs.length) {
    currentHistoricalLayerId = null;
    statusEl.textContent = 'Selected pass has no native overlays for this view.';
    return;
  }

  const group = L.layerGroup();

  for (const overlaySpec of overlaySpecs) {
    const overlay = L.imageOverlay(nativeOverlayUrl(layerInfo, overlaySpec), overlaySpec.bounds, {
      opacity: 1.0,
      interactive: false,
      crossOrigin: true,
      errorOverlayUrl: undefined,
    });
    overlay.addTo(group);
  }

  group.addTo(map);
  currentHistoricalLayerGroup = group;
  currentHistoricalLayerId = layerInfo.id;
}

// Map event listeners bind
map.on('moveend', queueDiscovery);
map.on('zoomend', queueDiscovery);

// Kick off
setTimeout(() => queueDiscovery(), 200);
