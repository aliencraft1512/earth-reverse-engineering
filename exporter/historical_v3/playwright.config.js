const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  use: {
    baseURL: 'http://localhost:3003',
    browserName: 'chromium',
    headless: true,
  },
  webServer: {
    command: 'node Server.js',
    url: 'http://localhost:3003',
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
