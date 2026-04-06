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

let currentHistoricalLayer = null;
let discoveredLayers = [];
let activeSelectedDate = null; // Track selected date across panning

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
    
    // Sort layers chronologically automatically
    // Expected date format typically includes year/month/day
    // e.g. "2020-03-12" or similar depending on the exact payload
    discoveredLayers.sort((a, b) => a.date.localeCompare(b.date));
    
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

  const labels = layers.map(l => l.date);

  let targetIndex = layers.length - 1; // Default to most recent

  // Try to preserve the user's previously selected date if it exists in the new area
  if (activeSelectedDate) {
    const foundIndex = labels.indexOf(activeSelectedDate);
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

  // Switch to the target layer immediately
  triggerLayerRender(targetIndex);
}

// SET fires when handle is released
sliderElement.noUiSlider.on('set', function () {
  const index = Math.round(Number(sliderElement.noUiSlider.get(true)));
  if (discoveredLayers[index]) {
    activeSelectedDate = discoveredLayers[index].date;
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
  if (currentHistoricalLayer) {
    map.removeLayer(currentHistoricalLayer);
    currentHistoricalLayer = null;
  }
  dateDisplayEl.textContent = 'Historical Imagery Timeline';
}

function tileUrlForLayer(layerInfo) {
  return `/tiles/unified/${encodeURIComponent(layerInfo.date)}/${encodeURIComponent(layerInfo.iCode)}/{z}/{x}/{y}.jpg`;
}

function triggerLayerRender(index) {
  if (!discoveredLayers[index]) return;
  const layerInfo = discoveredLayers[index];
  
  if (currentHistoricalLayer && currentHistoricalLayer.layerId === layerInfo.id) {
    return; // Already rendering this layer
  }

  // Swap out layer
  if (currentHistoricalLayer) {
    map.removeLayer(currentHistoricalLayer);
  }

  const layer = L.tileLayer(tileUrlForLayer(layerInfo), {
    tileSize: 256,
    opacity: 1.0,
    maxZoom: 19,
    crossOrigin: true,
  });
  
  layer.layerId = layerInfo.id;
  layer.addTo(map);
  layer.bringToFront();
  
  currentHistoricalLayer = layer;
}

// Map event listeners bind
map.on('moveend', queueDiscovery);
map.on('zoomend', queueDiscovery);

// Kick off
setTimeout(() => queueDiscovery(), 200);
