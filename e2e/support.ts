/**
 * Shell e2e support: the API answered by the shared fixtures of apps/ui/src/test/fixtures.ts until
 * the testkit BFF of plan/11 §5 serves the built UI; the `env` stream answers one `retry` frame.
 * The run route (`RUN_ID`) answers the recorded FLOW-30 fail log of fixtures/events (T-10): API-22,
 * API-06 for its flow files, its stream as SSE ending in `stream.end`, and API-45 its report.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { BOOT_FIXTURES } from '../apps/ui/src/test/fixtures.ts';
import { FAIL_REPORT } from '../apps/ui/src/test/report-fixtures.ts';
import {
  CHILD_ID,
  CHILD_LINEAGE,
  EXACT_DIAGNOSIS,
  KNOB01,
  PARENT_ID,
  PARENT_LINEAGE,
  POSSIBLE_DIAGNOSIS,
  POSSIBLE_ID,
  childCompare,
} from '../apps/ui/src/test/angle-fixtures.ts';

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
  // API-45 (UI-51): the forced-fail report fixture under the run's id
  [`/api/v1/reports/runs/${RUN_ID}`]: { ...FAIL_REPORT, runId: RUN_ID },
};

// ---- angle A (T-45) on the T-44 flow: parent fails with FP-01 exact + KNOB-01 offered; the derive
// call creates the child, which passes with `counterfactualResult: fixed` (fixture routes only)
const passLog = JSON.parse(read('fixtures/events/FLOW-30-pass.json')) as Fixture;
const delta = { knobId: 'KNOB-01', from: 'absent', to: 'present' };
function relabel(log: Fixture, runId: string, child: boolean): Fixture {
  const text = JSON.stringify(log).replaceAll(log.runId, runId);
  const out = JSON.parse(text) as Fixture;
  if (child) {
    const created = out.events[0]!.payload as { spec: Record<string, unknown> };
    created.spec = {
      ...created.spec,
      parentRunId: PARENT_ID,
      knobDelta: delta,
      causeFingerprintId: 'FP-01',
      knobs: { 'KNOB-01': 'present' },
    };
    for (const e of out.events)
      if (e.type === 'run.completed') Object.assign(e.payload, { counterfactualResult: 'fixed' });
  }
  return out;
}
const sse = (log: Fixture) =>
  [
    'retry: 3000\n\n',
    ...log.events.map((e) => `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`),
    `event: stream.end\ndata: ${JSON.stringify(log.end)}\n\n`,
  ].join('');
const runOf = (log: Fixture, runId: string, extra: Record<string, unknown> = {}) => ({
  runId,
  spec: log.events[0]?.payload.spec,
  label: null,
  state: 'completed',
  pinned: false,
  note: null,
  origin: 'local',
  counterfactualResult: null,
  links: { parentRunId: null, controlRunId: null, childRunIds: [] },
  ...extra,
});
const parentLog = relabel(fixture, PARENT_ID, false);
const possibleLog = relabel(fixture, POSSIBLE_ID, false);
const childLog = relabel(passLog, CHILD_ID, true);
const parentRun = runOf(parentLog, PARENT_ID);
const childRun = runOf(childLog, CHILD_ID, {
  counterfactualResult: 'fixed',
  links: { parentRunId: PARENT_ID, controlRunId: null, childRunIds: [] },
});
const ANGLE_STREAMS: Record<string, string> = {
  [PARENT_ID]: sse(parentLog),
  [POSSIBLE_ID]: sse(possibleLog),
  [CHILD_ID]: sse(childLog),
};
const ANGLE_FIXTURES: Record<string, unknown> = {
  '/api/v1/knobs': { knobs: [KNOB01] },
  [`/api/v1/runs/${PARENT_ID}`]: parentRun,
  [`/api/v1/runs/${PARENT_ID}/diagnosis`]: EXACT_DIAGNOSIS,
  [`/api/v1/runs/${PARENT_ID}/lineage`]: PARENT_LINEAGE,
  [`POST /api/v1/runs/${PARENT_ID}/derive`]: { ...childRun, state: 'queued' },
  [`/api/v1/runs/${POSSIBLE_ID}`]: runOf(possibleLog, POSSIBLE_ID),
  [`/api/v1/runs/${POSSIBLE_ID}/diagnosis`]: POSSIBLE_DIAGNOSIS,
  [`/api/v1/runs/${CHILD_ID}`]: childRun,
  [`/api/v1/runs/${CHILD_ID}/lineage`]: CHILD_LINEAGE,
  [`/api/v1/runs/${PARENT_ID}/compare/${CHILD_ID}`]: childCompare(parentRun, childRun),
};
export { CHILD_ID, PARENT_ID, POSSIBLE_ID };

export const ROUTES = [
  '/',
  '/runs/01J8ZZZZZZZZZZZZZZZZZZZZZZ',
  '/runs/01J8ZZZZZZZZZZZZZZZZZZZZZZ/report',
  `/runs/${PARENT_ID}`,
  `/runs/${CHILD_ID}`,
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
    const angleStream = /^\/api\/v1\/streams\/([^/]+)\/events$/.exec(url.pathname)?.[1];
    if (angleStream && ANGLE_STREAMS[angleStream] && url.searchParams.get('format') !== 'json') {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: ANGLE_STREAMS[angleStream],
      });
      return;
    }
    if (route.request().method() === 'POST') {
      const posted = ANGLE_FIXTURES[`POST ${url.pathname}`];
      if (posted !== undefined) {
        await route.fulfill({ status: 201, json: posted });
        return;
      }
    }
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
    const body =
      ANGLE_FIXTURES[url.pathname] ?? BOOT_FIXTURES[url.pathname] ?? RUN_FIXTURES[url.pathname];
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
