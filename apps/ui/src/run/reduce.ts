/**
 * The run view reducer (06 UI-09, ADR-41): one pure function over the run's ordered event log. Live
 * (SSE), terminal load and replay (`?format=json` pages) all feed it, so the same log always gives
 * the same view. It keeps no state the log cannot rebuild.
 */
import type {
  CheckResult,
  Coverage,
  EventEnvelope,
  FlowId,
  Outcome,
  RunSpec,
  RunState,
  RunVerdict,
} from '@interop-playground/api';

export interface StepView {
  stepKey: string;
  flowId: FlowId | null;
  order: number | null;
  kind: 'http' | 'engine' | 'ui' | 'manual' | null;
  state: 'pending' | 'running' | 'done';
  outcome: Outcome | null;
  capture: Coverage | null;
  skipReason: string | null;
  coverageNote: string | null;
  durationMs: number | null;
  startedSeq: number | null;
  exchangeIds: string[];
  /** status + error body of the last response of the step (ResultCard fallback, UI-11) */
  lastResponse: { status: number; text: string | null } | null;
  checks: CheckResult[];
  engines: string[];
}

export interface RunView {
  runId: string | null;
  spec: RunSpec | null;
  label: string | null;
  state: RunState | null;
  queuePosition: number;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  verdict: RunVerdict | null;
  failed: { errorCode: string; message: string; stepKey: string | null } | null;
  cancelled: { reason: 'user' | 'suite' | 'shutdown'; atStepKey: string | null } | null;
  steps: Record<string, StepView>;
  /** stepKeys in the order their first event arrived */
  seen: string[];
  /** the step that started last and has not completed */
  currentStepKey: string | null;
  awaiting: { stepKey: string; expects: string[]; deadline: string } | null;
  proofAlg: string | null;
  lastSeq: number;
}

export function initialRunView(): RunView {
  return {
    runId: null,
    spec: null,
    label: null,
    state: null,
    queuePosition: 0,
    createdAt: null,
    startedAt: null,
    finishedAt: null,
    verdict: null,
    failed: null,
    cancelled: null,
    steps: {},
    seen: [],
    currentStepKey: null,
    awaiting: null,
    proofAlg: null,
    lastSeq: 0,
  };
}

function emptyStep(stepKey: string): StepView {
  return {
    stepKey,
    flowId: null,
    order: null,
    kind: null,
    state: 'pending',
    outcome: null,
    capture: null,
    skipReason: null,
    coverageNote: null,
    durationMs: null,
    startedSeq: null,
    exchangeIds: [],
    lastResponse: null,
    checks: [],
    engines: [],
  };
}

function withStep(view: RunView, stepKey: string, patch: (s: StepView) => StepView): RunView {
  const prev = view.steps[stepKey] ?? emptyStep(stepKey);
  return {
    ...view,
    steps: { ...view.steps, [stepKey]: patch(prev) },
    seen: view.seen.includes(stepKey) ? view.seen : [...view.seen, stepKey],
  };
}

