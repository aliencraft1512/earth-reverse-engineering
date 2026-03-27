
async function fetchRegions() {
    const res = await fetch('/api/regions');
    const regions = await res.json();
    const list = document.getElementById('regions-list');
    list.innerHTML = '';
    regions.forEach(r => {
        const div = document.createElement('div');
        div.className = 'region-item';
        div.innerText = r.name;
        div.onclick = () => selectRegion(r, div);
        list.appendChild(div);
    });
}

async function selectRegion(region, element) {
    document.querySelectorAll('.region-item').forEach(el => el.classList.remove('active'));
    element.classList.add('active');
    document.getElementById('current-region-name').innerText = region.name;
    
    document.getElementById('loading-metadata').style.display = 'block';
    document.getElementById('metadata-body').innerHTML = '';

    const res = await fetch(`/api/metadata/${region.pathCode}`);
    const data = await res.json();
    
    document.getElementById('loading-metadata').style.display = 'none';
    const body = document.getElementById('metadata-body');
    
    if (data.entries.length === 0) {
        body.innerHTML = '<tr><td colspan="3">No dates found for this region</td></tr>';
        return;
    }

    data.entries.forEach(e => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${e.date}</td><td>${e.iCode}</td><td>${e.fToken}</td>`;
        body.appendChild(tr);
    });
}

async function refreshDbRoot() {
    const res = await fetch('/api/refresh', { method: 'POST' });
    const data = await res.json();
    alert(data.message);
}

fetchRegions();
