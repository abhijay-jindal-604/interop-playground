/**
 * T-20 acceptance (plan/12): orchestrator + runs API against fake adapters (02 §5.2 contracts).
 *  - 6 concurrent creates → 4 running, 2 queued; queue cap → 429 queue_full
 *  - preview mso_mdoc × Inji Verify → the G-09 rule
 *  - non-matching steps are emitted `skipped`, never omitted
 *  - BFF restart mid-run → state failed, outcome inconclusive
 */
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  AdapterContext,
  AdapterDescriptor,
  CapturingHttp,
  HeldCredential,
  IssuerAdapter,
  VerifierAdapter,
  WalletAdapter,
} from '@interop-playground/adapters';
import { catalogEntry } from '@interop-playground/adapters';
import type {
  ErrorEnvelope,
  EventEnvelope,
  PreviewResponse,
  Run,
  StepListResponse,
} from '@interop-playground/api';
import { REPO_ROOT } from '../config/index.js';
import { createServer } from '../server.js';
import { openStore } from '../store/index.js';
import type { Store } from '../store/index.js';
import { EventBus } from '../stream/index.js';
import type { AdapterSet, CaptureHooks } from './index.js';
import { Orchestrator, loadFlowTable, planRun } from './index.js';

const flowsDir = path.join(REPO_ROOT, 'flows');
const fpDir = path.join(REPO_ROOT, 'no-fingerprints-here');
const H = { host: '127.0.0.1:3100' };
const POST = { ...H, origin: 'http://127.0.0.1:3100', 'content-type': 'application/json' };
const flows = loadFlowTable(flowsDir);

const SLICE = {
  issuer: 'issuer.certify-preauth',
  wallet: 'wallet.playground-ts',
  verifier: 'verifier.inji-verify-local',
  grant: 'pre-authorized_code',
  presentationMode: 'cross-device',
  format: 'dc+sd-jwt',
};

// ---------- fakes ----------
interface Knobs {
  gate?: Promise<void>;
  verdict?: 'valid' | 'invalid' | 'no-submission';
  tokenFails?: boolean;
  throwAt?: 'present';
}

function descriptor(id: string): AdapterDescriptor {
  const e = catalogEntry(id as AdapterDescriptor['id']);
  return { ...e, knobs: [] };
}

async function step(
  ctx: AdapterContext,
  stepKey: string,
  outcome: 'pass' | 'fail' = 'pass',
): Promise<void> {
  await ctx.emit({ type: 'step.started', stepKey });
  await ctx.emit({ type: 'step.completed', stepKey, outcome, capture: 'full' });
}

