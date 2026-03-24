
let scene, camera, renderer, controls, currentModel, map, marker;

initThreeJS();
initMap();
animate();
loadRecentExports();

function initMap() {
    // Initial view: Googleplex
    map = L.map("map").setView([37.4208, -122.0841], 15);
    
    // Use Google Satellite tiles (not official Leaflet plugin but works)
    L.tileLayer("https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}", {
        maxZoom: 20,
        attribution: "&copy; Google Maps"
    }).addTo(map);

    marker = L.marker([37.4208, -122.0841], { draggable: true }).addTo(map);

    // Sync marker to inputs
    marker.on("dragend", () => {
        const pos = marker.getLatLng();
        document.getElementById("lat").value = pos.lat.toFixed(6);
        document.getElementById("lon").value = pos.lng.toFixed(6);
    });

    // Click map to move marker
    map.on("click", (e) => {
        marker.setLatLng(e.latlng);
        document.getElementById("lat").value = e.latlng.lat.toFixed(6);
        document.getElementById("lon").value = e.latlng.lng.toFixed(6);
    });
}

function initThreeJS() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);
    camera = new THREE.PerspectiveCamera(75, (window.innerWidth - 400) / window.innerHeight, 0.1, 1000000);
    camera.position.set(0, 500, 1000);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth - 400, window.innerHeight);
    document.getElementById("canvas-container").appendChild(renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
    directionalLight.position.set(1, 1, 1);
    scene.add(directionalLight);

    controls = new THREE.OrbitControls(camera, renderer.domElement);

    window.addEventListener("resize", onWindowResize, false);
}

function onWindowResize() {
    camera.aspect = (window.innerWidth - 400) / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth - 400, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

document.getElementById("exportBtn").addEventListener("click", async () => {
    const lat = document.getElementById("lat").value;
    const lon = document.getElementById("lon").value;
    const zoom = document.getElementById("zoom").value;
    const status = document.getElementById("status");

    status.innerText = "Finding octant and exporting OBJ... (this may take a minute)";
    
    try {
        const response = await fetch("/api/export", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lat, lon, zoom })
        });
        const data = await response.json();
        
        if (data.error) {
            status.innerText = "Error: " + data.error;
        } else {
            status.innerText = "Success! Loading model...";
            loadOBJ(data.downloadUrl);
            loadRecentExports();
        }
    } catch (err) {
        status.innerText = "Error: " + err.message;
    }
});

function loadOBJ(url) {
    if (currentModel) scene.remove(currentModel);
    
    const loader = new THREE.OBJLoader();
    loader.load(url, (obj) => {
        const box = new THREE.Box3().setFromObject(obj);
        const center = box.getCenter(new THREE.Vector3());
        obj.position.sub(center);
        
        currentModel = obj;
        scene.add(currentModel);
        
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        camera.position.set(maxDim, maxDim, maxDim);
        controls.target.set(0, 0, 0);
        
        document.getElementById("status").innerText = "Model loaded.";
    }, (xhr) => {
        const percent = Math.round((xhr.loaded / xhr.total) * 100);
        document.getElementById("status").innerText = "Loading: " + (isNaN(percent) ? "Processing..." : percent + "%");
    }, (err) => {
        document.getElementById("status").innerText = "Error loading OBJ: " + err.message;
    });
}

async function loadRecentExports() {
    const res = await fetch("/api/exports");
    const data = await res.json();
    const list = document.getElementById("list");
    list.innerHTML = "";
    data.forEach(item => {
        const li = document.createElement("li");
        li.innerText = item.name;
        li.onclick = () => loadOBJ(item.url);
        list.appendChild(li);
    });
}

