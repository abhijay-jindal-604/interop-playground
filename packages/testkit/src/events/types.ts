/**
 * Recorded event-log fixtures (plan/11 §3.1 `RunFixtureStream`, plan/12 T-10): one finished run's
 * `run:{runId}` stream exactly as API-15 delivers it (04 §7.1), ending in its terminal event and the
 * `stream.end` control frame. Files: `fixtures/events/<fixtureId>.json`.
 */
import type { EventEnvelope, FlowId, StreamEndFrame, Ulid } from '@interop-playground/api';

export const EVENT_FIXTURE_IDS = [
  'FLOW-01-pass',
  'FLOW-04-pass',
  'FLOW-30-pass',
  'FLOW-30-fail',
] as const;
export type EventFixtureId = (typeof EVENT_FIXTURE_IDS)[number];

export interface EventFixture {
  fixtureId: EventFixtureId;
  description: string;
  /** the golden files (fixtures/golden/…) and S-IDs the exchanges were taken from */
  sources: { file: string; sids: string[] }[];
  runId: Ulid;
  /** what the orchestrator would pass to `EventSink.createRun` besides the spec (05 §3 `runs`) */
  run: {
    flowId: FlowId;
    targetStepKey: string;
    evidenceTier: 'automated' | 'best-effort' | 'manual';
    knobsAllDefault: boolean;
  };
  /** the flow definitions the run's steps come from (API-06), issuance first */
  flows: FlowId[];
  events: EventEnvelope[];
  end: StreamEndFrame;
}
