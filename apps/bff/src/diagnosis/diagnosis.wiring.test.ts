/**
 * T-41 wiring: the server loads `fingerprintsDir` into C12 and the orchestrator calls it before the
 * terminal event, so a live run carries `fingerprint.matched` before `run.completed` and the run row
 * its `cause_fingerprint_id`.
 */
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AdapterContext,
  AdapterDescriptor,
  CapturingHttp,
  IssuerAdapter,
  VerifierAdapter,
  WalletAdapter,
} from '@interop-playground/adapters';
import { catalogEntry } from '@interop-playground/adapters';
import type { Run } from '@interop-playground/api';
import { REPO_ROOT } from '../config/index.js';
import type { AdapterSet, Orchestrator } from '../orchestrator/index.js';
import { createServer } from '../server.js';
import { openStore } from '../store/index.js';

const H = { host: '127.0.0.1:3100' };
const POST = { ...H, origin: 'http://127.0.0.1:3100', 'content-type': 'application/json' };
const SLICE = {
  issuer: 'issuer.certify-preauth',
  wallet: 'wallet.playground-ts',
  verifier: 'verifier.inji-verify-local',
  grant: 'pre-authorized_code',
  presentationMode: 'cross-device',
  format: 'dc+sd-jwt',
};

const descriptor = (id: string): AdapterDescriptor => ({
  ...catalogEntry(id as AdapterDescriptor['id']),
  knobs: [],
});
async function step(ctx: AdapterContext, stepKey: string): Promise<void> {
  await ctx.emit({ type: 'step.started', stepKey });
  await ctx.emit({ type: 'step.completed', stepKey, outcome: 'pass', capture: 'full' });
}

function fakes(): AdapterSet {
  const probe = () => Promise.resolve({ available: true, versionFingerprint: 'fake' });
  const issuer: IssuerAdapter = {
    descriptor: descriptor('issuer.certify-preauth'),
    probe,
    metadata: () => Promise.resolve({ issuer: {}, authorizationServer: {}, exchangeIds: [] }),
    createOffer: (_ctx, req) =>
      Promise.resolve({
        uri: 'openid-credential-offer://?x',
        credentialIssuer: 'https://i',
        configurationId: req.configurationId,
        grant: 'pre-authorized_code',
      }),
    resolveVariant: (_ctx, id) => Promise.resolve(id),
  };
  const wallet: WalletAdapter = {
    descriptor: descriptor('wallet.playground-ts'),
    probe,
    async receiveOffer(ctx) {
      for (const s of ['vci.token', 'vci.credential']) await step(ctx, s);
      return {
        ok: true,
        credential: {
          format: ctx.spec.format,
          raw: 'cred',
          holderKey: { keyId: 'k', alg: 'ES256', publicJwk: {}, didJwk: 'did:jwk:x' },
          issuerAdapter: ctx.spec.issuer,
          configurationId: ctx.spec.configurationId,
        },
        checks: [],
      };
    },
    async present(ctx) {
      await step(ctx, 'vp.response.post');
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
      return { verdict: 'invalid', checks: [], rawResult: {}, exchangeIds: [] };
    },
  };
  return {
    issuer: (id) => (id === issuer.descriptor.id ? issuer : undefined),
    wallet: (id) => (id === wallet.descriptor.id ? wallet : undefined),
    verifier: (id) => (id === verifier.descriptor.id ? verifier : undefined),
  };
}

const noHttp: CapturingHttp = {
  fetch: () => Promise.reject(new Error('no network in this test')),
  closePoll: () => Promise.resolve(),
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('diagnosis.wiring (orchestrator hook)', () => {
  it('a failed live run is diagnosed before run.completed and gets its cause', async () => {
    const fpDir = mkdtempSync(path.join(tmpdir(), 'fp-'));
    dirs.push(fpDir);
    const base = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'fingerprints', 'FP-01.json'), 'utf8'),
    ) as Record<string, unknown>;
    writeFileSync(
      path.join(fpDir, 'FP-92.json'),
      JSON.stringify({
        ...base,
        id: 'FP-92',
        title: 'Verify said invalid',
        scope: { verifiers: ['verifier.inji-verify-local'] },
        match: [
          [{ on: 'check', checkId: 'vp.verdict', outcome: 'fail', messageContains: 'invalid' }],
        ],
        fix: null,
        noFixReason: 'test fingerprint',
      }),
    );
    const store = openStore(':memory:');
    const app = await createServer({
      config: {
        flowsDir: path.join(REPO_ROOT, 'flows'),
        fingerprintsDir: fpDir,
        uiDistDir: path.join(REPO_ROOT, 'no-ui'),
      },
      probeSidecar: () => Promise.resolve({ reachable: true, version: 't' }),
      store,
      adapters: fakes(),
      capture: {
        http: noHttp,
        flushStep: () => Promise.resolve(),
        endRun: () => Promise.resolve(),
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/runs',
        headers: POST,
        payload: SLICE,
      });
      expect(res.statusCode).toBe(201);
      const runId = res.json<Run>().runId;
      await (
        app as unknown as { playgroundOrchestrator: Orchestrator }
      ).playgroundOrchestrator.idle();
      const types = store.reader.readEvents(runId, 0, 5000).map((e) => e.type);
      const at = types.indexOf('fingerprint.matched');
      expect(at).toBeGreaterThan(0);
      expect(types.at(-1)).toBe('run.completed');
      expect(at).toBeLessThan(types.length - 1);
      const run = (
        await app.inject({ method: 'GET', url: `/api/v1/runs/${runId}`, headers: H })
      ).json<Run>();
      expect(run.verdict?.outcome).toBe('fail');
      expect(
        store.driver.get<{ c: string | null }>(
          'SELECT cause_fingerprint_id AS c FROM runs WHERE run_id = ?',
          runId,
        )?.c,
      ).toBe('FP-92');
    } finally {
      await app.close();
      store.close();
    }
  });
});
