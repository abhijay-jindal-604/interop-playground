/**
 * T-44 live fix-it e2e (plan/12; 09 A5, A7 FP-01, A10 step 1; 06 UI-24..UI-28): on the real bundle
 * (bff + walt.id issuer-api2 from the peers profile + local Inji Verify, ADR-88), select
 * issuer.waltid × wallet.playground-ts × verifier.inji-verify-local on `/` with the knobs at their
 * defaults (KNOB-01 `absent`), Run → the parent fails at the verdict → the diagnosis card shows FP-01
 * exact with the KNOB-01 offer → one click on "Fix it and re-run" (no confirm dialog) derives the
 * child (KNOB-01 `present`, x5c) → the child passes → the child result card says `fixed` with the
 * API-31 claim sentence, and the compact strip shows the knob's direct effect first.
 * Runs only through e2e/playwright.live.config.ts (PLAYGROUND_LIVE=1); the fixture suite skips it.
 * LIVE_TAKE=<path> saves the video (deliverables/takes/m2-fixit.webm).
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { maskPrivate } from './take.ts';

// a take (LIVE_TAKE, plan/13 S10) holds each beat long enough to read; the plain e2e does not wait
const HOLD = process.env.LIVE_TAKE ? 3500 : 0;

const COMBINATION = {
  issuer: 'issuer.waltid',
  wallet: 'wallet.playground-ts',
  verifier: 'verifier.inji-verify-local',
} as const;
const RUN_URL = /\/runs\/([0-9A-HJKMNP-TV-Z]{26})$/;

test.skip(process.env.PLAYGROUND_LIVE !== '1', 'live bundle only (e2e/playwright.live.config.ts)');

test('fix-it: walt.id parent fails (FP-01) → one click → child Pass → fixed + claim', async ({
  page,
}, testInfo) => {
  await maskPrivate(page);
  let dialogs = 0;
  page.on('dialog', (d) => {
    dialogs += 1;
    void d.dismiss();
  });

  // the BFF probes every 30 s (EnvManager): right after `up.sh --with peers` walt.id may still be
  // marked unavailable from the previous round, so ask for a probe and wait for the adapters
  const base = testInfo.project.use.baseURL ?? 'http://127.0.0.1:3100';
  await page.request.post('/api/v1/env/probe', {
    headers: { origin: base, 'content-type': 'application/json' },
    data: {},
  });
  await expect
    .poll(
      async () => {
        const res = await page.request.get('/api/v1/adapters');
        const all = Object.values(
          (await res.json()) as Record<
            string,
            { descriptor: { id: string }; availability?: { available: boolean } }[]
          >,
        ).flat();
        return Object.values(COMBINATION).every(
          (id) => all.find((a) => a.descriptor.id === id)?.availability?.available === true,
        );
      },
      { timeout: 60_000, intervals: [1000] },
    )
    .toBe(true);

  // the selector (UI-03..UI-08), knobs left at their defaults
  await page.goto('/');
  for (const id of Object.values(COMBINATION)) {
    const radio = page.locator(`[data-adapter="${id}"] input[type="radio"]`);
    await expect(radio, id).toBeEnabled({ timeout: 30_000 });
    await radio.check();
  }
  await page.getByRole('radio', { name: 'SD-JWT VC', exact: true }).check();
  await page.getByRole('radio', { name: 'Cross-device (QR)', exact: true }).check();
  const run = page.getByRole('region', { name: 'Start' }).getByRole('button', { name: 'Run' });
  await expect(run).toBeEnabled({ timeout: 30_000 });
  await run.click();
  await page.waitForURL(RUN_URL);
  const parentId = RUN_URL.exec(new URL(page.url()).pathname)?.[1] ?? '';

  // the parent fails at the verdict
  const result = page.getByRole('region', { name: 'Result' });
  await expect(result).toBeVisible({ timeout: 120_000 });
  await expect(result.locator('.result-word')).toHaveText('Fail');
  await page.waitForTimeout(HOLD);

  // the diagnosis card: FP-01 exact, verifier side, with the KNOB-01 fix-it panel
  const card = page.getByTestId('diagnosis-card');
  await expect(card.getByRole('heading', { level: 2 })).toHaveText(
    /^Diagnosis: Inji Verify cannot verify an SD-JWT VC/,
    { timeout: 30_000 },
  );
  await expect(card.getByText('Exact match')).toBeVisible();
  await expect(card.getByTestId('deviating-side')).toContainText('Verifier');
  await expect(card).toContainText('G-55');
  const panel = page.getByRole('region', { name: 'Fix it and re-run' });
  await expect(panel).toContainText('waltid.sdjwt.x5c');
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800 + HOLD); // let the take show the diagnosis
  await panel.scrollIntoViewIfNeeded();
  await page.waitForTimeout(HOLD);

  // one click derives the child (API-24), no confirm dialog
  const derive = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith(`/runs/${parentId}/derive`),
  );
  await panel.getByRole('button', { name: 'Fix it and re-run' }).click();
  const res = await derive;
  expect(res.status()).toBe(201);
  expect(res.request().postDataJSON()).toEqual({ knobId: 'KNOB-01', value: 'present' });
  await page.waitForURL((u) => {
    const m = RUN_URL.exec(u.pathname);
    return m !== null && m[1] !== parentId;
  });
  const childId = RUN_URL.exec(new URL(page.url()).pathname)?.[1] ?? '';
  expect(dialogs).toBe(0);
  await expect(page.getByTestId('child-banner')).toContainText(
    `Re-run of ${parentId.slice(-8)}: waltid.sdjwt.x5c absent → present`,
  );

  // the child passes and is classified `fixed` with the claim sentence (09 A5.4, API-31)
  await expect(result).toBeVisible({ timeout: 120_000 });
  await expect(result.locator('.result-word')).toHaveText('Pass');
  const child = page.getByTestId('child-result');
  await expect(child).toHaveAttribute('data-classification', 'fixed', { timeout: 30_000 });
  await expect(child.getByRole('heading')).toHaveText('The change fixed it.');
  const claim = child.getByTestId('claim');
  await expect(claim).toContainText(
    'issuer.waltid → wallet.playground-ts → verifier.inji-verify-local (dc+sd-jwt) fails because',
  );
  await expect(claim).toContainText('[FP-01, G-55]');
  await expect(claim).toContainText(
    'Changing only waltid.sdjwt.x5c from absent to present makes it pass.',
  );
  await expect(claim).toContainText(`run ${parentId} vs run ${childId}`);
  await child.scrollIntoViewIfNeeded();
  await page.waitForTimeout(HOLD);

  // the compact strip: the knob's direct effect (credential header x5c) first
  const strip = page.getByTestId('compare-strip');
  await strip.getByRole('button', { name: `Compare with run ${parentId.slice(-8)}` }).click();
  const rows = strip.locator('tbody tr');
  await expect(rows.first()).toHaveAttribute('data-step-row', 'vci.credential');
  await expect(rows.first()).toContainText('Changed by KNOB-01');
  await strip.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500 + HOLD); // let the take show the result

  const take = process.env.LIVE_TAKE;
  const video = page.video();
  if (take && video) {
    await page.close();
    const out = path.resolve(take);
    mkdirSync(path.dirname(out), { recursive: true });
    copyFileSync(await video.path(), out);
    testInfo.annotations.push({ type: 'take', description: out });
  }
});
