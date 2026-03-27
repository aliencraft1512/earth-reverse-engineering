const test = require('node:test');
const assert = require('node:assert/strict');

const { chromium } = require('playwright');

const { startServer } = require('../HistoricalServer');

const BASE_URL = 'http://127.0.0.1:3001';
const MOCK_BOUNDS = {
  north: 35.184,
  south: 35.1606,
  east: 33.3845,
  west: 33.3489,
};
const TILE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZcdoAAAAASUVORK5CYII=';
const TILE_DATA_URL = `data:image/png;base64,${TILE_BASE64}`;

let server = null;
let ownsServer = false;

function buildMockEntries(count = 26) {
  return Array.from({ length: count }, (_, index) => {
    const day = String((index % 28) + 1).padStart(2, '0');
    const iCode = 364 - (index % 4);
    const entry = {
      date: `2025-07-${day}`,
      iCode,
      fToken: `fd${(0x200 + index).toString(16)}`,
      pathCount: 9 - (index % 3),
      paths: [`02002311210111${String(index % 10).padStart(2, '0')}`],
      sourcePaths: [`02002311210111${String(index % 10).padStart(2, '0')}`],
    };

    if (index === 0) {
      entry.duplicateCandidate = {
        mode: 'visible-tile-signature',
        versions: [364, 362],
        otherVersions: [362],
      };
    }

    return entry;
  });
}

function buildCatalogPayload(bounds = MOCK_BOUNDS, requestIndex = 1) {
  const entries = buildMockEntries();

  return {
    bounds,
    zoom: 15,
    pathCount: 9,
    entries,
    timing: {
      durationMs: 125.4,
      cacheStatus: requestIndex > 1 ? 'bounds' : 'miss',
    },
    verification: {
      requestedPathCount: 9,
      resolvedPathCount: 9,
      ancestorFallbackCount: 1,
      unresolvedPathCount: 0,
      duplicateCandidateCount: 2,
      duplicateModes: {
        'visible-tile-signature': 2,
      },
      parserModes: {
        framed: 9,
      },
    },
    paths: [
      {
        path: '0200231121011100',
        sourcePath: '0200231121011100',
        packetUrl: 'https://cmpmap.com/flatfile?db=tm&qp-0200231121011100-q.366',
        entryCount: 12,
        parser: {
          mode: 'framed',
          acceptedCount: 12,
        },
        bounds: {
          north: 35.18,
          south: 35.17,
          east: 33.37,
          west: 33.36,
        },
        entries: entries.slice(0, 8).map(entry => ({
          ...entry,
          parser: 'framed',
        })),
      },
      {
        path: '0200231121011101',
        sourcePath: '020023112101110',
        packetUrl: 'https://cmpmap.com/flatfile?db=tm&qp-020023112101110-q.366',
        entryCount: 8,
        parser: {
          mode: 'framed',
          acceptedCount: 8,
        },
        bounds: {
          north: 35.17,
          south: 35.16,
          east: 33.38,
          west: 33.37,
        },
        entries: entries.slice(4, 12).map(entry => ({
          ...entry,
          parser: 'framed',
        })),
      },
    ],
  };
}