function fakes(k: Knobs = {}): AdapterSet {
  const probe = () => Promise.resolve({ available: true, versionFingerprint: 'fake' });
  const issuer: IssuerAdapter = {
    descriptor: descriptor('issuer.certify-preauth'),
    probe,
    async metadata(ctx) {
      await step(ctx, 'vci.setup.config-read');
      return { issuer: {}, authorizationServer: {}, exchangeIds: [] };
    },
    async createOffer(ctx, req) {
      if (k.gate)
        await Promise.race([
          k.gate,
          new Promise((_r, reject) =>
            ctx.signal.addEventListener('abort', () => reject(new Error('aborted'))),
          ),
        ]);
      await step(ctx, 'vci.offer.mint');
      return {
        uri: 'openid-credential-offer://?x',
        credentialIssuer: 'https://i',
        configurationId: req.configurationId,
        grant: 'pre-authorized_code',
      };
    },
    resolveVariant: (_ctx, id) => Promise.resolve(id),
  };
  const held = (ctx: AdapterContext): HeldCredential => ({
    format: ctx.spec.format,
    raw: 'cred',
    holderKey: { keyId: 'k', alg: 'ES256', publicJwk: {}, didJwk: 'did:jwk:x' },
    issuerAdapter: ctx.spec.issuer,
    configurationId: ctx.spec.configurationId,
  });
  const wallet: WalletAdapter = {
    descriptor: descriptor('wallet.playground-ts'),
    probe,
    async receiveOffer(ctx) {
      for (const s of ['vci.offer.fetch', 'vci.metadata.issuer', 'vci.metadata.as'])
        await step(ctx, s);
      if (k.tokenFails) {
        await step(ctx, 'vci.token', 'fail');
        return { ok: false, checks: [] };
      }
      for (const s of [
        'vci.token',
        'vci.nonce',
        'vci.proof.sign',
        'vci.credential',
        'vci.credential.inspect',
      ])
        await step(ctx, s);
      return { ok: true, credential: held(ctx), checks: [] };
    },
    async present(ctx) {
      await ctx.emit({ type: 'step.started', stepKey: 'vp.request.validate' });
      if (k.throwAt === 'present') throw new Error('engine blew up');
      await ctx.emit({
        type: 'step.completed',
        stepKey: 'vp.request.validate',
        outcome: 'pass',
        capture: 'full',
      });
      for (const s of ['vp.credential.match', 'vp.token.build', 'vp.response.post'])
        await step(ctx, s);
      await ctx.emit({ type: 'step.started', stepKey: 'vp.error.dispatch' });
      await ctx.emit({
        type: 'step.completed',
        stepKey: 'vp.error.dispatch',
        outcome: 'skipped',
        capture: 'none',
      });
      return { submitted: true, checks: [] };
    },
  };
  const verifier: VerifierAdapter = {
    descriptor: descriptor('verifier.inji-verify-local'),
    probe,
    async createRequest(ctx) {
      await step(ctx, 'vp.request.create');
      return {
        verifierAdapter: 'verifier.inji-verify-local',
        requestUri: 'openid4vp://authorize?client_id=interop-playground',
        clientId: 'interop-playground',
        clientIdScheme: 'plain',
        responseUri: 'https://v/resp',
        nonce: 'n',
        state: 's',
        dcqlQuery: {},
        mode: 'cross-device',
      };
    },
    async awaitResult(ctx) {
      await step(ctx, 'vp.result.poll');
      return { verdict: k.verdict ?? 'valid', checks: [], rawResult: {}, exchangeIds: [] };
    },
  };
  return {
    issuer: (id) => (id === 'issuer.certify-preauth' ? issuer : undefined),
    wallet: (id) => (id === 'wallet.playground-ts' ? wallet : undefined),
    verifier: (id) => (id === 'verifier.inji-verify-local' ? verifier : undefined),
  };
}

function fakeCapture(log: string[] = []): CaptureHooks {
  const http: CapturingHttp = {
    fetch: () => Promise.reject(new Error('no network in this test')),
    closePoll: () => Promise.resolve(),
  };
  return {
    http,
    flushStep: (runId, stepKey) => {
      log.push(`flush:${stepKey}`);
      return Promise.resolve();
    },
    endRun: () => {
      log.push('endRun');
      return Promise.resolve();
    },
  };
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

// ---------- harness ----------
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

async function server(
  k: Knobs = {},
  opts: { store?: Store; limits?: { queueCap?: number }; captureLog?: string[] } = {},
): Promise<{ app: FastifyInstance; store: Store; orch: Orchestrator }> {
  const store = opts.store ?? openStore(':memory:');
  const bus = new EventBus();
  const orch = new Orchestrator({
    store,
    flows,
    adapters: fakes(k),
    capture: fakeCapture(opts.captureLog),
    ...(opts.limits ? { limits: opts.limits } : {}),
  });
  const app = await createServer({
    config: { flowsDir, fingerprintsDir: fpDir, uiDistDir: path.join(REPO_ROOT, 'no-ui') },
    probeSidecar: () => Promise.resolve({ reachable: true, version: 't' }),
    store,
    bus,
    orchestrator: orch,
  });
  cleanup.push(async () => {
    await app.close();
    if (!opts.store) store.close();
  });
  return { app, store, orch };
}

async function create(
  app: FastifyInstance,
  body: object = SLICE,
): Promise<{ status: number; json: unknown; headers: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/runs',
    headers: POST,
    payload: body,
  });
  return { status: res.statusCode, json: res.json(), headers: res.headers };
}

function events(store: Store, runId: string): EventEnvelope[] {
  return store.reader.readEvents(runId, 0, 5000);
}

