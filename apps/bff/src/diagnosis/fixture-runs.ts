/**
 * Test helper (diagnosis and report tests): writes a run through the sink from a compact step list,
 * so the C12 engine and the report generator read exactly what a live run persists. The golden
 * runs rebuild S-077 / S-120 from their saved traces (fixtures/golden/diagnosis/).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mapVerifyResult } from '@interop-playground/adapters';
import type { CheckResult, Coverage, Run, RunSpec, RunVerdict } from '@interop-playground/api';
import { REPO_ROOT } from '../config/index.js';
import { sampleSpec } from '../store/fixture-log.js';
import type { Store } from '../store/index.js';

export interface FxExchange {
  counterpart: string;
  method: string;
  url: string;
  status: number;
  responseBody?: string;
}
export interface FxStep {
  stepKey: string;
  outcome: 'pass' | 'fail' | 'skipped';
  capture?: Coverage;
  coverageNote?: string;
  skipReason?: string;
  exchanges?: FxExchange[];
  /** `exchangeIds: ['@0']` refers to this step's first exchange */
  checks?: CheckResult[];
  engineCalls?: { op: string; outputSummary: unknown }[];
}

let n = 0;

/**
 * Persists a run (start, steps, optional terminal event) through the sink and returns its run id.
 * Records a run; `terminal: null` leaves it open (the diagnosis hook runs before the end)
 */
export function recordRun(
  store: Store,
  spec: RunSpec,
  steps: FxStep[],
  terminal: { verdict: RunVerdict } | { failed: string } | null,
  fixedRunId?: string,
): string {
  n += 1;
  const runId = fixedRunId ?? `01JF${String(n).padStart(22, '0')}`;
  const sink = store.sink;
  sink.createSuite({
    suiteId: `${runId}-s`,
    name: 'fixture',
    triggerKind: 'interactive',
    envClass: 'local',
    appVersion: '0.0.0',
  });
  sink.createRun({
    runId,
    suiteId: `${runId}-s`,
    triggerKind: 'interactive',
    flowId: spec.presentationFlowId ?? spec.issuanceFlowId,
    spec: { ...spec, suiteId: `${runId}-s` },
    knobsAllDefault: true,
    targetStepKey: spec.scope === 'full' ? 'vp.verdict.evaluate' : 'vci.credential',
    evidenceTier: 'automated',
    appVersion: '0.0.0',
    label: null,
  });
  sink.append(runId, { type: 'run.started', payload: { startedAt: '2026-10-19T00:00:00.000Z' } });
  steps.forEach((s, i) => {
    sink.append(runId, {
      type: 'step.started',
      stepKey: s.stepKey,
      payload: { flowId: 'FLOW-30', order: i + 1, kind: 'http', label: s.stepKey },
    });
    const ids: string[] = [];
    for (const x of s.exchanges ?? []) {
      const exchangeId = sink.nextExchangeId(runId);
      ids.push(exchangeId);
      sink.append(runId, {
        type: 'exchange.request',
        stepKey: s.stepKey,
        payload: {
          exchangeId,
          direction: 'outbound',
          actor: spec.wallet,
          counterpart: x.counterpart,
          method: x.method,
          url: x.url,
          headers: [],
          body: null,
          poll: null,
        },
      });
      sink.append(runId, {
        type: 'exchange.response',
        stepKey: s.stepKey,
        payload: {
          exchangeId,
          status: x.status,
          statusText: null,
          headers: [['Content-Type', 'application/json']],
          body:
            x.responseBody === undefined
              ? null
              : { bytes: x.responseBody, contentType: 'application/json' },
          durationMs: 5,
          poll: null,
        },
      });
    }
    for (const c of s.engineCalls ?? [])
      sink.append(runId, {
        type: 'engine.call',
        stepKey: s.stepKey,
        payload: {
          engine: 'playground-ts',
          op: c.op as never,
          inputSummary: null,
          outputSummary: c.outputSummary,
          durationMs: 0,
        },
      });
    for (const c of s.checks ?? [])
      sink.append(runId, {
        type: 'verdict.check',
        stepKey: s.stepKey,
        payload: {
          check: {
            ...c,
            exchangeIds: c.exchangeIds.map((id) =>
              id.startsWith('@') ? (ids[Number(id.slice(1))] ?? id) : id,
            ),
          },
        },
      });
    sink.append(runId, {
      type: 'step.completed',
      stepKey: s.stepKey,
      payload: {
        outcome: s.outcome,
        capture: s.capture ?? (s.outcome === 'skipped' ? 'none' : 'full'),
        skipReason: s.outcome === 'skipped' ? (s.skipReason ?? 'not performed') : null,
        coverageNote: s.coverageNote ?? null,
        durationMs: 5,
      },
    });
  });
  if (terminal) closeRun(store, runId, terminal);
  return runId;
}

