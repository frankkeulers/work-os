import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4391',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } }],
  webServer: {
    command: 'npm run build:mock && npm run preview:mock', // the UX tests run against the in-browser mock
    url: 'http://127.0.0.1:4391',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
