const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3010);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SERVER_BOOT_TIMEOUT_MS = 15000;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  return { response, data, text };
}

async function waitForHealth(baseUrl, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const { response, data } = await fetchJson(`${baseUrl}/api/health`);
      if (response.ok && data && data.ok) {
        return data;
      }
    } catch (error) {
      // server may still be booting
    }
    await delay(300);
  }
  throw new Error(`Server did not become healthy within ${timeoutMs} ms`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';

  server.stdout.on('data', chunk => {
    stdout += chunk.toString();
  });
  server.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });

  try {
    const health = await waitForHealth(BASE_URL, SERVER_BOOT_TIMEOUT_MS);
    assert(health.ok === true, 'Health endpoint did not return ok=true');

    const indexPage = await fetch(`${BASE_URL}/`);
    const html = await indexPage.text();
    assert(indexPage.ok, `Root page returned ${indexPage.status}`);
    assert(html.includes('timeline-slider'), 'Root HTML is missing timeline-slider');
    assert(html.includes('Historical Imagery Timeline'), 'Root HTML is missing timeline UI text');

    const discover = await fetchJson(`${BASE_URL}/api/layers/discover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bounds: { west: 33.28, south: 35.10, east: 33.45, north: 35.22 },
        zoom: 16,
      }),
    });
    assert(discover.response.ok, `Discover endpoint returned ${discover.response.status}`);
    assert(discover.data && Array.isArray(discover.data.layers), 'Discover payload missing layers array');

    const coverageIndex = await fetchJson(`${BASE_URL}/api/coverage/index`);
    assert(coverageIndex.response.ok, `Coverage index endpoint returned ${coverageIndex.response.status}`);
    assert(coverageIndex.data && typeof coverageIndex.data === 'object', 'Coverage index payload is not an object');

    const geojson = await fetchJson(`${BASE_URL}/api/coverage/geojson?verifiedOnly=true`);
    assert(geojson.response.ok, `Coverage geojson endpoint returned ${geojson.response.status}`);
    assert(geojson.data && geojson.data.ok === true, 'Coverage geojson payload missing ok=true');

    console.log(JSON.stringify({
      status: 'ok',
      baseUrl: BASE_URL,
      health: {
        generatedAt: health.now,
        pathCount: health.coverageIndex?.pathCount ?? null,
        layerCount: health.coverageIndex?.layerCount ?? null,
      },
      discover: {
        layerCount: discover.data.layers.length,
      },
      geojson: {
        filePath: geojson.data.filePath || geojson.data.outPath || null,
        featureCount: geojson.data.featureCount ?? null,
      },
    }, null, 2));
  } finally {
    server.kill('SIGTERM');
    await delay(300);
    if (!server.killed) {
      server.kill('SIGKILL');
    }
    if (stderr.trim()) {
      console.error(stderr.trim());
    }
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
