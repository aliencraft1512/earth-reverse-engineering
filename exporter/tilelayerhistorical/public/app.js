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
const HISTORICAL_NATIVE_ZOOM_CANDIDATES = [18, 17, 19, 16];
const FALLBACK_NATIVE_ZOOM = 18;

let currentHistoricalLayer = null;
let currentHistoricalNativeZoom = null;
let discoveredLayers = [];
let activeSelectedLayerId = null; // Track selected logical layer across panning
let renderRequestToken = 0;
const nativeZoomCache = new Map();

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

function latLonToSlippyXY(lat, lon, z) {
  const tileCount = Math.pow(2, z);
  const x = Math.floor(((lon + 180) / 360) * tileCount);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * tileCount
  );
  return { x, y };
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    data = text;
  }

  if (!response.ok) {
    const message = (data && data.error) || response.statusText || 'Request failed';
    throw new Error(message);
  }

  return data;
}

function nativeZoomCacheKey(layerInfo) {
  const center = map.getCenter();
  return `${layerInfo.id}|${center.lat.toFixed(3)}|${center.lng.toFixed(3)}`;
}

async function fetchNeighborhoodDiagnostic(layerInfo, nativeZoom, radius = 1) {
  const center = map.getCenter();
  const { x, y } = latLonToSlippyXY(center.lat, center.lng, nativeZoom);
  const url = `/api/debug/neighborhood/${encodeURIComponent(layerInfo.date)}/${encodeURIComponent(layerInfo.iCode)}/${nativeZoom}/${x}/${y}?radius=${radius}`;
  return fetchJson(url);
}

function scoreDiagnostic(diag, zoom) {
  const tiles = Array.isArray(diag?.tiles) ? diag.tiles : [];
  if (!tiles.length) return -Infinity;

  const okTiles = tiles.filter(tile => tile.ok && tile.status === 200 && tile.exactPathMatch && tile.resolvedPathCode);
  if (!okTiles.length) return -Infinity;

  const uniqueResolved = new Set(okTiles.map(tile => tile.resolvedPathCode)).size;
  const duplicateResolved = okTiles.length - uniqueResolved;
  const missingTiles = tiles.length - okTiles.length;

  let score = 0;
  score += okTiles.length * 100;
  score += uniqueResolved * 20;
  score -= duplicateResolved * 120;
  score -= missingTiles * 80;

  if (duplicateResolved === 0 && missingTiles === 0) {
    score += 500;
  }

  score -= Math.abs(zoom - 18) * 8;
  return score;
}

async function chooseNativeZoomForLayer(layerInfo) {
  const cacheKey = nativeZoomCacheKey(layerInfo);
  if (nativeZoomCache.has(cacheKey)) {
    return nativeZoomCache.get(cacheKey);
  }

  const previousStatus = statusEl.textContent;
  statusEl.textContent = 'Choosing native zoom...';

  try {
    const diagnostics = await Promise.all(HISTORICAL_NATIVE_ZOOM_CANDIDATES.map(async zoom => {
      try {
        const diag = await fetchNeighborhoodDiagnostic(layerInfo, zoom, 1);
        return {
          zoom,
          score: scoreDiagnostic(diag, zoom),
          diag,
        };
      } catch (error) {
        return {
          zoom,
          score: -Infinity,
          diag: null,
          error: error.message,
        };
      }
    }));

    diagnostics.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return Math.abs(a.zoom - 18) - Math.abs(b.zoom - 18);
    });

    const best = diagnostics.find(item => Number.isFinite(item.score) && item.score > -Infinity);
    const chosenZoom = best ? best.zoom : FALLBACK_NATIVE_ZOOM;
    nativeZoomCache.set(cacheKey, chosenZoom);

    console.table(diagnostics.map(item => ({
      zoom: item.zoom,
      score: item.score,
      tiles: item.diag?.tiles?.length || 0,
      error: item.error || null,
    })));

    return chosenZoom;
  } finally {
    statusEl.textContent = previousStatus;
  }
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

  void triggerLayerRender(targetIndex);
}

// SET fires when handle is released
sliderElement.noUiSlider.on('set', function () {
  const index = Math.round(Number(sliderElement.noUiSlider.get(true)));
  if (discoveredLayers[index]) {
    activeSelectedLayerId = discoveredLayers[index].id;
  }
  void triggerLayerRender(index);
});

// UPDATE fires whenever slider is touched or dragged
sliderElement.noUiSlider.on('update', function () {
   if (sliderElement.hasAttribute('disabled')) return;

   const index = Math.round(Number(sliderElement.noUiSlider.get(true)));
   if (discoveredLayers[index]) {
      const nativeZoomText = Number.isFinite(currentHistoricalNativeZoom) ? currentHistoricalNativeZoom : '?';
      dateDisplayEl.innerHTML = `Active Pass: <strong>${discoveredLayers[index].date}</strong> <em>(i.${discoveredLayers[index].iCode})</em> <small>(source z.${nativeZoomText})</small>`;
   }
});

function clearOverlays() {
  if (currentHistoricalLayer) {
    map.removeLayer(currentHistoricalLayer);
    currentHistoricalLayer = null;
  }
  currentHistoricalNativeZoom = null;
  dateDisplayEl.textContent = 'Historical Imagery Timeline';
}

function tileUrlForLayer(layerInfo, sourceZoom) {
  return `/tiles/unified/${encodeURIComponent(layerInfo.date)}/${encodeURIComponent(layerInfo.iCode)}/{z}/{x}/{y}.jpg?sourceZoom=${encodeURIComponent(sourceZoom)}`;
}

async function triggerLayerRender(index) {
  if (!discoveredLayers[index]) return;
  const layerInfo = discoveredLayers[index];
  const token = ++renderRequestToken;

  const chosenNativeZoom = await chooseNativeZoomForLayer(layerInfo);
  if (token !== renderRequestToken) {
    return;
  }

  if (
    currentHistoricalLayer &&
    currentHistoricalLayer.layerId === layerInfo.id &&
    currentHistoricalNativeZoom === chosenNativeZoom
  ) {
    return;
  }

  if (currentHistoricalLayer) {
    map.removeLayer(currentHistoricalLayer);
  }

  const layer = L.tileLayer(tileUrlForLayer(layerInfo, chosenNativeZoom), {
    tileSize: 256,
    opacity: 1.0,
    maxZoom: 19,
    crossOrigin: true,
    updateWhenZooming: false,
    updateWhenIdle: true,
    keepBuffer: 0,
  });

  layer.layerId = layerInfo.id;
  layer.addTo(map);
  layer.bringToFront();

  currentHistoricalLayer = layer;
  currentHistoricalNativeZoom = chosenNativeZoom;

  if (discoveredLayers[index]) {
    dateDisplayEl.innerHTML = `Active Pass: <strong>${discoveredLayers[index].date}</strong> <em>(i.${discoveredLayers[index].iCode})</em> <small>(source z.${chosenNativeZoom})</small>`;
  }
}

map.on('movestart', clearOverlays);
map.on('zoomstart', clearOverlays);
map.on('moveend', queueDiscovery);
map.on('zoomend', queueDiscovery);

setTimeout(() => queueDiscovery(), 200);