function buildOverlayPayload(requestBody = {}) {
  return {
    bounds: requestBody.bounds || MOCK_BOUNDS,
    fidelityMode: 'allow-ancestor-derived',
    renderStrategy: 'bounds-overlay',
    zoom: requestBody.zoom || 15,
    tiles: [
      {
        path: '0200231121011100',
        bounds: {
          north: 35.178,
          south: 35.172,
          east: 33.366,
          west: 33.359,
        },
        requestedPath: '0200231121011100',
        resolvedPath: '0200231121011100',
        url: TILE_DATA_URL,
        status: 'ok',
        sourceUrl: 'https://cmpmap.com/flatfile?db=tm&f1-0200231121011100-i.364-fd200',
        version: 364,
        croppedFromParent: false,
        cacheHit: false,
        derivedCacheHit: false,
        selectionReason: 'preferred-version',
        availableVersions: [364, 362],
      },
      {
        path: '0200231121011101',
        bounds: {
          north: 35.172,
          south: 35.166,
          east: 33.373,
          west: 33.366,
        },
        requestedPath: '0200231121011101',
        resolvedPath: '020023112101110',
        url: TILE_DATA_URL,
        status: 'ok',
        sourceUrl: 'https://cmpmap.com/flatfile?db=tm&f1-020023112101110-i.362-fd200',
        version: 362,
        croppedFromParent: true,
        cacheHit: true,
        derivedCacheHit: true,
        selectionReason: 'alternate-version',
        availableVersions: [364, 362],
      },
    ],
    downloadLog: [
      {
        date: requestBody.date || '2025-07-01',
        path: '0200231121011100',
        requestedPath: '0200231121011100',
        resolvedPath: '0200231121011100',
        iCode: 364,
        fToken: requestBody.fToken || 'fd200',
        sourceUrl: 'https://cmpmap.com/flatfile?db=tm&f1-0200231121011100-i.364-fd200',
        status: 'ok',
        cacheHit: false,
        derivedCacheHit: false,
        croppedFromParent: false,
        selectionReason: 'preferred-version',
        availableVersions: [364, 362],
        message: null,
      },
      {
        date: requestBody.date || '2025-07-01',
        path: '0200231121011101',
        requestedPath: '0200231121011101',
        resolvedPath: '0200231121011101',
        iCode: 364,
        fToken: requestBody.fToken || 'fd200',
        sourceUrl: 'https://cmpmap.com/flatfile?db=tm&f1-0200231121011101-i.364-fd200',
        status: 'missing',
        cacheHit: false,
        derivedCacheHit: false,
        croppedFromParent: false,
        selectionReason: 'alternate-version',
        availableVersions: [364, 362],
        message: 'Unexpected status 404',
      },
      {
        date: requestBody.date || '2025-07-01',
        path: '0200231121011101',
        requestedPath: '0200231121011101',
        resolvedPath: '020023112101110',
        iCode: 362,
        fToken: requestBody.fToken || 'fd200',
        sourceUrl: 'https://cmpmap.com/flatfile?db=tm&f1-020023112101110-i.362-fd200',
        status: 'ok',
        cacheHit: true,
        derivedCacheHit: true,
        croppedFromParent: true,
        selectionReason: 'alternate-version',
        availableVersions: [364, 362],
        message: null,
      },
      {
        date: requestBody.date || '2025-07-01',
        path: '0200231121011110',
        requestedPath: '0200231121011110',
        resolvedPath: null,
        iCode: null,
        fToken: requestBody.fToken || 'fd200',
        sourceUrl: null,
        status: 'missing',
        cacheHit: false,
        derivedCacheHit: false,
        croppedFromParent: false,
        selectionReason: 'preferred-version-unavailable',
        availableVersions: [],
        message: 'No live metadata match for the selected date in this visible cell.',
      },
    ],
    summary: {
      fidelityMode: 'allow-ancestor-derived',
      renderStrategy: 'bounds-overlay',
      versionMode: 'exact-preferred',
      selection: {
        date: requestBody.date || '2025-07-01',
        fToken: requestBody.fToken || 'fd200',
        preferredVersion: Number.isFinite(requestBody.preferredVersion) ? requestBody.preferredVersion : 364,
      },
      totalTiles: 4,
      exactCount: 1,
      ancestorDerivedCount: 1,
      missingCount: 2,
      mixedVersion: true,
      preferredVersionCount: 1,
      alternateVersionCount: 1,
      bestValidVersionCount: 0,
      versionsUsed: [364, 362],
      updatedAt: Date.now(),
    },
  };
}

