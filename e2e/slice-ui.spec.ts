import { expect, test } from '@playwright/test';
import { RUN_ID, serveApi } from './support.ts';

test.describe('slice UI (T-29 diagram, T-30 selector, UI-51 report)', () => {
  test.beforeEach(async ({ page }) => {
    await serveApi(page);
  });

  test('the run screen draws both sequence blocks and opens the Delivery dialog', async ({
    page,
  }) => {
    await page.goto(`/runs/${RUN_ID}`);
    const figure = page.getByRole('figure', { name: 'Sequence diagram' });
    await expect(figure.locator('.dg-block')).toHaveCount(2);
    // ADR-78: the pinned Mermaid draws both blocks and passes the index check (RISK-32)
    await expect(figure.locator('[data-renderer="mermaid"]')).toHaveCount(2);
    await expect(figure.getByText('Using the built-in diagram renderer.')).toHaveCount(0);
    await expect(figure.locator('[data-step="vp.response.post"]').first()).toHaveAttribute(
      'data-state',
      'fail',
    );
    const opener = page.getByRole('navigation', { name: 'Steps' }).getByRole('button', {
      name: 'Delivery',
      exact: true,
    });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Verification request' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test('the deep link preselects the selector', async ({ page }) => {
    await page.goto('/?format=ldp_vc&mode=same-device');
    await expect(page.getByRole('radio', { name: 'JSON-LD', exact: true })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'Same-device (deep link)' })).toBeChecked();
    await expect(page.getByRole('region', { name: 'Start' })).toContainText('JSON-LD');
  });

  test('the report view lists the REQ-26 fields', async ({ page }) => {
    await page.goto(`/runs/${RUN_ID}/report`);
    await expect(page.locator('h1')).toContainText('Run No.');
    await expect(page.getByTestId('stamp')).toHaveAttribute('data-status', 'fail');
    const table = page.getByRole('region', { name: 'Combination' });
    await expect(table).toContainText('issuer.certify-preauth');
    await expect(table).toContainText('jwt (ES256, P1363)');
    await expect(table).toContainText('vp.response.post');
  });
});
