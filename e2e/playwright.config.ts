// Playwright (plan/11 §5). Loaded through the root `playwright.config.mjs` (ADR-63: this typed file
// lives in e2e/ so the type-aware lint finds it through e2e/tsconfig.json). The shell specs run against `vite preview` of apps/ui/dist on
// 127.0.0.1 with the API answered by fixtures (e2e/support.ts); the bundle-backed specs of
// plan/11 §5 (testkit BFF) join later. Visual baselines are CI-only (`chromium-visual`).
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const repo = path.resolve(import.meta.dirname, '..');
const isCI = process.env.CI === 'true';

export default defineConfig({
  testDir: path.join(repo, 'e2e'),
  outputDir: path.join(repo, 'test-results'),
  fullyParallel: false,
  workers: 1,
  retries: isCI ? 1 : 0,
  forbidOnly: isCI,
  reporter: isCI
    ? [['list'], ['html', { open: 'never', outputFolder: path.join(repo, 'playwright-report') }]]
    : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  projects: [
    // e2e/live/** is session A's real-stack suite (e2e/playwright.live.config.ts)
    { name: 'chromium-functional', testIgnore: [/a11y\.spec\.ts/, /[\\/]live[\\/]/] },
    { name: 'chromium-a11y', testMatch: /a11y\.spec\.ts/ },
  ],
  webServer: {
    command: `npm run build -w @interop-playground/ui && npm run preview -w @interop-playground/ui -- --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    cwd: repo,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
