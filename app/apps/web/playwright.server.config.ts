import { defineConfig, devices } from '@playwright/test';

// e2e:server (M1 step 11): the built web app against the real server with a fake Slack. Each test
// file starts its own server (`main.ts --fakes`) in a temp data directory, so it can restart it.
export default defineConfig({
  testDir: './e2e-server',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:4399',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'server', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } }],
});
