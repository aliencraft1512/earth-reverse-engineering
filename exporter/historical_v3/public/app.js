
let map;
let currentMetadata = null;
let currentLayer = null;
let worldIndex = null;
let highlightLayers = [];

function initMap() {
    map = L.map('map').setView([35.1856, 33.3823], 14); // Nicosia default

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
    }).addTo(map);

    map.on('moveend', () => {
        updateMetadataForCurrentView();
    });

    updateMetadataForCurrentView();
    loadWorldIndex();
}

async function loadWorldIndex() {
    try {
        const res = await fetch('/api/world-index');
        if (!res.ok) throw new Error("Index not found");
        worldIndex = await res.json();
        
        document.getElementById('timeline-container').style.display = 'block';
        document.getElementById('global-status').innerText = `Global Index Active (Z${worldIndex.zoomLevel})`;
        
        setupTimeline();
    } catch (e) {
        document.getElementById('global-status').innerText = "Global Index: Not generated (Run WorldCrawler.js)";
    }
}

function setupTimeline() {
    const slider = document.getElementById('timeline-slider');
    const dates = Object.keys(worldIndex.dates).sort();
    
    slider.min = 0;
    slider.max = dates.length - 1;
    slider.value = dates.length - 1;
    
    document.getElementById('timeline-start').innerText = dates[0].substring(0, 4);
    document.getElementById('timeline-end').innerText = dates[dates.length - 1].substring(0, 4);

    slider.oninput = () => {
        const date = dates[slider.value];
        document.getElementById('timeline-current').innerText = date;
        highlightWorldAreas(date);
    };
}

function highlightWorldAreas(date) {
    // Clear old highlights
    highlightLayers.forEach(l => map.removeLayer(l));
    highlightLayers = [];

    const paths = worldIndex.dates[date] || [];
    paths.forEach(pathCode => {
        // Draw a rectangle for this pathCode
        // This is a simplified visualization of the global metadata coverage
        const bounds = getBoundsForPath(pathCode);
        const rect = L.rectangle(bounds, { color: "#ff7800", weight: 1, fillOpacity: 0.2 }).addTo(map);
        highlightLayers.push(rect);
    });
}

function getBoundsForPath(pathCode) {
    const VALID_BOUND_RC = [-180.0, 180.0, 180.0, -180.0];
    let west = VALID_BOUND_RC[0];
    let east = VALID_BOUND_RC[1];
    let north = VALID_BOUND_RC[2];
    let south = VALID_BOUND_RC[3];

    for (let i = 1; i < pathCode.length; i++) {
        const midLon = (west + east) / 2;
        const midLat = (south + north) / 2;
        const char = pathCode[i];

        if (char === '0') { north = north; south = midLat; west = west; east = midLon; }
        else if (char === '1') { north = north; south = midLat; west = midLon; east = east; }
        else if (char === '2') { north = midLat; south = south; west = midLon; east = east; }
        else if (char === '3') { north = midLat; south = south; west = west; east = midLon; }
    }
    return [[south, west], [north, east]];
}

async function fetchRegions() {
    const regions = [
        { name: "Cyprus (Whole)", lat: 35.1264, lon: 33.4299, z: 10 },
        { name: "Nicosia", lat: 35.1856, lon: 33.3823, z: 15 },
        { name: "Athens", lat: 37.9838, lon: 23.7275, z: 15 },
        { name: "London", lat: 51.5074, lon: -0.1278, z: 15 },
        { name: "New York", lat: 40.7128, lon: -74.0060, z: 15 }
    ];
    const list = document.getElementById('regions-list');
    list.innerHTML = '';
    regions.forEach(r => {
        const div = document.createElement('div');
        div.className = 'region-item';
        div.innerText = r.name;
        div.onclick = () => {
            document.querySelectorAll('.region-item').forEach(el => el.classList.remove('active'));
            div.classList.add('active');
            map.setView([r.lat, r.lon], r.z);
        };
        list.appendChild(div);
    });
}

async function updateMetadataForCurrentView() {
    const zoom = map.getZoom();
    const center = map.getCenter();
    
    if (zoom < 14) {
        document.getElementById('status-bar').firstChild.textContent = `Current zoom: ${zoom}. Zoom to 14+ to see available dates. `;
        document.getElementById('metadata-body').innerHTML = '<tr><td colspan="3">Zoom in further (Z14+)</td></tr>';
        return;
    }

    document.getElementById('loading-indicator').style.display = 'block';
    
    try {
        // Fetch metadata for the actual zoom level (up to Z16)
        const fetchZoom = Math.min(zoom, 16);
        const res = await fetch(`/api/metadata-at?lat=${center.lat}&lon=${center.lng}&zoom=${fetchZoom}`);
        const data = await res.json();
        
        currentMetadata = data;
        document.getElementById('status-bar').firstChild.textContent = `Path: ${data.pathCode} (Z${fetchZoom}) | Lat: ${center.lat.toFixed(4)} Lon: ${center.lng.toFixed(4)} `;
        
        renderMetadataTable(data.entries);
    } catch (e) {
        console.error(e);
    } finally {
        document.getElementById('loading-indicator').style.display = 'none';
    }
}

function renderMetadataTable(entries) {
    const body = document.getElementById('metadata-body');
    body.innerHTML = '';
    
    if (!entries || entries.length === 0) {
        body.innerHTML = '<tr><td colspan="3">No dates found for this area</td></tr>';
        return;
    }

    // Sort entries by date descending
    entries.sort((a, b) => b.date.localeCompare(a.date));

    entries.forEach(e => {
        const tr = document.createElement('tr');
        tr.className = 'metadata-row';
        tr.innerHTML = `<td>${e.date}</td><td>${e.iCode}</td><td>${e.fToken}</td>`;
        tr.onclick = () => selectHistoricalDate(e, tr);
        body.appendChild(tr);
    });
}

function selectHistoricalDate(entry, element) {
    document.querySelectorAll('.metadata-row').forEach(el => el.classList.remove('active'));
    element.classList.add('active');

    if (currentLayer) {
        map.removeLayer(currentLayer);
    }

    const tileUrl = `/api/tile/{z}/{x}/{y}?iCode=${entry.iCode}&fToken=${entry.fToken}`;
    
    currentLayer = L.tileLayer(tileUrl, {
        maxZoom: 21,
        minZoom: 10,
        attribution: '© Google Earth'
    }).addTo(map);
}

async function refreshDbRoot() {
    const res = await fetch('/api/refresh', { method: 'POST' });
    const data = await res.json();
    alert(data.message);
}

initMap();
fetchRegions();
