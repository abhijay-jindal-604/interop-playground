/**
 * T-36 live slice e2e (plan/12; 06 UI-03..UI-23; RISK-16): on the real bundle, select
 * issuer.certify-preauth × wallet.playground-ts × verifier.inji-verify-local on `/`, Start, and
 * follow the run screen to Pass: the diagram animates (a message is drawn or active before the
 * end), every key payload chip of the inspector opens its payload, then the report view.
 * Runs only through e2e/playwright.live.config.ts (PLAYGROUND_LIVE=1); the fixture suite skips it.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const COMBINATION = {
  issuer: 'issuer.certify-preauth',
  wallet: 'wallet.playground-ts',
  verifier: 'verifier.inji-verify-local',
} as const;
const CHIPS = [
  'offer',
  'token',
  'credential',
  'request-link',
  'vp-token',
  'query',
  'result',
] as const;

test.skip(process.env.PLAYGROUND_LIVE !== '1', 'live bundle only (e2e/playwright.live.config.ts)');

test('slice: select → Start → Pass, diagram animates, key payloads, report', async ({
  page,
}, testInfo) => {
  // every data-state the diagram shows during the run (UI-12 animation evidence)
  await page.addInitScript(() => {
    const seen = new Set<string>();
    (window as unknown as { __dgStates: Set<string> }).__dgStates = seen;
    new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target as Element;
        if (el.closest?.('[data-slot="diagram"]')) seen.add(el.getAttribute('data-state') ?? '');
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-state'] });
  });

  // UI-03..UI-08: the selector
  await page.goto('/');
  for (const id of Object.values(COMBINATION)) {
    const radio = page.locator(`[data-adapter="${id}"] input[type="radio"]`);
    await expect(radio).toBeEnabled({ timeout: 30_000 });
    await radio.check();
  }
  await page.getByRole('radio', { name: 'SD-JWT VC', exact: true }).check();
  await page.getByRole('radio', { name: 'Cross-device (QR)', exact: true }).check();
  const run = page.getByRole('region', { name: 'Start' }).getByRole('button', { name: 'Run' });
  await expect(run).toBeEnabled({ timeout: 30_000 });
  await run.click();
  await page.waitForURL(/\/runs\/[0-9A-HJKMNP-TV-Z]{26}$/);
  const runId = new URL(page.url()).pathname.split('/').pop()!;

  // UI-09..UI-12: the run screen reaches Pass
  const result = page.getByRole('region', { name: 'Result' });
  await expect(result).toBeVisible({ timeout: 120_000 });
  await expect(result.locator('.result-word')).toHaveText('Pass');
  await expect(result).toContainText('Inji Certify');

  // UI-12/UI-13: the diagram drew the run (messages moved through drawn/active to pass)
  const diagram = page.getByRole('figure', { name: 'Sequence diagram' });
  await expect(diagram.locator('.dg-block')).toHaveCount(2);
  await expect(diagram.locator('.dg-msg[data-state="pass"]').first()).toBeVisible();
  await expect(
    diagram.locator('.dg-msg[data-state="fail"], .dg-msg[data-state="error"]'),
  ).toHaveCount(0);
  const states = await page.evaluate(() => [
    ...(window as unknown as { __dgStates: Set<string> }).__dgStates,
  ]);
  expect(states.some((s) => s === 'active' || s === 'drawn')).toBe(true);
  expect(states).toContain('pass');

  // UI-18..UI-23: every key payload of the inspector is part of this run and opens its payload
  const inspector = page
    .getByRole('complementary', { name: 'Inspector' })
    .or(page.locator('[data-slot="inspector"]'));
  const bar = inspector.getByRole('toolbar', { name: 'Key payloads' });
  // Inji Verify sends the request by value (FLOW-30 vp.request.fetch skipped: "request carried by
  // value"), so the request-object chip is the one key payload that is not part of this run
  await expect(bar.locator('[data-chip="request-object"]')).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  for (const chip of CHIPS) {
    const button = bar.locator(`[data-chip="${chip}"]`);
    await expect(button, `${chip} is part of the run`).not.toHaveAttribute('aria-disabled', 'true');
    await button.click();
    if (chip === 'request-link') {
      await expect(inspector.locator('[data-engine-op="deliver-request"]')).toBeVisible();
      await expect(inspector.locator('[data-engine-op="deliver-request"]')).toContainText(
        'openid4vp://',
      );
    } else {
      const panel = inspector.locator('.xcard.is-open [data-part-panel]').first();
      await expect(panel, `${chip} payload`).toBeVisible();
      await expect(panel).not.toBeEmpty();
    }
  }
  await page.waitForTimeout(500); // let the take show the last payload

  // UI-51: the report view
  await page.goto(`/runs/${runId}/report`);
  await expect(page.locator('h1')).toContainText(': PASS');
  const combination = page.getByRole('region', { name: 'Combination' });
  for (const id of Object.values(COMBINATION)) await expect(combination).toContainText(id);
  await page.waitForTimeout(1000);

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