// ---------- tests ----------
describe('runs.create (API-20) and scheduling (04 §5.1)', () => {
  it('6 concurrent creates → 4 running, 2 queued; queued ones start as slots free', async () => {
    const g = gate();
    const { app, orch, store } = await server({ gate: g.promise });
    const results = await Promise.all(Array.from({ length: 6 }, () => create(app)));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
    const states = results.map((r) => (r.json as Run).state);
    expect(states.filter((s) => s === 'running')).toHaveLength(4);
    expect(states.filter((s) => s === 'queued')).toHaveLength(2);
    expect(orch.counts()).toEqual({ running: 4, queued: 2 });
    const list = (
      await app.inject({ method: 'GET', url: '/api/v1/runs?state=queued', headers: H })
    ).json<{ items: Run[] }>();
    expect(list.items).toHaveLength(2);
    g.open();
    await orch.idle();
    for (const r of results) {
      const run = (
        await app.inject({
          method: 'GET',
          url: `/api/v1/runs/${(r.json as Run).runId}`,
          headers: H,
        })
      ).json<Run>();
      expect(run.state).toBe('completed');
      expect(run.verdict?.outcome).toBe('pass');
      expect(events(store, run.runId).at(-1)?.type).toBe('run.completed');
    }
  });

  it('queue cap → 429 queue_full with Retry-After', async () => {
    const g = gate();
    const { app, orch } = await server({ gate: g.promise }, { limits: { queueCap: 3 } });
    for (let i = 0; i < 7; i++) expect((await create(app)).status).toBe(201);
    expect(orch.counts()).toEqual({ running: 4, queued: 3 });
    const res = await create(app);
    expect(res.status).toBe(429);
    expect((res.json as ErrorEnvelope).error.code).toBe('queue_full');
    expect(res.headers['retry-after']).toBe('30');
    g.open();
    await orch.idle();
  });

  it('the default queue cap is 50', async () => {
    const g = gate();
    const { app, orch } = await server({ gate: g.promise });
    for (let i = 0; i < 54; i++) await create(app);
    expect(orch.counts()).toEqual({ running: 4, queued: 50 });
    expect((await create(app)).status).toBe(429);
    g.open();
    await orch.idle();
  });

  it('Idempotency-Key replays the stored run; a different body is 409', async () => {
    const { app, orch } = await server();
    const h = { ...POST, 'idempotency-key': 'k-1' };
    const a = await app.inject({ method: 'POST', url: '/api/v1/runs', headers: h, payload: SLICE });
    const b = await app.inject({ method: 'POST', url: '/api/v1/runs', headers: h, payload: SLICE });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.json<Run>().runId).toBe(a.json<Run>().runId);
    const c = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      headers: h,
      payload: { ...SLICE, format: 'ldp_vc' },
    });
    expect(c.json<ErrorEnvelope>().error.code).toBe('idempotency_conflict');
    await orch.idle();
  });

  it('rejects unknown fields, unknown knobs, incompatible and unbuilt selections', async () => {
    const { app } = await server();
    expect(((await create(app, { ...SLICE, typo: 1 })).json as ErrorEnvelope).error.code).toBe(
      'validation_failed',
    );
    expect(
      ((await create(app, { ...SLICE, knobs: { 'KNOB-99': 'x' } })).json as ErrorEnvelope).error
        .code,
    ).toBe('knob_invalid');
    const inc = await create(app, { ...SLICE, format: 'mso_mdoc' });
    expect(inc.status).toBe(422);
    expect((inc.json as ErrorEnvelope).error.details).toMatchObject({
      ruleId: 'mdoc-at-inji-verify',
      gapId: 'G-09',
    });
    const unbuilt = await create(app, { ...SLICE, verifier: 'verifier.waltid' });
    expect(unbuilt.status).toBe(503);
    expect((unbuilt.json as ErrorEnvelope).error.code).toBe('adapter_unavailable');
    const tunnel = await create(app, { ...SLICE, wallet: 'wallet.inji-mobile' });
    expect((tunnel.json as ErrorEnvelope).error.code).toBe('tunnel_required');
  });
});

describe('runs.preview (API-03)', () => {
  it('mso_mdoc × Inji Verify returns the G-09 rule', async () => {
    const { app } = await server();
    for (const verifier of [
      'verifier.inji-verify-local',
      'verifier.inji-verify-collab',
      'verifier.inji-verify-sdk',
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/runs/preview',
        headers: POST,
        payload: { ...SLICE, format: 'mso_mdoc', verifier },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<PreviewResponse>()).toEqual({
        ok: false,
        hit: {
          ruleId: 'mdoc-at-inji-verify',
          reason: 'Inji Verify has no mso_mdoc path.',
          gapId: 'G-09',
        },
      });
    }
  });

  it('resolves the full RunSpec with defaults written out and creates nothing', async () => {
    const { app, store } = await server();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs/preview',
      headers: POST,
      payload: SLICE,
    });
    const p = res.json<PreviewResponse>();
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.spec).toMatchObject({
      issuanceFlowId: 'FLOW-04',
      presentationFlowId: 'FLOW-30',
      delivery: 'in-process',
      configurationId: 'PlaygroundSdJwt',
      disclosure: { claimPaths: [['fullName']] },
      clientIdScheme: 'plain',
      scope: 'full',
      env: { issuer: 'local', wallet: 'local', verifier: 'local' },
    });
    expect(store.driver.get<{ n: number }>('SELECT count(*) AS n FROM runs')?.n).toBe(0);
    const ldp = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/runs/preview',
        headers: POST,
        payload: { ...SLICE, format: 'ldp_vc' },
      })
    ).json<PreviewResponse>();
    expect(ldp.ok && ldp.spec.issuanceFlowId).toBe('FLOW-01');
    expect(ldp.ok && ldp.warnings).toContain('FLOW-03 runs as its base FLOW-01');
  });
});

