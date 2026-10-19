/**
 * T-42 acceptance (plan/12; 04 API-24, §5.4, 09 A5.3, ADR-21), API-30 and API-31 contract tests,
 * G-151. The failed parent is the S-077 golden (walt.id without x5c → Inji Verify: FP-01 exact,
 * KNOB-01 absent → present offered); the fixed child is the S-120 golden.
 *  - one contract test per derive error code (+ the 201 child: one knob changed, lineage set);
 *  - child classification fixed / moved / not-fixed / inconclusive on fixtures;
 *  - API-30 / API-31 responses valid against the generated schema; parent-first swap; volatile.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import type { FastifyInstance } from 'fastify';
import type {
  AdapterId,
  CompareResponse,
  DiagnosisResponse,
  ErrorEnvelope,
  Run,
  RunSpec,
} from '@interop-playground/api';
import type {
  CapturingHttp,
  IssuerAdapter,
  VerifierAdapter,
  WalletAdapter,
} from '@interop-playground/adapters';
import { REPO_ROOT } from '../config/index.js';
import {
  DiagnosisEngine,
  classifyStoredChild,
  diagnose,
  loadEvidence,
  loadLibrary,
} from '../diagnosis/index.js';
import {
  closeRun,
  goldenSteps,
  recordRun,
  verdictOf,
  waltidSpec,
} from '../diagnosis/fixture-runs.js';
import type { FxStep } from '../diagnosis/fixture-runs.js';
import { ApiError } from '../errors/index.js';
import { Orchestrator, loadFlowTable } from '../orchestrator/index.js';
import type { AdapterSet, CaptureHooks, ResolveEnv } from '../orchestrator/index.js';
import { createServer } from '../server.js';
import { openStore } from '../store/index.js';
import type { Store } from '../store/index.js';

const H = { host: '127.0.0.1:3100' };
const POST = { ...H, origin: 'http://127.0.0.1:3100', 'content-type': 'application/json' };
const flowsDir = path.join(REPO_ROOT, 'flows');
const fpDir = path.join(REPO_ROOT, 'fingerprints');
const flows = loadFlowTable(flowsDir);
const library = loadLibrary(fpDir);
const schema = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'packages', 'api', 'api.schema.json'), 'utf8'),
) as Record<string, unknown>;
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema({ $id: 'api', ...schema });
const valid = (name: string, v: unknown): void => {
  const f = ajv.getSchema(`api#/definitions/${name}`);
  expect(f?.(v), JSON.stringify(f?.errors)).toBe(true);
};

const S077 = 'S-077-trace-waltid-to-collab.json';
const S120 = 'S-120-trace-x5chain-to-collab.json';

// ---------- environment the derive checks read ----------
const versions: Record<'issuer' | 'wallet' | 'verifier', string> = {
  issuer: 'waltid@7ac0710e',
  wallet: '0.0.0',
  verifier: 'collab',
};
const unavailable = new Set<string>();
const tunnel = { up: false, host: null as string | null };
const env: ResolveEnv = {
  availability: (id: AdapterId) => ({
    available: !unavailable.has(id),
    versionFingerprint: versions[id.split('.')[0] as 'issuer' | 'wallet' | 'verifier'],
  }),
  tunnel: () => ({ ...tunnel }),
};

const anyAdapter: AdapterSet = {
  issuer: () => ({}) as IssuerAdapter,
  wallet: () => ({}) as WalletAdapter,
  verifier: () => ({}) as VerifierAdapter,
};
const capture: CaptureHooks = {
  http: {} as CapturingHttp,
  flushStep: () => Promise.resolve(),
  endRun: () => Promise.resolve(),
};

let store: Store;
let app: FastifyInstance;
let diag: DiagnosisEngine;

/** maxRunning 0: derived children stay queued, nothing executes */
function orchestrator(queueCap = 50): Orchestrator {
  return new Orchestrator({
    store,
    flows,
    adapters: anyAdapter,
    capture,
    env,
    limits: { maxRunning: 0, queueCap },
  });
}

/** a terminal run: diagnosed before its terminal event, as the orchestrator does */
function run(
  spec: RunSpec,
  steps: FxStep[],
  outcome: 'pass' | 'fail' | { failed: string },
  counterfactual = false,
): string {
  const id = recordRun(store, spec, steps, null);
  if (typeof outcome === 'object') {
    diag.diagnoseRun(id, 'failed');
    closeRun(store, id, outcome);
    return id;
  }
  diag.diagnoseRun(id, 'completed');
  const failedStep = steps.find((s) => s.outcome === 'fail')?.stepKey ?? null;
  const v = verdictOf(outcome, outcome === 'pass' ? null : failedStep);
  closeRun(store, id, { verdict: v }, counterfactual ? classifyStoredChild(store, id, v) : null);
  return id;
}

