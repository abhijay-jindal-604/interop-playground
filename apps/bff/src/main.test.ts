/**
 * T-23/T-25 wiring (no network): main's AdapterSet (certify-preauth + inji-verify-local) runs a
 * full slice through the real orchestrator, CaptureHttp and store, against an in-process Certify
 * and Verify built from the golden traces. Checks the step trail, `engine.call{deliver-request}`
 * carrying the `openid4vp://` URI, and that the keys the adapters create resolve inbound gateway
 * hops (offer fetch, direct_post) to the run's steps.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

const traces = path.join(REPO_ROOT, 'fixtures', 'golden', 'traces');
type TraceEx = { method: string; url: string; status: number; resBody: unknown };
const sdjwt = JSON.parse(
  readFileSync(path.join(traces, 'local-preauth-sdjwt-trace.json'), 'utf8'),
) as TraceEx[];
const vpOk = JSON.parse(
  readFileSync(path.join(traces, 'trace-localverify-vp-ok.json'), 'utf8'),
) as TraceEx[];
const PUB = '192.0.2.10';
const ISS = `https://${PUB}`;
const OFFER_ID = '8845dd16-46a3-47a0-ba99-c632c1e3d25e';

const issuerMd = JSON.parse(
  JSON.stringify(sdjwt[1]?.resBody).replaceAll('http://localhost:8090', ISS),
) as Record<string, unknown>;

/** in-process upstreams keyed by `METHOD host/path` */
function upstream(): typeof fetch {
  return (input: string | URL | Request, init?: RequestInit) => Promise.resolve(route(input, init));
}

