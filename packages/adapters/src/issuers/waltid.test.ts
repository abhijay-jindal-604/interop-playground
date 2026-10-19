/**
 * T-43 unit: `issuer.waltid` × `wallet.playground-ts` (03 FLOW-08) against walt.id issuer-api2
 * upstreams recorded from the bundle (`waltid.recorded.json`, one run per KNOB-01 value): the
 * internal mint body (no `runtimeOverrides` for `absent`; `issuerKey` + `x5Chain` for `present`,
 * read from the run spec's `KnobValues`), the by-value offer (fetch skipped), the wallet hops on
 * the 18103 base with the well-known inserted before `/openid4vci`, full capture, and the
 * decoded credential header (`x5c` absent / present).
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AdapterContext, AdapterEvent, KnobValues } from '../contracts.js';
import type { FakeRun, Handler } from '../testing/fake-context.js';
import { fakeRun, stepTrail } from '../testing/fake-context.js';
import { HolderKeyService, memoryHolderKeyStore } from '../wallets/keys.js';
import { PlaygroundTsWallet, wellKnownUrl } from '../wallets/playground-ts.js';
import {
  WALTID_ROUTES,
  WaltidIssuer,
  offerByValue,
  waltidOfferBody,
  x5cMaterialFromFiles,
} from './waltid.js';

const here = path.dirname(fileURLToPath(import.meta.url));
type Ex = { method: string; url: string; reqBody: string | null; status: number; resBody: unknown };
const recorded = (
  JSON.parse(readFileSync(path.join(here, 'waltid.recorded.json'), 'utf8')) as { exchanges: Ex[] }
).exchanges;
const ABSENT = recorded.slice(0, 6);
const PRESENT = recorded.slice(6, 12);
const INTERNAL = 'http://waltid-issuer-api2:8080';
const PUBLIC = 'http://192.0.2.10:18103';
const CERT = (
  JSON.parse(PRESENT[0]?.reqBody ?? '{}') as { runtimeOverrides: { x5Chain: string[] } }
).runtimeOverrides.x5Chain;

/** replays one recorded run by method + URL (origin included: internal vs gateway) */
function replay(run: Ex[]): Handler {
  return ({ method, url }) => {
    const hit = run.find((e) => e.method === method && new URL(e.url).href === url.href);
    return hit ? { status: hit.status, body: hit.resBody } : { status: 404, body: 'Not Found' };
  };
}

const testKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
const material = () => ({ issuerJwk: testKey.export({ format: 'jwk' }), x5Chain: CERT });

function setup(run: Ex[], knobs: KnobValues): { r: FakeRun; ctx: AdapterContext } {
  const r = fakeRun(replay(run), {
    spec: {
      issuer: 'issuer.waltid',
      configurationId: 'identityCredentialSdJwt',
      issuanceFlowId: 'FLOW-08',
      knobs,
    },
  });
  const store = memoryHolderKeyStore();
  const keys = new HolderKeyService(() => store);
  const ctx: AdapterContext = {
    ...r.ctx,
    holderKey: () => keys.holderKey(r.ctx.runId, r.ctx.spec),
    sign: (k, alg, data) => keys.sign(k, alg, data),
  };
  return { r, ctx };
}

async function issue(run: Ex[], knobs: KnobValues) {
  const { r, ctx } = setup(run, knobs);
  const routes: unknown[] = [];
  const issuer = new WaltidIssuer({
    internalBase: INTERNAL,
    publicBase: PUBLIC,
    x5c: material,
    gateway: { register: () => undefined, addRoutes: (_id, t) => routes.push(...t) },
  });
  const offer = await issuer.createOffer(ctx, {
    configurationId: 'identityCredentialSdJwt',
    claims: {},
    withTxCode: false,
  });
  const out = await new PlaygroundTsWallet().receiveOffer(ctx, offer);
  return { r, offer, out, routes };
}

const header = (events: AdapterEvent[]): Record<string, unknown> => {
  const call = events.find(
    (e) => e.type === 'engine.call' && e.stepKey === 'vci.credential.inspect',
  ) as { outputSummary: { header?: Record<string, unknown> } } | undefined;
  return call?.outputSummary.header ?? {};
};

const TRAIL = [
  'vci.offer.mint:start',
  'vci.offer.mint:pass:full',
  'vci.offer.fetch:start',
  'vci.offer.fetch:skipped:none',
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
];