/** Apply one event. Events at or below `lastSeq` are ignored (the stream client already dedupes). */
export function reduceRunView(view: RunView, event: EventEnvelope): RunView {
  if (event.seq <= view.lastSeq) return view;
  let next: RunView = { ...view, lastSeq: event.seq, runId: view.runId ?? event.runId };
  const key = event.stepKey;
  switch (event.type) {
    case 'run.created': {
      const p = (event as EventEnvelope<'run.created'>).payload;
      next = {
        ...next,
        spec: p.spec,
        label: p.label,
        queuePosition: p.queuePosition,
        state: 'queued',
        createdAt: event.ts,
      };
      break;
    }
    case 'run.started':
      next = {
        ...next,
        state: 'running',
        startedAt: (event as EventEnvelope<'run.started'>).payload.startedAt,
      };
      break;
    case 'run.completed':
      next = {
        ...next,
        state: 'completed',
        verdict: (event as EventEnvelope<'run.completed'>).payload.verdict,
        finishedAt: event.ts,
        awaiting: null,
        currentStepKey: null,
      };
      break;
    case 'run.failed':
      next = {
        ...next,
        state: 'failed',
        failed: (event as EventEnvelope<'run.failed'>).payload,
        finishedAt: event.ts,
        awaiting: null,
        currentStepKey: null,
      };
      break;
    case 'run.cancelled':
      next = {
        ...next,
        state: 'cancelled',
        cancelled: (event as EventEnvelope<'run.cancelled'>).payload,
        finishedAt: event.ts,
        awaiting: null,
        currentStepKey: null,
      };
      break;
    case 'step.started': {
      if (!key) break;
      const p = (event as EventEnvelope<'step.started'>).payload;
      next = withStep(next, key, (s) => ({
        ...s,
        flowId: p.flowId,
        order: p.order,
        kind: p.kind,
        state: 'running',
        startedSeq: event.seq,
      }));
      next.currentStepKey = key;
      break;
    }
    case 'step.completed': {
      if (!key) break;
      const p = (event as EventEnvelope<'step.completed'>).payload;
      next = withStep(next, key, (s) => ({
        ...s,
        state: 'done',
        outcome: p.outcome,
        capture: p.capture,
        skipReason: p.skipReason,
        coverageNote: p.coverageNote,
        durationMs: p.durationMs,
      }));
      if (next.currentStepKey === key) next.currentStepKey = null;
      if (next.awaiting?.stepKey === key) next.awaiting = null;
      break;
    }
    case 'exchange.request': {
      if (!key) break;
      const id = (event as EventEnvelope<'exchange.request'>).payload.exchangeId;
      next = withStep(next, key, (s) =>
        s.exchangeIds.includes(id) ? s : { ...s, exchangeIds: [...s.exchangeIds, id] },
      );
      break;
    }
    case 'exchange.response': {
      if (!key) break;
      const p = (event as EventEnvelope<'exchange.response'>).payload;
      next = withStep(next, key, (s) => ({
        ...s,
        lastResponse: { status: p.status, text: p.body?.text ?? null },
      }));
      break;
    }
    case 'engine.call': {
      if (!key) break;
      const p = (event as EventEnvelope<'engine.call'>).payload;
      next = withStep(next, key, (s) => ({
        ...s,
        engines: s.engines.includes(p.engine) ? s.engines : [...s.engines, p.engine],
      }));
      if (p.op === 'sign-proof' && key.startsWith('vci.')) {
        const alg = (p.outputSummary as { alg?: unknown } | null)?.alg;
        if (typeof alg === 'string') next.proofAlg = alg;
      }
      if (p.op === 'await-observation') {
        const o = p.outputSummary as { expects?: string[]; deadline?: string } | null;
        next.awaiting = {
          stepKey: key,
          expects: o?.expects ?? [],
          deadline: o?.deadline ?? event.ts,
        };
      }
      if (p.op === 'manual-observation' && next.awaiting?.stepKey === key) next.awaiting = null;
      break;
    }
    case 'engine.exception': {
      if (!key) break;
      const p = (event as EventEnvelope<'engine.exception'>).payload;
      next = withStep(next, key, (s) => ({
        ...s,
        engines: s.engines.includes(p.engine) ? s.engines : [...s.engines, p.engine],
      }));
      break;
    }
    case 'verdict.check': {
      if (!key) break;
      const c = (event as EventEnvelope<'verdict.check'>).payload.check;
      next = withStep(next, key, (s) => ({ ...s, checks: [...s.checks, c] }));
      break;
    }
    default:
      break;
  }
  return next;
}

export function reduceAll(
  events: readonly EventEnvelope[],
  from: RunView = initialRunView(),
): RunView {
  return events.reduce(reduceRunView, from);
}

export type ViewState =
  | 'loading'
  | 'queued'
  | 'running'
  | 'awaiting'
  | 'done-pass'
  | 'done-fail'
  | 'done-blocked'
  | 'done-lenient'
  | 'done-inconclusive'
  | 'done-no-submission'
  | 'cancelled'
  | 'error';

/** UI-09 `viewState` from the reduced log (the `replaying` state belongs to the diagram, T-29). */
export function viewStateOf(view: RunView, flowsReady: boolean): ViewState {
  if (!flowsReady || view.state === null) return 'loading';
  switch (view.state) {
    case 'queued':
      return 'queued';
    case 'running':
      return view.awaiting ? 'awaiting' : 'running';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'error';
    case 'completed':
      return view.verdict ? `done-${view.verdict.outcome}` : 'done-inconclusive';
  }
}

export const isTerminal = (v: RunView): boolean =>
  v.state === 'completed' || v.state === 'failed' || v.state === 'cancelled';
