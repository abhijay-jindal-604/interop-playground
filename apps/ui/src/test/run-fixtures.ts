/**
 * Run-screen test fixtures: the recorded event logs of fixtures/events/ (T-10) and the flow files
 * of flows/ read from disk, plus helpers that derive every UI-11 state from them (a prefix of a log,
 * or its terminal event replaced). The UI may import only @interop-playground/api, so the files are
 * read, not imported from the testkit.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  EventEnvelope,
  EventType,
  FlowDefinition,
  PayloadOf,
  StreamEndFrame,
} from '@interop-playground/api';
import { railSteps, type RunFlows } from '../run/flows.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

export type FixtureId = 'FLOW-01-pass' | 'FLOW-04-pass' | 'FLOW-30-pass' | 'FLOW-30-fail';
export interface LogFixture {
  fixtureId: FixtureId;
  runId: string;
  flows: string[];
  events: EventEnvelope[];
  end: StreamEndFrame;
}

export function logFixture(id: FixtureId): LogFixture {
  return JSON.parse(
    readFileSync(path.join(repo, 'fixtures', 'events', `${id}.json`), 'utf8'),
  ) as LogFixture;
}

export function flowFile(id: string): FlowDefinition {
  return JSON.parse(readFileSync(path.join(repo, 'flows', `${id}.json`), 'utf8')) as FlowDefinition;
}

/** the RunFlows the page would build for this fixture */
export function fixtureFlows(f: LogFixture): RunFlows {
  const created = f.events[0] as EventEnvelope<'run.created'>;
  const spec = created.payload.spec;
  const issuance = flowFile(spec.issuanceFlowId);
  const presentation = spec.presentationFlowId ? flowFile(spec.presentationFlowId) : null;
  const bases: Record<string, FlowDefinition> = {};
  for (const d of [issuance, presentation]) if (d?.extends) bases[d.extends] = flowFile(d.extends);
  return { issuance, presentation, steps: railSteps(issuance, presentation, bases, spec) };
}

/** events up to (excluding) the terminal one */
export function withoutTerminal(events: readonly EventEnvelope[]): EventEnvelope[] {
  return events.slice(0, -1);
}

export function append<T extends EventType>(
  events: readonly EventEnvelope[],
  type: T,
  payload: PayloadOf<T>,
  stepKey?: string,
): EventEnvelope[] {
  const last = events.at(-1);
  const seq = (last?.seq ?? 0) + 1;
  const ev = {
    v: 1,
    runId: last?.runId ?? 'R',
    seq,
    ts: new Date(Date.parse(last?.ts ?? '2026-10-19T10:00:00.000Z') + 5).toISOString(),
    type,
    ...(stepKey === undefined ? {} : { stepKey }),
    payload,
  } as EventEnvelope;
  return [...events, ev];
}

/** the first `n` events (a live run caught mid-way) */
export function prefix(
  events: readonly EventEnvelope[],
  predicate: (e: EventEnvelope) => boolean,
): EventEnvelope[] {
  const at = events.findIndex(predicate);
  return at < 0 ? [...events] : events.slice(0, at + 1);
}
