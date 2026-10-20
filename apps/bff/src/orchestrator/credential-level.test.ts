/**
 * FLOW-14 + FLOW-40 through the orchestrator (T-47 wiring, ADR-94): a request with
 * `presentationMode: null` is credential-level; `issuer.fixture` hands the held credential to
 * `verifier.verifyCredential` without a wallet presentation. The same fixture with an OID4VP mode
 * runs FLOW-14 → FLOW-30 (the VP-level `chk.vp.sdjwt.expired-credential` run).
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  AdapterContext,
  AdapterDescriptor,
  CapturingHttp,
  HeldCredential,
  IssuerAdapter,
  VerificationOutcome,
  VerifierAdapter,
  WalletAdapter,
} from '@interop-playground/adapters';
import { catalogEntry } from '@interop-playground/adapters';
import type { EventEnvelope, PreviewResponse, Run } from '@interop-playground/api';
import { REPO_ROOT } from '../config/index.js';
import { createServer } from '../server.js';
import { openStore } from '../store/index.js';
import type { Store } from '../store/index.js';
import { EventBus } from '../stream/index.js';
import type { AdapterSet, CaptureHooks } from './index.js';
import { Orchestrator, loadFlowTable } from './index.js';

const flowsDir = path.join(REPO_ROOT, 'flows');
const H = { host: '127.0.0.1:3100' };
const POST = { ...H, origin: 'http://127.0.0.1:3100', 'content-type': 'application/json' };
const flows = loadFlowTable(flowsDir);

const FLOW40 = {
  issuer: 'issuer.fixture',
  wallet: 'wallet.playground-ts',
  verifier: 'verifier.inji-verify-local',
  grant: 'pre-authorized_code',
  presentationMode: null,
  format: 'dc+sd-jwt',
};

const VERDICT: Record<string, VerificationOutcome['verdict']> = {
  PlaygroundSdJwt: 'valid',
  PlaygroundSdJwtInvalid: 'invalid',
  PlaygroundSdJwtExpired: 'valid-but-expired',
};

const descriptor = (id: string): AdapterDescriptor => ({
  ...catalogEntry(id as AdapterDescriptor['id']),
  knobs: [],
});

async function step(ctx: AdapterContext, stepKey: string): Promise<void> {
  await ctx.emit({ type: 'step.started', stepKey });
  await ctx.emit({ type: 'step.completed', stepKey, outcome: 'pass', capture: 'full' });
}

function fakes(log: string[]): AdapterSet {
  const probe = () => Promise.resolve({ available: true, versionFingerprint: 'fake' });
  const issuer: IssuerAdapter = {
    descriptor: descriptor('issuer.fixture'),
    probe,
    metadata: () => Promise.resolve({ issuer: null, authorizationServer: null, exchangeIds: [] }),
    resolveVariant: (_ctx, id) => Promise.resolve(id),
    async fixture(ctx, format) {
      log.push(`fixture:${ctx.spec.configurationId}`);
      await ctx.emit({ type: 'step.started', stepKey: 'vci.fixture.load' });
      await ctx.emit({
        type: 'step.completed',
        stepKey: 'vci.fixture.load',
        outcome: 'pass',
        capture: 'none',
      });
      const held: HeldCredential = {
        format,
        raw: `cred-${ctx.spec.configurationId}`,
        holderKey: { keyId: 'k', alg: 'ES256', publicJwk: {}, didJwk: 'did:jwk:x' },
        issuerAdapter: 'issuer.fixture',
        configurationId: ctx.spec.configurationId,
      };
      return held;
    },
  };
  const wallet: WalletAdapter = {
    descriptor: descriptor('wallet.playground-ts'),
    probe,
    async present(ctx, _ref, held) {
      log.push(`present:${held.raw}`);
      for (const s of [
        'vp.request.validate',
        'vp.credential.match',
        'vp.token.build',
        'vp.response.post',
      ])
        await step(ctx, s);
      return { submitted: true, checks: [] };
    },
  };
  const verdictOf = (held: HeldCredential) => VERDICT[held.configurationId] ?? 'invalid';
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
      return {
        verdict: verdictOf({ configurationId: ctx.spec.configurationId } as HeldCredential),
        checks: [],
        rawResult: {},
        exchangeIds: [],
      };
    },
    async verifyCredential(ctx, held) {
      log.push(`verify:${held.raw}`);
      await step(ctx, 'vp.vc.verify');
      await step(ctx, 'vp.verdict.evaluate');
      return { verdict: verdictOf(held), checks: [], rawResult: {}, exchangeIds: [] };
    },
  };
  return {
    issuer: (id) => (id === 'issuer.fixture' ? issuer : undefined),
    wallet: (id) => (id === 'wallet.playground-ts' ? wallet : undefined),
    verifier: (id) => (id === 'verifier.inji-verify-local' ? verifier : undefined),
  };
}

function fakeCapture(): CaptureHooks {
  const http: CapturingHttp = {
    fetch: () => Promise.reject(new Error('no network in this test')),
    closePoll: () => Promise.resolve(),
  };
  return { http, flushStep: () => Promise.resolve(), endRun: () => Promise.resolve() };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

async function server(
  log: string[],
): Promise<{ app: FastifyInstance; store: Store; orch: Orchestrator }> {
  const store = openStore(':memory:');
  const orch = new Orchestrator({ store, flows, adapters: fakes(log), capture: fakeCapture() });
  const app = await createServer({
    config: {
      flowsDir,
      fingerprintsDir: path.join(REPO_ROOT, 'no-fingerprints-here'),
      uiDistDir: path.join(REPO_ROOT, 'no-ui'),
    },
    probeSidecar: () => Promise.resolve({ reachable: true, version: 't' }),
    store,
    bus: new EventBus(),
    orchestrator: orch,
  });
  cleanup.push(async () => {
    await app.close();
    store.close();
  });
  return { app, store, orch };
}

async function runOf(app: FastifyInstance, orch: Orchestrator, body: object): Promise<Run> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/runs',
    headers: POST,
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  await orch.idle();
  return (
    await app.inject({ method: 'GET', url: `/api/v1/runs/${res.json<Run>().runId}`, headers: H })
  ).json<Run>();
}

const stepKeys = (store: Store, runId: string): string[] =>
  store.reader
    .readEvents(runId, 0, 5000)
    .filter((e: EventEnvelope) => e.type === 'step.completed')
    .map((e) => e.stepKey ?? '');

describe('FLOW-40 credential-level runs (ADR-94)', () => {
  it('preview: presentationMode null selects FLOW-14 + FLOW-40, delivery in-process', async () => {
    const { app } = await server([]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs/preview',
      headers: POST,
      payload: { ...FLOW40, configurationId: 'PlaygroundSdJwtExpired' },
    });
    const p = res.json<PreviewResponse>();
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.spec.issuanceFlowId).toBe('FLOW-14');
    expect(p.spec.presentationFlowId).toBe('FLOW-40');
    expect(p.spec.presentationMode).toBeNull();
    expect(p.spec.delivery).toBe('in-process');
    expect(p.spec.configurationId).toBe('PlaygroundSdJwtExpired');
  });

  it('null mode with a non in-process delivery is validation_failed', async () => {
    const { app } = await server([]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs/preview',
      headers: POST,
      payload: { ...FLOW40, delivery: 'deep-link' },
    });
    expect(res.statusCode).toBe(400);
  });

  it.each([
    ['PlaygroundSdJwt', 'valid', 'pass'],
    ['PlaygroundSdJwtInvalid', 'invalid', 'fail'],
    ['PlaygroundSdJwtExpired', 'valid-but-expired', 'pass'],
  ])('%s → %s (no wallet presentation)', async (configurationId, verification, outcome) => {
    const log: string[] = [];
    const { app, store, orch } = await server(log);
    const run = await runOf(app, orch, { ...FLOW40, configurationId });
    expect(run.state).toBe('completed');
    expect(run.verdict?.verification).toBe(verification);
    expect(run.verdict?.outcome).toBe(outcome);
    expect(run.verdict?.issuanceOk).toBeNull();
    expect(log).toEqual([`fixture:${configurationId}`, `verify:cred-${configurationId}`]);
    expect(stepKeys(store, run.runId)).toEqual([
      'vci.fixture.load',
      'vp.vc.verify',
      'vp.verdict.evaluate',
    ]);
  });

  it('the fixture with an OID4VP mode runs FLOW-14 → FLOW-30 through the wallet', async () => {
    const log: string[] = [];
    const { app, orch } = await server(log);
    const run = await runOf(app, orch, {
      ...FLOW40,
      presentationMode: 'cross-device',
      configurationId: 'PlaygroundSdJwtExpired',
    });
    expect(run.state).toBe('completed');
    expect(run.verdict?.verification).toBe('valid-but-expired');
    expect(log).toEqual(['fixture:PlaygroundSdJwtExpired', 'present:cred-PlaygroundSdJwtExpired']);
  });

  it('fixture issuance-only run passes with issuanceOk null', async () => {
    const { app, orch } = await server([]);
    const run = await runOf(app, orch, {
      ...FLOW40,
      presentationMode: 'cross-device',
      scope: 'issuance',
    });
    expect(run.verdict?.outcome).toBe('pass');
    expect(run.verdict?.issuanceOk).toBeNull();
  });
});
