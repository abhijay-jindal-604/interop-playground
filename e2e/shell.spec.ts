import { expect, test } from '@playwright/test';
import {
  CHILD_ID,
  PARENT_ID,
  ROUTES,
  RUN_ID,
  hasHorizontalScroll,
  noBackend,
  serveApi,
} from './support.ts';

test.describe('shell', () => {
  test.beforeEach(async ({ page }) => {
    await serveApi(page);
  });

  for (const width of [640, 1024, 1440]) {
    test(`renders every route at ${width} px without horizontal scroll`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      for (const path of ROUTES) {
        await page.goto(path);
        await expect(page.locator('h1')).toHaveCount(1);
        if (path === `/runs/${RUN_ID}`)
          await expect(page.getByRole('region', { name: 'Result' })).toBeVisible();
        expect(await hasHorizontalScroll(page), `${path} at ${width}px`).toBe(false);
      }
    });
  }

  test('reflows at 320 px (UI-72 reflow rule)', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    for (const path of [
      '/',
      '/environment',
      `/runs/${RUN_ID}`,
      `/runs/${PARENT_ID}`,
      `/runs/${CHILD_ID}`,
    ]) {
      await page.goto(path);
      await expect(page.locator('h1')).toHaveCount(1);
      if (path.startsWith('/runs/'))
        await expect(page.getByRole('navigation', { name: 'Steps' })).toBeVisible();
      expect(await hasHorizontalScroll(page), path).toBe(false);
    }
  });

  test('compact width: the nav sits behind a visible "Menu" button', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav).toBeHidden();
    await page.getByRole('button', { name: 'Menu' }).click();
    await expect(nav).toBeVisible();
    await nav.getByRole('link', { name: 'History' }).click();
    await expect(page).toHaveURL(/\/history$/);
    await expect(nav).toBeHidden();
  });

  test('skip link is the first Tab stop; Alt+Shift+H goes to History and focuses its h1', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Pick who plays each role');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
    await page.locator('body').click({ position: { x: 1, y: 300 } });
    await page.keyboard.press('Alt+Shift+H');
    await expect(page).toHaveURL(/\/history$/);
    await expect(page.locator('h1')).toBeFocused();
    await expect(page).toHaveTitle('History · Interop Playground');
  });

  test('Alt+Shift+K opens the shortcuts dialog; Esc closes it', async ({ page }) => {
    await page.goto('/');
    await page.locator('h1').waitFor();
    await page.keyboard.press('Alt+Shift+K');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('theme switch sets data-theme and survives a reload', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('radio', { name: 'Dark' }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('radio', { name: 'System' }).check();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
  });

  test('env chip popover lists the upstreams and links to the Environment page', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Full local/ }).click();
    await expect(page.getByText('inji-verify', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Open environment page' }).click();
    await expect(page).toHaveURL(/\/environment$/);
    await expect(page.locator('h1')).toHaveText('Environment');
  });

  test('recent runs drawer opens, shows the empty copy and closes with Esc', async ({ page }) => {
    await page.goto('/');
    const button = page.getByRole('button', { name: 'Recent runs' });
    await button.click();
    await expect(
      page.getByText('No runs yet. Pick an issuer, a wallet and a verifier to start.'),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(button).toBeFocused();
  });
});

test('backend unreachable shows the full-page copy (UI-02)', async ({ page }) => {
  // no API route: vite preview answers index.html, which is not the BFF
  await noBackend(page);
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('The playground backend is not reachable.');
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
});

test.describe('run screen (T-27, recorded FLOW-30 fail log)', () => {
  test.beforeEach(async ({ page }) => {
    await serveApi(page);
  });

  test('shows the result card, the step rail and selects the #step= deep link', async ({
    page,
  }) => {
    await page.goto(`/runs/${RUN_ID}#step=vci.token`);
    const result = page.getByRole('region', { name: 'Result' });
    // ADR-136/137: the stamp, a plain sentence with the step's plain title, the error as a field
    await expect(result.locator('.stamp')).toHaveAttribute('data-stamp', 'invalid');
    await expect(result).toContainText(
      'The verifier rejected the credential at “Wallet sends the presentation”.',
    );
    await expect(result).toContainText(
      'invalid_request Client id validation failed due to invalid client_id/domain',
    );
    const rail = page.getByRole('navigation', { name: 'Steps' });
    await expect(rail.locator('[aria-current="true"]')).toHaveAttribute('data-step', 'vci.token');
    await rail.locator('[data-step="vp.response.post"]').click();
    await expect(page).toHaveURL(/#step=vp\.response\.post$/);
    await page.keyboard.press('ArrowDown');
    await expect(rail.locator('[data-step="vp.error.dispatch"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Inspector' })).toBeFocused();
  });
});
