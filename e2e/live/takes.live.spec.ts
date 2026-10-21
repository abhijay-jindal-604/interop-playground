/**
 * Video shot takes (plan/13 §2.1, §2.2; T-55): S2 (environment after `scripts/up.sh`) and S3–S7 (one
 * continuous FLOW-30 run: selection, issuance, decoded SD-JWT, QR + `vp.*`, result card, report),
 * at 1440 px, reduced-motion off (the diagram animates). S9 is `labels.live.spec.ts`, S10 is
 * `fixit.live.spec.ts` (`s10-fixit.webm`); S8 is cut (T-48/T-49 not built, ADR-92).
 * The LAN host is masked and QR codes blurred (`take.ts`); no OTP, key or `.env` value is shown.
 * Runs only through e2e/playwright.live.config.ts (PLAYGROUND_LIVE=1), on the slice bundle:
 *   LIVE_TAKES=deliverables/takes LIVE_UPLOG=<up.sh output> npx playwright test -c e2e/playwright.live.config.ts takes
 * S2 is saved as `s02-take.webm` and S3–S7 as `s03-s07-slice.webm`, each with `.marks.json` (shot
 * marks, take.ts); `scripts/cut-takes.sh` cuts them into `s02-environment.webm`, `s03-*.webm` …
 * `s07-*.webm`.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { marker, maskPrivate, publicHost, settled, warmUp } from './take.ts';

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

test('S2: up.sh ready, then the environment strip is all green', async ({
  browser,
  page,
}, testInfo) => {
  await maskPrivate(page);
  const { mark, at, marks } = marker(page);
  // the UI part starts on a painted page (a fresh headless browser can paint its first page late)
  await warmUp(browser, testInfo.project.use.baseURL ?? 'http://127.0.0.1:3100');
  await page.setContent(
    `<!doctype html><meta charset="utf-8"><title>scripts/up.sh</title>
     <style>body{margin:0;background:#0d1117;color:#c9d1d9;font:15px/1.5 ui-monospace,monospace;padding:32px}
     .p{color:#7ee787}</style>
     <pre><span class="p">$ scripts/up.sh</span>\n…\n${escapeHtml(upTail())}</pre>`,
  );
  // shot times follow the narration (deliverables/video/demo-v1-script.md): the command first,
  // then from about 1.8 s the services coming up
  await mark('s02-environment');
  await at(1.5);
  await page.goto('/');
  await settled(page, 0);
  await expect(page.getByText('Ready', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  // the header strip (UI-02): mode and readiness of the required services
  await page.getByText('Ready', { exact: true }).first().hover();
  await at(10.55);
  await mark('end');
  await save(page, testInfo, 's02-take.webm', marks);
});

test('S3–S7: selection → issuance → decoded SD-JWT → QR + vp.* → result → report', async ({
  browser,
  page,
}, testInfo) => {
  await maskPrivate(page);
  const { mark, at, marks } = marker(page);
  await warmUp(browser, testInfo.project.use.baseURL ?? 'http://127.0.0.1:3100');
  const smooth = async (
    target: Locator,
    block: ScrollLogicalPosition = 'center',
  ): Promise<void> => {
    await target.evaluate((el, b) => el.scrollIntoView({ behavior: 'smooth', block: b }), block);
  };

  // S3: pick the slice; then mDoc greys Inji Verify with its one-line reason (G-09). The shot
  // starts once the selector has painted and settled (no blank first frames).
  // the shot opens on another issuer (deep link, UI-50), so the first pick visibly changes it
  await page.goto('/?issuer=issuer.waltid');
  await settled(page);
  await mark('s03-select');
  let t = 0.4;
  for (const id of Object.values(SLICE)) {
    const radio = page.locator(`[data-adapter="${id}"] input[type="radio"]`);
    await expect(radio).toBeEnabled({ timeout: 30_000 });
    await at(t);
    await radio.check();
    t += 1.5;
  }
  await at(4.9);
  await page.getByRole('radio', { name: 'mDoc', exact: true }).check();
  const verifierCard = page.locator(`[data-adapter="${SLICE.verifier}"]`);
  await expect(verifierCard).toHaveClass(/is-conflict/);
  // the column's one-line note says why (rule and gap G-09 sit in its closed Details)
  const noteId = await verifierCard
    .locator('[aria-describedby]')
    .first()
    .getAttribute('aria-describedby');
  const note = page.locator(`[id="${noteId ?? ''}"]`);
  await expect(note).toContainText('G-09');
  await expect(note).toBeVisible();
  await smooth(note);
  await verifierCard.hover();
  await at(9.6);
  await page.getByRole('radio', { name: 'SD-JWT VC', exact: true }).check();
  await page.getByRole('radio', { name: 'Cross-device (QR)', exact: true }).check();
  const run = page.getByRole('region', { name: 'Start' }).getByRole('button', { name: 'Run' });
  await expect(run).toBeEnabled({ timeout: 30_000 });
  await at(10.85);

  // S4: Run; the issuance steps appear, then the diagram's arrows, then the offer, token and
  // credential messages in the inspector
  await mark('s04-issuance');
  await at(0.6);
  await run.click();
  await page.waitForURL(/\/runs\/[0-9A-HJKMNP-TV-Z]{26}$/);
  const runId = new URL(page.url()).pathname.split('/').pop()!;
  const result = page.getByRole('region', { name: 'Result' });
  await expect(result).toBeVisible({ timeout: 120_000 });
  await expect(result.locator('.result-word')).toHaveText('Pass');
  const diagram = page.locator('[data-slot="diagram"]');
  await expect(diagram.locator('svg').first()).toBeVisible();
  await at(1.2);
  await smooth(diagram, 'start');
  await at(6.1);
  await page.evaluate(() => window.scrollBy({ top: 260, behavior: 'smooth' }));
  const inspector = page
    .getByRole('complementary', { name: 'Inspector' })
    .or(page.locator('[data-slot="inspector"]'));
  const bar = inspector.getByRole('toolbar', { name: 'Key payloads' });
  const chip = async (name: string, when: number): Promise<void> => {
    await at(when);
    await bar.locator(`[data-chip="${name}"]`).click();
    const open = inspector.locator('.xcard.is-open').first();
    await expect(open.locator('[data-part-panel]').first()).toBeVisible();
    await smooth(open, 'start');
  };
  await at(9.7);
  await smooth(bar);
  await chip('offer', 10.4);
  await chip('token', 12.6);
  await chip('credential', 14.0);
  await at(15.45);

  // S5: the credential as a document (claims), who signed it and the disclosures, then the
  // holder key (cnf) in the raw payload; the step's Details name it a full capture
  await mark('s05-decoded');
  await at(0.3);
  const details = inspector.locator('details.inspector-details');
  await details.locator('summary').click();
  await expect(details.getByText('Full capture').first()).toBeVisible();
  await details.locator('summary').click();
  await inspector.getByRole('tab', { name: 'Decoded' }).click();
  const doc = inspector.getByTestId('credential-document').first();
  await expect(doc).toBeVisible();
  await at(3.2);
  await smooth(doc.locator('.doc-claims'));
  await at(6.0);
  await smooth(doc.locator('.doc-issuing'));
  await at(9.2);
  const raw = doc.locator('details.doc-raw');
  await raw.locator('summary').click();
  const cnf = raw.getByText('"cnf"').first();
  await expect(cnf).toBeVisible();
  await smooth(cnf);
  await at(11.85);

  // S6: the QR of the Inji Verify request (blurred: it carries the LAN host), the vp.* payloads,
  // then the verdict stamp "Valid"
  await mark('s06-present');
  await inspector.getByRole('tab', { name: 'Messages' }).click();
  const delivery = page.locator('[data-action="delivery"]').first();
  if ((await delivery.count()) > 0) {
    await at(0.3);
    await delivery.click();
    await at(2.0);
    await page.keyboard.press('Escape');
  }
  await chip('query', 2.3);
  await chip('vp-token', 4.2);
  await chip('result', 6.6);
  await at(8.6);
  await smooth(result);
  await expect(result).toContainText('accepted the credential');
  await expect(result.getByTestId('stamp')).toHaveAttribute('data-stamp', 'valid');
  await at(11.45);

  // S7: the run report (REQ-26 table), then its failing-checks section
  await mark('s07-report');
  await at(0.3);
  await page.getByRole('link', { name: 'Report', exact: true }).first().click();
  await page.waitForURL(new RegExp(`/runs/${runId}/report$`));
  // the report opens like a document: "Run No." and the run's number, then the verdict stamp
  await expect(page.locator('h1')).toContainText('Run No.');
  await expect(page.locator('h1')).toContainText(runId.slice(-8));
  const reportStamp = page.locator('main').getByTestId('stamp').first();
  await expect(reportStamp).toHaveAttribute('data-status', 'pass');
  await expect(reportStamp).toHaveAttribute('data-stamp', 'valid');
  await at(5.4);
  await smooth(page.locator('#failing-checks'));
  await at(9.05);
  await mark('end');
  await save(page, testInfo, 's03-s07-slice.webm', marks);
});