describe('orchestrator.steps (ADR-27, ADR-29)', () => {
  it('emits every step of the plan in order; non-matching steps are skipped with their reason', async () => {
    const log: string[] = [];
    const { app, orch, store } = await server({}, { captureLog: log });
    const run = (await create(app)).json as Run;
    await orch.idle();
    const evs = events(store, run.runId);
    const plan = planRun(flows, run.spec);
    const started = evs.filter((e) => e.type === 'step.started').map((e) => e.stepKey);
    expect(started).toEqual(plan.map((p) => p.stepKey));
    const completed = evs.filter((e) => e.type === 'step.completed');
    expect(completed).toHaveLength(plan.length);
    const skipped: Record<string, string> = Object.fromEntries(
      completed
        .filter((e) => (e.payload as { outcome: string }).outcome === 'skipped')
        .map((e): [string, string] => [
          String(e.stepKey),
          (e.payload as { skipReason: string }).skipReason,
        ]),
    );
    expect(skipped).toMatchObject({
      'vci.setup.variant': 'no issuer-side knob differs from its default',
      'vp.request.fetch': 'request carried by value',
      'vp.error.dispatch': 'wallet raised no error',
      'vp.response.redirect': 'not a web-wallet delivery',
      'vp.result.fetch': 'cross-device flow reads the result by poll',
      'vp.wallet.observe': 'automated wallet, nothing to observe',
      'vp.dcapi.invoke': 'not a DC API run',
    });
    // deliver-request carries the URI the BFF built (04 §7.2 EngineOp summaries)
    const deliver = evs.find((e) => e.type === 'engine.call' && e.stepKey === 'vp.request.deliver');
    expect(deliver?.payload).toMatchObject({
      op: 'deliver-request',
      outputSummary: {
        channel: 'in-process',
        uri: 'openid4vp://authorize?client_id=interop-playground',
      },
    });
    // flushStep before every non-skipped step.completed, endRun before the terminal event
    expect(log.at(-1)).toBe('endRun');
    const performed = completed.filter(
      (e) => (e.payload as { outcome: string }).outcome !== 'skipped',
    );
    for (const e of performed) expect(log).toContain(`flush:${String(e.stepKey)}`);
    const steps = (
      await app.inject({ method: 'GET', url: `/api/v1/runs/${run.runId}/steps`, headers: H })
    ).json<StepListResponse>();
    expect(steps.steps.map((s) => s.stepKey)).toEqual(plan.map((p) => p.stepKey));
    expect(steps.steps.every((s) => s.state === 'done')).toBe(true);
    expect(steps.steps.find((s) => s.stepKey === 'vp.verdict.evaluate')?.checks[0]).toMatchObject({
      checkId: 'vp.verdict',
      outcome: 'pass',
    });
    const got = (
      await app.inject({ method: 'GET', url: `/api/v1/runs/${run.runId}`, headers: H })
    ).json<Run>();
    expect(got.stepSummary).toMatchObject({
      total: plan.length,
      fail: 0,
      skipped: Object.keys(skipped).length,
    });
  });

  it('a failed step blocks the rest: outcome blocked, failedStepKey set', async () => {
    const { app, orch, store } = await server({ tokenFails: true });
    const run = (await create(app)).json as Run;
    await orch.idle();
    const got = (
      await app.inject({ method: 'GET', url: `/api/v1/runs/${run.runId}`, headers: H })
    ).json<Run>();
    expect(got.verdict).toMatchObject({
      outcome: 'blocked',
      failedStepKey: 'vci.token',
      issuanceOk: false,
      countsTowardPassRate: true,
    });
    const done = events(store, run.runId).filter(
      (e) => e.type === 'step.completed' && e.stepKey === 'vp.verdict.evaluate',
    );
    expect(done[0]?.payload).toMatchObject({
      outcome: 'skipped',
      skipReason: 'blocked at vci.token',
    });
  });

  it('an invalid verdict fails the run at vp.verdict.evaluate', async () => {
    const { app, orch } = await server({ verdict: 'invalid' });
    const run = (await create(app)).json as Run;
    await orch.idle();
    const got = (
      await app.inject({ method: 'GET', url: `/api/v1/runs/${run.runId}`, headers: H })
    ).json<Run>();
    expect(got.verdict).toMatchObject({
      outcome: 'fail',
      verification: 'invalid',
      failedStepKey: 'vp.verdict.evaluate',
    });
  });

  it('an adapter throw ends the run failed{engine_exception} with one terminal event', async () => {
    const { app, orch, store } = await server({ throwAt: 'present' });
    const run = (await create(app)).json as Run;
    await orch.idle();
    const got = (
      await app.inject({ method: 'GET', url: `/api/v1/runs/${run.runId}`, headers: H })
    ).json<Run>();
    expect(got.state).toBe('failed');
    expect(got.errorCode).toBe('engine_exception');
    const terminal = events(store, run.runId).filter((e) =>
      ['run.completed', 'run.failed', 'run.cancelled'].includes(e.type),
    );
    expect(terminal).toHaveLength(1);
  });
});

