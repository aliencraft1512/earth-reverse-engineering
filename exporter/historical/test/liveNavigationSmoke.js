const fs = require('node:fs');
const path = require('node:path');

const { chromium } = require('playwright');

const { startServer } = require('../HistoricalServer');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_LIMIT = 6;
const DEFAULT_SEED = 20260327;
const REPORT_DIRECTORY = path.join(__dirname, '..', 'output');

const WORLD_TARGETS = [
  { label: 'Nicosia', center: [35.1723, 33.3667], zoom: 15 },
  { label: 'London', center: [51.5074, -0.1278], zoom: 15 },
  { label: 'New York', center: [40.7128, -74.006], zoom: 15 },
  { label: 'Tokyo', center: [35.6762, 139.6503], zoom: 15 },
  { label: 'Cairo', center: [30.0444, 31.2357], zoom: 15 },
  { label: 'Rio', center: [-22.9068, -43.1729], zoom: 15 },
  { label: 'Sydney', center: [-33.8688, 151.2093], zoom: 15 },
  { label: 'Cape Town', center: [-33.9249, 18.4241], zoom: 15 },
  { label: 'Buenos Aires', center: [-34.6037, -58.3816], zoom: 15 },
  { label: 'Reykjavik', center: [64.1466, -21.9426], zoom: 15 },
];

function parseCliArgs(argv) {
  const options = {
    seed: DEFAULT_SEED,
    limit: DEFAULT_LIMIT,
    reportPath: null,
  };

  for (const argument of argv) {
    if (argument.startsWith('--seed=')) {
      options.seed = Number.parseInt(argument.slice('--seed='.length), 10);
      continue;
    }

    if (argument.startsWith('--limit=')) {
      options.limit = Number.parseInt(argument.slice('--limit='.length), 10);
      continue;
    }

    if (argument.startsWith('--report=')) {
      options.reportPath = path.resolve(argument.slice('--report='.length));
    }
  }

  if (!Number.isFinite(options.seed)) {
    options.seed = DEFAULT_SEED;
  }

  if (!Number.isFinite(options.limit) || options.limit < 1) {
    options.limit = DEFAULT_LIMIT;
  }

  return options;
}