describe('issuer.waltid × wallet.playground-ts (T-43, FLOW-08)', () => {
  it('KNOB-01 absent: plain mint, by-value offer, full capture, credential without x5c', async () => {
    const { r, offer, out, routes } = await issue(ABSENT, { 'KNOB-01': 'absent' });
    expect(stepTrail(r.events)).toEqual(TRAIL);
    expect(out.ok).toBe(true);
    const mint = r.exchanges[0];
    expect(mint?.url).toBe(`${INTERNAL}/issuer2/credential-offers`);
    expect(JSON.parse(mint?.body ?? '{}')).toEqual({
      profileId: 'identityCredentialSdJwt',
      authMethod: 'PRE_AUTHORIZED',
      valueMode: 'BY_VALUE',
    });
    expect(offer.uri.startsWith('openid-credential-offer://?credential_offer=')).toBe(true);
    expect(offer.credentialIssuer).toBe(`${PUBLIC}/openid4vci`);
    expect(offer.configurationId).toBe('identity_credential');
    // every wallet hop on the gateway's 18103 listener, well-knowns per OID4VCI 1.0 §12.2.2
    const wallet = r.exchanges.slice(1);
    expect(wallet.map((x) => `${x.method} ${x.url}`)).toEqual([
      `GET ${PUBLIC}/.well-known/openid-credential-issuer/openid4vci`,
      `GET ${PUBLIC}/.well-known/oauth-authorization-server/openid4vci`,
      `POST ${PUBLIC}/openid4vci/token`,
      `POST ${PUBLIC}/openid4vci/nonce`,
      `POST ${PUBLIC}/openid4vci/credential`,
    ]);
    expect(r.correlations.map((c) => c.kind)).toEqual([
      'pre-authorized-code',
      'access-token-sha256',
    ]);
    expect(routes).toEqual([...WALTID_ROUTES]);
    const h = header(r.events);
    expect(h.typ).toBe('dc+sd-jwt');
    expect(h.x5c).toBeUndefined();
    expect(out.credential?.issuerAdapter).toBe('issuer.waltid');
  });

  it('KNOB-01 present: runtimeOverrides issuerKey + x5Chain, credential header carries x5c', async () => {
    const { r, out } = await issue(PRESENT, { 'KNOB-01': 'present' });
    expect(stepTrail(r.events)).toEqual(TRAIL);
    expect(out.ok).toBe(true);
    const body = JSON.parse(r.exchanges[0]?.body ?? '{}') as {
      runtimeOverrides: {
        issuerKey: { type: string; jwk: Record<string, unknown> };
        x5Chain: string[];
      };
    };
    expect(body.runtimeOverrides.issuerKey.type).toBe('jwk');
    expect(body.runtimeOverrides.issuerKey.jwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(typeof body.runtimeOverrides.issuerKey.jwk.d).toBe('string');
    expect(body.runtimeOverrides.x5Chain).toEqual(CERT);
    const h = header(r.events);
    expect(Array.isArray(h.x5c)).toBe(true);
    expect((h.x5c as string[]).length).toBe(1);
  });

  it('an unset KNOB-01 is the default absent (ADR-21)', () => {
    expect(waltidOfferBody('identityCredentialSdJwt', 'absent', undefined)).not.toHaveProperty(
      'runtimeOverrides',
    );
    expect(() => waltidOfferBody('identityCredentialSdJwt', 'present', undefined)).toThrow(
      /KNOB-01/,
    );
  });

  it('a failed mint is a failed vci.offer.mint step', async () => {
    const { ctx, r } = setup([], {});
    const issuer = new WaltidIssuer({ internalBase: INTERNAL, publicBase: PUBLIC });
    await issuer.createOffer(ctx, {
      configurationId: 'identityCredentialSdJwt',
      claims: {},
      withTxCode: false,
    });
    expect(stepTrail(r.events)).toEqual(['vci.offer.mint:start', 'vci.offer.mint:fail:full']);
  });

  it('probe reads the inserted well-known on the service name', async () => {
    const { ctx, r } = setup(
      ABSENT.map((e) => ({ ...e, url: e.url.replace(PUBLIC, INTERNAL) })),
      {},
    );
    const a = await new WaltidIssuer({ internalBase: INTERNAL, publicBase: PUBLIC }).probe(ctx);
    expect(a.available).toBe(true);
    expect(r.exchanges[0]?.url).toBe(`${INTERNAL}/.well-known/openid-credential-issuer/openid4vci`);
  });

  it('reads the KNOB-01 material from PEM files', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'waltid-'));
    const kf = path.join(dir, 'k.pem');
    const cf = path.join(dir, 'c.pem');
    writeFileSync(kf, testKey.export({ format: 'pem', type: 'pkcs8' }));
    writeFileSync(cf, `${CERT[0]}\n`);
    const m = x5cMaterialFromFiles(kf, cf)();
    expect(m.issuerJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(m.x5Chain).toEqual(CERT);
    expect(() => x5cMaterialFromFiles(path.join(dir, 'none'), cf)()).toThrow(/KNOB-01/);
  });

  it('well-known insertion leaves a path-less identifier unchanged (Certify)', () => {
    expect(wellKnownUrl('https://192.0.2.10', 'openid-credential-issuer')).toBe(
      'https://192.0.2.10/.well-known/openid-credential-issuer',
    );
    expect(wellKnownUrl(`${PUBLIC}/openid4vci/`, 'oauth-authorization-server')).toBe(
      `${PUBLIC}/.well-known/oauth-authorization-server/openid4vci`,
    );
    expect(offerByValue('openid-credential-offer://?credential_offer=nope')).toBeNull();
  });
});
