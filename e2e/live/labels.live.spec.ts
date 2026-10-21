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
const CASES = [
  { name: 'Valid', word: 'Pass', sentence: 'The verifier accepted the credential: Valid.' },
  {
    name: 'Bad signature',
    word: 'Fail',
    sentence:
      'Invalid. The verifier rejected the credential: ERR_SIGNATURE_VERIFICATION_FAILED Verification Failed.',
  },
  {
    name: 'Expired',
    word: 'Pass',
    sentence:
      'Valid but expired. The signature checks out and the credential is past its expiry date.',
  },
] as const;

test.skip(process.env.PLAYGROUND_LIVE !== '1', 'live bundle only (e2e/playwright.live.config.ts)');

async function runCase(
  page: Page,
  name: string,
  start: ((shot: string) => Promise<void>) | null,
): Promise<string> {
  await page.goto('/');
  await settled(page, 0);
  if (start) await start('s09-labels'); // the take starts on the painted selector
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
  const { mark, marks } = marker(page);
  // the take starts on a painted page (a fresh headless browser can paint its first page late)
  await warmUp(browser, testInfo.project.use.baseURL ?? 'http://127.0.0.1:3100');
  const runs: string[] = [];
  for (const c of CASES) {
    runs.push(await runCase(page, c.name, runs.length === 0 ? mark : null));
    const result = page.getByRole('region', { name: 'Result' });
    await expect(result).toBeVisible({ timeout: 60_000 });
    await expect(result.locator('.result-word')).toHaveText(c.word);
    await expect(result).toContainText(c.sentence);
    await page.waitForTimeout(500); // the take shows each card
  }
  // S9: the three result cards side by side (the run screens in one strip of frames)
  await page.setContent(
    `<!doctype html><meta charset="utf-8"><title>REQ-23 labels</title>
     <style>body{margin:0;display:grid;grid-template-columns:repeat(3,1fr);height:100vh;background:#111}
     iframe{width:100%;height:100%;border:0;border-right:2px solid #333}</style>
     ${runs.map((r) => `<iframe src="${testInfo.project.use.baseURL ?? 'http://127.0.0.1:3100'}/runs/${r}"></iframe>`).join('')}`,
  );
  for (const [i, c] of CASES.entries()) {
    const card = page.frameLocator('iframe').nth(i).getByRole('region', { name: 'Result' });
    await expect(card.locator('.result-word')).toHaveText(c.word, { timeout: 30_000 });
    await card.scrollIntoViewIfNeeded();
  }
  await page.waitForTimeout(6000); // the narration lands on the three cards side by side
  await mark('end');
  await saveTake(page, testInfo, marks);
});
