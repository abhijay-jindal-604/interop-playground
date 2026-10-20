/**
 * T-46 unit: `wallet.playground-ts` with `ldp_vc` on recorded upstream shapes.
 *  - FLOW-03 (issuance, `FarmerCredential`): Certify answers of `local-preauth-farmer-trace.json`
 *    (S-018), the four `vci.credential.inspect` lints, then `vci.issuer.did` at the issuer's
 *    did:web URL.
 *  - FLOW-31 tier 2 (presentation at local Inji Verify, S-199): DCQL `ldp_vc` with `type_values`
 *    and the claim path `["fullName"]` relative to `credentialSubject`, a JsonWebSignature2020 VP
 *    signed ES256 by the issuance key with `domain` = the full clientId and `challenge` = nonce,
 *    posted as `vp_token={"pg":[<VP>]}`; the recorded submit rejections and vp-results (p1, e1).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AdapterContext, HeldCredential, PresentationRequestRef } from '../contracts.js';
import type { FakeRun, Handler } from '../testing/fake-context.js';
import { fakeRun, stepTrail } from '../testing/fake-context.js';
import { mapVerifyResult } from '../verifiers/inji-verify-result.js';
import {
  InjiVerifyLocalVerifier,
  buildRequestUri,
  dcqlFor,
} from '../verifiers/inji-verify-local.js';
import { HolderKeyService, generateHolderKey, memoryHolderKeyStore } from './keys.js';
import type { Canonize, LdpVp } from './ldp.js';
import { JWS_2020_V1, VC_V1, loadJsonldCanonize, verifyLdpVp } from './ldp.js';
import { PlaygroundTsWallet } from './playground-ts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', '..', '..', '..', 'fixtures');
type TraceEx = { method: string; url: string; status: number; resBody: unknown };
const farmer = JSON.parse(
  readFileSync(path.join(fixtures, 'golden', 'traces', 'local-preauth-farmer-trace.json'), 'utf8'),
) as TraceEx[];
const ldp = (f: string): string => readFileSync(path.join(fixtures, 'ldp', f), 'utf8');
const CRED = JSON.parse(ldp('S-199-cred-farmer-p256.json')) as Record<string, unknown>;
const VP_P1 = JSON.parse(ldp('S-199-vp-p1.json')) as LdpVp;
/** the submit line of an `S-199-run-*.txt` (line after "submit:") */
const submitOf = (f: string): unknown => {
  const lines = ldp(f).split('\n');
  return JSON.parse(lines[lines.indexOf('submit:') + 1] ?? 'null') as unknown;
};

const PUB = 'https://192.0.2.10';
const OFFER_ID = '7ccae5ed-bd42-455b-bfc0-06b60f25a7ac';
const swapHost = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v).replaceAll('http://localhost:8090', PUB)) as unknown;
const FARMER_VC = (farmer[6]?.resBody as { credentials: { credential: Record<string, unknown> }[] })
  .credentials[0]?.credential as Record<string, unknown>;
const ISSUER_DID = FARMER_VC.issuer as string;
const VM = (FARMER_VC.proof as { verificationMethod: string }).verificationMethod;

/** sorted-key JSON: a deterministic stand-in for URDNA2015 (the golden cases use jsonld) */
const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
        )
      : v;
const stub: Canonize = (d) => Promise.resolve(JSON.stringify(sortKeys(d)));
let jsonldInstalled = true;
try {
  await loadJsonldCanonize();
} catch {
  jsonldInstalled = false;
}

function certify(over: Record<string, { status: number; body?: unknown }> = {}): Handler {
  return ({ method, url }) => {
    const k = `${method} ${url.pathname}`;
    if (over[k]) return over[k];
    switch (k) {
      case `GET /v1/certify/credential-offer-data/${OFFER_ID}`:
        return { status: 200, body: swapHost(farmer[3]?.resBody) };
      case 'GET /.well-known/openid-credential-issuer':
        return { status: 200, body: swapHost(farmer[1]?.resBody) };
      case 'GET /.well-known/oauth-authorization-server':
        return {
          status: 200,
          body: { issuer: PUB, token_endpoint: `${PUB}/v1/certify/oauth/token` },
        };
      case 'POST /v1/certify/oauth/token':
        return { status: 200, body: farmer[4]?.resBody };
      case 'POST /v1/certify/nonce':
        return { status: 200, body: farmer[5]?.resBody };
      case 'POST /v1/certify/issuance/credential':
        return { status: 200, body: farmer[6]?.resBody };
      case 'GET /.well-known/did.json':
        // the Certify did.json form of LOG R3TUN: key ids `<did>#<kid>`, bare-DID assertionMethod
        return {
          status: 200,
          body: { id: ISSUER_DID, verificationMethod: [{ id: VM }], assertionMethod: [ISSUER_DID] },
        };
    }
    return { status: 404, body: { error: 'Not Found' } };
  };
}

