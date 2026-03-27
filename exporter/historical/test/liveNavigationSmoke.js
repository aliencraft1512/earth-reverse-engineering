const fs = require('node:fs');
const path = require('node:path');

const { chromium } = require('playwright');

const { startServer } = require('../HistoricalServer');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_LIMIT = 6;
const DEFAULT_SEED = 20260327;
const DEFAULT_CLICKS_PER_TARGET = 2;
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
    clicksPerTarget: DEFAULT_CLICKS_PER_TARGET,
    reportPath: null,
    strict: false,
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
      continue;
    }

    if (argument.startsWith('--clicks=')) {
      options.clicksPerTarget = Number.parseInt(argument.slice('--clicks='.length), 10);
      continue;
    }

    if (argument === '--strict') {
      options.strict = true;
    }
  }

  if (!Number.isFinite(options.seed)) {
    options.seed = DEFAULT_SEED;
  }

  if (!Number.isFinite(options.limit) || options.limit < 1) {
    options.limit = DEFAULT_LIMIT;
  }

  if (!Number.isFinite(options.clicksPerTarget) || options.clicksPerTarget < 1) {
    options.clicksPerTarget = DEFAULT_CLICKS_PER_TARGET;
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

function buildEntryId(entry) {
  return `${entry.date}|${entry.iCode}|${entry.fToken}`;
}

function compareCoverageDesc(left, right) {
  const leftPathCount = Number.isFinite(left?.pathCount) ? left.pathCount : 0;
  const rightPathCount = Number.isFinite(right?.pathCount) ? right.pathCount : 0;

  if (leftPathCount !== rightPathCount) {
    return rightPathCount - leftPathCount;
  }

  if (left?.date !== right?.date) {
    return String(right?.date || '').localeCompare(String(left?.date || ''));
  }

  return (right?.iCode || 0) - (left?.iCode || 0);
}

function compareAgeAsc(left, right) {
  if (left?.date !== right?.date) {
    return String(left?.date || '').localeCompare(String(right?.date || ''));
  }

  return compareCoverageDesc(left, right);
}

function pickEntriesToTest(entries, clickCount = DEFAULT_CLICKS_PER_TARGET) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }

  const uniqueEntries = new Map();
  const byCoverage = [...entries].sort(compareCoverageDesc);
  const byAge = [...entries].sort(compareAgeAsc);

  for (const candidate of [byCoverage[0], byAge[0], ...byCoverage]) {
    if (!candidate) {
      continue;
    }

    uniqueEntries.set(buildEntryId(candidate), candidate);

    if (uniqueEntries.size >= clickCount) {
      break;
    }
  }

  return Array.from(uniqueEntries.values()).slice(0, clickCount);
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

async function clickEntryAndCollectState(page, entry) {
  const entryId = buildEntryId(entry);
  const locator = page.locator(`#dateList .date-item[data-entry-id="${entryId}"]`);
  await locator.click();
  await waitForRenderAttempt(page);
  const state = await collectLocationState(page);
  const downloadStatusCounts = summarizeDownloadLog(state.downloadLog);
  const selectedEntryId = state.selectedEntry ? buildEntryId(state.selectedEntry) : null;
  const failureReasons = [];

  if (selectedEntryId !== entryId) {
    failureReasons.push('selection-mismatch');
  }

  if (state.downloadLog.length === 0) {
    failureReasons.push('no-download-log');
  }

  if ((downloadStatusCounts.ok || 0) === 0) {
    failureReasons.push('no-successful-tiles');
  }

  if (state.overlayCount === 0) {
    failureReasons.push('no-overlays');
  }

  if (/Error rendering historical imagery/i.test(state.statusText)) {
    failureReasons.push('render-error');
  }

  return {
    entry: {
      id: entryId,
      date: entry.date,
      iCode: entry.iCode,
      fToken: entry.fToken,
      pathCount: entry.pathCount,
    },
    statusText: state.statusText,
    selectionText: state.selectionText,
    renderSummary: state.renderSummary,
    overlayCount: state.overlayCount,
    downloadLogCount: state.downloadLog.length,
    downloadStatusCounts,
    passed: failureReasons.length === 0,
    failureReasons,
  };
}

