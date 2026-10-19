/**
 * `events.replay` (plan/12 T-10 acceptance): each fixture loads into a real wave-2 store (SQLite temp
 * file, `openStore` + its EventSink) and the stored log replays to the same terminal state.
 *
 * The store module is loaded by a computed dynamic import: testkit may not import apps/bff
 * statically (plan/10 §1, bff depends on testkit; ADR-68). Only this test reaches into it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../paths.js';
import {
  foldRunLog,
  readEventFixture,
  readWholeLog,
  writeFixtureToStore,
  type FixtureReader,
  type FixtureSink,
} from './load.js';
import { EVENT_FIXTURE_IDS } from './types.js';

interface StoreLike {
  sink: FixtureSink;
  reader: FixtureReader;
  close(): void;
}
const storeModule = pathToFileURL(
  path.join(REPO_ROOT, 'apps', 'bff', 'src', 'store', 'index.ts'),
).href;
const { openStore } = (await import(storeModule)) as {
  openStore: (file: string, opts?: { backupDir?: string | null }) => StoreLike;
};

const dir = mkdtempSync(path.join(tmpdir(), 'events-replay-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('events.replay', () => {
  for (const id of EVENT_FIXTURE_IDS) {
    it(`${id} loads through the sink and replays to a terminal state`, () => {
      const store = openStore(path.join(dir, `${id}.db`), { backupDir: null });
      try {
        const fixture = readEventFixture(id);
        const runId = writeFixtureToStore(store.sink, fixture);
        const stored = readWholeLog(store.reader, runId, 25);
        expect(stored.map((e) => [e.seq, e.type, e.stepKey])).toEqual(
          fixture.events.map((e) => [e.seq, e.type, e.stepKey]),
        );
        const a = foldRunLog(stored);
        const b = foldRunLog(fixture.events);
        expect(a).toEqual(b);
        expect(a.terminalSeq).toBe(fixture.end.lastSeq);
        // bodies survive the sink (redaction finds no registered secret in them)
        const firstResponse = stored.find((e) => e.type === 'exchange.response');
        const fixtureResponse = fixture.events.find((e) => e.type === 'exchange.response');
        expect(JSON.stringify(firstResponse?.payload)).toContain(
          (fixtureResponse?.payload as { body: { sha256: string } }).body.sha256,
        );
        // the store refuses anything after the terminal event (02 §4.1)
        expect(() =>
          store.sink.append(runId, {
            type: 'run.started',
            payload: { startedAt: fixture.events[1]?.ts },
          }),
        ).toThrow();
      } finally {
        store.close();
      }
    });
  }
});
