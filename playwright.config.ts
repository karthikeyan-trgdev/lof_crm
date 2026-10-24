import { defineConfig } from '@playwright/test';

// Runs the real screens against `wrangler dev` (local D1 seeded with demo data, integrations in mock mode).
// Prerequisite: `npm run db:migrate:local` once. Set CHROME_PATH to use an existing Chromium.
export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:8787',
    launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'npx wrangler dev --port 8787 --ip 127.0.0.1',
    url: 'http://127.0.0.1:8787/health',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