function withKeys(run: FakeRun): AdapterContext {
  const store = memoryHolderKeyStore();
  const keys = new HolderKeyService(() => store);
  return {
    ...run.ctx,
    holderKey: () => keys.holderKey(run.ctx.runId, run.ctx.spec),
    sign: (k, alg, data) => keys.sign(k, alg, data),
  };
}

const LDP_SPEC = {
  format: 'ldp_vc',
  configurationId: 'FarmerCredential',
  issuanceFlowId: 'FLOW-03',
  presentationFlowId: 'FLOW-31',
} as const;

describe('FLOW-03: ldp_vc issuance (FarmerCredential)', () => {
  const offer = {
    uri: `openid-credential-offer://?credential_offer_uri=${encodeURIComponent(`${PUB}/v1/certify/credential-offer-data/${OFFER_ID}`)}`,
    credentialIssuer: PUB,
    configurationId: 'FarmerCredential',
    grant: 'pre-authorized_code' as const,
  };

  it('passes every FLOW-03 step, holds the JSON credential, fetches the issuer did.json', async () => {
    const run = fakeRun(certify(), { spec: LDP_SPEC });
    const out = await new PlaygroundTsWallet().receiveOffer(withKeys(run), offer);
    expect(out.ok).toBe(true);
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
      'vci.issuer.did:start',
      'vci.issuer.did:pass:full',
    ]);
    const cred = run.exchanges.find((x) => x.ctx.stepKey === 'vci.credential');
    expect(JSON.parse(cred?.body ?? '{}')).toMatchObject({
      credential_configuration_id: 'FarmerCredential',
    });
    // credentials[0].credential is a JSON object; the held raw is its JSON text
    expect(out.credential?.format).toBe('ldp_vc');
    expect(JSON.parse(out.credential?.raw ?? '{}')).toEqual(FARMER_VC);
    expect(out.credential?.holderKey.alg).toBe('ES256');
    const did = run.exchanges.find((x) => x.ctx.stepKey === 'vci.issuer.did');
    expect(did?.url).toBe(`https://${ISSUER_DID.slice('did:web:'.length)}/.well-known/did.json`);
    const checks = run.events
      .filter((e) => e.type === 'verdict.check')
      .map((e) => (e as { check: { checkId: string; outcome: string } }).check);
    expect(checks.map((c) => c.checkId)).toEqual([
      'vc.ldp.placeholders',
      'vc.ldp.verification-method',
      'vc.ldp.issuer-did',
      'vc.ldp.holder-binding',
      'vc.ldp.did-document',
    ]);
    expect(checks.every((c) => c.outcome === 'info')).toBe(true);
    const inspect = run.events.find(
      (e) => e.type === 'engine.call' && e.stepKey === 'vci.credential.inspect',
    ) as { outputSummary: { artifacts: { credential: { placeholders: string[] } } } };
    expect(inspect.outputSummary.artifacts.credential.placeholders).toContain('${primaryCropType}');
  });

  it('a did.json 404 fails vci.issuer.did and still holds the credential', async () => {
    const run = fakeRun(certify({ 'GET /.well-known/did.json': { status: 404 } }), {
      spec: LDP_SPEC,
    });
    const out = await new PlaygroundTsWallet().receiveOffer(withKeys(run), offer);
    expect(out.ok).toBe(true);
    expect(stepTrail(run.events).at(-1)).toBe('vci.issuer.did:fail:full');
  });

  it('a credential that is not a JSON-LD object with a proof fails the inspect step', async () => {
    const run = fakeRun(
      certify({
        'POST /v1/certify/issuance/credential': {
          status: 200,
          body: { credentials: [{ credential: { type: ['VerifiableCredential'] } }] },
        },
      }),
      { spec: LDP_SPEC },
    );
    const out = await new PlaygroundTsWallet().receiveOffer(withKeys(run), offer);
    expect(out.ok).toBe(false);
    expect(stepTrail(run.events).at(-1)).toBe('vci.credential.inspect:fail:none');
  });
});