function route(input: string | URL | Request, init?: RequestInit): Response {
  {
    const u = new URL(input instanceof Request ? input.url : input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const k = `${method} ${u.host}${u.pathname}`;
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const req = vpOk[5]?.resBody as { authorizationDetails: Record<string, unknown> };
    switch (k) {
      case 'GET certify-preauth:8090/v1/certify/credential-configurations/PlaygroundSdJwt':
        return json(200, { credentialConfigKeyId: 'PlaygroundSdJwt', sdClaim: '$.fullName' });
      case 'GET certify-preauth:8090/v1/certify/.well-known/openid-credential-issuer':
      case `GET ${PUB}/.well-known/openid-credential-issuer`:
        return json(200, issuerMd);
      case `GET ${PUB}/.well-known/did.json`:
        return json(200, { id: `did:web:${PUB}` });
      case 'POST certify-preauth:8090/v1/certify/pre-authorized-data':
        return json(200, {
          credential_offer_uri: `openid-credential-offer://?credential_offer_uri=${encodeURIComponent(`${ISS}/v1/certify/credential-offer-data/${OFFER_ID}`)}`,
        });
      case `GET ${PUB}/v1/certify/credential-offer-data/${OFFER_ID}`:
        return json(
          200,
          JSON.parse(JSON.stringify(sdjwt[3]?.resBody).replaceAll('http://localhost:8090', ISS)),
        );
      case `GET ${PUB}/.well-known/oauth-authorization-server`:
        return json(200, { issuer: ISS, token_endpoint: `${ISS}/v1/certify/oauth/token` });
      case `POST ${PUB}/v1/certify/oauth/token`:
        return json(200, { access_token: 'eyJ.test.token', token_type: 'Bearer', expires_in: 600 });
      case `POST ${PUB}/v1/certify/nonce`:
        return json(200, sdjwt[5]?.resBody);
      case `POST ${PUB}/v1/certify/issuance/credential`:
        return json(200, sdjwt[6]?.resBody);
      case 'POST verify-service:8080/v1/verify/v2/vp-request': {
        const sent = JSON.parse(init?.body as string) as { nonce: string };
        return json(201, {
          ...req,
          authorizationDetails: {
            ...req.authorizationDetails,
            clientId: 'interop-playground',
            nonce: sent.nonce,
            responseUri: `https://${PUB}:8443/v1/verify/v2/vp-submission/direct-post`,
          },
        });
      }
    }
    if (k.startsWith('GET verify-service:8080/v1/verify/vp-request/'))
      return json(200, { status: 'ACTIVE' });
    if (k.startsWith('POST verify-service:8080/v1/verify/v2/vp-results/'))
      return json(404, {
        errorCode: 'NO_VP_SUBMISSION',
        errorMessage: 'No VP submission found for given transaction ID.',
      });
    return json(599, { unexpected: k });
  }
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

describe('main: adapters registered (T-23, T-25)', () => {
  it('adaptersFor serves certify-preauth and inji-verify-local, nothing else yet', () => {
    const a = adaptersFor({ PUBLIC_HOST: PUB }, new CorrelationIndex());
    expect(a.issuer('issuer.certify-preauth')?.descriptor.id).toBe('issuer.certify-preauth');
    expect(a.verifier('verifier.inji-verify-local')?.descriptor.id).toBe(
      'verifier.inji-verify-local',
    );
    expect(a.wallet('wallet.playground-ts')).toBeUndefined();
    expect(a.issuer('issuer.waltid')).toBeUndefined();
  });

  it('a slice run: issuance through the gateway URLs, request created, deliver-request, premature result', async () => {
    const correlation = new CorrelationIndex();
    const adapters = adaptersFor({ PUBLIC_HOST: PUB }, correlation, {
      wallets: { 'wallet.playground-ts': testHolder() },
    });
    const store = openStore(':memory:');
    const orch = new Orchestrator({
      store,
      flows: loadFlowTable(path.join(REPO_ROOT, 'flows')),
      adapters,
      capture: captureHooks(
        new CaptureHttp({ sink: store.sink, selfToken: 't'.repeat(43), fetch: upstream() }),
      ),
      resultTimeoutMs: 1000,
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
    cleanup.push(async () => {
      await app.close();
      store.close();
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
    const done = new Map(
      events
        .filter((e) => e.type === 'step.completed')
        .map((e) => [
          e.stepKey,
          (e.payload as { outcome: string; capture: string }).outcome +
            ':' +
            (e.payload as { capture: string }).capture,
        ]),
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
      'vp.request.create',
      'vp.request.deliver',
      'vp.result.poll',
    ])
      expect(done.get(k), k).toBe('pass:full');
    expect(done.get('vci.setup.variant')).toBe('skipped:none');
    const deliver = events.find(
      (e) => e.type === 'engine.call' && e.stepKey === 'vp.request.deliver',
    );
    const out = deliver?.payload as {
      op: string;
      outputSummary: { uri: string; uriSha256: string };
    };
    expect(out.op).toBe('deliver-request');
    expect(out.outputSummary.uri).toMatch(
      /^openid4vp:\/\/authorize\?client_id=interop-playground&state=req_/,
    );
    const nonce = new URL(out.outputSummary.uri).searchParams.get('nonce') ?? '';
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const create = events.find(
      (e) => e.type === 'exchange.request' && e.stepKey === 'vp.request.create',
    );
    const body = JSON.parse((create?.payload as { body: { text: string } }).body.text) as {
      clientId: string;
      nonce: string;
    };
    expect(body).toMatchObject({ clientId: 'interop-playground', nonce });
    const run = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/runs/${runId}`,
        headers: { host: '127.0.0.1:3100' },
      })
    ).json<Run>();
    expect(run.verdict?.outcome).toBe('no-submission');
    // inbound hops resolve through the gateway's index
    expect(
      correlation.resolve({
        method: 'GET',
        url: `/v1/certify/credential-offer-data/${OFFER_ID}`,
        headers: {},
        body: null,
      }),
    ).toEqual({ runId, stepKey: 'vci.offer.fetch', actor: null });
    const state = new URL(out.outputSummary.uri).searchParams.get('state') ?? '';
    expect(
      correlation.resolve({
        method: 'POST',
        url: '/v1/verify/v2/vp-submission/direct-post',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: Buffer.from(`vp_token=x&state=${state}`),
      }),
    ).toEqual({ runId, stepKey: 'vp.response.post', actor: null });
  });
});