const s077 = (over: Partial<RunSpec> = {}): string =>
  run({ ...waltidSpec('absent'), ...over }, goldenSteps(S077), 'fail');

function childSpec(parentRunId: string, over: Partial<RunSpec> = {}): RunSpec {
  return {
    ...waltidSpec('present'),
    parentRunId,
    knobDelta: { knobId: 'KNOB-01', from: 'absent', to: 'present' },
    causeFingerprintId: 'FP-01',
    ...over,
  };
}

async function derive(
  runId: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/runs/${runId}/derive`,
    headers: { ...POST, ...headers },
    payload: JSON.stringify(body),
  });
  return { status: res.statusCode, json: JSON.parse(res.body) as unknown };
}

async function get(url: string): Promise<{ status: number; json: unknown }> {
  const res = await app.inject({ method: 'GET', url, headers: H });
  return { status: res.statusCode, json: JSON.parse(res.body) as unknown };
}

const code = (r: { json: unknown }): string => (r.json as ErrorEnvelope).error.code;
const details = (r: { json: unknown }): unknown => (r.json as ErrorEnvelope).error.details;
const FIX = { knobId: 'KNOB-01', value: 'present' };

beforeAll(async () => {
  store = openStore(':memory:');
  diag = new DiagnosisEngine(store, library);
  app = await createServer({
    config: { flowsDir, fingerprintsDir: fpDir, uiDistDir: path.join(REPO_ROOT, 'no-ui') },
    probeSidecar: () => Promise.resolve({ reachable: true, version: 't' }),
    store,
    orchestrator: orchestrator(),
    resolveEnv: env,
  });
});

afterAll(async () => {
  await app.close();
  store.close();
});

// ---------- API-24 ----------
describe('derive (API-24) creates the child', () => {
  it('201: the parent spec with KNOB-01 absent → present, lineage and cause set, queued', async () => {
    const parentId = s077();
    const r = await derive(parentId, FIX, { 'idempotency-key': 'k-1' });
    expect(r.status).toBe(201);
    valid('Run', r.json);
    const child = r.json as Run;
    const parent = (await get(`/api/v1/runs/${parentId}`)).json as Run;
    expect(child.state).toBe('queued');
    expect(child.spec.knobs).toEqual({ 'KNOB-01': 'present' });
    expect(child.spec.parentRunId).toBe(parentId);
    expect(child.spec.knobDelta).toEqual({ knobId: 'KNOB-01', from: 'absent', to: 'present' });
    expect(child.spec.causeFingerprintId).toBe('FP-01');
    expect(child.links.parentRunId).toBe(parentId);
    // everything else is the parent's (ADR-21): same adapters, format, configuration, disclosure, versions
    const strip = (s: RunSpec): Partial<RunSpec> => ({
      ...s,
      knobs: {},
      knobDelta: null,
      parentRunId: null,
      causeFingerprintId: null,
      suiteId: null,
    });
    expect(strip(child.spec)).toEqual(strip(parent.spec));
    expect(parent.links.childRunIds).toEqual([child.runId]);
    // the same Idempotency-Key replays the same child
    const again = await derive(parentId, FIX, { 'idempotency-key': 'k-1' });
    expect(again.status).toBe(200);
    expect((again.json as Run).runId).toBe(child.runId);
  });

  it('validation_failed: body not a DeriveRequest', async () => {
    const r = await derive(s077(), { knobId: 'KNOB-01' });
    expect(r.status).toBe(400);
    expect(code(r)).toBe('validation_failed');
  });
});

describe('derive (API-24) error codes, 04 §5.4 order', () => {
  it('not_found: unknown parent', async () => {
    const r = await derive('01JA00000000000000000000ZZ', FIX);
    expect([r.status, code(r)]).toEqual([404, 'not_found']);
  });

  it('run_not_terminal: the parent is still open', async () => {
    const open = recordRun(
      store,
      waltidSpec('absent'),
      [{ stepKey: 'vci.token', outcome: 'pass' }],
      null,
    );
    const r = await derive(open, FIX);
    expect([r.status, code(r)]).toEqual([409, 'run_not_terminal']);
  });

  it('key_unavailable: an imported parent has no holder key', async () => {
    const id = s077();
    // origin is immutable (0001_init.sql trigger): lift the trigger for this one fixture update
    const trigger = store.driver.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'runs_immutable'",
    );
    store.driver.run('DROP TRIGGER runs_immutable');
    store.driver.run("UPDATE runs SET origin = 'imported' WHERE run_id = ?", id);
    if (trigger) store.driver.run(trigger.sql);
    const r = await derive(id, FIX);
    expect([r.status, code(r)]).toEqual([409, 'key_unavailable']);
  });

  it('tamper_run_not_derivable: the parent is a tamper run', async () => {
    const r = await derive(s077({ tamperCase: 'TMP-01' }), FIX);
    expect([r.status, code(r)]).toEqual([409, 'tamper_run_not_derivable']);
    expect(details(r)).toEqual({ tmpId: 'TMP-01' });
  });

  it('parent_not_failed: the parent passed (S-120)', async () => {
    const pass = run(waltidSpec('present'), goldenSteps(S120), 'pass');
    const r = await derive(pass, { knobId: 'KNOB-01', value: 'absent' });
    expect([r.status, code(r)]).toEqual([409, 'parent_not_failed']);
    expect(details(r)).toEqual({ outcome: 'pass' });
  });

  it('knob_invalid: unknown knob, unknown value', async () => {
    const id = s077();
    const a = await derive(id, { knobId: 'KNOB-99', value: 'x' });
    expect([a.status, code(a)]).toEqual([422, 'knob_invalid']);
    const b = await derive(id, { knobId: 'KNOB-01', value: 'maybe' });
    expect([b.status, code(b)]).toEqual([422, 'knob_invalid']);
    expect(details(b)).toMatchObject({ allowed: ['absent', 'present'] });
  });

  it('knob_not_applicable: KNOB-07 is not a knob of this run', async () => {
    const r = await derive(s077(), { knobId: 'KNOB-07', value: 'plain' });
    expect([r.status, code(r)]).toEqual([422, 'knob_not_applicable']);
  });

  it('derive_not_one_knob: the value is the current one (no change)', async () => {
    const r = await derive(s077(), { knobId: 'KNOB-01', value: 'absent' });
    expect([r.status, code(r)]).toEqual([422, 'derive_not_one_knob']);
    expect(details(r)).toEqual({ reason: 'no-change' });
  });

  it('fix_not_offered: a failed run whose diagnosis offered nothing', async () => {
    const id = run(
      waltidSpec('absent'),
      [
        {
          stepKey: 'vp.verdict.evaluate',
          outcome: 'fail',
          checks: [
            {
              checkId: 'vp.verdict',
              outcome: 'fail',
              source: 'verifier-response',
              exchangeIds: [],
            },
          ],
        },
      ],
      'fail',
    );
    const r = await derive(id, FIX);
    expect([r.status, code(r)]).toEqual([422, 'fix_not_offered']);
    expect(details(r)).toEqual({ knobId: 'KNOB-01', value: 'present' });
  });

  it('knob_reverted: an ancestor already changed KNOB-01', async () => {
    const root = run(waltidSpec('present'), goldenSteps(S120), 'pass');
    // a derived run that set KNOB-01 back to absent and failed like S-077 (FP-01 offers present again)
    const back = run(
      {
        ...waltidSpec('absent'),
        parentRunId: root,
        knobDelta: { knobId: 'KNOB-01', from: 'present', to: 'absent' },
        causeFingerprintId: 'FP-01',
      },
      goldenSteps(S077),
      'fail',
    );
    const r = await derive(back, FIX);
    expect([r.status, code(r)]).toEqual([409, 'knob_reverted']);
    expect(details(r)).toEqual({ knobId: 'KNOB-01', ancestorRunId: back });
  });

  it('version_drift: the issuer version changed since the parent', async () => {
    const id = s077();
    versions.issuer = 'waltid@NEW';
    try {
      const r = await derive(id, FIX);
      expect([r.status, code(r)]).toEqual([409, 'version_drift']);
      expect(details(r)).toEqual({ column: 'issuer', was: 'waltid@7ac0710e', now: 'waltid@NEW' });
      // API-30 says so before the button is pressed
      const d = (await get(`/api/v1/runs/${id}/diagnosis`)).json as DiagnosisResponse;
      expect(d.noFixReason).toBe('version-drift');
    } finally {
      versions.issuer = 'waltid@7ac0710e';
    }
  });

  it('environment_changed: the tunnel the parent used is down', async () => {
    const id = s077({ tunnelHost: 'abc.trycloudflare.com' });
    const r = await derive(id, FIX);
    expect([r.status, code(r)]).toEqual([409, 'environment_changed']);
    expect(details(r)).toEqual({ was: 'abc.trycloudflare.com', now: null });
    expect(
      ((await get(`/api/v1/runs/${id}/diagnosis`)).json as DiagnosisResponse).noFixReason,
    ).toBe('environment-changed');
  });

  it('adapter_unavailable: the issuer probe says unavailable', async () => {
    const id = s077();
    unavailable.add('issuer.waltid');
    try {
      const r = await derive(id, FIX);
      expect([r.status, code(r)]).toEqual([503, 'adapter_unavailable']);
    } finally {
      unavailable.clear();
    }
  });

  it('queue_full: the queue cap is reached', () => {
    const id = s077();
    let err: unknown;
    try {
      orchestrator(0).derive(id, FIX);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('queue_full');
  });
});

// ---------- 09 A5.3 child classification ----------
describe('child classification (09 A5.3)', () => {
  const resultOf = (id: string): Run['counterfactualResult'] =>
    store.driver.get<{ r: Run['counterfactualResult'] }>(
      'SELECT counterfactual_result AS r FROM runs WHERE run_id = ?',
      id,
    )?.r ?? null;

  it('fixed: S-077 parent, S-120 child (the failing checks pass, FP-01 gone)', () => {
    const parent = s077();
    const child = run(childSpec(parent), goldenSteps(S120), 'pass', true);
    expect(resultOf(child)).toBe('fixed');
  });

  it('not-fixed: the same cause (FP-01) matches the child', () => {
    const parent = s077();
    const child = run(childSpec(parent), goldenSteps(S077), 'fail', true);
    expect(resultOf(child)).toBe('not-fixed');
  });

  it('moved: the child fails at a different check', () => {
    const parent = s077();
    const steps: FxStep[] = [
      {
        stepKey: 'vci.credential',
        outcome: 'fail',
        checks: [
          {
            checkId: 'vci.credential.status',
            outcome: 'fail',
            source: 'engine',
            code: 'invalid_proof',
            exchangeIds: [],
          },
        ],
      },
      {
        stepKey: 'vp.verdict.evaluate',
        outcome: 'skipped',
        skipReason: 'blocked at vci.credential',
      },
    ];
    const child = run(childSpec(parent), steps, 'fail', true);
    expect(resultOf(child)).toBe('moved');
  });

  it('inconclusive: a step the diagnosis relied on lost capture; a run.failed child', () => {
    const parent = s077();
    const partial = run(childSpec(parent), goldenSteps(S120, 'partial'), 'pass', true);
    expect(resultOf(partial)).toBe('inconclusive');
    const failed = run(childSpec(parent), [{ stepKey: 'vci.token', outcome: 'fail' }], {
      failed: 'env_not_ready',
    });
    expect(resultOf(failed)).toBe('inconclusive');
  });
});

// ---------- API-30 ----------
describe('diagnosis (API-30)', () => {
  it('S-077: FP-01 exact cause, KNOB-01 offer, noFixReason null; valid DiagnosisResponse', async () => {
    const r = await get(`/api/v1/runs/${s077()}/diagnosis`);
    expect(r.status).toBe(200);
    valid('DiagnosisResponse', r.json);
    const d = r.json as DiagnosisResponse;
    expect(d.matches.map((m) => [m.fingerprintId, m.confidence, m.role])).toEqual([
      ['FP-01', 'exact', 'cause'],
    ]);
    expect(d.offers).toMatchObject([{ knobId: 'KNOB-01', from: 'absent', to: 'present' }]);
    expect(d.noFixReason).toBeNull();
  });

  it('unclassified failure and a pass run; not_found', async () => {
    const fail = run(waltidSpec('absent'), [{ stepKey: 'vci.token', outcome: 'fail' }], 'fail');
    const d = (await get(`/api/v1/runs/${fail}/diagnosis`)).json as DiagnosisResponse;
    expect(d).toMatchObject({ matches: [], offers: [], noFixReason: 'unclassified' });
    const pass = run(waltidSpec('present'), goldenSteps(S120), 'pass');
    expect(
      ((await get(`/api/v1/runs/${pass}/diagnosis`)).json as DiagnosisResponse).noFixReason,
    ).toBeNull();
    const missing = await get('/api/v1/runs/01JA00000000000000000000ZZ/diagnosis');
    expect([missing.status, code(missing)]).toEqual([404, 'not_found']);
  });
});

// ---------- API-31 ----------
describe('compare (API-31)', () => {
  let parent: string;
  let child: string;
  beforeAll(() => {
    parent = s077();
    child = run(childSpec(parent), goldenSteps(S120), 'pass', true);
  });

  it('derived pair: classification, claim sentence, the x5c header first; valid CompareResponse', async () => {
    const r = await get(`/api/v1/runs/${parent}/compare/${child}`);
    expect(r.status).toBe(200);
    valid('CompareResponse', r.json);
    const c = r.json as CompareResponse;
    expect(c.relation).toBe('derived');
    expect(c.parent.runId).toBe(parent);
    expect(c.knobDelta).toEqual({ knobId: 'KNOB-01', from: 'absent', to: 'present' });
    expect(c.classification).toBe('fixed');
    expect(c.claimSentence).toContain('Changing only waltid.sdjwt.x5c from absent to present');
    expect(c.claimSentence).toContain('[FP-01, G-55]');
    const first = c.steps[0];
    expect(first?.stepKey).toBe('vci.credential');
    expect(first?.directEffect).toBe(true);
    expect(first?.differences.some((d) => d.path.includes('#header.x5c'))).toBe(true);
    expect(c.steps.filter((s) => s.directEffect).map((s) => s.stepKey)).toEqual(['vci.credential']);
    // the verdict step differs (fail → pass), not as a direct effect
    const verdict = c.steps.find((s) => s.stepKey === 'vp.verdict.evaluate');
    expect(verdict?.differences).toContainEqual({
      path: 'outcome',
      parent: 'fail',
      child: 'pass',
      volatile: false,
    });
    expect(c.steps.flatMap((s) => s.differences).every((d) => !d.volatile)).toBe(true);
  });

  it('child first in the URL: the BFF swaps to parent first (OI-4)', async () => {
    const c = (await get(`/api/v1/runs/${child}/compare/${parent}`)).json as CompareResponse;
    expect([c.parent.runId, c.child.runId, c.relation]).toEqual([parent, child, 'derived']);
  });

  it('includeVolatile=true adds the volatile differences', async () => {
    const c = (await get(`/api/v1/runs/${parent}/compare/${child}?includeVolatile=true`))
      .json as CompareResponse;
    expect(c.steps.flatMap((s) => s.differences).some((d) => d.volatile)).toBe(true);
    const bad = await get(`/api/v1/runs/${parent}/compare/${child}?includeVolatile=maybe`);
    expect([bad.status, code(bad)]).toEqual([400, 'validation_failed']);
  });

  it('unrelated runs keep URL order; different scopes → compare_not_comparable; not_found', async () => {
    const other = run(waltidSpec('present'), goldenSteps(S120), 'pass');
    const c = (await get(`/api/v1/runs/${child}/compare/${other}`)).json as CompareResponse;
    expect([c.parent.runId, c.relation, c.classification, c.claimSentence]).toEqual([
      child,
      'unrelated',
      null,
      null,
    ]);
    const issuanceOnly = run(
      { ...waltidSpec('absent'), scope: 'issuance', presentationFlowId: null },
      [{ stepKey: 'vci.token', outcome: 'pass' }],
      'pass',
    );
    const nc = await get(`/api/v1/runs/${parent}/compare/${issuanceOnly}`);
    expect([nc.status, code(nc)]).toEqual([422, 'compare_not_comparable']);
    const missing = await get(`/api/v1/runs/${parent}/compare/01JA00000000000000000000ZZ`);
    expect([missing.status, code(missing)]).toEqual([404, 'not_found']);
  });
});

// ---------- G-151 ----------
describe('G-151: deviatingSide carries the six sides of 09 A2', () => {
  it('an issuer+verifier fingerprint is emitted unmapped', () => {
    const parent = s077();
    const fp01 = library.find((f) => f.id === 'FP-01');
    if (!fp01) throw new Error('FP-01 missing');
    for (const side of ['issuer+verifier', 'environment'] as const) {
      const r = diagnose(
        [{ ...fp01, deviatingSide: side }],
        loadEvidence(store, parent),
        'completed',
      );
      expect(r.emissions[0]?.match.deviatingSide).toBe(side);
      valid('FingerprintMatchedPayload', r.emissions[0]?.match);
    }
  });
});
