/**
 * Recaptures docs/screenshots/design-*.png from the fixture UI (see docs/design.md, "How the
 * screenshots were made"). The preview server must already be running:
 *   npm run build -w @interop-playground/ui
 *   npm run preview -w @interop-playground/ui -- --port 4391 &
 *   npx tsx scripts/capture-design.mts docs/screenshots http://127.0.0.1:4391
 */
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { CHILD_ID, PARENT_ID, RUN_ID, serveApi, setTheme } from '../e2e/support.ts';
import { UNCLASSIFIED_DIAGNOSIS } from '../apps/ui/src/test/angle-fixtures.ts';

const [outDir = 'docs/screenshots', base = 'http://127.0.0.1:4391'] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const repo = path.resolve(import.meta.dirname, '..');
const load = (name: string, runId: string, verification?: string) => {
  const raw = readFileSync(path.join(repo, `fixtures/events/${name}.json`), 'utf8');
  const log = JSON.parse(raw.replaceAll(JSON.parse(raw).runId, runId));
  if (verification) {
    for (const e of log.events)
      if (e.type === 'run.completed') e.payload.verdict.verification = verification;
  }
  return log;
};
const sseOf = (events: { seq: number; type: string }[], end?: unknown) =>
  [
    'retry: 600000\n\n',
    ...events.map((e) => `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`),
    ...(end ? [`event: stream.end\ndata: ${JSON.stringify(end)}\n\n`] : []),
  ].join('');

const MID = '01J8MMMMMMMMMMMMMMMMMMMMMM';
const VALID = '01J8VVVVVVVVVVVVVVVVVVVVVV';
const EXPIRED = '01J8EEEEEEEEEEEEEEEEEEEEEE';
const mid = load('FLOW-30-fail', MID);
const cut = mid.events.filter((e: { seq: number }) => e.seq <= 63);
const logs: Record<string, { events: { payload: { spec: unknown } }[]; end: unknown }> = {
  [VALID]: load('FLOW-30-pass', VALID),
  [EXPIRED]: load('FLOW-30-pass', EXPIRED, 'valid-but-expired'),
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: base });
const page = await ctx.newPage();
await setTheme(page as never, 'light');
await serveApi(page as never);
const run = (id: string, state: string, spec: unknown) => ({
  runId: id,
  spec,
  label: null,
  state,
  pinned: false,
  note: null,
  origin: 'local',
});
await page.route(`**/api/v1/runs/${MID}`, (r) =>
  r.fulfill({ json: run(MID, 'running', cut[0].payload.spec) }),
);
await page.route(`**/api/v1/streams/${MID}/events*`, (r) =>
  r.fulfill({ status: 200, contentType: 'text/event-stream', body: sseOf(cut) }),
);
for (const [id, log] of Object.entries(logs)) {
  await page.route(`**/api/v1/runs/${id}`, (r) =>
    r.fulfill({ json: run(id, 'completed', log.events[0]!.payload.spec) }),
  );
  await page.route(`**/api/v1/streams/${id}/events*`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sseOf(log.events as never, log.end),
    }),
  );
}
await page.route(`**/api/v1/runs/${RUN_ID}/diagnosis`, (r) =>
  r.fulfill({ json: UNCLASSIFIED_DIAGNOSIS }),
);

const shot = async (name: string) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, `design-${name}.png`) });
};
const resultCard = async (id: string) => {
  await page.goto(`/runs/${id}`);
  const card = page.getByRole('region', { name: 'Result' });
  await card.waitFor();
  await card.scrollIntoViewIfNeeded();
};

await page.goto('/');
await page.getByRole('radiogroup').first().waitFor();
await shot('selector');

await page.clock.setFixedTime(new Date(Date.parse(cut[1].ts) + 41_000));
await page.goto(`/runs/${MID}`);
await page.locator('[data-renderer]').first().waitFor();
await page.waitForTimeout(800);
await shot('run-midrun');

await page.goto(`/runs/${RUN_ID}#step=vci.credential`);
await page.getByRole('region', { name: 'Result' }).waitFor();
await page.getByRole('tab', { name: 'Decoded' }).click();
await page.locator('.run-pane-inspector').scrollIntoViewIfNeeded();
await shot('inspector-decoded');

await resultCard(VALID);
await shot('result-valid');
await resultCard(RUN_ID);
await shot('result-invalid');
await resultCard(EXPIRED);
await shot('result-expired');

await page.goto(`/runs/${PARENT_ID}`);
await page.getByTestId('diagnosis-card').waitFor();
await page.getByTestId('diagnosis-card').scrollIntoViewIfNeeded();
await shot('diagnosis-fixit');

await page.goto(`/runs/${CHILD_ID}`);
await page.getByTestId('claim').waitFor();
await page.getByRole('button', { name: /^Compare with run/ }).click();
await page.locator('.compare-strip').waitFor();
await page.getByTestId('child-result').scrollIntoViewIfNeeded();
await shot('child-compare');

await page.goto(`/runs/${RUN_ID}/report`);
await page.getByRole('tab', { name: 'Report' }).waitFor();
await shot('report');

await page.goto('/environment');
await page.getByRole('heading', { level: 1 }).waitFor();
await shot('environment');

await browser.close();
console.log('done', outDir);
