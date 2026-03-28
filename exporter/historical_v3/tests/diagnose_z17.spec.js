const { test, expect } = require('@playwright/test');

test('Diagnose missing tiles at Z17', async ({ page }) => {
    // 1. Capture Console Logs
    page.on('console', msg => console.log(`[BROWSER]: ${msg.text()}`));
    page.on('pageerror', err => console.error(`[BROWSER ERROR]: ${err.message}`));

    console.log("Navigating to explorer...");
    await page.goto('http://localhost:3003');

    console.log("Zooming into Nicosia (Z17)...");
    const nicosiaShortcut = page.locator('.region-item', { hasText: 'Nicosia' });
    await nicosiaShortcut.click();
    
    // Manual zoom to 17
    await page.evaluate(() => map.setZoom(17));
    await page.waitForTimeout(1000);

    console.log("Waiting for dates...");
    const firstDateRow = page.locator('.metadata-row').first();
    await expect(firstDateRow).toBeVisible({ timeout: 15000 });

    console.log("Clicking first date...");
    // Listen for the specific tile request
    const tileRequestPromise = page.waitForResponse(response => response.url().includes('/api/tile/'), { timeout: 10000 }).catch(() => null);
    
    await firstDateRow.click();
    
    const response = await tileRequestPromise;
    if (response) {
        console.log(`Tile Response Status: ${response.status()} for ${response.url()}`);
    } else {
        console.error("NO TILE REQUEST DETECTED AT Z17!");
    }

    // Check if historicalLayer is actually on the map
    const layerExists = await page.evaluate(() => !!historicalLayer);
    console.log(`historicalLayer object exists: ${layerExists}`);
});
