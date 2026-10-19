/**
 * T-23..T-26 wiring (no network): main's AdapterSet (certify-preauth, playground-ts,
 * inji-verify-local) and key service run a full slice through the real orchestrator, CaptureHttp
 * and store, against an in-process Certify and Verify built from the golden traces. Checks the
 * step trail (all 20 `vp.*` keys applied or skipped), `engine.call{deliver-request}` carrying the
 * `openid4vp://` URI, the KB-JWT the in-process Verify receives, the Valid verdict, that the
 * holder private key is only in `holder_keys` (scan-store), and that the keys the adapters create
 * resolve inbound gateway hops (offer fetch, direct_post) to the run's steps.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Run } from '@interop-playground/api';
import { CaptureHttp } from './capture/index.js';
import { REPO_ROOT } from './config/index.js';
import { CorrelationIndex } from './gateway/index.js';
import { adaptersFor, holderKeysFor, registerPeerSecrets } from './main.js';
import { Orchestrator, loadFlowTable } from './orchestrator/index.js';
import { SecretRegistry } from './redact/registry.js';
import { scanStore } from './redact/scan.js';
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

/** the S-022 credential (4 disclosures, JSONPath sdClaim) */
const CREDENTIAL_RESPONSE = vpOk[4]?.resBody;

const issuerMd = JSON.parse(
  JSON.stringify(sdjwt[1]?.resBody).replaceAll('http://localhost:8090', ISS),
) as Record<string, unknown>;

const textOf = (b: unknown): string =>
  typeof b === 'string' ? b : b instanceof Uint8Array ? Buffer.from(b).toString('utf8') : '';

/** what the in-process Verify received at direct_post */
interface Submission {
  form: URLSearchParams;
}

