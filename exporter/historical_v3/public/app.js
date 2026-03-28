
let map;
let currentMetadata = null;
let worldIndex = null;
let highlightLayers = [];
let historicalLayer = null; 
let activeSelection = null;

function initMap() {
    map = L.map('map').setView([35.1856, 33.3823], 14);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
    }).addTo(map);

    let moveTimeout;
    map.on('moveend', () => {
        clearTimeout(moveTimeout);
        moveTimeout = setTimeout(() => {
            updateMetadataForCurrentView();
        }, 300);
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
        document.getElementById('global-status').innerText = `Global Index Active`;
        setupTimeline();
    } catch (e) {
        document.getElementById('global-status').innerText = "Global Index: Not found";
    }
}

function setupTimeline() {
    const slider = document.getElementById('timeline-slider');
    const dates = Object.keys(worldIndex.dates).sort();
    slider.min = 0; slider.max = dates.length - 1; slider.value = dates.length - 1;
    slider.oninput = () => {
        const date = dates[slider.value];
        document.getElementById('timeline-current').innerText = date;
        highlightWorldAreas(date);
    };
}

function highlightWorldAreas(date) {
    highlightLayers.forEach(l => map.removeLayer(l));
    highlightLayers = [];
    const paths = worldIndex.dates[date] || [];
    paths.forEach(pathCode => {
        const bounds = getBoundsForPath(pathCode);
        const rect = L.rectangle(bounds, { color: "#ff7800", weight: 1, fillOpacity: 0.15 }).addTo(map);
        highlightLayers.push(rect);
    });
}

function getBoundsForPath(pathCode) {
    const ValidBoundRc = [-180.0, 180.0, 180.0, -180.0];
    let west = ValidBoundRc[0], east = ValidBoundRc[1], north = ValidBoundRc[2], south = ValidBoundRc[3];
    for (let i = 0; i < pathCode.length; i++) {
        const midLon = (west + east) / 2;
        const midLat = (south + north) / 2;
        const char = pathCode[i];
        if (char === '0') { north = midLat; east = midLon; }
        else if (char === '1') { north = midLat; west = midLon; }
        else if (char === '2') { south = midLat; west = midLon; }
        else if (char === '3') { south = midLat; east = midLon; }
    }
    return [[south, west], [north, east]];
}

async function updateMetadataForCurrentView() {
    const zoom = map.getZoom();
    const center = map.getCenter();
    if (zoom < 14) {
        document.getElementById('status-bar').firstChild.textContent = `Zoom in (Z14+) `;
        return;
    }
    document.getElementById('loading-indicator').style.display = 'block';
    try {
        const fetchZoom = Math.min(zoom, 16);
        const res = await fetch(`/api/metadata-at?lat=${center.lat}&lon=${center.lng}&zoom=${fetchZoom}`);
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
    
    entries.sort((a, b) => b.date.localeCompare(a.date)).forEach(e => {
        const tr = document.createElement('tr');
        tr.className = 'metadata-row';
        if (activeSelection && activeSelection.date === e.date) tr.classList.add('active');
        
        const dateTd = document.createElement('td');
        dateTd.innerHTML = `<span style="margin-right:10px">${e.date}</span>`;
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';
        copyBtn.innerText = '📋';
        copyBtn.onclick = (event) => {
            event.stopPropagation();
            copyToClipboard(`${e.date} (v.${e.iCode}, ${e.fToken})`, copyBtn, tr);
        };
        dateTd.appendChild(copyBtn);
        tr.appendChild(dateTd);

        tr.innerHTML += `<td>${e.iCode}</td><td>${e.fToken}</td>`;
        
        tr.onclick = () => {
            activeSelection = e;
            document.querySelectorAll('.metadata-row').forEach(el => el.classList.remove('active'));
            tr.classList.add('active');
            refreshHistoricalLayer();
        };
        body.appendChild(tr);
    });
}

function refreshHistoricalLayer() {
    if (historicalLayer) {
        map.removeLayer(historicalLayer);
    }
    if (!activeSelection) return;

    // Use L.tileLayer for parallel loading speed
    // We pass sourcePath to the backend so it knows when to crop
    const tileUrl = `/api/tile/{z}/{x}/{y}?iCode=${activeSelection.iCode}&fToken=${activeSelection.fToken}&sourcePath=${activeSelection.sourcePath}`;
    
    historicalLayer = L.tileLayer(tileUrl, {
        maxZoom: 21,
        minZoom: 5,
        opacity: 1.0,
        attribution: '© Google Earth'
    }).addTo(map);
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