describe('runs.cancel (API-23)', () => {
  it('cancels queued and running runs; later steps are skipped "cancelled"; completed runs are not cancellable', async () => {
    const g = gate();
    const { app, orch, store } = await server({ gate: g.promise });
    const runs = (await Promise.all(Array.from({ length: 5 }, () => create(app)))).map(
      (r) => r.json as Run,
    );
    const queued = runs.find((r) => r.state === 'queued') as Run;
    const running = runs.find((r) => r.state === 'running') as Run;
    const q = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${queued.runId}/cancel`,
      headers: POST,
      payload: {},
    });
    expect(q.json<Run>().state).toBe('cancelled');
    const cr = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${running.runId}/cancel`,
      headers: POST,
      payload: {},
    });
    g.open();
    expect(cr.json<Run>().state, cr.body).toBe('cancelled');
    const evs = events(store, running.runId);
    expect(evs.at(-1)).toMatchObject({ type: 'run.cancelled', payload: { reason: 'user' } });
    expect(
      evs.filter(
        (e) =>
          e.type === 'step.completed' &&
          (e.payload as { skipReason: string | null }).skipReason === 'cancelled',
      ).length,
    ).toBeGreaterThan(0);
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${queued.runId}/cancel`,
      headers: POST,
      payload: {},
    });
    expect(again.statusCode).toBe(200);
    await orch.idle();
    const done = runs.find((r) => r !== queued && r !== running) as Run;
    const no = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${done.runId}/cancel`,
      headers: POST,
      payload: {},
    });
    expect(no.json<ErrorEnvelope>().error.code).toBe('run_not_cancellable');
  });
});

describe('orchestrator.restart (04 §5.1 shutdown rule)', () => {
  it('a BFF restart mid-run leaves the run failed with outcome inconclusive', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-restart-'));
    const file = path.join(dir, 'playground.db');
    try {
      const g = gate();
      const s1 = openStore(file, { backupDir: null });
      const first = await server({ gate: g.promise }, { store: s1 });
      const runs = (await Promise.all(Array.from({ length: 5 }, () => create(first.app)))).map(
        (r) => r.json as Run,
      );
      expect(runs.filter((r) => r.state === 'running')).toHaveLength(4);
      // "crash": the process goes away without closing its runs (no orchestrator.stop)
      s1.close();
      const s2 = openStore(file, { backupDir: null });
      const app2 = await createServer({
        config: { flowsDir, fingerprintsDir: fpDir, uiDistDir: path.join(REPO_ROOT, 'no-ui') },
        probeSidecar: () => Promise.resolve({ reachable: true, version: 't' }),
        store: s2,
        bus: new EventBus(),
        adapters: fakes(),
        capture: fakeCapture(),
      });
      for (const r of runs) {
        const got = (
          await app2.inject({ method: 'GET', url: `/api/v1/runs/${r.runId}`, headers: H })
        ).json<Run>();
        expect(got.state).toBe('failed');
        expect(got.errorCode).toBe('bff_restarted');
        const row = s2.reader.getRunRow(r.runId) as { outcome: string };
        expect(row.outcome).toBe('inconclusive');
      }
      await app2.close();
      s2.close();
      g.open();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
