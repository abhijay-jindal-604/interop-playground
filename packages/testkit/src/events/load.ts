/**
 * Loads an event-log fixture into a store through its EventSink and replays it back (plan/12 T-10
 * acceptance, plan/11 §3.1 `RunFixtureStream`). The sink and reader are injected structurally: the
 * testkit may not import `apps/bff` (plan/10 §1 dependency direction; bff depends on testkit), so a
 * caller passes `openStore(...)`'s `sink` and `reader` (ADR-68).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  BodyRef,
  EventEnvelope,
  EventType,
  Headers,
  RunSpec,
  RunState,
  RunVerdict,
  StreamEndFrame,
} from '@interop-playground/api';
import { EVENTS_DIR } from '../paths.js';
import type { EventFixture, EventFixtureId } from './types.js';

export function serialiseFixture(fixture: unknown): string {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

export function readEventFixture(id: EventFixtureId, dir: string = EVENTS_DIR): EventFixture {
  return JSON.parse(readFileSync(path.join(dir, `${id}.json`), 'utf8')) as EventFixture;
}

/** the parts of `EventSink` (apps/bff/src/store/sink.ts) the loader uses */
export interface FixtureSink {
  createSuite(s: {
    suiteId: string;
    name: string;
    triggerKind: 'interactive' | 'nightly' | 'ci' | 'manual-suite';
    envClass: 'local' | 'collab' | 'mixed';
    appVersion: string;
  }): void;
  createRun(n: {
    runId: string;
    suiteId: string;
    triggerKind: 'interactive' | 'nightly' | 'ci' | 'derive';
    flowId: string;
    spec: RunSpec;
    label?: string | null;
    queuePosition?: number;
    knobsAllDefault: boolean;
    targetStepKey: string;
    evidenceTier: 'automated' | 'best-effort' | 'manual';
    appVersion: string;
  }): unknown;
  append(runId: string, ev: { type: EventType; stepKey?: string; payload: unknown }): unknown;
}

/** the part of `StoreReader` the replay uses */
export interface FixtureReader {
  readEvents(runId: string, after?: number, limit?: number): EventEnvelope[];
}

function rawBody(
  body: BodyRef | null,
  headers: Headers,
): { bytes: string | Uint8Array; contentType: string | null } | null {
  if (!body) return null;
  const ct = headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? null;
  return {
    bytes: body.encoding === 'base64' ? Buffer.from(body.text, 'base64') : body.text,
    contentType: ct,
  };
}

/** Writes the fixture's run (suite, `run.created`, every later event) through the sink; returns the run id. */
export function writeFixtureToStore(
  sink: FixtureSink,
  fixture: EventFixture,
  opts: { runId?: string; appVersion?: string } = {},
): string {
  const runId = opts.runId ?? fixture.runId;
  const created = fixture.events[0] as EventEnvelope<'run.created'> | undefined;
  if (created?.type !== 'run.created')
    throw new Error(`${fixture.fixtureId}: first event is not run.created`);
  const suiteId = `${runId}-suite`;
  const appVersion = opts.appVersion ?? '0.0.0';
  sink.createSuite({
    suiteId,
    name: fixture.fixtureId,
    triggerKind: 'ci',
    envClass: 'local',
    appVersion,
  });
  sink.createRun({
    runId,
    suiteId,
    triggerKind: 'ci',
    flowId: fixture.run.flowId,
    spec: created.payload.spec,
    label: created.payload.label,
    queuePosition: created.payload.queuePosition,
    knobsAllDefault: fixture.run.knobsAllDefault,
    targetStepKey: fixture.run.targetStepKey,
    evidenceTier: fixture.run.evidenceTier,
    appVersion,
  });
  for (const ev of fixture.events.slice(1)) {
    const stepKey = ev.stepKey === undefined ? {} : { stepKey: ev.stepKey };
    if (ev.type === 'exchange.request' || ev.type === 'exchange.response') {
      const p = ev.payload as EventEnvelope<'exchange.request'>['payload'];
      const { bodyState: _bodyState, body, ...rest } = p;
      const fixedId =
        runId === fixture.runId ? rest.exchangeId : rest.exchangeId.replace(fixture.runId, runId);
      sink.append(runId, {
        type: ev.type,
        ...stepKey,
        payload: { ...rest, exchangeId: fixedId, body: rawBody(body, p.headers) },
      });
      continue;
    }
    sink.append(runId, { type: ev.type, ...stepKey, payload: ev.payload });
  }
  return runId;
}

/** Reads the whole stored log back in pages (what API-15 `?format=json` serves). */
export function readWholeLog(
  reader: FixtureReader,
  runId: string,
  pageSize = 500,
): EventEnvelope[] {
  const out: EventEnvelope[] = [];
  for (;;) {
    const page = reader.readEvents(runId, out.length === 0 ? 0 : (out.at(-1)?.seq ?? 0), pageSize);
    out.push(...page);
    if (page.length < pageSize) return out;
  }
}

export interface RunFold {
  state: RunState;
  verdict: RunVerdict | null;
  errorCode: string | null;
  lastSeq: number;
  terminalSeq: number | null;
  steps: Record<string, { outcome: 'pass' | 'fail' | 'skipped' | null; capture: string | null }>;
}

const TERMINAL: ReadonlySet<string> = new Set(['run.completed', 'run.failed', 'run.cancelled']);

/** Replays a log to its final run state; throws on a gap, a duplicate or an event after the terminal one. */
export function foldRunLog(events: readonly EventEnvelope[]): RunFold {
  const fold: RunFold = {
    state: 'queued',
    verdict: null,
    errorCode: null,
    lastSeq: 0,
    terminalSeq: null,
    steps: {},
  };
  for (const ev of events) {
    if (ev.seq !== fold.lastSeq + 1) throw new Error(`seq ${ev.seq} after ${fold.lastSeq}`);
    if (fold.terminalSeq !== null) throw new Error(`event ${ev.seq} after the terminal event`);
    fold.lastSeq = ev.seq;
    switch (ev.type) {
      case 'run.started':
        fold.state = 'running';
        break;
      case 'run.completed':
        fold.state = 'completed';
        fold.verdict = (ev as EventEnvelope<'run.completed'>).payload.verdict;
        break;
      case 'run.failed':
        fold.state = 'failed';
        fold.errorCode = (ev as EventEnvelope<'run.failed'>).payload.errorCode;
        break;
      case 'run.cancelled':
        fold.state = 'cancelled';
        break;
      case 'step.started':
        fold.steps[ev.stepKey ?? '?'] = { outcome: null, capture: null };
        break;
      case 'step.completed': {
        const p = (ev as EventEnvelope<'step.completed'>).payload;
        fold.steps[ev.stepKey ?? '?'] = { outcome: p.outcome, capture: p.capture };
        break;
      }
      default:
        break;
    }
    if (TERMINAL.has(ev.type)) fold.terminalSeq = ev.seq;
  }
  return fold;
}

/** The SSE frames API-15 sends for a closed run: one per event, then `stream.end` (04 §7.1). */
export function sseFrames(events: readonly EventEnvelope[], end: StreamEndFrame): string {
  const frames = ['retry: 3000\n\n'];
  for (const ev of events)
    frames.push(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  frames.push(`event: stream.end\ndata: ${JSON.stringify(end)}\n\n`);
  return frames.join('');
}
