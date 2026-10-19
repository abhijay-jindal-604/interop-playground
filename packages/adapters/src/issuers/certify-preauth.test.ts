/**
 * T-23 unit: `issuer.certify-preauth` against an in-process Certify built from the golden trace
 * `local-preauth-sdjwt-trace.json` (S-019): steps, BFF-internal hosts, request bodies,
 * correlation keys, the FLOW-02 `errors` rule and variant creation (02 §5.7).
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Handler } from '../testing/fake-context.js';
import { fakeRun, stepTrail } from '../testing/fake-context.js';
import {
  CertifyPreauthIssuer,
  PREAUTH_ROUTES,
  differingIssuerKnobs,
  offerIdOf,
  preAuthorizedCodeOf,
  variantId,
} from './certify-preauth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const traces = path.join(here, '..', '..', '..', '..', 'fixtures', 'golden', 'traces');
type TraceEx = { method: string; url: string; status: number; resBody: unknown; reqBody?: string };
const sdjwt = JSON.parse(
  readFileSync(path.join(traces, 'local-preauth-sdjwt-trace.json'), 'utf8'),
) as TraceEx[];
const golden = (suffix: string): TraceEx =>
  sdjwt.find((e) => e.url.endsWith(suffix) || e.url.includes(suffix)) as TraceEx;

const INTERNAL = 'http://certify-preauth:8090';
const PUBLIC = 'https://192.0.2.10';

function certify(over: Partial<Record<string, ReturnType<Handler>>> = {}): Handler {
  return ({ method, url }) => {
    const key = `${method} ${url.pathname}`;
    if (over[key]) return over[key];
    if (key === 'GET /v1/certify/credential-configurations/PlaygroundSdJwt')
      return {
        status: 200,
        body: { credentialConfigKeyId: 'PlaygroundSdJwt', sdClaim: '$.fullName' },
      };
    if (key === 'GET /v1/certify/.well-known/openid-credential-issuer')
      return {
        status: 200,
        body: golden('/v1/certify/.well-known/openid-credential-issuer').resBody,
      };
    if (key === 'GET /.well-known/did.json')
      return { status: 200, body: { id: 'did:web:192.0.2.10', verificationMethod: [] } };
    if (key === 'POST /v1/certify/pre-authorized-data') {
      const offerRef = `${PUBLIC}/v1/certify/credential-offer-data/8845dd16-46a3-47a0-ba99-c632c1e3d25e`;
      return {
        status: 200,
        body: {
          credential_offer_uri: `openid-credential-offer://?credential_offer_uri=${encodeURIComponent(offerRef)}`,
        },
      };
    }
    return { status: 404, body: { error: 'Not Found' } };
  };
}

describe('issuer.certify-preauth (T-23)', () => {
  it('metadata: one vci.setup.config-read step, internal config + metadata, did.json via the public base', async () => {
    const run = fakeRun(certify());
    const issuer = new CertifyPreauthIssuer({ internalBase: INTERNAL, publicBase: PUBLIC });
    const md = await issuer.metadata(run.ctx);
    expect(stepTrail(run.events)).toEqual([
      'vci.setup.config-read:start',
      'vci.setup.config-read:pass:full',
    ]);
    expect(run.exchanges.map((x) => `${x.method} ${x.url}`)).toEqual([
      `GET ${INTERNAL}/v1/certify/credential-configurations/PlaygroundSdJwt`,
      `GET ${INTERNAL}/v1/certify/.well-known/openid-credential-issuer`,
      `GET ${PUBLIC}/.well-known/did.json`,
    ]);
    expect(run.exchanges.every((x) => x.ctx.stepKey === 'vci.setup.config-read')).toBe(true);
    expect((md.issuer as { credential_issuer: string }).credential_issuer).toBe(
      'http://localhost:8090',
    );
    expect(md.authorizationServer).toBe('http://localhost:8090');
  });

  it('metadata fails when the configuration is not offered or did.json is missing', async () => {
    const run = fakeRun(certify({ 'GET /.well-known/did.json': { status: 404 } }));
    await new CertifyPreauthIssuer({ internalBase: INTERNAL, publicBase: PUBLIC }).metadata(
      run.ctx,
    );
    expect(stepTrail(run.events).at(-1)).toBe('vci.setup.config-read:fail:full');
  });

  it('createOffer mints internally with the trace body shape and registers the offer id', async () => {
    const registered: string[] = [];
    const routes: string[] = [];
    const run = fakeRun(certify());
    const issuer = new CertifyPreauthIssuer({
      internalBase: INTERNAL,
      publicBase: PUBLIC,
      gateway: {
        register: (runId, key, stepKey) => registered.push(`${runId}|${key}|${stepKey}`),
        addRoutes: (_r, t) => routes.push(...t.map((x) => x.stepKey)),
      },
    });
    const offer = await issuer.createOffer(run.ctx, {
      configurationId: 'PlaygroundSdJwt',
      claims: {},
      withTxCode: false,
    });
    expect(stepTrail(run.events)).toEqual(['vci.offer.mint:start', 'vci.offer.mint:pass:full']);
    const mint = run.exchanges[0];
    expect(mint?.url).toBe(`${INTERNAL}/v1/certify/pre-authorized-data`);
    expect(mint?.headers['content-type']).toBe('application/json');
    const goldenBody = JSON.parse(golden('/pre-authorized-data').reqBody as string) as object;
    expect(JSON.parse(mint?.body ?? '')).toEqual(goldenBody);
    expect(offer.uri).toMatch(
      /^openid-credential-offer:\/\/\?credential_offer_uri=https%3A%2F%2F192\.0\.2\.10/,
    );
    expect(offer.credentialIssuer).toBe(PUBLIC);
    expect(offer.grant).toBe('pre-authorized_code');
    expect(offer.txCode).toBeUndefined();
    expect(run.correlations).toEqual([
      { kind: 'offer-id', value: '8845dd16-46a3-47a0-ba99-c632c1e3d25e' },
    ]);
    expect(registered).toEqual([
      `${run.ctx.runId}|8845dd16-46a3-47a0-ba99-c632c1e3d25e|vci.offer.fetch`,
    ]);
    expect(routes).toEqual(PREAUTH_ROUTES.map((r) => r.stepKey));
  });

  it('FLOW-02: tx_code is six digits, sent at mint and returned for the out-of-band channel', async () => {
    const run = fakeRun(certify());
    const issuer = new CertifyPreauthIssuer({
      internalBase: INTERNAL,
      publicBase: PUBLIC,
      txCode: () => '042917',
    });
    const offer = await issuer.createOffer(run.ctx, {
      configurationId: 'PlaygroundSdJwt',
      claims: { fullName: 'X' },
      withTxCode: true,
    });
    expect(JSON.parse(run.exchanges[0]?.body ?? '')).toMatchObject({
      tx_code: '042917',
      claims: { fullName: 'X' },
    });
    expect(offer.txCode).toEqual({ value: '042917', inputMode: 'numeric', length: 6 });
  });

  it('a 200 mint with a non-null errors array is a failed step (FLOW-02 mint-time validation)', async () => {
    const run = fakeRun(
      certify({
        'POST /v1/certify/pre-authorized-data': {
          status: 200,
          body: {
            response: null,
            errors: [{ errorCode: 'Transaction code must be 4-8 alphanumeric characters' }],
          },
        },
      }),
    );
    const offer = await new CertifyPreauthIssuer({
      internalBase: INTERNAL,
      publicBase: PUBLIC,
    }).createOffer(run.ctx, { configurationId: 'PlaygroundSdJwt', claims: {}, withTxCode: false });
    expect(stepTrail(run.events).at(-1)).toBe('vci.offer.mint:fail:full');
    expect(offer.uri).toBe('');
    expect(run.correlations).toEqual([]);
  });

  it('resolveVariant: skipped without a differing knob; creates <id>__KNOB-04_plain once', async () => {
    const none = fakeRun(certify(), { spec: { knobs: { 'KNOB-04': 'jsonpath' } } });
    const issuer = new CertifyPreauthIssuer({ internalBase: INTERNAL, publicBase: PUBLIC });
    expect(await issuer.resolveVariant(none.ctx, 'PlaygroundSdJwt')).toBe('PlaygroundSdJwt');
    expect(stepTrail(none.events)).toEqual([
      'vci.setup.variant:start',
      'vci.setup.variant:skipped:none',
    ]);
    expect(none.exchanges).toEqual([]);

    const dir = mkdtempSync(path.join(tmpdir(), 'cc-'));
    writeFileSync(
      path.join(dir, 'PlaygroundSdJwt.knob04-plain.json'),
      JSON.stringify({
        credentialConfigKeyId: 'PlaygroundSdJwt',
        scope: 'playground_sdjwt',
        sdClaim: 'fullName',
      }),
    );
    const posted: string[] = [];
    const run = fakeRun(
      (req) => {
        if (req.method === 'POST') {
          posted.push(req.body ?? '');
          return { status: 200, body: {} };
        }
        if (req.url.pathname.endsWith('/credential-configurations/PlaygroundSdJwt__KNOB-04_plain'))
          return { status: posted.length > 0 ? 200 : 404 };
        return certify()(req);
      },
      { spec: { knobs: { 'KNOB-04': 'plain' } } },
    );
    const v = new CertifyPreauthIssuer({
      internalBase: INTERNAL,
      publicBase: PUBLIC,
      configDir: dir,
    });
    expect(await v.resolveVariant(run.ctx, 'PlaygroundSdJwt')).toBe(
      'PlaygroundSdJwt__KNOB-04_plain',
    );
    expect(JSON.parse(posted[0] ?? '')).toEqual({
      credentialConfigKeyId: 'PlaygroundSdJwt__KNOB-04_plain',
      scope: 'playground_sdjwt__knob04-plain',
      sdClaim: 'fullName',
    });
    // idempotent: the second call finds it and posts nothing
    await v.resolveVariant(run.ctx, 'PlaygroundSdJwt');
    expect(posted).toHaveLength(1);
    // the run now reads and mints the variant
    await v.createOffer(run.ctx, {
      configurationId: 'PlaygroundSdJwt',
      claims: {},
      withTxCode: false,
    });
    const mint = run.exchanges.find((x) => x.url.endsWith('/pre-authorized-data'));
    expect(JSON.parse(mint?.body ?? '')).toMatchObject({
      credential_configuration_id: 'PlaygroundSdJwt__KNOB-04_plain',
      claims: { fullName: 'Asha Rao' },
    });
  });

  it('helpers: variant ids, offer ids, pre-authorized codes', () => {
    expect(
      variantId('A', [
        ['KNOB-04', 'plain'],
        ['KNOB-06', 'seeded'],
      ]),
    ).toBe('A__KNOB-04_plain__KNOB-06_seeded');
    expect(
      differingIssuerKnobs({ 'KNOB-04': 'jsonpath', 'KNOB-06': 'seeded', 'KNOB-07': 'x' }),
    ).toEqual([['KNOB-06', 'seeded']]);
    expect(offerIdOf('nope')).toBeNull();
    const offerJson = golden('/credential-offer-data/').resBody;
    expect(preAuthorizedCodeOf(offerJson)).toBe('GMZqZpa9myf4HDsvmIPzArrFZBwEmK81');
  });

  it('probe reads the internal well-known', async () => {
    const run = fakeRun(certify());
    const a = await new CertifyPreauthIssuer({ internalBase: INTERNAL, publicBase: PUBLIC }).probe(
      run.ctx,
    );
    expect(a).toEqual({ available: true, versionFingerprint: 'inji-certify:1.0.0-alpha.1' });
    const down = fakeRun(() => ({ status: 503 }));
    expect(
      (
        await new CertifyPreauthIssuer({ internalBase: INTERNAL, publicBase: PUBLIC }).probe(
          down.ctx,
        )
      ).available,
    ).toBe(false);
  });
});
