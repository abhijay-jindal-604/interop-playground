import { spawnSync } from 'node:child_process';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { ROUTES, serveApi, setTheme } from './support.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

test('contrast script passes (UI-73 rule 2)', () => {
  const script = path.resolve(import.meta.dirname, '..', 'scripts', 'contrast.mjs');
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
});

for (const theme of ['light', 'dark'] as const) {
  for (const route of ROUTES) {
    test(`axe ${theme} ${route}: zero serious or critical`, async ({ page }) => {
      await setTheme(page, theme);
      await serveApi(page);
      await page.goto(route);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.locator('main[aria-busy="true"]')).toHaveCount(0);
      const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      const blocking = result.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      );
      expect(
        blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
      ).toEqual([]);
    });
  }
}

test('axe on the unreachable page', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('The playground backend is not reachable.');
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(
    result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
  ).toEqual([]);
});

for (const theme of ['light', 'dark'] as const) {
  test(`axe ${theme} at 360 px with the menu, the drawer and the shortcuts dialog open`, async ({
    page,
  }) => {
    await setTheme(page, theme);
    await serveApi(page);
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto('/environment');
    await expect(page.locator('h1')).toHaveText('Environment');
    const check = async (label: string) => {
      const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      const blocking = result.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      );
      expect(blocking.map((v) => `${label} ${v.id}`)).toEqual([]);
    };
    await check('page');
    await page.getByRole('button', { name: 'Menu' }).click();
    await check('menu');
    await page.getByRole('button', { name: 'Recent runs' }).click();
    await expect(page.getByRole('dialog', { name: 'Recent runs' })).toBeVisible();
    await check('drawer');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Alt+Shift+K');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await check('dialog');
  });
}