function buildSelectionDiagnosticsPayload(requestBody = {}) {
  return {
    bounds: requestBody.bounds || MOCK_BOUNDS,
    zoom: requestBody.zoom || 15,
    selection: {
      date: requestBody.date || '2025-07-01',
      fToken: requestBody.fToken || 'fd200',
      preferredVersion: Number.isFinite(requestBody.preferredVersion) ? requestBody.preferredVersion : 364,
    },
    summary: {
      totalPaths: 9,
      matchedPaths: 8,
      missingPaths: 1,
      preferredVersionPaths: 5,
      alternateVersionPaths: 3,
      bestValidVersionPaths: 0,
      versionsUsed: [364, 362],
    },
    paths: [
      {
        path: '0200231121011100',
        sourcePath: '0200231121011100',
        bounds: {
          north: 35.18,
          south: 35.17,
          east: 33.37,
          west: 33.36,
        },
        availableVersions: [364, 362],
        candidateVersions: [364, 362],
        selectedVersion: 364,
        reason: 'preferred-version',
      },
      {
        path: '0200231121011101',
        sourcePath: '020023112101110',
        bounds: {
          north: 35.17,
          south: 35.16,
          east: 33.38,
          west: 33.37,
        },
        availableVersions: [362],
        candidateVersions: [364, 362],
        selectedVersion: 362,
        reason: 'alternate-version',
      },
    ],
  };
}

async function isServerReachable(url) {
  try {
    const response = await fetch(url);
    return response.ok || response.status === 404;
  } catch (error) {
    return false;
  }
}

async function waitForServer(url, timeoutMs = 30000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await isServerReachable(url)) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForCondition(predicate, timeoutMs = 30000, intervalMs = 100) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  throw new Error('Timed out waiting for condition.');
}

async function installMockApi(page) {
  const requests = {
    catalogs: [],
    overlays: [],
    selectionDiagnostics: [],
  };

  await page.route('**/api/catalog', async route => {
    const requestBody = route.request().postDataJSON();
    requests.catalogs.push(requestBody);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildCatalogPayload(requestBody.bounds, requests.catalogs.length)),
    });
  });

  await page.route('**/api/overlays', async route => {
    const requestBody = route.request().postDataJSON();
    requests.overlays.push(requestBody);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildOverlayPayload(requestBody)),
    });
  });

  await page.route('**/api/selection-diagnostics', async route => {
    const requestBody = route.request().postDataJSON();
    requests.selectionDiagnostics.push(requestBody);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildSelectionDiagnosticsPayload(requestBody)),
    });
  });

  return requests;
}

test.before(async () => {
  if (await isServerReachable(BASE_URL)) {
    await waitForServer(BASE_URL);
    return;
  }

  ownsServer = true;
  server = startServer();
  await waitForServer(BASE_URL);
});

test.after(async () => {
  if (!server || !ownsServer) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
});

