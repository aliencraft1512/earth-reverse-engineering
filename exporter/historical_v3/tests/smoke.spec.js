const { test, expect } = require('@playwright/test');

test.describe('Historical V3 Smoke Tests', () => {
    test.beforeEach(async ({ page }) => {
        // We assume the server is running on port 3003
        await page.goto('http://localhost:3003');
    });

    test('should load the map and UI components', async ({ page }) => {
        await expect(page.locator('h1')).toContainText('Historical V3: Interactive Map Explorer');
        const map = page.locator('#map');
        await expect(map).toBeVisible();
    });

    test('should load predefined regions', async ({ page }) => {
        const nicosiaShortcut = page.locator('.region-item', { hasText: 'Nicosia' });
        await expect(nicosiaShortcut).toBeVisible();
    });

    test('should fetch metadata when Nicosia shortcut is clicked', async ({ page }) => {
        const nicosiaShortcut = page.locator('.region-item', { hasText: 'Nicosia' });
        await nicosiaShortcut.click();

        // Wait for metadata table to populate
        // Nicosia usually has many dates, so we check if the table has rows
        const firstDateRow = page.locator('.metadata-row').first();
        await expect(firstDateRow).toBeVisible({ timeout: 15000 });
        
        const dateText = await firstDateRow.locator('td').first().textContent();
        console.log(`Verified metadata for Nicosia. Found date: ${dateText}`);
        expect(dateText).toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    test('should attempt to load tiles when a date is clicked', async ({ page }) => {
        const nicosiaShortcut = page.locator('.region-item', { hasText: 'Nicosia' });
        await nicosiaShortcut.click();

        const firstDateRow = page.locator('.metadata-row').first();
        await expect(firstDateRow).toBeVisible({ timeout: 15000 });
        
        // Listen for tile requests
        const tileRequestPromise = page.waitForRequest(request => request.url().includes('/api/tile/'));
        await firstDateRow.click();
        
        const request = await tileRequestPromise;
        console.log(`Verified tile request: ${request.url()}`);
        expect(request.url()).toContain('iCode=');
    });
});
