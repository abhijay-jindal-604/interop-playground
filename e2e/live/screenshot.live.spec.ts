/**
 * README screenshot (plan/13 §1; build wave 9): the selector with the slice triple
 * issuer.certify-preauth × wallet.playground-ts × verifier.inji-verify-local, SD-JWT VC,
 * cross-device: the Start bar summarises it with Run enabled, and the run preview resolves the same
 * selection to FLOW-04 → FLOW-30. 1440 px wide, host masked (take.ts).
 * LIVE_SCREENSHOT=<path> saves it (docs/screenshots/selector.png). Live bundle only.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { maskPrivate } from './take.ts';

const SLICE = {
  issuer: 'issuer.certify-preauth',
  wallet: 'wallet.playground-ts',
  verifier: 'verifier.inji-verify-local',
} as const;

test.skip(process.env.PLAYGROUND_LIVE !== '1', 'live bundle only (e2e/playwright.live.config.ts)');

test('selector: slice triple resolves to FLOW-30', async ({ page, request }) => {
  await maskPrivate(page);
  await page.goto('/');
  await expect(page.getByText('Ready', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  for (const id of Object.values(SLICE)) {
    const radio = page.locator(`[data-adapter="${id}"] input[type="radio"]`);
    await expect(radio).toBeEnabled({ timeout: 30_000 });
    await radio.check();
  }
  await page.getByRole('radio', { name: 'SD-JWT VC', exact: true }).check();
  await page.getByRole('radio', { name: 'Cross-device (QR)', exact: true }).check();
  const start = page.getByRole('region', { name: 'Start' });
  await expect(start).toContainText('Inji Certify (pre-authorized) → Playground reference wallet');
  const preview = (await (
    await request.post('/api/v1/runs/preview', {
      headers: { host: '127.0.0.1:3100', origin: 'http://127.0.0.1:3100' },
      data: {
        ...SLICE,
        grant: 'pre-authorized_code',
        presentationMode: 'cross-device',
        format: 'dc+sd-jwt',
      },
    })
  ).json()) as { spec: { presentationFlowId: string } };
  expect(preview.spec.presentationFlowId).toBe('FLOW-30');
  await expect(start.getByRole('button', { name: 'Run' })).toBeEnabled();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(800);
  const out = process.env.LIVE_SCREENSHOT;
  if (out) {
    mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    await page.screenshot({ path: path.resolve(out) });
  }
});
