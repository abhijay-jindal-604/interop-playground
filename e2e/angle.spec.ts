import { expect, test } from '@playwright/test';
import { CHILD_ID, PARENT_ID, POSSIBLE_ID, serveApi } from './support.ts';

// T-45 on the T-44 flow (fixture routes, e2e/support.ts): the failed parent shows FP-01 exact with
// the KNOB-01 fix; one click derives the child (no confirm dialog); the child shows the banner, the
// `fixed` card with the API-31 claim sentence, the compact strip (direct effect first) and lineage.
test.describe('angle A (T-45)', () => {
  test.beforeEach(async ({ page }) => {
    await serveApi(page);
  });

  test('fix it and re-run: parent diagnosis → one click → fixed child', async ({ page }) => {
    let dialogs = 0;
    page.on('dialog', (d) => {
      dialogs += 1;
      void d.dismiss();
    });
    const derive = page.waitForRequest(
      (r) => r.method() === 'POST' && r.url().endsWith(`/runs/${PARENT_ID}/derive`),
    );
    await page.goto(`/runs/${PARENT_ID}`);
    const card = page.getByTestId('diagnosis-card');
    await expect(card.getByRole('heading', { level: 2 })).toHaveText(
      /^Diagnosis: Inji Verify cannot verify an SD-JWT VC/,
    );
    await expect(card.getByText('Exact match')).toBeVisible();
    await expect(card.getByTestId('deviating-side')).toHaveText(
      'Deviating side: Verifier: inji-verify (vc-verifier) 1.0-alpha.1',
    );
    const panel = page.getByRole('region', { name: 'Fix it and re-run' });
    await expect(panel).toContainText('waltid.sdjwt.x5c');
    await panel.getByRole('button', { name: 'Fix it and re-run' }).click();
    const req = await derive;
    expect(req.postDataJSON()).toEqual({ knobId: 'KNOB-01', value: 'present' });
    expect(req.headers()['idempotency-key']).toBeTruthy();

    await expect(page).toHaveURL(new RegExp(`/runs/${CHILD_ID}$`));
    expect(dialogs).toBe(0);
    await expect(page.getByTestId('child-banner')).toContainText(
      'Re-run of PPPPPPPP: waltid.sdjwt.x5c absent → present',
    );
    const result = page.getByTestId('child-result');
    await expect(result).toHaveAttribute('data-classification', 'fixed');
    await expect(result.getByRole('heading')).toHaveText('The change fixed it.');
    await expect(result.getByTestId('claim')).toContainText('passes; nothing else changed.');

    const strip = page.getByTestId('compare-strip');
    await strip.getByRole('button', { name: 'Compare with run PPPPPPPP' }).click();
    const rows = strip.locator('tbody tr');
    await expect(rows.first()).toHaveAttribute('data-step-row', 'vci.credential');
    await expect(rows.first()).toContainText('Changed by KNOB-01');

    const lineage = page.getByRole('navigation', { name: 'Re-run chain' });
    await expect(lineage).toContainText('waltid.sdjwt.x5c absent → present · Fixed');
    await expect(lineage.locator('[aria-current="step"]')).toContainText('CCCCCCCC');
  });

  test('possible causes: every cause, no fix-it button', async ({ page }) => {
    await page.goto(`/runs/${POSSIBLE_ID}`);
    const card = page.getByTestId('diagnosis-card');
    await expect(card.getByRole('heading', { level: 2 })).toHaveText('Possible causes');
    await expect(card.locator('.cause-block')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Fix it and re-run' })).toHaveCount(0);
    await expect(card).toContainText('More than one known cause fits, so no single change');
  });

  test('the Advanced options panel lists only applicable knobs', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Advanced options' }).click();
    // the fixture selection has no walt.id issuer, so KNOB-01 does not apply
    await expect(page.getByTestId('advanced-options')).toContainText(
      'No settings apply to this combination.',
    );
    await expect(page.getByLabel('Run label')).toBeVisible();
  });
});
