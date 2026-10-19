/**
 * `events.fixtures` (plan/12 T-10): every recorded event log under fixtures/events/ is valid against
 * the generated contract schema (04 §7), has contiguous seqs from 1, exactly one terminal event as
 * its last event and a matching `stream.end`, uses only stepKeys of its flow files, and equals what
 * the builder produces from the golden traces.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import { resolvedSteps } from '../flows.js';
import { API_SCHEMA_PATH } from '../paths.js';
import { buildEventFixture } from './build.js';
import { foldRunLog, readEventFixture, serialiseFixture, sseFrames } from './load.js';
import { EVENT_FIXTURE_IDS } from './types.js';
import { EVENTS_DIR } from '../paths.js';
import path from 'node:path';

const schema = JSON.parse(readFileSync(API_SCHEMA_PATH, 'utf8')) as Record<string, unknown>;
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema({ $id: 'api', ...schema });
const validEvent = ajv.getSchema('api#/definitions/AnyEvent');
const validEnd = ajv.getSchema('api#/definitions/StreamEndFrame');
const TERMINAL = new Set(['run.completed', 'run.failed', 'run.cancelled']);
const STEP_TYPES = /^(step\.|exchange\.|engine\.|verdict\.check)/;

describe('events.fixtures', () => {
  for (const id of EVENT_FIXTURE_IDS) {
    describe(id, () => {
      const fixture = readEventFixture(id);

      it('every event validates against AnyEvent and the end frame against StreamEndFrame', () => {
        for (const ev of fixture.events) {
          expect(
            validEvent?.(ev),
            `${ev.seq} ${ev.type}: ${JSON.stringify(validEvent?.errors?.slice(0, 2))}`,
          ).toBe(true);
          expect(ev.runId).toBe(fixture.runId);
        }
        expect(validEnd?.(fixture.end)).toBe(true);
      });

      it('replays to a terminal state: seq 1..n, one terminal event last, stream.end lastSeq = n', () => {
        const fold = foldRunLog(fixture.events);
        expect(fold.terminalSeq).toBe(fixture.events.length);
        expect(fixture.events.filter((e) => TERMINAL.has(e.type))).toHaveLength(1);
        expect(fixture.end).toEqual({ reason: 'terminal', lastSeq: fixture.events.length });
        expect(fold.state).toBe('completed');
        expect(fold.verdict?.outcome).toBe(id.endsWith('fail') ? 'fail' : 'pass');
      });

      it('stepKey rules: present on step/exchange/engine/check events, absent on run.*, and in the flow files', () => {
        const keys = new Set(fixture.flows.flatMap((f) => resolvedSteps(f).map((s) => s.stepKey)));
        for (const ev of fixture.events) {
          if (STEP_TYPES.test(ev.type))
            expect(keys.has(ev.stepKey ?? ''), `${ev.seq} ${ev.stepKey}`).toBe(true);
          else expect(ev.stepKey).toBeUndefined();
        }
        // every flow step is reported exactly once (skipped steps included, ADR-27/29)
        const completed = fixture.events
          .filter((e) => e.type === 'step.completed')
          .map((e) => e.stepKey);
        expect(completed.sort()).toEqual(
          fixture.flows.flatMap((f) => resolvedSteps(f).map((s) => s.stepKey)).sort(),
        );
      });

      it('equals the builder output (regenerate with packages/testkit/src/events/write.ts)', () => {
        const committed = readFileSync(path.join(EVENTS_DIR, `${id}.json`), 'utf8');
        expect(committed).toBe(serialiseFixture(buildEventFixture(id)));
      });

      it('serialises as the SSE frames of 04 §7.1 ending in stream.end', () => {
        const sse = sseFrames(fixture.events, fixture.end);
        expect(sse.startsWith('retry: 3000\n\n')).toBe(true);
        expect(sse.match(/^id: /gm)).toHaveLength(fixture.events.length);
        expect(sse.endsWith(`event: stream.end\ndata: ${JSON.stringify(fixture.end)}\n\n`)).toBe(
          true,
        );
      });
    });
  }

  it('the FLOW-30 fail variant fails at vp.response.post with the recorded verifier code', () => {
    const f = readEventFixture('FLOW-30-fail');
    const last = f.events.at(-1);
    expect(last?.type).toBe('run.completed');
    const check = f.events.find(
      (e) => e.type === 'verdict.check' && e.stepKey === 'vp.response.post',
    );
    expect(JSON.stringify(check?.payload)).toContain('Client id validation failed');
  });
});
