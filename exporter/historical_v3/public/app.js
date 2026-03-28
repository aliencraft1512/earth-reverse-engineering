
let map;
let currentMetadata = null;
let worldIndex = null;
let highlightLayers = [];
let historicalLayer = null; 
let activeSelection = null;
let timelineSlider = null;

// --- FAST PLATE CARREE TILE LAYER ---
L.HistoricalLayer = L.TileLayer.extend({
    getTileUrl: function(coords) {
        if (!activeSelection) return "";
        return `/api/tile/${coords.z}/${coords.x}/${coords.y}?iCode=${activeSelection.iCode}&fToken=${activeSelection.fToken}&sourcePath=${activeSelection.sourcePath}`;
    }
});

async function initMap() {
    console.log("UI: Initializing High-Speed Map...");
    map = L.map('map').setView([35.1856, 33.3823], 14);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 21,
        attribution: '© OpenStreetMap'
    }).addTo(map);

    map.on('zoom', () => {
        document.getElementById('zoom-indicator').innerText = `ZOOM: ${map.getZoom().toFixed(1)}`;
    });

    let moveTimeout;
    map.on('moveend', () => {
        clearTimeout(moveTimeout);
        moveTimeout = setTimeout(() => {
            updateMetadataForCurrentView();
        }, 300);
    });

    const sliderDiv = document.getElementById('timeline-slider');
    timelineSlider = noUiSlider.create(sliderDiv, {
        start: [0],
        range: { min: 0, max: 1 },
        step: 1,
        pips: { mode: 'count', values: 2 }
    });

    updateMetadataForCurrentView();
    loadWorldIndex();
}

async function loadWorldIndex() {
    try {
        const res = await fetch('/api/world-index');
        worldIndex = await res.json();
        const dates = Object.keys(worldIndex.dates).sort().map(d => ({ date: d, iCode: worldIndex.dates[d][0] }));
        updateSliderWithLocalDates(dates);
    } catch (e) {}
}

function updateSliderWithLocalDates(entries) {
    if (!entries || entries.length === 0) return;
    const container = document.getElementById('timeline-container');
    container.style.display = 'block';

    const uniqueDatesMap = new Map();
    entries.forEach(e => {
        if (!uniqueDatesMap.has(e.date) || e.iCode > (uniqueDatesMap.get(e.date).iCode || 0)) {
            uniqueDatesMap.set(e.date, e);
        }
    });
    const sorted = [...uniqueDatesMap.values()].sort((a, b) => a.date.localeCompare(b.date));
    
    timelineSlider.updateOptions({
        range: { min: 0, max: sorted.length - 1 },
        start: [sorted.length - 1],
        pips: {
            mode: 'values',
            values: [0, Math.floor(sorted.length / 2), sorted.length - 1],
            density: 4,
            format: { to: (val) => sorted[Math.round(val)]?.date.substring(0, 4) || "" }
        }
    }, true);

    timelineSlider.off('update');
    timelineSlider.on('update', (values, handle) => {
        const index = Math.round(values[handle]);
        const entry = sorted[index];
        if (entry?.iCode) selectHistoricalDate(entry);
    });
}

async function updateMetadataForCurrentView() {
    const zoom = map.getZoom();
    const center = map.getCenter();
    
    if (zoom < 14) {
        document.getElementById('status-bar').firstChild.textContent = `Zoom in (Z14+) `;
        document.getElementById('metadata-body').innerHTML = '<tr><td colspan="3">Zoom in further (Z14+)</td></tr>';
        return;
    }

    document.getElementById('loading-indicator').style.display = 'block';
    try {
        const fetchZoom = Math.min(Math.floor(zoom), 16);
        const res = await fetch(`/api/metadata-at?lat=${center.lat}&lon=${center.lng}&zoom=${fetchZoom}&_=${Date.now()}`);
        const data = await res.json();
        currentMetadata = data;
        document.getElementById('status-bar').firstChild.textContent = `Path: ${data.pathCode} (Z${fetchZoom}) `;
        renderMetadataTable(data.entries);
    } catch (e) { console.error(e); }
    finally { document.getElementById('loading-indicator').style.display = 'none'; }
}

function renderMetadataTable(entries) {
    const body = document.getElementById('metadata-body');
    body.innerHTML = '';
    if (!entries || entries.length === 0) return;
    
    const sorted = entries.sort((a, b) => b.date.localeCompare(a.date));
    updateSliderWithLocalDates([...sorted]);

    sorted.forEach(e => {
        const tr = document.createElement('tr');
        tr.className = 'metadata-row';
        tr.id = `row-${e.date}-${e.iCode}`;
        if (activeSelection && activeSelection.date === e.date && activeSelection.iCode === e.iCode) tr.classList.add('active');
        
        const dateTd = document.createElement('td');
        dateTd.innerHTML = `<span>${e.date}</span> <button class="copy-btn" onclick="event.stopPropagation(); copyRow('${e.date}','${e.iCode}','${e.fToken}')">📋</button>`;
        tr.appendChild(dateTd);
        tr.innerHTML += `<td>${e.iCode}</td><td>${e.fToken}</td>`;
        tr.onclick = () => selectHistoricalDate(e);
        body.appendChild(tr);
    });
}

function selectHistoricalDate(entry) {
    activeSelection = entry;
    document.querySelectorAll('.metadata-row').forEach(el => el.classList.remove('active'));
    const activeRow = document.getElementById(`row-${entry.date}-${entry.iCode}`);
    if (activeRow) activeRow.classList.add('active');
    refreshHistoricalLayer();
}

function refreshHistoricalLayer() {
    if (historicalLayer) {
        map.removeLayer(historicalLayer);
        historicalLayer = null;
    }
    if (!activeSelection) return;
    if (map.getZoom() < 17) return;

    // Fixed: Pass a real URL template to the custom layer
    const url = `/api/tile/{z}/{x}/{y}?iCode=${activeSelection.iCode}&fToken=${activeSelection.fToken}&sourcePath=${activeSelection.sourcePath}`;
    historicalLayer = new L.HistoricalLayer(url, { maxZoom: 21, opacity: 1.0 }).addTo(map);
}

function copyRow(d, v, t) {
    const text = `${d}📋${v}${t}`;
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    console.log("Copied:", text);
}

initMap();
async function fetchRegions() {
    const regions = [
        { name: "Nicosia", lat: 35.1856, lon: 33.3823, z: 15 },
        { name: "Athens", lat: 37.9838, lon: 23.7275, z: 15 },
        { name: "London", lat: 51.5074, lon: -0.1278, z: 15 }
    ];
    const list = document.getElementById('regions-list');
    regions.forEach(r => {
        const div = document.createElement('div');
        div.className = 'region-item'; div.innerText = r.name;
        div.onclick = () => map.setView([r.lat, r.lon], r.z);
        list.appendChild(div);
    });
}
fetchRegions();
