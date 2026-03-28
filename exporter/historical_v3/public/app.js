
let map;
let currentMetadata = null;
let worldIndex = null;
let highlightLayers = [];
let historicalLayer = null; 
let activeSelection = null;
let timelineSlider = null;

// --- CUSTOM PLATE CARREE TILE LAYER ---
L.HistoricalLayer = L.TileLayer.extend({
    getTileUrl: function(coords) {
        if (!activeSelection) return "";
        const zoom = coords.z;
        return `/api/tile/${zoom}/${coords.x}/${coords.y}?iCode=${activeSelection.iCode}&fToken=${activeSelection.fToken}&sourcePath=${activeSelection.sourcePath}`;
    }
});

async function initMap() {
    console.log("UI: Initializing Map...");
    map = L.map('map').setView([35.1856, 33.3823], 14);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
    }).addTo(map);

    // Test Server Connection
    fetch('/api/regions').then(r => console.log("UI: Server Connection OK")).catch(e => console.error("UI: Server Connection FAILED", e));

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
        if (!res.ok) throw new Error("Index not found");
        worldIndex = await res.json();
        document.getElementById('global-status').innerText = `Global Index Active`;
        const dates = Object.keys(worldIndex.dates).sort().map(d => ({ date: d }));
        updateSliderWithLocalDates(dates);
    } catch (e) {
        document.getElementById('global-status').innerText = "Global Index: Not found";
    }
}

async function remoteLog(type, message, data = null) {
    try {
        const res = await fetch('/api/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, message, data })
        });
        if (!res.ok) console.warn("Remote log failed status:", res.status);
    } catch (e) {
        console.error("Remote log error:", e.message);
    }
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
        if (!entry) return;
        document.getElementById('timeline-current').innerText = entry.date;
        if (entry.iCode) {
            selectHistoricalDate(entry);
        }
    });
}

async function updateMetadataForCurrentView() {
    const zoom = map.getZoom();
    const center = map.getCenter();
    
    // RESTORED: Metadata threshold Z14
    if (zoom < 14) {
        document.getElementById('status-bar').firstChild.textContent = `Current zoom: ${zoom.toFixed(1)}. Zoom to 14+ to explore historical dates. `;
        document.getElementById('metadata-body').innerHTML = '<tr><td colspan="3">Zoom in further (Z14+)</td></tr>';
        return;
    }

    document.getElementById('loading-indicator').style.display = 'block';
    try {
        const fetchZoom = Math.min(zoom, 16);
        const res = await fetch(`/api/metadata-at?lat=${center.lat}&lon=${center.lng}&zoom=${fetchZoom}`);
        const data = await res.json();
        currentMetadata = data;
        document.getElementById('status-bar').firstChild.textContent = `Path: ${data.pathCode} (Z${fetchZoom}) | Lat: ${center.lat.toFixed(4)} Lon: ${center.lng.toFixed(4)} `;
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
        dateTd.innerHTML = `<span style="margin-right:10px">${e.date}</span>`;
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';
        copyBtn.innerText = '📋';
        copyBtn.onclick = (event) => {
            event.stopPropagation();
            copyToClipboard(`${e.date}📋${e.iCode}${e.fToken}`, copyBtn, tr);
        };
        dateTd.appendChild(copyBtn);
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
    
    remoteLog('SELECT', `Viewed ${entry.date} v.${entry.iCode}`, { 
        iCode: entry.iCode, fToken: entry.fToken, zoom: map.getZoom(), center: map.getCenter()
    });
}

function refreshHistoricalLayer() {
    if (historicalLayer) {
        map.removeLayer(historicalLayer);
        historicalLayer = null;
    }
    if (!activeSelection) return;
    const zoom = map.getZoom();
    if (zoom < 17) {
        document.getElementById('status-bar').firstChild.textContent += ` | Zoom to 17+ to see tiles.`;
        return;
    }
    const tileUrlTemplate = `/api/tile/{z}/{x}/{y}?iCode=${activeSelection.iCode}&fToken=${activeSelection.fToken}&sourcePath=${activeSelection.sourcePath}`;
    historicalLayer = new L.HistoricalLayer(tileUrlTemplate, { maxZoom: 21, minZoom: 1, opacity: 1.0, attribution: '© Google Earth' }).addTo(map);
}

function copyToClipboard(text, btn, tr) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-9999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
        document.execCommand('copy');
        const oldIcon = btn.innerText;
        btn.innerText = '✅';
        tr.style.backgroundColor = '#e8f5e9';
        setTimeout(() => { 
            btn.innerText = oldIcon; 
            tr.style.backgroundColor = tr.classList.contains('active') ? '#d0e8ff' : '';
        }, 1000);
    } catch (err) {}
    document.body.removeChild(textArea);
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
