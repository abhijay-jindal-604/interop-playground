/**
 * Shell e2e support: the API answered by the shared fixtures of apps/ui/src/test/fixtures.ts until
 * the testkit BFF of plan/11 §5 serves the built UI; the `env` stream answers one `retry` frame.
 */
import type { Page } from '@playwright/test';
import { BOOT_FIXTURES } from '../apps/ui/src/test/fixtures.ts';

export const ROUTES = [
  '/',
  '/runs/01J8ZZZZZZZZZZZZZZZZZZZZZZ',
  '/runs/01J8ZZZZZZZZZZZZZZZZZZZZZZ/report',
  '/runs/01J8ZZZZZZZZZZZZZZZZZZZZZZ/compare/01J8YYYYYYYYYYYYYYYYYYYYYY',
  '/environment',
  '/history',
  '/matrix',
  '/matrix/snapshots',
  '/matrix/snapshots/compare',
  '/suites/01J8SSSSSSSSSSSSSSSSSSSSSS',
  '/drafts',
  '/drafts/01J8DDDDDDDDDDDDDDDDDDDDDD',
  '/tamper',
  '/no/such/page',
] as const;

export async function serveApi(page: Page): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/events')) {
      if (url.searchParams.get('format') === 'json') {
        await route.fulfill({
          json: { streamId: 'env', events: [], nextAfter: null, closed: false },
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'retry: 60000\n\n',
      });
      return;
    }
    const body = BOOT_FIXTURES[url.pathname];
    if (body === undefined) {
      await route.fulfill({
        status: 404,
        json: {
          error: {
            code: 'not_found',
            message: 'fixture',
            status: 404,
            requestId: '01J8REQ',
            retryable: false,
          },
        },
      });
      return;
    }
    await route.fulfill({ json: body });
  });
}

export async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem('interop-playground.theme', t);
    } catch {
      // storage blocked
    }
  }, theme);
}

/** True when the page scrolls horizontally (UI-72: never). */
export function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}
