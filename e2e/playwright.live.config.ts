// Live slice e2e (plan/12 T-36, 06 UI-03..UI-23, RISK-16). Runs against the real bundle, not
// fixtures: start it first (`scripts/up.sh`, or the ADR-77/ADR-82 slice subset), then
//   npx playwright test -c e2e/playwright.live.config.ts
// No web server: the BFF serves the built UI on 127.0.0.1:3100 (10 §7.3) and drives the issuer,
// wallet and verifier hops through the gateway listeners. LIVE_BASE_URL overrides the address.
// LIVE_TAKE=<path> saves the video of the passing run there (deliverables/takes/m1-slice.webm).
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const repo = path.resolve(import.meta.dirname, '..');
process.env.PLAYGROUND_LIVE = '1';

export default defineConfig({
  testDir: path.join(repo, 'e2e', 'live'),
  testMatch: /\.live\.spec\.ts$/,
  outputDir: path.join(repo, 'test-results', 'live'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    baseURL: process.env.LIVE_BASE_URL ?? 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    video: {
      mode: process.env.LIVE_TAKE ? 'on' : 'retain-on-failure',
      size: { width: 1440, height: 900 },
    },
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'live-slice' }],
});
