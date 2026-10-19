/**
 * Shell e2e support: the API answered by the shared fixtures of apps/ui/src/test/fixtures.ts until
 * the testkit BFF of plan/11 §5 serves the built UI; the `env` stream answers one `retry` frame.
 * The run route (`RUN_ID`) answers the recorded FLOW-30 fail log of fixtures/events (T-10): API-22,
 * API-06 for its flow files, and its stream as SSE ending in `stream.end`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { BOOT_FIXTURES } from '../apps/ui/src/test/fixtures.ts';

export const RUN_ID = '01J8ZZZZZZZZZZZZZZZZZZZZZZ';
const repo = path.resolve(import.meta.dirname, '..');
const read = (p: string): string => readFileSync(path.join(repo, p), 'utf8');

interface Fixture {
  runId: string;
  events: { seq: number; type: string; payload: { spec?: unknown; label?: string | null } }[];
  end: unknown;
}
const fixture = JSON.parse(
  read('fixtures/events/FLOW-30-fail.json').replaceAll(
    (JSON.parse(read('fixtures/events/FLOW-30-fail.json')) as Fixture).runId,
    RUN_ID,
  ),
) as Fixture;
const runSse = [
  'retry: 3000\n\n',
  ...fixture.events.map((e) => `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`),
  `event: stream.end\ndata: ${JSON.stringify(fixture.end)}\n\n`,
].join('');
const RUN_FIXTURES: Record<string, unknown> = {
  [`/api/v1/runs/${RUN_ID}`]: {
    runId: RUN_ID,
    spec: fixture.events[0]?.payload.spec,
    label: fixture.events[0]?.payload.label ?? null,
    state: 'completed',
    pinned: false,
    note: null,
    origin: 'local',
  },
  '/api/v1/flows/FLOW-04': JSON.parse(read('flows/FLOW-04.json')) as unknown,
  '/api/v1/flows/FLOW-01': JSON.parse(read('flows/FLOW-01.json')) as unknown,
  '/api/v1/flows/FLOW-30': JSON.parse(read('flows/FLOW-30.json')) as unknown,
};

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
    if (
      url.pathname === `/api/v1/streams/${RUN_ID}/events` &&
      url.searchParams.get('format') !== 'json'
    ) {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: runSse });
      return;
    }
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
    const body = BOOT_FIXTURES[url.pathname] ?? RUN_FIXTURES[url.pathname];
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

/**
 * Waits until every finite CSS animation and transition has finished (the drawer's 200 ms
 * slide-in fades from opacity 0, and axe measuring mid-fade reports a false color-contrast hit;
 * that was the wave-2 360 px flake). Infinite ones (skeleton shimmer) are ignored.
 */
export async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
  });
}

/**
 * No BFF behind the preview: answer every API path with the SPA's HTML, as `vite preview` does
 * when nothing listens on 127.0.0.1:3100 (a host BFF, e.g. the Docker stack, would otherwise
 * answer through the preview proxy and the "unreachable" page would never show).
 */
export async function noBackend(page: Page): Promise<void> {
  await page.route(/\/api\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html></html>' }),
  );
}
