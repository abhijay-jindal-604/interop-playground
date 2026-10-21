/**
 * T-47 live labels e2e (plan/12 T-47; 08 §5 REQ-23; 03 FLOW-14 + FLOW-40; ADR-94): on the real
 * bundle (bff + local Inji Verify), select issuer.fixture × wallet.playground-ts ×
 * verifier.inji-verify-local, mode "Credential only (no OID4VP)", and run the three fixture cases:
 * the result cards say exactly Valid, Invalid and Valid but expired. The three cards are then shown
 * side by side (plan/13 S9). Runs only through e2e/playwright.live.config.ts (PLAYGROUND_LIVE=1).
 * LIVE_TAKE=<path> saves the video + `.marks.json` (deliverables/takes/s09-take.webm,
 * cut to `s09-labels.webm` by `scripts/cut-takes.sh`).
 */
import { expect, test, type Page } from '@playwright/test';
import { marker, maskPrivate, saveTake, settled, warmUp } from './take.ts';

const COMBINATION = {
  issuer: 'issuer.fixture',
  wallet: 'wallet.playground-ts',
  verifier: 'verifier.inji-verify-local',
} as const;
// the verdict stamp says Valid / Invalid / Expired; the sentence beside it says why, and the
// verifier's own error is its own field (ADR-136)
const CASES = [
  {
    name: 'Valid',
    word: 'Pass',
    stamp: 'valid',
    sentence: 'The verifier accepted the credential.',
    detail: null,
  },
  {
    name: 'Bad signature',
    word: 'Fail',
    stamp: 'invalid',
    sentence: 'The verifier rejected the credential',
    detail: 'ERR_SIGNATURE_VERIFICATION_FAILED',
  },
  {
    name: 'Expired',
    word: 'Pass',
    stamp: 'expired',
    sentence: 'The signature checks out, but the credential is past its expiry date.',
    detail: null,
  },
] as const;

test.skip(process.env.PLAYGROUND_LIVE !== '1', 'live bundle only (e2e/playwright.live.config.ts)');

async function runCase(page: Page, name: string): Promise<string> {
  await page.goto('/');
  await settled(page, 0);
  for (const id of Object.values(COMBINATION)) {
    const radio = page.locator(`[data-adapter="${id}"] input[type="radio"]`);
    await expect(radio).toBeEnabled({ timeout: 30_000 });
    await radio.check();
  }
  await page.getByRole('radio', { name: 'SD-JWT VC', exact: true }).check();
  await page.getByRole('radio', { name: 'Credential only (no OID4VP)', exact: true }).check();
  await page.getByRole('radio', { name, exact: true }).check();
  const run = page.getByRole('region', { name: 'Start' }).getByRole('button', { name: 'Run' });
  await expect(run).toBeEnabled({ timeout: 30_000 });
  await run.click();
  await page.waitForURL(/\/runs\/[0-9A-HJKMNP-TV-Z]{26}$/);
  return new URL(page.url()).pathname.split('/').pop()!;
}

test('labels: fixture Valid / Invalid / Valid but expired at the real Verify (FLOW-40)', async ({
  browser,
  page,
}, testInfo) => {
  await maskPrivate(page);
  const { mark, at, marks } = marker(page);
  // the take starts on a painted page (a fresh headless browser can paint its first page late)
  await warmUp(browser, testInfo.project.use.baseURL ?? 'http://127.0.0.1:3100');
  const runs: string[] = [];
  for (const c of CASES) {
    runs.push(await runCase(page, c.name));
    const result = page.getByRole('region', { name: 'Result' });
    await expect(result).toBeVisible({ timeout: 60_000 });
    await expect(result.locator('.result-word')).toHaveText(c.word);
    await expect(result.getByTestId('stamp')).toHaveAttribute('data-stamp', c.stamp);
    await expect(result).toContainText(c.sentence);
    if (c.detail) await expect(result).toContainText(c.detail);
  }
  // S9: the three result cards side by side (the run screens in one strip of frames), then the
  // expired one alone: the narration ends on "…the credential has expired"
  await page.setContent(
    `<!doctype html><meta charset="utf-8"><title>REQ-23 labels</title>
     <style>body{margin:0;display:grid;grid-template-columns:1fr 1fr 1fr;height:100vh;background:#f7f5f0;
     transition:grid-template-columns .9s ease-in-out}
     body.solo{grid-template-columns:0fr 0fr 1fr}
     iframe{width:100%;height:100%;border:0;border-right:1px solid #d9d5cc;min-width:0}</style>
     ${runs.map((r) => `<iframe src="${testInfo.project.use.baseURL ?? 'http://127.0.0.1:3100'}/runs/${r}"></iframe>`).join('')}`,
  );
  for (const [i, c] of CASES.entries()) {
    const card = page.frameLocator('iframe').nth(i).getByRole('region', { name: 'Result' });
    await expect(card.locator('.result-word')).toHaveText(c.word, { timeout: 30_000 });
    await expect(card.getByTestId('stamp')).toHaveAttribute('data-stamp', c.stamp);
    await card.scrollIntoViewIfNeeded();
  }
  await page.waitForTimeout(1500); // the stamps have pressed and the frames are still
  await mark('s09-labels');
  await at(4.0);
  await page.evaluate(() => document.body.classList.add('solo'));
  const expired = page.frameLocator('iframe').nth(2).getByRole('region', { name: 'Result' });
  await at(5.0);
  await expired.scrollIntoViewIfNeeded();
  await expect(expired.getByTestId('stamp')).toBeInViewport();
  await at(8.45);
  await mark('end');
  await saveTake(page, testInfo, marks);
});
