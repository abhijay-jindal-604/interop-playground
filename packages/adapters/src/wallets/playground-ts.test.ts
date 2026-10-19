/**
 * T-24 / T-26 unit: `wallet.playground-ts` against in-process upstreams built from the golden
 * traces (`local-preauth-sdjwt-trace.json` S-019, `trace-localverify-vp-ok.json` S-022):
 * issuance steps and proof (ES256 P1363 by the key service), the decoded artifact of
 * `vci.credential.inspect`, presentation (KB-JWT aud/nonce/sd_hash, direct_post body), a
 * verifier rejection, a DCQL miss, and the holder key service (root, derived, missing parent).
 */
import { createPublicKey, verify as verifySig } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AdapterContext, HeldCredential, PresentationRequestRef } from '../contracts.js';
import type { FakeRun, Handler } from '../testing/fake-context.js';
import { fakeRun, stepTrail } from '../testing/fake-context.js';
import { buildRequestUri, dcqlFor } from '../verifiers/inji-verify-local.js';
import { HolderKeyService, generateHolderKey, memoryHolderKeyStore } from './keys.js';
import { PlaygroundTsWallet, parseRequestUri } from './playground-ts.js';
import { decodeSdJwt, sdHashOf } from './sd-jwt.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const traces = path.join(here, '..', '..', '..', '..', 'fixtures', 'golden', 'traces');
type TraceEx = { method: string; url: string; status: number; resBody: unknown };
const load = (f: string): TraceEx[] =>
  JSON.parse(readFileSync(path.join(traces, f), 'utf8')) as TraceEx[];
const sdjwt = load('local-preauth-sdjwt-trace.json');
const vpOk = load('trace-localverify-vp-ok.json');
const PUB = 'https://192.0.2.10';
const OFFER = `${PUB}/v1/certify/credential-offer-data/8845dd16-46a3-47a0-ba99-c632c1e3d25e`;
/** the S-022 credential: 4 disclosures (JSONPath sdClaim) */
const CREDENTIAL = (vpOk[4]?.resBody as { credentials: { credential: string }[] }).credentials[0]
  ?.credential as string;
const swapHost = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v).replaceAll('http://localhost:8090', PUB)) as unknown;

function certify(over: Record<string, { status: number; body?: unknown }> = {}): Handler {
  return ({ method, url }) => {
    const k = `${method} ${url.pathname}`;
    if (over[k]) return over[k];
    switch (k) {
      case 'GET /v1/certify/credential-offer-data/8845dd16-46a3-47a0-ba99-c632c1e3d25e':
        return { status: 200, body: swapHost(sdjwt[3]?.resBody) };
      case 'GET /.well-known/openid-credential-issuer':
        return { status: 200, body: swapHost(sdjwt[1]?.resBody) };
      case 'GET /.well-known/oauth-authorization-server':
        return {
          status: 200,
          body: { issuer: PUB, token_endpoint: `${PUB}/v1/certify/oauth/token` },
        };
      case 'POST /v1/certify/oauth/token':
        return { status: 200, body: { access_token: 'eyJ.at.x', token_type: 'Bearer' } };
      case 'POST /v1/certify/nonce':
        return { status: 200, body: sdjwt[5]?.resBody };
      case 'POST /v1/certify/issuance/credential':
        return { status: 200, body: { credentials: [{ credential: CREDENTIAL }] } };
    }
    return { status: 404, body: { error: 'Not Found' } };
  };
}

function withKeys(run: FakeRun, given?: HolderKeyService): AdapterContext {
  const store = memoryHolderKeyStore();
  const keys = given ?? new HolderKeyService(() => store);
  return {
    ...run.ctx,
    holderKey: () => keys.holderKey(run.ctx.runId, run.ctx.spec),
    sign: (k, alg, data) => keys.sign(k, alg, data),
  };
}