/** Appends the terminal event of a recorded run: completed with a verdict, or failed with a code. */
export function closeRun(
  store: Store,
  runId: string,
  terminal: { verdict: RunVerdict } | { failed: string },
  counterfactualResult: Run['counterfactualResult'] = null,
): void {
  if ('verdict' in terminal)
    store.sink.append(runId, {
      type: 'run.completed',
      payload: { verdict: terminal.verdict, counterfactualResult },
    });
  else
    store.sink.append(runId, {
      type: 'run.failed',
      payload: { errorCode: terminal.failed, message: 'environment fault', stepKey: null },
    });
}

/** Builds a minimal interop verdict for a test run. */
export function verdictOf(
  outcome: RunVerdict['outcome'],
  failedStepKey: string | null,
): RunVerdict {
  return {
    kind: 'interop',
    outcome,
    issuanceOk: true,
    verification: outcome === 'pass' ? 'valid' : 'invalid',
    tamperVerdict: null,
    failedStepKey,
    countsTowardPassRate: true,
  };
}

// ---------- golden runs from the saved traces (S-077 fails, S-120 passes) ----------
type TraceEntry = {
  method: string;
  url: string;
  status: number;
  reqBody: string;
  resBody: unknown;
};

export const GOLDEN_DIAGNOSIS_DIR = path.join(REPO_ROOT, 'fixtures', 'golden', 'diagnosis');

/** A walt.id-to-Inji-Verify run spec with the KNOB-01 setting given, the combination the live defect run used. */
export function waltidSpec(knob01: 'absent' | 'present'): RunSpec {
  return sampleSpec({
    issuer: 'issuer.waltid',
    verifier: 'verifier.inji-verify-collab',
    format: 'dc+sd-jwt',
    configurationId: 'identityCredentialSdJwt',
    env: { issuer: 'local', wallet: 'local', verifier: 'collab' },
    versions: { issuer: 'waltid@7ac0710e', wallet: '0.0.0', verifier: 'collab' },
    knobs: { 'KNOB-01': knob01 },
  });
}

/**
 * Rebuilds the step list of a golden diagnosis run from its saved HTTP trace.
 * The steps of a waltid → playground-ts → Inji Verify (Collab) run rebuilt from a saved trace.
 */
export function goldenSteps(traceFile: string, credentialCapture: Coverage = 'full'): FxStep[] {
  const trace = JSON.parse(
    readFileSync(path.join(GOLDEN_DIAGNOSIS_DIR, traceFile), 'utf8'),
  ) as TraceEntry[];
  const [create, post, result] = trace as [TraceEntry, TraceEntry, TraceEntry];
  const vpToken = JSON.parse(new URLSearchParams(post.reqBody).get('vp_token') ?? '{}') as {
    pg: string[];
  };
  const parts = (vpToken.pg[0] ?? '').split('~');
  const credential = `${parts.slice(0, -1).join('~')}~`; // without the KB-JWT
  const { verdict, checks } = mapVerifyResult(result.resBody, ['@0']);
  const pass = verdict === 'valid';
  return [
    {
      stepKey: 'vci.credential',
      outcome: 'pass',
      capture: credentialCapture,
      ...(credentialCapture === 'partial'
        ? { coverageNote: 'issuer-side hop outside capture' }
        : {}),
      exchanges: [
        {
          counterpart: 'waltid',
          method: 'POST',
          url: 'https://waltid.local/openid4vci/credential',
          status: 200,
          responseBody: JSON.stringify({ credentials: [{ credential }] }),
        },
      ],
    },
    {
      stepKey: 'vp.request.create',
      outcome: 'pass',
      exchanges: [
        {
          counterpart: 'inji-verify',
          method: create.method,
          url: create.url,
          status: create.status,
          responseBody: JSON.stringify(create.resBody),
        },
      ],
    },
    {
      stepKey: 'vp.response.post',
      outcome: 'pass',
      exchanges: [
        { counterpart: 'inji-verify', method: post.method, url: post.url, status: post.status },
      ],
    },
    {
      stepKey: 'vp.result.poll',
      outcome: 'pass',
      exchanges: [
        {
          counterpart: 'inji-verify',
          method: result.method,
          url: result.url,
          status: result.status,
          responseBody: JSON.stringify(result.resBody),
        },
      ],
      checks,
    },
    {
      stepKey: 'vp.verdict.evaluate',
      outcome: pass ? 'pass' : 'fail',
      checks: [
        {
          checkId: 'vp.verdict',
          outcome: pass ? 'pass' : 'fail',
          source: 'verifier-response',
          message: verdict,
          exchangeIds: [],
        },
      ],
    },
  ];
}
