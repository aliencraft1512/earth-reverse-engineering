const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startServer } = require('../HistoricalServer');

const DEFAULT_HOST = '127.0.0.1';
const TEST_PORT = 3002;
const BASE_URL = 'http://' + DEFAULT_HOST + ':' + TEST_PORT;
const SEED = Date.now();
const TARGET_COUNT = 3;

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = Math.imul(value ^ (value >>> 15), value | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(SEED);

function generateRandomTarget() {
  const lat = (random() * 180) - 90;
  const lon = (random() * 360) - 180;
  const zoom = Math.floor(random() * 6) + 12;
  return { center: [lat, lon], zoom };
}

test('agnostic random navigation and metadata decryption', { timeout: 180000 }, async () => {
  console.log('Starting agnostic test with seed: ' + SEED);
  const server = startServer({ port: TEST_PORT, host: DEFAULT_HOST, exitOnError: false });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.__historicalDebug), { timeout: 30000 });

    for (let i = 0; i < TARGET_COUNT; i++) {
      const target = generateRandomTarget();
      console.log('Navigating to target ' + (i + 1) + '/' + TARGET_COUNT + ': [' + target.center[0].toFixed(4) + ', ' + target.center[1].toFixed(4) + '] @ z' + target.zoom);
      
      const previousNonce = await page.evaluate(() => window.__historicalDebug.getRequestNonce());
      
      await page.evaluate((t) => {
        window.__historicalDebug.getMap().setView(t.center, t.zoom, { animate: false });
      }, target);

      // Wait for catalog refresh (moveend -> /api/catalog)
      await page.waitForFunction(nonce => {
        const debug = window.__historicalDebug;
        return debug && debug.getRequestNonce() > nonce && !/Verifying live/i.test(document.getElementById('status')?.textContent || '');
      }, previousNonce, { timeout: 60000 });

      const state = await page.evaluate(() => {
        const debug = window.__historicalDebug;
        const catalog = debug.getCatalog();
        return {
          status: document.getElementById('status')?.textContent,
          entryCount: catalog?.entries?.length || 0,
          resolvedPathCount: catalog?.verification?.resolvedPathCount || 0,
          requestedPathCount: catalog?.verification?.requestedPathCount || 0,
        };
      });

      console.log('  Result: ' + state.entryCount + ' entries found, ' + state.resolvedPathCount + '/' + state.requestedPathCount + ' paths resolved.');
      
      assert.ok(state.requestedPathCount > 0, 'Should have requested at least one path for metadata');
      assert.ok(!/Error/i.test(state.status), 'Should not show error in status: ' + state.status);
    }
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});