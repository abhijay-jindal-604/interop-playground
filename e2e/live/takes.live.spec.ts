/**
 * Video shot takes (plan/13 §2.1, §2.2; T-55): S2 (environment after `scripts/up.sh`) and S3–S7 (one
 * continuous FLOW-30 run: selection, issuance, decoded SD-JWT, QR + `vp.*`, result card, report),
 * at 1440 px, reduced-motion off (the diagram animates). S9 is `labels.live.spec.ts`, S10 is
 * `fixit.live.spec.ts` (`m2-fixit.webm`); S8 is cut (T-48/T-49 not built, ADR-92).
 * The LAN host is masked and QR codes blurred (`take.ts`); no OTP, key or `.env` value is shown.
 * Runs only through e2e/playwright.live.config.ts (PLAYGROUND_LIVE=1), on the slice bundle:
 *   LIVE_TAKES=deliverables/takes LIVE_UPLOG=<up.sh output> npx playwright test -c e2e/playwright.live.config.ts takes
 * S3–S7 is saved as `s03-s07-slice.webm` + `.marks.json` (shot cut points, seconds);
 * `scripts/cut-takes.sh` splits it into `s03-*.webm` … `s07-*.webm`.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { marker, maskPrivate, publicHost } from './take.ts';

const SLICE = {
  issuer: 'issuer.certify-preauth',
  wallet: 'wallet.playground-ts',
  verifier: 'verifier.inji-verify-local',
} as const;

test.skip(process.env.PLAYGROUND_LIVE !== '1', 'live bundle only (e2e/playwright.live.config.ts)');

async function save(
  page: Page,
  testInfo: TestInfo,
  name: string,
  marks: [string, number][] = [],
): Promise<void> {
  const dir = process.env.LIVE_TAKES;
  const video = page.video();
  if (!dir || !video) return;
  await page.close();
  mkdirSync(path.resolve(dir), { recursive: true });
  const out = path.resolve(dir, name);
  copyFileSync(await video.path(), out);
  if (marks.length > 0) writeFileSync(`${out}.marks.json`, `${JSON.stringify(marks)}\n`);
  testInfo.annotations.push({ type: 'take', description: out });
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** the end of the real `scripts/up.sh` output (from "ready." on), host masked */
function upTail(): string {
  const file = process.env.LIVE_UPLOG;
  if (!file) return '[up] ready. mode=local profiles=local\n[up] UI: http://127.0.0.1:3100';
  const lines = readFileSync(file, 'utf8').split('\n');
  const from = lines.findIndex((l) => l.startsWith('[up] ready.'));
  const host = publicHost();
  return lines
    .slice(Math.max(0, from), from + 24)
    .join('\n')
    .split(host ?? '\u0000')
    .join('<PUBLIC_HOST>');
}

test('S2: up.sh ready, then the environment strip is all green', async ({ page }, testInfo) => {
  await maskPrivate(page);
  await page.setContent(
    `<!doctype html><meta charset="utf-8"><title>scripts/up.sh</title>
     <style>body{margin:0;background:#0d1117;color:#c9d1d9;font:15px/1.5 ui-monospace,monospace;padding:32px}
     .p{color:#7ee787}</style>
     <pre><span class="p">$ scripts/up.sh</span>\n…\n${escapeHtml(upTail())}</pre>`,
  );
  await page.waitForTimeout(3000);
  await page.goto('/');
  await expect(page.getByText('Ready', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  // the header strip (UI-02): mode and readiness of the required services
  await page.getByText('Ready', { exact: true }).first().hover();
  await page.waitForTimeout(4000);
  await save(page, testInfo, 's02-environment.webm');
});

test('S3–S7: selection → issuance → decoded SD-JWT → QR + vp.* → result → report', async ({
  page,
}, testInfo) => {
  await maskPrivate(page);
  const { mark, marks } = marker();

  // S3: pick the slice; the greyed mDoc × Inji Verify card shows its reason and G-09
  mark('s03-select');
  await page.goto('/');
  for (const id of Object.values(SLICE)) {
    const radio = page.locator(`[data-adapter="${id}"] input[type="radio"]`);
    await expect(radio).toBeEnabled({ timeout: 30_000 });
    await radio.check();
    await page.waitForTimeout(700);
  }
  await page.getByRole('radio', { name: 'mDoc', exact: true }).check();
  const verifierCard = page.locator(`[data-adapter="${SLICE.verifier}"]`);
  await expect(verifierCard).toContainText('G-09');
  await verifierCard.scrollIntoViewIfNeeded();
  await verifierCard.hover();
  await page.waitForTimeout(2500);
  await page.getByRole('radio', { name: 'SD-JWT VC', exact: true }).check();
  await page.getByRole('radio', { name: 'Cross-device (QR)', exact: true }).check();
  await page.waitForTimeout(1200);

  // S4: Start; the diagram animates the vci.* steps; offer, token and credential payloads
  const run = page.getByRole('region', { name: 'Start' }).getByRole('button', { name: 'Run' });
  await expect(run).toBeEnabled({ timeout: 30_000 });
  mark('s04-issuance');
  await run.click();
  await page.waitForURL(/\/runs\/[0-9A-HJKMNP-TV-Z]{26}$/);
  const runId = new URL(page.url()).pathname.split('/').pop()!;
  const result = page.getByRole('region', { name: 'Result' });
  await expect(result).toBeVisible({ timeout: 120_000 });
  await expect(result.locator('.result-word')).toHaveText('Pass');
  const inspector = page
    .getByRole('complementary', { name: 'Inspector' })
    .or(page.locator('[data-slot="inspector"]'));
  const bar = inspector.getByRole('toolbar', { name: 'Key payloads' });
  const chip = async (name: string): Promise<void> => {
    await bar.locator(`[data-chip="${name}"]`).click();
    await expect(inspector.locator('.xcard.is-open [data-part-panel]').first()).toBeVisible();
    await page.waitForTimeout(2200);
  };
  await chip('offer');
  await chip('token');
  await chip('credential');

  // S5: the decoded SD-JWT (header, disclosures, cnf) and the evidence label
  mark('s05-decoded');
  await inspector.getByRole('tab', { name: 'Decoded' }).click();
  await page.waitForTimeout(1500);
  await inspector.evaluate((el) => el.scrollBy({ top: 400, behavior: 'smooth' }));
  await page.waitForTimeout(1800);
  await expect(page.getByText('Full capture').first()).toBeVisible();
  await page.getByText('Full capture').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);

  // S6: the QR of the Inji Verify request (blurred: it carries the LAN host), the vp.* payloads,
  // the result card "Valid"
  mark('s06-present');
  await inspector.getByRole('tab', { name: 'Messages' }).click();
  const delivery = page.locator('[data-action="delivery"]').first();
  if ((await delivery.count()) > 0) {
    await delivery.click();
    await page.waitForTimeout(2500);
    await page.keyboard.press('Escape');
  }
  await chip('query');
  await chip('vp-token');
  await chip('result');
  await result.scrollIntoViewIfNeeded();
  await expect(result).toContainText('Valid');
  await page.waitForTimeout(2500);

  // S7: the run report (REQ-26 table)
  mark('s07-report');
  await page.goto(`/runs/${runId}/report`);
  await expect(page.locator('h1')).toContainText(': PASS');
  await page.waitForTimeout(1200);
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(1500);
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(2000);
  mark('end');
  await save(page, testInfo, 's03-s07-slice.webm', marks);
});
