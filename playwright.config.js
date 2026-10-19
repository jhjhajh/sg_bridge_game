const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/ui',
  // Keep these browser tests separate from Vitest's *.test.* / *.spec.* files.
  testMatch: '**/*.pw.js',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4174',
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    trace: 'retain-on-failure',
  },
});