const verifyJws = (jws: string, jwk: JsonWebKey): boolean => {
  const [h, p, s] = jws.split('.') as [string, string, string];
  return verifySig(
    'sha256',
    Buffer.from(`${h}.${p}`),
    { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
    Buffer.from(s, 'base64url'),
  );
};
const part = (jws: string, i: 0 | 1): Record<string, unknown> =>
  JSON.parse(Buffer.from(jws.split('.')[i] ?? '', 'base64url').toString()) as Record<
    string,
    unknown
  >;

describe('wallet.playground-ts issuance (T-24)', () => {
  const offer = {
    uri: `openid-credential-offer://?credential_offer_uri=${encodeURIComponent(OFFER)}`,
    credentialIssuer: PUB,
    configurationId: 'PlaygroundSdJwt',
    grant: 'pre-authorized_code' as const,
  };

  it('runs FLOW-01/04 and signs an ES256 P1363 proof with the run key', async () => {
    const run = fakeRun(certify());
    const ctx = withKeys(run);
    const out = await new PlaygroundTsWallet({ now: () => 1_790_000_000_000 }).receiveOffer(
      ctx,
      offer,
    );
    expect(stepTrail(run.events)).toEqual([
      'vci.offer.fetch:start',
      'vci.offer.fetch:pass:full',
      'vci.metadata.issuer:start',
      'vci.metadata.issuer:pass:full',
      'vci.metadata.as:start',
      'vci.metadata.as:pass:full',
      'vci.token:start',
      'vci.token:pass:full',
      'vci.nonce:start',
      'vci.nonce:pass:full',
      'vci.proof.sign:start',
      'vci.proof.sign:pass:none',
      'vci.credential:start',
      'vci.credential:pass:full',
      'vci.credential.inspect:start',
      'vci.credential.inspect:pass:none',
    ]);
    expect(out.ok).toBe(true);
    const key = out.credential?.holderKey;
    expect(key?.alg).toBe('ES256');
    // every hop goes to the advertised (gateway) host
    expect(run.exchanges.every((x) => x.url.startsWith(`${PUB}/`))).toBe(true);
    const token = run.exchanges.find((x) => x.ctx.stepKey === 'vci.token');
    expect(token?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(new URLSearchParams(token?.body ?? '').get('pre-authorized_code')).toBeTruthy();
    const cred = run.exchanges.find((x) => x.ctx.stepKey === 'vci.credential');
    expect(cred?.headers.authorization).toBe('Bearer eyJ.at.x');
    const req = JSON.parse(cred?.body ?? '{}') as {
      credential_configuration_id: string;
      proofs: { jwt: string[] };
    };
    expect(req.credential_configuration_id).toBe('PlaygroundSdJwt');
    const proof = req.proofs.jwt[0] as string;
    expect(part(proof, 0)).toEqual({
      alg: 'ES256',
      typ: 'openid4vci-proof+jwt',
      kid: `${key?.didJwk}#0`,
    });
    expect(part(proof, 1)).toEqual({
      aud: PUB,
      iat: 1_790_000_000,
      nonce: (sdjwt[5]?.resBody as { c_nonce: string }).c_nonce,
    });
    expect(Buffer.from(proof.split('.')[2] ?? '', 'base64url')).toHaveLength(64); // P1363
    expect(verifyJws(proof, key?.publicJwk as JsonWebKey)).toBe(true);
    // correlation keys: code → vci.token, sha256(access token) → vci.credential
    expect(run.correlations.map((c) => c.kind)).toEqual([
      'pre-authorized-code',
      'access-token-sha256',
    ]);
  });

  it('vci.credential.inspect emits the decoded artifact and the structural lints', async () => {
    const run = fakeRun(certify());
    const out = await new PlaygroundTsWallet().receiveOffer(withKeys(run), offer);
    const inspect = run.events.find(
      (e) => e.type === 'engine.call' && e.stepKey === 'vci.credential.inspect',
    );
    expect(inspect).toMatchObject({ engine: 'playground-ts', op: 'inspect-credential' });
    const decoded = (inspect as { outputSummary: Record<string, unknown> }).outputSummary as {
      payload: { vct: string };
      disclosures: { name: string }[];
      artifacts: Record<string, Record<string, unknown>>;
    };
    expect(decoded.payload.vct).toBe('PlaygroundSdJwt');
    expect(decoded.disclosures.map((d) => d.name).sort()).toEqual([
      'dateOfBirth',
      'email',
      'fullName',
      'gender',
    ]);
    expect(decoded.artifacts['credential-header']).toMatchObject({ x5cPresent: true });
    expect(decoded.artifacts.credential).toMatchObject({ cnfJwkPresent: false });
    const checks = run.events.filter((e) => e.type === 'verdict.check');
    expect(checks.map((c) => (c as { check: { checkId: string } }).check.checkId)).toEqual([
      'vc.sd-jwt.disclosure-count',
      'vc.sd-jwt.disclosure-digests',
      'vc.sd-jwt.holder-binding',
    ]);
    expect(out.checks.find((c) => c.checkId === 'vc.sd-jwt.disclosure-digests')?.outcome).toBe(
      'pass',
    );
  });

  it('an invalid_proof answer is a failed vci.credential step, no credential', async () => {
    const run = fakeRun(
      certify({
        'POST /v1/certify/issuance/credential': { status: 400, body: { error: 'invalid_proof' } },
      }),
    );
    const out = await new PlaygroundTsWallet().receiveOffer(withKeys(run), offer);
    expect(out.ok).toBe(false);
    expect(stepTrail(run.events).at(-1)).toBe('vci.credential:fail:full');
  });

  it('the holder private key never appears in an event or an exchange', async () => {
    const store = memoryHolderKeyStore();
    const keys = new HolderKeyService(() => store);
    const run = fakeRun(certify());
    const out = await new PlaygroundTsWallet().receiveOffer(withKeys(run, keys), offer);
    const d = store.privateJwk(out.credential?.holderKey.keyId ?? '')?.d as string;
    expect(d).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const all = JSON.stringify({ events: run.events, exchanges: run.exchanges, out });
    expect(all).not.toContain(d);
  });
});

describe('wallet.playground-ts presentation (T-26)', () => {
  const NONCE = 'n'.repeat(16) + 'N'.repeat(16);
  const RESPONSE_URI = `${PUB}:8443/v1/verify/v2/vp-submission/direct-post`;
  const dcqlQuery = dcqlFor({
    format: 'dc+sd-jwt',
    configurationId: 'PlaygroundSdJwt',
    vctOrDoctypeOrType: 'PlaygroundSdJwt',
    claimPaths: [['fullName']],
    mode: 'cross-device',
  });
  const ref = (over: Partial<PresentationRequestRef> = {}): PresentationRequestRef => {
    const r: PresentationRequestRef = {
      verifierAdapter: 'verifier.inji-verify-local',
      requestUri: '',
      clientId: 'interop-playground',
      clientIdScheme: 'plain',
      responseUri: RESPONSE_URI,
      nonce: NONCE,
      state: 'req_0c4e6e1c-8af3-46c0-ab90-c7b1a8965e8b',
      dcqlQuery,
      mode: 'cross-device',
      ...over,
    };
    return { ...r, requestUri: over.requestUri ?? buildRequestUri(r) };
  };
  const key = generateHolderKey();
  const store = memoryHolderKeyStore();
  store.insert(key, 'r');
  const keys = new HolderKeyService(() => store);
  const held: HeldCredential = {
    format: 'dc+sd-jwt',
    raw: CREDENTIAL,
    holderKey: key.ref,
    issuerAdapter: 'issuer.certify-preauth',
    configurationId: 'PlaygroundSdJwt',
  };
  const verify =
    (status = 200, body: unknown = {}): Handler =>
    ({ method, url }) =>
      method === 'POST' && url.toString() === RESPONSE_URI ? { status, body } : { status: 404 };
  const ctxOf = (run: FakeRun): AdapterContext => ({
    ...run.ctx,
    sign: (k, alg, data) => keys.sign(k, alg, data),
  });

  it('builds the KB-JWT (aud = clientId, nonce = request nonce, sd_hash) and posts direct_post', async () => {
    const run = fakeRun(verify());
    const out = await new PlaygroundTsWallet({ now: () => 1_790_000_000_000 }).present(
      ctxOf(run),
      ref(),
      held,
      { claimPaths: [['fullName']] },
    );
    expect(out).toEqual({ submitted: true, checks: [] });
    expect(stepTrail(run.events)).toEqual([
      'vp.request.validate:start',
      'vp.request.validate:pass:none',
      'vp.credential.match:start',
      'vp.credential.match:pass:none',
      'vp.token.build:start',
      'vp.token.build:pass:none',
      'vp.response.post:start',
      'vp.response.post:pass:full',
      'vp.error.dispatch:start',
      'vp.error.dispatch:skipped:none',
    ]);
    expect(run.exchanges).toHaveLength(1);
    const post = run.exchanges[0];
    expect(post?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(post?.body ?? '');
    expect(form.get('state')).toBe('req_0c4e6e1c-8af3-46c0-ab90-c7b1a8965e8b');
    const token = JSON.parse(form.get('vp_token') ?? '{}') as { pg: string[] };
    const presented = token.pg[0] as string;
    const parts = presented.split('~');
    const kb = parts.at(-1) as string;
    const disclosed = decodeSdJwt(parts.slice(0, -1).join('~') + '~').disclosures;
    expect(disclosed.map((d) => d.name)).toEqual(['fullName']);
    expect(part(kb, 0)).toEqual({ alg: 'ES256', typ: 'kb+jwt' });
    expect(part(kb, 1)).toEqual({
      iat: 1_790_000_000,
      aud: 'interop-playground',
      nonce: NONCE,
      sd_hash: sdHashOf(parts.slice(0, -1).join('~') + '~'),
    });
    expect(verifyJws(kb, key.ref.publicJwk)).toBe(true);
    const build = run.events.find(
      (e) => e.type === 'engine.call' && e.stepKey === 'vp.token.build',
    );
    expect(build).toMatchObject({ op: 'build-kb-jwt' });
  });

  it('parses the request it is handed (not the ref fields)', () => {
    const p = parseRequestUri(ref().requestUri);
    expect(p).toMatchObject({
      clientId: 'interop-playground',
      nonce: NONCE,
      responseUri: RESPONSE_URI,
      responseMode: 'direct_post',
      responseType: 'vp_token',
    });
  });

  it('a synchronous verifier rejection is a failed vp.response.post with the verbatim code', async () => {
    const run = fakeRun(
      verify(400, {
        errorCode: 'invalid_request',
        errorMessage: 'Nonce validation failed due to invalid nonce/challenge.',
      }),
    );
    const out = await new PlaygroundTsWallet().present(ctxOf(run), ref(), held, {
      claimPaths: [['fullName']],
    });
    expect(out.submitted).toBe(false);
    expect(out.checks[0]).toMatchObject({
      checkId: 'vp.response.post',
      outcome: 'fail',
      code: 'invalid_request',
      message: 'Nonce validation failed due to invalid nonce/challenge.',
    });
    expect(stepTrail(run.events).at(-1)).toBe('vp.response.post:fail:full');
  });

  it('a DCQL query for another vct fails vp.credential.match and posts nothing', async () => {
    const run = fakeRun(verify());
    const other = ref({
      dcqlQuery: {
        credentials: [
          { id: 'pg', format: 'dc+sd-jwt', meta: { vct_values: ['Other'] }, claims: [] },
        ],
      },
    });
    const out = await new PlaygroundTsWallet().present(ctxOf(run), other, held, {
      claimPaths: [],
    });
    expect(out.submitted).toBe(false);
    expect(stepTrail(run.events).at(-1)).toBe('vp.credential.match:fail:none');
    expect(run.exchanges).toHaveLength(0);
  });

  it('a request without response_mode direct_post fails vp.request.validate', async () => {
    const r = ref();
    const run = fakeRun(verify());
    const out = await new PlaygroundTsWallet().present(
      ctxOf(run),
      { ...r, requestUri: r.requestUri.replace('direct_post', 'fragment') },
      held,
      { claimPaths: [['fullName']] },
    );
    expect(out.submitted).toBe(false);
    expect(stepTrail(run.events)).toEqual([
      'vp.request.validate:start',
      'vp.request.validate:fail:none',
    ]);
  });
});

describe('holder key service (02 §1.3 item 4)', () => {
  it('creates one key per root run, reuses it, and hands the parent key to a derived run', async () => {
    const store = memoryHolderKeyStore();
    const keys = new HolderKeyService(() => store);
    const a = await keys.holderKey('R1', { parentRunId: null });
    expect(await keys.holderKey('R1', { parentRunId: null })).toEqual(a);
    expect(await keys.holderKey('R2', { parentRunId: 'R1' })).toEqual(a);
    expect(store.size()).toBe(1);
    expect(a.didJwk.startsWith('did:jwk:')).toBe(true);
    const sig = await keys.sign(a, 'ES256', Buffer.from('x'));
    expect(sig).toHaveLength(64);
    await expect(keys.holderKey('R3', { parentRunId: 'gone' })).rejects.toThrow(/no holder key/);
    await expect(
      new HolderKeyService(() => null).holderKey('R', { parentRunId: null }),
    ).rejects.toThrow(/not attached/);
  });
});