function summarizeLocationResult(target, state, clickResults = []) {
  const catalog = state.catalog || { entries: [], verification: {}, paths: [] };
  const entries = catalog.entries || [];
  const dates = entries.map(entry => entry.date).sort();
  const parserModes = catalog.verification?.parserModes || {};
  const errorPaths = (catalog.paths || []).filter(pathInfo => pathInfo.parser?.mode === 'error');
  const failureReasons = [];

  if (
    errorPaths.length === (catalog.verification?.requestedPathCount || 0) &&
    errorPaths.length > 0
  ) {
    failureReasons.push('metadata-fetch-failed');
  } else if (entries.length === 0) {
    failureReasons.push('no-dates-returned');
  }

  if (entries.length > 0 && clickResults.length === 0) {
    failureReasons.push('no-render-attempt');
  }

  const failingClicks = clickResults.filter(result => !result.passed);
  if (entries.length > 0 && failingClicks.length === clickResults.length && clickResults.length > 0) {
    failureReasons.push('all-clicks-failed');
  }

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
      id: buildEntryId(state.selectedEntry),
      date: state.selectedEntry.date,
      iCode: state.selectedEntry.iCode,
      fToken: state.selectedEntry.fToken,
    } : null,
    overlayCount: state.overlayCount,
    downloadLogCount: state.downloadLog.length,
    downloadStatusCounts: summarizeDownloadLog(state.downloadLog),
    clickResults,
    failureReasons,
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
    targetsWithSuccessfulClicks: 0,
    targetsWithMetadataErrors: 0,
    clickAttempts: 0,
    clickFailures: 0,
    targetFailures: 0,
    parserModes: {},
    failures: [],
  };

  for (const result of results) {
    if (result.catalogEntryCount > 0) {
      totals.targetsWithEntries += 1;
    }

    if (result.overlayCount > 0) {
      totals.targetsWithRenderedOverlays += 1;
    }

    if (result.clickResults.some(click => click.passed)) {
      totals.targetsWithSuccessfulClicks += 1;
    }

    if (
      result.metadataErrorCount > 0 ||
      (result.downloadStatusCounts.error || 0) > 0 ||
      /Error verifying historical metadata|Live metadata fetch failed/i.test(result.statusText)
    ) {
      totals.targetsWithMetadataErrors += 1;
    }

    totals.clickAttempts += result.clickResults.length;
    totals.clickFailures += result.clickResults.filter(click => !click.passed).length;

    if (result.failureReasons.length > 0 || result.clickResults.some(click => !click.passed)) {
      totals.targetFailures += 1;
      totals.failures.push({
        label: result.label,
        failureReasons: result.failureReasons,
        clickFailures: result.clickResults
          .filter(click => !click.passed)
          .map(click => ({
            entry: click.entry,
            failureReasons: click.failureReasons,
            statusText: click.statusText,
          })),
      });
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
      const clickResults = [];

      if (state.catalog?.entries?.length > 0) {
        state = await collectLocationState(page);

        for (const entry of pickEntriesToTest(state.catalog.entries, options.clicksPerTarget)) {
          const clickResult = await clickEntryAndCollectState(page, entry);
          clickResults.push(clickResult);
          state = await collectLocationState(page);
        }
      }

      results.push(summarizeLocationResult(target, state, clickResults));
    }

    const summary = buildSummary(results);
    const report = {
      generatedAt: new Date().toISOString(),
      seed: options.seed,
      limit: options.limit,
      clicksPerTarget: options.clicksPerTarget,
      strict: options.strict,
      baseUrl,
      summary,
      results,
    };

    const reportPath = options.reportPath || path.join(REPORT_DIRECTORY, 'live-navigation-report.json');
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ reportPath, ...report }, null, 2));

    if (report.summary.targetsWithEntries === 0 || (options.strict && report.summary.failures.length > 0)) {
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
