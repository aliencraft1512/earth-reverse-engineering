const test = require('node:test');
const assert = require('node:assert/strict');

const { chromium } = require('playwright');

const { startServer } = require('../HistoricalServer');

const BASE_URL = 'http://127.0.0.1:3001';

let server = null;
let ownsServer = false;

async function isServerReachable(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch (error) {
    return false;
  }
}

async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);

      if (response.ok) {
        return;
      }
    } catch (error) {
      // Retry until the timeout expires.
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for ${url}`);
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

test('frontend smoke: bounds refresh, list scroll, selection, and tile responses', { timeout: 180000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });

  const catalogResponses = [];

  page.on('response', async response => {
    if (!response.url().includes('/api/catalog')) {
      return;
    }

    try {
      catalogResponses.push(await response.json());
    } catch (error) {
      // Ignore non-JSON failures.
    }
  });

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => document.getElementById('status')?.textContent.includes('Verified'),
      { timeout: 180000 }
    );

    const entryItems = page.locator('#dateList .date-item:not(.empty)');
    assert.ok((await entryItems.count()) > 0, 'expected at least one historical entry');

    const dateList = page.locator('#dateList');
    await page.waitForFunction(() => {
      const node = document.getElementById('dateList');
      return Boolean(node && node.scrollHeight > node.clientHeight);
    }, { timeout: 30000 });

    await dateList.evaluate(node => {
      node.scrollTop = node.scrollHeight;
    });

    const scrollState = await dateList.evaluate(node => ({
      top: node.scrollTop,
      height: node.scrollHeight,
      client: node.clientHeight,
    }));
    assert.ok(scrollState.height > scrollState.client, 'expected the entry list to overflow');
    assert.ok(scrollState.top > 0, 'expected the entry list to scroll');

    const zoomBeforeWheel = await page.evaluate(() => window.__historicalDebug.getMap().getZoom());
    const listBox = await dateList.boundingBox();
    assert.ok(listBox, 'expected entry list bounding box');

    await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + listBox.height / 2);
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(500);

    const [zoomAfterWheel, scrolledAfterWheel] = await page.evaluate(() => {
      const node = document.getElementById('dateList');
      return [window.__historicalDebug.getMap().getZoom(), node.scrollTop];
    });
    assert.equal(zoomAfterWheel, zoomBeforeWheel, 'expected sidebar wheel input not to zoom the map');
    assert.ok(scrolledAfterWheel > 0, 'expected the list to retain wheel-driven scroll');

    const firstEntry = entryItems.first();
    await firstEntry.click();
    await page.waitForFunction(
      () => document.getElementById('selectionStatus')?.textContent.includes('Selected'),
      { timeout: 30000 }
    );

    const tileResponse = await page.waitForResponse(response => {
      return response.url().includes('/api/tile/') && response.status() === 200;
    }, { timeout: 180000 });
    const tileHeaders = await tileResponse.allHeaders();
    assert.ok(tileHeaders['x-historical-requested-path'], 'expected requested path header');
    assert.ok(tileHeaders['x-historical-resolved-path'], 'expected resolved path header');
    assert.ok(tileHeaders['x-historical-version'], 'expected resolved version header');

    const firstCatalogNonce = await page.evaluate(() => window.__historicalDebug.getRequestNonce());
    await page.evaluate(() => {
      const map = window.__historicalDebug.getMap();
      map.setView([35.1765, 33.3775], map.getZoom(), { animate: false });
    });

    await page.waitForFunction(
      previousNonce => window.__historicalDebug.getRequestNonce() > previousNonce,
      firstCatalogNonce,
      { timeout: 30000 }
    );
    await page.waitForFunction(
      () => document.getElementById('status')?.textContent.includes('Verified'),
      { timeout: 180000 }
    );

    const verificationText = await page.locator('#verificationSummary').textContent();
    assert.match(verificationText || '', /Parser modes/i);

    const pathCards = page.locator('#pathDebugList details');
    assert.ok((await pathCards.count()) > 0, 'expected visible path debug cards');
    await pathCards.first().click();

    const firstPathText = await pathCards.first().textContent();
    assert.match(firstPathText || '', /Packet:/);
    assert.match(firstPathText || '', /Accepted tuples/);

    assert.ok(catalogResponses.length >= 2, 'expected multiple catalog responses after the bounds change');
    const lastCatalog = catalogResponses[catalogResponses.length - 1];
    assert.ok(lastCatalog.verification.parserModes.framed > 0, 'expected framed parser usage');
    assert.ok(lastCatalog.paths[0].packetUrl.includes('qp-'), 'expected qp packet URL in debug data');
  } finally {
    await browser.close();
  }
});