test('frontend smoke: bounds refresh, date selection, overlays, and tile download log', { timeout: 180000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const requests = await installMockApi(page);

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => document.querySelectorAll('#dateList .date-item:not(.empty)').length > 0,
      { timeout: 30000 }
    );

    assert.equal(await page.locator('#entriesPanel').evaluate(node => node.open), true);
    assert.equal(await page.locator('#verificationPanel').evaluate(node => node.open), true);
    assert.equal(await page.locator('#downloadLogPanel').evaluate(node => node.open), true);
    assert.equal(await page.locator('#pathDebugPanel').evaluate(node => node.open), false);

    const entryItems = page.locator('#dateList .date-item:not(.empty)');
    assert.ok((await entryItems.count()) > 0, 'expected at least one historical entry');

    const dateList = page.locator('#dateList');
    await page.waitForFunction(() => {
      const node = document.getElementById('dateList');
      return Boolean(node && node.scrollHeight > node.clientHeight);
    }, { timeout: 30000 });

    const programmaticScroll = await dateList.evaluate(node => {
      node.scrollTop = 1200;
      return node.scrollTop;
    });
    const initialZoom = await page.evaluate(() => window.__historicalDebug.getMap().getZoom());
    await dateList.hover();
    await page.mouse.wheel(0, 1200);
    const zoomAfterWheel = await page.evaluate(() => window.__historicalDebug.getMap().getZoom());

    assert.ok(programmaticScroll > 0, 'expected the list container to be scrollable');
    assert.equal(zoomAfterWheel, initialZoom, 'expected the map zoom to remain unchanged while scrolling the list');

    await entryItems.first().click();
    await page.waitForFunction(
      () => document.getElementById('selectionStatus')?.textContent.includes('Showing 2025-07-01'),
      { timeout: 30000 }
    );
    await page.waitForFunction(
      () => document.getElementById('selectionStatus')?.textContent.includes('Coverage 8/9 visible cells'),
      { timeout: 30000 }
    );
    await page.waitForFunction(
      () => document.getElementById('renderSummary')?.textContent.includes('Tiles loaded 2/4 visible cells'),
      { timeout: 30000 }
    );
    await page.waitForFunction(
      () => document.querySelectorAll('#downloadLogList .download-log-entry').length >= 4,
      { timeout: 30000 }
    );

    const overlayState = await page.evaluate(() => {
      const layer = window.__historicalDebug.getHistoricalLayer();
      return {
        isLayerGroup: Boolean(layer && typeof layer.eachLayer === 'function'),
        downloadLogLength: window.__historicalDebug.getDownloadLog().length,
      };
    });

    assert.equal(overlayState.isLayerGroup, true);
    assert.ok(overlayState.downloadLogLength >= 4);
    assert.ok(requests.overlays.length > 0, 'expected mocked overlay requests');
    assert.ok(requests.selectionDiagnostics.length > 0, 'expected mocked selection diagnostics requests');

    const renderText = await page.locator('#renderSummary').textContent();
    assert.match(renderText || '', /Parent-derived 1/);
    assert.match(renderText || '', /Missing 2/);

    const logText = await page.locator('#downloadLogList').textContent();
    assert.match(logText || '', /OK/);
    assert.match(logText || '', /MISSING/);
    assert.match(logText || '', /network/i);
    assert.match(logText || '', /tile cache|derived cache/i);

    await page.locator('#pathDebugPanel .accordion-summary').click();
    await page.waitForFunction(() => document.getElementById('pathDebugPanel')?.open === true, { timeout: 30000 });
    const pathCards = page.locator('#pathDebugList details');
    assert.ok((await pathCards.count()) > 0, 'expected visible path debug cards');
    await pathCards.first().click();

    const firstPathText = await pathCards.first().textContent();
    assert.match(firstPathText || '', /Packet:/);
    assert.match(firstPathText || '', /Accepted tuples/);
    assert.match(firstPathText || '', /Selection:/);
    assert.match(firstPathText || '', /Available versions:/);

    const firstCatalogNonce = await page.evaluate(() => window.__historicalDebug.getRequestNonce());
    await page.evaluate(() => {
      const map = window.__historicalDebug.getMap();
      map.setView([35.1756, 33.375], 15, { animate: false });
    });
    await page.waitForFunction(
      nonce => window.__historicalDebug.getRequestNonce() > nonce,
      firstCatalogNonce,
      { timeout: 30000 }
    );
    await waitForCondition(() => requests.catalogs.length >= 2, 30000);
    await waitForCondition(() => requests.overlays.length >= 2, 30000);

    assert.ok(requests.catalogs.length >= 2, 'expected multiple catalog responses after the bounds change');
    assert.ok(requests.overlays.length >= 2, 'expected overlay refresh after the bounds change');
    assert.equal(requests.catalogs[0].zoom, 15);
    assert.ok(requests.catalogs[0].bounds.north > requests.catalogs[0].bounds.south, 'expected a real north/south bounds box');
    assert.ok(requests.catalogs[0].bounds.east > requests.catalogs[0].bounds.west, 'expected a real east/west bounds box');
    assert.equal(requests.overlays[0].preferredVersion, 364);
  } finally {
    await browser.close();
  }
});