describe('FLOW-31 tier 2: ldp_vc VP at local Inji Verify (S-199 shape)', () => {
  const NONCE = '2O-73Xx_KafciLib2tfdm2nLgRnsTdug';
  const RESPONSE_URI = `${PUB}:8443/v1/verify/v2/vp-submission/direct-post`;
  const CLIENT_ID = `redirect_uri:${RESPONSE_URI}`;
  const dcqlQuery = dcqlFor({
    format: 'ldp_vc',
    configurationId: 'FarmerCredential',
    vctOrDoctypeOrType: 'FarmerCredential',
    claimPaths: [['fullName']],
    mode: 'cross-device',
  });
  const ref = (over: Partial<PresentationRequestRef> = {}): PresentationRequestRef => {
    const r: PresentationRequestRef = {
      verifierAdapter: 'verifier.inji-verify-local',
      requestUri: '',
      clientId: CLIENT_ID,
      clientIdScheme: 'redirect_uri',
      responseUri: RESPONSE_URI,
      nonce: NONCE,
      state: 'req_4e282472-cb9c-4e10-82d5-d51328c8842f',
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
    format: 'ldp_vc',
    raw: JSON.stringify(CRED),
    holderKey: key.ref,
    issuerAdapter: 'issuer.certify-preauth',
    configurationId: 'FarmerCredential',
  };
  const verify =
    (status = 200, body: unknown = {}): Handler =>
    ({ method, url }) =>
      method === 'POST' && url.toString() === RESPONSE_URI ? { status, body } : { status: 404 };
  const ctxOf = (run: FakeRun): AdapterContext => ({
    ...run.ctx,
    spec: { ...run.ctx.spec, ...LDP_SPEC },
    sign: (k, alg, data) => keys.sign(k, alg, data),
  });
  const wallet = new PlaygroundTsWallet({ now: () => 1_790_000_000_000, canonize: stub });

  it('the DCQL query is the 03 §2.0 ldp_vc row (type_values, path relative to credentialSubject)', () => {
    expect(dcqlQuery).toEqual({
      credentials: [
        {
          id: 'pg',
          format: 'ldp_vc',
          meta: { type_values: [['VerifiableCredential', 'FarmerCredential']] },
          claims: [{ path: ['fullName'] }],
        },
      ],
    });
  });

  it('builds the JsonWebSignature2020 VP (domain = full clientId, challenge = nonce) and posts it', async () => {
    const run = fakeRun(verify());
    const out = await wallet.present(ctxOf(run), ref(), held, { claimPaths: [['fullName']] });
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
    const post = run.exchanges[0];
    expect(post?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(post?.body ?? '');
    expect(form.get('state')).toBe('req_4e282472-cb9c-4e10-82d5-d51328c8842f');
    const token = JSON.parse(form.get('vp_token') ?? '{}') as { pg: LdpVp[] };
    expect(Object.keys(token)).toEqual(['pg']);
    const vp = token.pg[0] as LdpVp;
    // the S-199 p1 shape: same members, same context, the credential embedded unchanged
    expect(Object.keys(vp).sort()).toEqual(Object.keys(VP_P1).sort());
    expect(Object.keys(vp.proof ?? {}).sort()).toEqual(Object.keys(VP_P1.proof ?? {}).sort());
    expect(vp['@context']).toEqual([VC_V1, JWS_2020_V1]);
    expect(vp.type).toEqual(['VerifiablePresentation']);
    expect(vp.holder).toBe(key.ref.didJwk);
    expect(vp.verifiableCredential).toEqual([CRED]);
    expect(vp.proof).toMatchObject({
      type: 'JsonWebSignature2020',
      created: '2026-09-21T14:13:20Z',
      verificationMethod: `${key.ref.didJwk}#0`,
      proofPurpose: 'authentication',
      domain: CLIENT_ID,
      challenge: NONCE,
    });
    expect(vp.proof?.jws.split('.')[0]).toBe(VP_P1.proof?.jws.split('.')[0]);
    expect(vp.proof?.jws.split('.')[1]).toBe('');
    expect(await verifyLdpVp(vp, stub)).toBe(true);
    const build = run.events.find(
      (e) => e.type === 'engine.call' && e.stepKey === 'vp.token.build',
    );
    expect(build).toMatchObject({ op: 'build-ldp-vp' });
  });

  it('with the plain clientId the domain is that clientId', async () => {
    const run = fakeRun(verify());
    await wallet.present(
      ctxOf(run),
      ref({ clientId: 'interop-playground', clientIdScheme: 'plain' }),
      held,
      { claimPaths: [] },
    );
    const form = new URLSearchParams(run.exchanges[0]?.body ?? '');
    const vp = (JSON.parse(form.get('vp_token') ?? '{}') as { pg: LdpVp[] }).pg[0];
    expect(vp?.proof?.domain).toBe('interop-playground');
  });

  it('a submit rejection is a failed vp.response.post with the verbatim S-199 message', async () => {
    for (const f of ['S-199-run-e2.txt', 'S-199-run-e3.txt', 'S-199-run-e4.txt']) {
      const body = submitOf(f) as { errorCode: string; errorMessage: string };
      const run = fakeRun(verify(400, body));
      const out = await wallet.present(ctxOf(run), ref(), held, { claimPaths: [] });
      expect(out.submitted).toBe(false);
      expect(out.checks[0]).toMatchObject({
        checkId: 'vp.response.post',
        outcome: 'fail',
        code: 'invalid_request',
        message: body.errorMessage,
      });
    }
  });

  it('a DCQL query for another type fails vp.credential.match and posts nothing', async () => {
    const run = fakeRun(verify());
    const other = ref({
      dcqlQuery: {
        credentials: [
          {
            id: 'pg',
            format: 'ldp_vc',
            meta: { type_values: [['VerifiableCredential', 'Other']] },
            claims: [],
          },
        ],
      },
    });
    const out = await wallet.present(ctxOf(run), other, held, { claimPaths: [] });
    expect(out.submitted).toBe(false);
    expect(stepTrail(run.events).at(-1)).toBe('vp.credential.match:fail:none');
    expect(run.exchanges).toHaveLength(0);
  });

  it('an EdDSA issuance key cannot sign the VP (S-199 point 2)', async () => {
    const ed = generateHolderKey('EdDSA');
    const run = fakeRun(verify());
    const out = await wallet.present(
      ctxOf(run),
      ref(),
      { ...held, holderKey: ed.ref },
      {
        claimPaths: [],
      },
    );
    expect(out.submitted).toBe(false);
    expect(stepTrail(run.events).at(-1)).toBe('vp.token.build:fail:none');
    expect(run.events.some((e) => e.type === 'engine.exception')).toBe(true);
  });

  it.skipIf(jsonldInstalled)(
    'without jsonld and without a canonicaliser vp.token.build fails with the reason',
    async () => {
      const run = fakeRun(verify());
      const out = await new PlaygroundTsWallet().present(ctxOf(run), ref(), held, {
        claimPaths: [],
      });
      expect(out.submitted).toBe(false);
      const ex = run.events.find((e) => e.type === 'engine.exception') as { message: string };
      expect(ex.message).toMatch(/jsonld/);
    },
  );

  it.skipIf(!jsonldInstalled)(
    'with jsonld (default canonicaliser) the posted VP verifies under URDNA2015',
    async () => {
      const run = fakeRun(verify());
      const out = await new PlaygroundTsWallet({ now: () => 1_790_000_000_000 }).present(
        ctxOf(run),
        ref(),
        held,
        { claimPaths: [] },
      );
      expect(out.submitted).toBe(true);
      const form = new URLSearchParams(run.exchanges[0]?.body ?? '');
      const vp = (JSON.parse(form.get('vp_token') ?? '{}') as { pg: LdpVp[] }).pg[0] as LdpVp;
      expect(await verifyLdpVp(vp, await loadJsonldCanonize())).toBe(true);
      expect(await verifyLdpVp(vp, stub)).toBe(false);
    },
  );

  it('vp-results p1 → valid with holderProofCheck pass; e1 → invalid, code verbatim', () => {
    const p1 = mapVerifyResult(JSON.parse(ldp('S-199-result-p1.json')));
    expect(p1.verdict).toBe('valid');
    expect(p1.checks.find((c) => c.checkId === 'vp.holder-proof')?.outcome).toBe('pass');
    const e1 = mapVerifyResult(JSON.parse(ldp('S-199-result-e1.json')));
    expect(e1.verdict).toBe('invalid');
    expect(e1.checks.find((c) => c.checkId === 'vp.holder-proof')).toMatchObject({
      outcome: 'fail',
      code: 'ERR_HOLDER_BINDING_CHECK_FAILED',
    });
  });

  it('tier 1 posts the held ldp_vc to /v2/vc-verification as JSON text (G-10)', async () => {
    const base = 'http://verify-service:8080/v1/verify';
    // the S-199 p1 credential result in the top-level `/v2/vc-verification` form (S-014 shape)
    const p1 = (
      JSON.parse(ldp('S-199-result-p1.json')) as { credentialResults: Record<string, unknown>[] }
    ).credentialResults[0] as Record<string, unknown>;
    const { verifiableCredential: _v, holderProofCheck: _h, claims: _c, ...answer } = p1;
    let body: unknown = null;
    const run = fakeRun(({ url, body: b }) => {
      if (url.pathname.endsWith('/v2/vc-verification')) body = JSON.parse(b ?? 'null');
      return { status: 200, body: answer };
    });
    const v = new InjiVerifyLocalVerifier({ internalBase: base });
    const out = await v.verifyCredential(ctxOf(run), held, { evaluate: false });
    expect(body).toEqual({ verifiableCredential: held.raw });
    expect(out.verdict).toBe('valid');
    // tier 1 is reported at vp.vc.verify only; vp.verdict.evaluate stays with tier 2 (ADR-97)
    expect(stepTrail(run.events)).toEqual(['vp.vc.verify:start', 'vp.vc.verify:pass:full']);
    const checks = run.events.filter((e) => e.type === 'verdict.check');
    expect(checks.every((e) => e.stepKey === 'vp.vc.verify')).toBe(true);
    expect(checks.length).toBeGreaterThan(0);
  });
});