function mulberry32(seed) {
  let value = seed >>> 0;

  return () => {
    value += 0x6d2b79f5;
    let result = Math.imul(value ^ (value >>> 15), value | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleTargets(targets, seed) {
  const random = mulberry32(seed);
  const shuffled = [...targets];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  return shuffled;
}

async function waitForServer(baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok || response.status === 404) {
        return;
      }
    } catch (error) {
      // Keep polling until the timeout expires.
    }

    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${baseUrl}`);
}

async function waitForListening(server) {
  if (server.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

async function waitForCatalogRefresh(page, previousNonce) {
  await page.waitForFunction(
    nonce => {
      const debug = window.__historicalDebug;
      const status = document.getElementById('status')?.textContent || '';
      return Boolean(
        debug &&
        debug.getRequestNonce() > nonce &&
        !/Verifying live historical metadata/i.test(status)
      );
    },
    previousNonce,
    { timeout: DEFAULT_TIMEOUT_MS }
  );
}

async function waitForRenderAttempt(page) {
  await page.waitForFunction(
    () => {
      const debug = window.__historicalDebug;
      const status = document.getElementById('status')?.textContent || '';
      const hasDownloadLog = Boolean(debug && debug.getDownloadLog().length > 0);
      return hasDownloadLog || !/Downloading historical tiles|Preparing historical imagery/i.test(status);
    },
    { timeout: DEFAULT_TIMEOUT_MS }
  );
}

async function collectLocationState(page) {
  return page.evaluate(() => {
    const debug = window.__historicalDebug;
    const catalog = debug?.getCatalog() || null;
    const selectedEntry = debug?.getSelectedEntry() || null;
    const downloadLog = debug?.getDownloadLog() || [];
    const historicalLayer = debug?.getHistoricalLayer();
    const overlayCount = historicalLayer && typeof historicalLayer.eachLayer === 'function'
      ? historicalLayer.getLayers().length
      : 0;

    return {
      statusText: document.getElementById('status')?.textContent?.trim() || '',
      selectionText: document.getElementById('selectionStatus')?.textContent?.trim() || '',
      renderSummary: document.getElementById('renderSummary')?.textContent?.trim() || '',
      requestNonce: debug?.getRequestNonce() || 0,
      catalog,
      selectedEntry,
      downloadLog,
      overlayCount,
    };
  });
}

function summarizeDownloadLog(downloadLog) {
  const statusCounts = {};

  for (const entry of downloadLog) {
    statusCounts[entry.status] = (statusCounts[entry.status] || 0) + 1;
  }

  return statusCounts;
}

function summarizeLocationResult(target, state) {
  const catalog = state.catalog || { entries: [], verification: {}, paths: [] };
  const entries = catalog.entries || [];
  const dates = entries.map(entry => entry.date).sort();
  const parserModes = catalog.verification?.parserModes || {};
  const errorPaths = (catalog.paths || []).filter(pathInfo => pathInfo.parser?.mode === 'error');

  return {
    label: target.label,
    center: target.center,
    zoom: target.zoom,
    statusText: state.statusText,
    selectionText: state.selectionText,
    renderSummary: state.renderSummary,
    catalogEntryCount: entries.length,
    requestedPathCount: catalog.verification?.requestedPathCount || 0,
    resolvedPathCount: catalog.verification?.resolvedPathCount || 0,
    unresolvedPathCount: catalog.verification?.unresolvedPathCount || 0,
    parserModes,
    metadataErrorCount: errorPaths.length,
    metadataErrorSample: errorPaths[0]?.parser?.message || null,
    oldestDate: dates[0] || null,
    newestDate: dates[dates.length - 1] || null,
    selectedEntry: state.selectedEntry ? {
      id: state.selectedEntry.id,
      date: state.selectedEntry.date,
      iCode: state.selectedEntry.iCode,
      fToken: state.selectedEntry.fToken,
    } : null,
    overlayCount: state.overlayCount,
    downloadLogCount: state.downloadLog.length,
    downloadStatusCounts: summarizeDownloadLog(state.downloadLog),
    firstPath: catalog.paths?.[0] ? {
      path: catalog.paths[0].path,
      sourcePath: catalog.paths[0].sourcePath,
      packetUrl: catalog.paths[0].packetUrl,
      parserMode: catalog.paths[0].parser?.mode || null,
      entryCount: catalog.paths[0].entryCount,
    } : null,
  };
}

function buildSummary(results) {
  const totals = {
    targetCount: results.length,
    targetsWithEntries: 0,
    targetsWithRenderedOverlays: 0,
    targetsWithMetadataErrors: 0,
    parserModes: {},
  };

  for (const result of results) {
    if (result.catalogEntryCount > 0) {
      totals.targetsWithEntries += 1;
    }

    if (result.overlayCount > 0) {
      totals.targetsWithRenderedOverlays += 1;
    }

    if (
      result.metadataErrorCount > 0 ||
      (result.downloadStatusCounts.error || 0) > 0 ||
      /Error verifying historical metadata|Live metadata fetch failed/i.test(result.statusText)
    ) {
      totals.targetsWithMetadataErrors += 1;
    }

    for (const [mode, count] of Object.entries(result.parserModes)) {
      totals.parserModes[mode] = (totals.parserModes[mode] || 0) + count;
    }
  }

  return totals;
}

async function run() {
  const options = parseCliArgs(process.argv.slice(2));
  const targets = shuffleTargets(WORLD_TARGETS, options.seed).slice(0, options.limit);
  const server = startServer({ port: 0, host: DEFAULT_HOST, exitOnError: false });
  await waitForListening(server);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 3001;
  const baseUrl = `http://${DEFAULT_HOST}:${port}`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });

  try {
    await waitForServer(baseUrl);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => Boolean(window.__historicalDebug && typeof window.__historicalDebug.getRequestNonce === 'function'),
      { timeout: DEFAULT_TIMEOUT_MS }
    );

    const results = [];

    for (const target of targets) {
      const previousNonce = await page.evaluate(() => window.__historicalDebug.getRequestNonce());
      await page.evaluate(
        location => {
          window.__historicalDebug.getMap().setView(location.center, location.zoom, { animate: false });
        },
        target
      );
      await waitForCatalogRefresh(page, previousNonce);

      let state = await collectLocationState(page);

      if (state.catalog?.entries?.length > 0) {
        await page.locator('#dateList .date-item:not(.empty)').first().click();
        await waitForRenderAttempt(page);
        state = await collectLocationState(page);
      }

      results.push(summarizeLocationResult(target, state));
    }

    const report = {
      generatedAt: new Date().toISOString(),
      seed: options.seed,
      limit: options.limit,
      baseUrl,
      summary: buildSummary(results),
      results,
    };

    const reportPath = options.reportPath || path.join(REPORT_DIRECTORY, 'live-navigation-report.json');
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ reportPath, ...report }, null, 2));

    if (report.summary.targetsWithEntries === 0) {
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => {
      server.close(error => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

run().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
