/**
 * T-23 / T-25 acceptance ON THE BUNDLE (skipped unless BUNDLE_IT=1; run by scripts/bundle-it.sh
 * with the stack up; command in the T-23/T-25 note of STATUS.md). main's AdapterSet + the test-only holder run one full slice through the
 * real orchestrator, CaptureHttp and store from the host:
 *  - T-23: offer minted, metadata, token, nonce, credential, did.json exchanges all `capture: full`,
 *    shape (method, path, status, JSON keys) equal to `local-preauth-sdjwt-trace.json`;
 *  - T-25: request created (clientId `interop-playground`, 32-char nonce), `openid4vp://` URI,
 *    `engine.call{deliver-request}`, and a premature status / result call (no submission).
 * Env: PUBLIC_HOST, CERTIFY_PREAUTH_URL, VERIFY_SERVICE_URL (container IPs), NODE_EXTRA_CA_CERTS.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Run } from '@interop-playground/api';
import { CaptureHttp } from './capture/index.js';
import { REPO_ROOT } from './config/index.js';
import { CorrelationIndex } from './gateway/index.js';
import { adaptersFor } from './main.js';
import { testHolder } from './main.test-holder.js';
import { Orchestrator, loadFlowTable } from './orchestrator/index.js';
import { captureHooks, createServer } from './server.js';
import { openStore } from './store/index.js';
import { EventBus } from './stream/index.js';

const ON = process.env.BUNDLE_IT === '1';
type TraceEx = { method: string; url: string; status: number; resBody: unknown; reqBody?: string };

const norm = (url: string): string =>
  new URL(url).pathname.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    '<uuid>',
  );
const keysOf = (v: unknown): string[] =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort() : [];

describe.skipIf(!ON)('bundle: certify-preauth + inji-verify-local (T-23, T-25)', () => {
  const store = openStore(':memory:');
  afterAll(() => store.close());

  it('one slice run from the host against the running bundle', { timeout: 120_000 }, async () => {
    const env = process.env;
    const correlation = new CorrelationIndex();
    const adapters = adaptersFor(env, correlation, {
      wallets: { 'wallet.playground-ts': testHolder() },
    });
    const orch = new Orchestrator({
      store,
      flows: loadFlowTable(path.join(REPO_ROOT, 'flows')),
      adapters,
      capture: captureHooks(
        new CaptureHttp({ sink: store.sink, selfToken: 'bundle-it-'.padEnd(43, 'x') }),
      ),
      // premature: the holder never posts; the status long-poll is cut after 3 s
      resultTimeoutMs: 3000,
    });
    const app = await createServer({
      config: {
        flowsDir: path.join(REPO_ROOT, 'flows'),
        fingerprintsDir: path.join(REPO_ROOT, 'none'),
        uiDistDir: path.join(REPO_ROOT, 'none'),
      },
      probeSidecar: () => Promise.resolve({ reachable: true, version: 't' }),
      store,
      bus: new EventBus(),
      orchestrator: orch,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      headers: {
        host: '127.0.0.1:3100',
        origin: 'http://127.0.0.1:3100',
        'content-type': 'application/json',
      },
      payload: {
        issuer: 'issuer.certify-preauth',
        wallet: 'wallet.playground-ts',
        verifier: 'verifier.inji-verify-local',
        grant: 'pre-authorized_code',
        presentationMode: 'cross-device',
        format: 'dc+sd-jwt',
      },
    });
    expect(res.statusCode).toBe(201);
    const runId = res.json<Run>().runId;
    await orch.idle();
    const events = store.reader.readEvents(runId, 0, 5000);
    const run = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/runs/${runId}`,
        headers: { host: '127.0.0.1:3100' },
      })
    ).json<Run>();
    await app.close();

    // ---- exchanges (request + response pairs) ----
    type P = Record<string, unknown> & { exchangeId: string };
    const reqs = events.filter((e) => e.type === 'exchange.request');
    const resps = new Map(
      events
        .filter((e) => e.type === 'exchange.response' || e.type === 'exchange.error')
        .map((e) => [(e.payload as P).exchangeId, e]),
    );
    const ex = reqs.map((e) => {
      const p = e.payload as P & { method: string; url: string };
      const r = resps.get(p.exchangeId);
      const rp = (r?.payload ?? {}) as { status?: number; body?: { text: string } | null };
      let json: unknown;
      try {
        json = rp.body ? JSON.parse(rp.body.text) : null;
      } catch {
        json = null;
      }
      return {
        step: e.stepKey ?? '',
        method: p.method,
        path: norm(p.url),
        url: p.url,
        status: rp.status ?? 0,
        json,
        type: r?.type,
      };
    });
    const lines = ex.map((x) => `${x.step} ${x.method} ${x.path} ${x.status}`);
    console.warn(`run ${runId} ${run.state} ${run.verdict?.outcome}\n${lines.join('\n')}`);

    // ---- T-23: the steps are full and the shape equals the golden trace ----
    const done = new Map(
      events
        .filter((e) => e.type === 'step.completed')
        .map((e) => [e.stepKey, e.payload as { outcome: string; capture: string }]),
    );
    for (const k of [
      'vci.setup.config-read',
      'vci.offer.mint',
      'vci.offer.fetch',
      'vci.metadata.issuer',
      'vci.metadata.as',
      'vci.token',
      'vci.nonce',
      'vci.credential',
    ]) {
      expect(done.get(k), k).toMatchObject({ outcome: 'pass', capture: 'full' });
    }
    const golden = (
      JSON.parse(
        readFileSync(
          path.join(REPO_ROOT, 'fixtures/golden/traces/local-preauth-sdjwt-trace.json'),
          'utf8',
        ),
      ) as TraceEx[]
    ).filter((g) => g.status !== 404); // the raw service's root 404; the bundle's front maps the root (S-018)
    const certify = ex.filter(
      (x) => x.path.startsWith('/v1/certify/') || x.path.startsWith('/.well-known/'),
    );
    let at = 0;
    for (const g of golden) {
      const i = certify.findIndex(
        (x, j) => j >= at && x.method === g.method && x.path === norm(g.url),
      );
      expect(i, `${g.method} ${norm(g.url)} in order`).toBeGreaterThanOrEqual(0);
      const x = certify[i] as (typeof certify)[number];
      expect(x.status, `${g.method} ${norm(g.url)}`).toBe(g.status);
      expect(keysOf(x.json), `${g.method} ${norm(g.url)} keys`).toEqual(
        expect.arrayContaining(keysOf(g.resBody)),
      );
      at = i + 1;
    }
    const pub = `https://${env.PUBLIC_HOST}`;
    const wallet = ex.filter((x) => x.step.startsWith('vci.') && x.url.startsWith(`${pub}/`));
    expect(wallet.map((x) => x.step)).toEqual(
      expect.arrayContaining([
        'vci.offer.fetch',
        'vci.metadata.issuer',
        'vci.metadata.as',
        'vci.token',
        'vci.nonce',
        'vci.credential',
        'vci.setup.config-read',
      ]),
    );
    const did = ex.find((x) => x.path === '/.well-known/did.json');
    expect(did).toMatchObject({ status: 200, step: 'vci.setup.config-read' });
    expect((did?.json as { id: string }).id).toBe(`did:web:${env.PUBLIC_HOST}`);
    const cred = ex.find((x) => x.step === 'vci.credential');
    const compact =
      (cred?.json as { credentials: { credential: string }[] }).credentials[0]?.credential ?? '';
    expect(compact.split('~').length).toBeGreaterThan(2); // issuer-jwt~disclosures~ (FLOW-04)

    // ---- T-25: request created, URI, deliver-request, premature result ----
    expect(done.get('vp.request.create')).toMatchObject({ outcome: 'pass', capture: 'full' });
    const create = events.find(
      (e) => e.type === 'exchange.request' && e.stepKey === 'vp.request.create',
    );
    const sent = JSON.parse((create?.payload as { body: { text: string } }).body.text) as {
      clientId: string;
      nonce: string;
    };
    expect(sent.clientId).toBe('interop-playground');
    expect(sent.nonce).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const created = ex.find((x) => x.step === 'vp.request.create');
    expect(created?.status).toBe(201);
    const details = (
      created?.json as {
        authorizationDetails: { nonce: string; clientId: string; responseUri: string };
      }
    ).authorizationDetails;
    expect(details).toMatchObject({
      clientId: 'interop-playground',
      nonce: sent.nonce,
      responseUri: `https://${env.PUBLIC_HOST}:8443/v1/verify/v2/vp-submission/direct-post`,
    });
    const deliver = events.find(
      (e) => e.type === 'engine.call' && e.stepKey === 'vp.request.deliver',
    );
    const uri = (deliver?.payload as { op: string; outputSummary: { uri: string } }).outputSummary
      .uri;
    expect((deliver?.payload as { op: string }).op).toBe('deliver-request');
    const u = new URL(uri);
    expect(u.protocol).toBe('openid4vp:');
    expect(u.searchParams.get('client_id')).toBe('interop-playground');
    expect(u.searchParams.get('nonce')).toBe(sent.nonce);
    expect(u.searchParams.get('response_uri')).toBe(details.responseUri);
    const results = ex.filter((x) => x.path.includes('/v2/vp-results/'));
    expect(results.at(-1)).toMatchObject({ status: 404, json: { errorCode: 'NO_VP_SUBMISSION' } });
    expect(ex.some((x) => x.path.endsWith('/status'))).toBe(true);
    expect(run.verdict?.outcome).toBe('no-submission');
  });
});
