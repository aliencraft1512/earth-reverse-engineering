
let map, historicalLayer;
let selectedDate = null;

initMap();

function initMap() {
    map = L.map('map').setView([35.1723, 33.3667], 15); // Nicosia, Cyprus

    L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
        maxZoom: 20,
        attribution: '&copy; Google Maps'
    }).addTo(map);

    map.on('moveend', updateDates);
    updateDates();
}

async function updateDates() {
    const center = map.getCenter();
    const zoom = Math.max(17, map.getZoom());
    const status = document.getElementById('status');
    status.innerText = `Updating dates for zoom ${zoom}...`;

    try {
        const res = await fetch(`/api/dates?lat=${center.lat}&lon=${center.lng}&zoom=${zoom}`);
        const data = await res.json();
        
        renderDateList(data.dates);
        status.innerText = `Path: ${data.path}`;
    } catch (err) {
        status.innerText = 'Error fetching dates: ' + err.message;
    }
}

function renderDateList(dates) {
    const list = document.getElementById('dateList');
    list.innerHTML = '';

    if (dates.length === 0) {
        list.innerHTML = '<div class="date-item">No historical data found</div>';
        return;
    }

    dates.forEach(entry => {
        const div = document.createElement('div');
        div.className = 'date-item';
        if (selectedDate && selectedDate.date === entry.date) div.classList.add('active');
        
        div.innerText = `${entry.date} (i.${entry.iCode})`;
        div.onclick = () => selectDate(entry);
        list.appendChild(div);
    });
}

function selectDate(entry) {
    selectedDate = entry;
    
    // Update UI
    document.querySelectorAll('.date-item').forEach(el => {
        el.classList.toggle('active', el.innerText.startsWith(entry.date));
    });

    if (historicalLayer) {
        map.removeLayer(historicalLayer);
    }

    // Add historical tile layer using the simplified z/x/y endpoint
    historicalLayer = L.tileLayer(`/api/tile/{z}/{x}/{y}/${entry.iCode}/${entry.fToken}`, {
        maxZoom: 20,
        attribution: 'Historical Imagery'
    }).addTo(map);
}