/** in-process upstreams keyed by `METHOD host/path` */
function upstream(subs: Submission[]): typeof fetch {
  return (input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(route(input, init, subs));
}

function route(
  input: string | URL | Request,
  init: RequestInit | undefined,
  subs: Submission[],
): Response {
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
        return json(200, CREDENTIAL_RESPONSE);
      case `POST ${PUB}:8443/v1/verify/v2/vp-submission/direct-post`:
        subs.push({ form: new URLSearchParams(textOf(init?.body)) });
        return json(200, {});
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
      return json(200, { status: subs.length > 0 ? 'VP_SUBMITTED' : 'ACTIVE' });
    if (k.startsWith('POST verify-service:8080/v1/verify/v2/vp-results/'))
      if (subs.length > 0) return json(200, vpOk[7]?.resBody);
      else
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

const VP_KEYS = [
  'vp.request.create',
  'vp.request.deliver',
  'vp.request.fetch',
  'vp.request.validate',
  'vp.credential.match',
  'vp.token.build',
  'vp.response.post',
  'vp.error.dispatch',
  'vp.response.redirect',
  'vp.result.poll',
  'vp.result.fetch',
  'vp.vc.verify',
  'vp.verdict.evaluate',
  'vp.wallet.observe',
  'vp.dcapi.probe',
  'vp.dcapi.request.create',
  'vp.dcapi.request.fetch',
  'vp.dcapi.invoke',
  'vp.dcapi.response.post',
  'vp.dcapi.holder',
];

const part = (jws: string, i: number): Record<string, unknown> =>
  JSON.parse(Buffer.from(jws.split('.')[i] ?? '', 'base64url').toString()) as Record<
    string,
    unknown
  >;

describe('main: adapters registered (T-23..T-26)', () => {
  it('adaptersFor serves certify-preauth, waltid, playground-ts and inji-verify-local', () => {
    const a = adaptersFor({ PUBLIC_HOST: PUB }, new CorrelationIndex());
    expect(a.issuer('issuer.certify-preauth')?.descriptor.id).toBe('issuer.certify-preauth');
    expect(a.verifier('verifier.inji-verify-local')?.descriptor.id).toBe(
      'verifier.inji-verify-local',
    );
    expect(a.wallet('wallet.playground-ts')?.descriptor.id).toBe('wallet.playground-ts');
    expect(a.issuer('issuer.waltid')?.descriptor.id).toBe('issuer.waltid');
    expect(a.issuer('issuer.waltid')?.descriptor.knobs.map((k) => k.id)).toEqual(['KNOB-01']);
    expect(a.wallet('wallet.inji-jvm')).toBeUndefined();
  });

  it('a slice run (FLOW-04 + FLOW-30): issuance, presentation, Valid verdict, key only in holder_keys', async () => {
    const correlation = new CorrelationIndex();
    const adapters = adaptersFor({ PUBLIC_HOST: PUB }, correlation);
    const store = openStore(':memory:');
    const subs: Submission[] = [];
    const orch = new Orchestrator({
      store,
      flows: loadFlowTable(path.join(REPO_ROOT, 'flows')),
      adapters,
      keys: holderKeysFor(store),
      capture: captureHooks(
        new CaptureHttp({ sink: store.sink, selfToken: 't'.repeat(43), fetch: upstream(subs) }),
      ),
      resultTimeoutMs: 5000,
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
      'vp.response.post',
      'vp.result.poll',
    ])
      expect(done.get(k), k).toBe('pass:full');
    for (const k of [
      'vci.proof.sign',
      'vci.credential.inspect',
      'vp.request.validate',
      'vp.credential.match',
      'vp.token.build',
    ])
      expect(done.get(k), k).toBe('pass:none');
    expect(done.get('vci.setup.variant')).toBe('skipped:none');
    // all 20 vp.* keys of 03 §2.0 are present, each applied (pass) or skipped
    for (const k of VP_KEYS) expect(done.get(k), k).toMatch(/^(pass|skipped):/);
    expect([...done.keys()].filter((k) => k?.startsWith('vp.')).sort()).toEqual(
      [...VP_KEYS].sort(),
    );
    // vci.credential.inspect: the decoded artifact
    const inspect = events.find(
      (e) => e.type === 'engine.call' && e.stepKey === 'vci.credential.inspect',
    )?.payload as { op: string; outputSummary: { disclosures: { name: string }[] } };
    expect(inspect.op).toBe('inspect-credential');
    expect(inspect.outputSummary.disclosures).toHaveLength(4);
    // the deliver-request URI and what the wallet posted for it
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
    const state = new URL(out.outputSummary.uri).searchParams.get('state') ?? '';
    expect(subs).toHaveLength(1);
    expect(subs[0]?.form.get('state')).toBe(state);
    const presented = (JSON.parse(subs[0]?.form.get('vp_token') ?? '{}') as { pg: string[] })
      .pg[0] as string;
    const kb = presented.split('~').at(-1) as string;
    expect(part(kb, 0)).toEqual({ alg: 'ES256', typ: 'kb+jwt' });
    expect(part(kb, 1)).toMatchObject({ aud: 'interop-playground', nonce });
    const run = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/runs/${runId}`,
        headers: { host: '127.0.0.1:3100' },
      })
    ).json<Run>();
    expect(run.verdict).toMatchObject({ outcome: 'pass', verification: 'valid', issuanceOk: true });
    // the holder key: one row, linked to the run, private part only in holder_keys
    const key = store.driver.get<{ key_id: string; private_jwk_json: string }>(
      'SELECT h.key_id, h.private_jwk_json FROM holder_keys h JOIN run_keys r ON r.key_id = h.key_id WHERE r.run_id = ?',
      runId,
    );
    const d = (JSON.parse(key?.private_jwk_json ?? '{}') as { d: string }).d;
    expect(d).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const hits = scanStore(store.driver, new SecretRegistry().add('HOLDER_KEY_D', d));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.filter((h) => h.table !== 'holder_keys')).toEqual([]);
    expect(JSON.stringify(events)).not.toContain(d);
    // inbound hops resolve through the gateway's index
    expect(
      correlation.resolve({
        method: 'GET',
        url: `/v1/certify/credential-offer-data/${OFFER_ID}`,
        headers: {},
        body: null,
      }),
    ).toEqual({ runId, stepKey: 'vci.offer.fetch', actor: null });
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

describe('main: peer secrets (T-43, 03 FLOW-08 "key redacted")', () => {
  it('registers the walt.id issuer key d with the sink, so a mint body is stored redacted', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'peers-'));
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    writeFileSync(
      path.join(dir, 'waltid-issuer.key'),
      privateKey.export({ format: 'pem', type: 'pkcs8' }),
    );
    writeFileSync(
      path.join(dir, 'waltid-issuer.pem'),
      '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
    );
    const store = openStore(':memory:');
    try {
      expect(registerPeerSecrets(store, { PEERS_CERT_DIR: dir })).toEqual(['WALTID_ISSUER_KEY_D']);
      const d = privateKey.export({ format: 'jwk' }).d as string;
      expect(store.sink.registry.redactString(`{"d":"${d}"}`)).toBe(
        '{"d":"«redacted:WALTID_ISSUER_KEY_D»"}',
      );
      expect(registerPeerSecrets(store, { PEERS_CERT_DIR: path.join(dir, 'none') })).toEqual([]);
    } finally {
      store.close();
    }
  });
});
