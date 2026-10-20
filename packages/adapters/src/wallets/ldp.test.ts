/**
 * T-46 unit: the `ldp_vc` VP of `wallet.playground-ts` against the recorded S-199 shapes
 * (`fixtures/ldp/`, copied from `research/spikes/r5d10/`): the golden JsonWebSignature2020 ES256
 * VP p1 that local Inji Verify accepted verifies with our signing input (URDNA2015 by `jsonld`
 * over the offline contexts), a VP we build has the same structure, and the FLOW-03 lints and
 * did:web resolution. The `jsonld` cases run only when the package is installed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateHolderKey, signWithJwk } from './keys.js';
import type { Canonize, LdpVp } from './ldp.js';
import {
  DETACHED_ES256_HEADER,
  JWS_2020_V1,
  VC_V1,
  didWebUrl,
  inspectLdpVc,
  jwkOfDidJwk,
  ldpClaimPresent,
  ldpTypeMatches,
  loadJsonldCanonize,
  offlineDocumentLoader,
  proofCreated,
  signLdpVp,
  unsignedVp,
  verifyLdpVp,
} from './ldp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ldpDir = path.join(here, '..', '..', '..', '..', 'fixtures', 'ldp');
const readJson = (f: string): unknown =>
  JSON.parse(readFileSync(path.join(ldpDir, f), 'utf8')) as unknown;
/** S-199 p1: the VP local Inji Verify answered `allChecksSuccessful:true` for */
const VP_P1 = readJson('S-199-vp-p1.json') as LdpVp;
/** the S-199 FarmerCredential bound to the P-256 holder key */
const CRED = readJson('S-199-cred-farmer-p256.json') as Record<string, unknown>;

let real: Canonize | null = null;
try {
  real = await loadJsonldCanonize();
} catch {
  real = null;
}

/** a deterministic stand-in for URDNA2015 (sorted-key JSON) for the structural tests */
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

describe('ldp_vc VP, S-199 golden (jsonld installed)', () => {
  it.skipIf(real === null)('the recorded p1 VP verifies with our signing input', async () => {
    expect(await verifyLdpVp(VP_P1, real as Canonize)).toBe(true);
  });

  it.skipIf(real === null)('a changed challenge breaks the recorded signature', async () => {
    const proof = { ...(VP_P1.proof as NonNullable<LdpVp['proof']>), challenge: 'wrong-nonce' };
    expect(await verifyLdpVp({ ...VP_P1, proof }, real as Canonize)).toBe(false);
  });

  it.skipIf(real === null)(
    'a VP we build over the S-199 credential verifies and has the p1 shape',
    async () => {
      const key = generateHolderKey();
      const p1 = VP_P1.proof as NonNullable<LdpVp['proof']>;
      const { vp, proof } = unsignedVp({
        credential: CRED,
        holderDid: key.ref.didJwk,
        domain: p1.domain,
        challenge: p1.challenge,
        created: proofCreated(1_790_000_000_000),
      });
      const signed = await signLdpVp(vp, proof, real as Canonize, (d) =>
        Promise.resolve(signWithJwk(key.privateJwk, 'ES256', d)),
      );
      expect(await verifyLdpVp(signed, real as Canonize)).toBe(true);
      expect(Object.keys(signed).sort()).toEqual(Object.keys(VP_P1).sort());
      expect(Object.keys(signed.proof ?? {}).sort()).toEqual(Object.keys(p1).sort());
      expect(signed['@context']).toEqual(VP_P1['@context']);
      expect(signed.verifiableCredential).toEqual(VP_P1.verifiableCredential);
    },
  );

  it.skipIf(real === null)('the offline contexts resolve every context of the VP', async () => {
    const n = await (real as Canonize)(VP_P1);
    expect(n).toContain('<https://w3id.org/security#JsonWebSignature2020>');
    expect(n).toContain('"Playground Farmer"');
  });
});

describe('ldp_vc VP structure (S-199 point 3)', () => {
  it('unsignedVp carries the p1 members: holder did:jwk, #0, authentication, domain, challenge', () => {
    const p1 = VP_P1.proof as NonNullable<LdpVp['proof']>;
    const { vp, proof } = unsignedVp({
      credential: CRED,
      holderDid: VP_P1.holder,
      domain: p1.domain,
      challenge: p1.challenge,
      created: p1.created,
    });
    expect(vp).toEqual({
      '@context': [VC_V1, JWS_2020_V1],
      type: ['VerifiablePresentation'],
      holder: VP_P1.holder,
      verifiableCredential: VP_P1.verifiableCredential,
    });
    const { jws, ...p1Options } = p1;
    expect(proof).toEqual(p1Options);
    expect(JSON.parse(Buffer.from(jws.split('.')[0] ?? '', 'base64url').toString())).toEqual(
      DETACHED_ES256_HEADER,
    );
    expect(jws.split('.')[1]).toBe('');
  });

  it('signs a detached ES256 P1363 JWS that verifyLdpVp accepts (stand-in canonicaliser)', async () => {
    const key = generateHolderKey();
    const { vp, proof } = unsignedVp({
      credential: CRED,
      holderDid: key.ref.didJwk,
      domain: 'interop-playground',
      challenge: 'c'.repeat(32),
      created: proofCreated(1_790_000_000_123),
    });
    expect(proof.created).toBe('2026-09-21T14:13:20Z');
    const signed = await signLdpVp(vp, proof, stub, (d) =>
      Promise.resolve(signWithJwk(key.privateJwk, 'ES256', d)),
    );
    expect(Buffer.from(signed.proof?.jws.split('.')[2] ?? '', 'base64url')).toHaveLength(64);
    expect(await verifyLdpVp(signed, stub)).toBe(true);
    const other = { ...signed, holder: 'did:jwk:other' };
    expect(await verifyLdpVp(other, stub)).toBe(false);
  });

  it('jwkOfDidJwk reads the holder key of the recorded VP', () => {
    expect(jwkOfDidJwk(`${VP_P1.holder}#0`)).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(jwkOfDidJwk('did:key:z6Mk')).toBeNull();
  });

  it('the offline loader serves the four contexts and refuses any other URL', async () => {
    for (const url of (VP_P1.verifiableCredential[0] as { '@context': string[] })['@context'])
      await expect(offlineDocumentLoader(url)).resolves.toMatchObject({ documentUrl: url });
    await expect(offlineDocumentLoader(JWS_2020_V1)).resolves.toBeTruthy();
    await expect(offlineDocumentLoader('https://example.org/ctx')).rejects.toThrow(/offline/);
  });
});

describe('FLOW-03 inspection and DCQL matching', () => {
  it('lints the S-199 credential: placeholders, verificationMethod, issuer DID, binding', () => {
    const holder = VP_P1.holder;
    const { inspection, checks } = inspectLdpVc(JSON.stringify(CRED), holder);
    expect(inspection.artifacts.credential).toMatchObject({
      type: ['VerifiableCredential', 'FarmerCredential'],
      issuer: 'did:web:172.16.134.37',
      proofType: 'Ed25519Signature2020',
    });
    expect(inspection.artifacts.credential.placeholders).toContain('${primaryCropType}');
    expect(checks.map((c) => [c.checkId, c.outcome])).toEqual([
      ['vc.ldp.placeholders', 'info'],
      ['vc.ldp.verification-method', 'info'],
      ['vc.ldp.issuer-did', 'info'],
      ['vc.ldp.holder-binding', 'info'],
    ]);
    expect(checks[1]?.message).toBe('proof.verificationMethod is a key of the issuer DID');
    expect(checks[3]?.message).toMatch(/can be holder-bound/);
    const other = inspectLdpVc(JSON.stringify(CRED), 'did:jwk:someoneelse').checks[3];
    expect(other?.message).toMatch(/S-199 point 1/);
  });

  it('flags a %3A issuer DID (G-107) and a foreign verificationMethod (G-20)', () => {
    const bad = {
      ...CRED,
      issuer: 'did:web:192.0.2.10%3A8091',
      proof: { ...(CRED.proof as object), verificationMethod: 'did:web:dead.example#k' },
    };
    const { checks } = inspectLdpVc(JSON.stringify(bad), null);
    expect(checks.find((c) => c.checkId === 'vc.ldp.issuer-did')?.message).toMatch(/G-107/);
    expect(checks.find((c) => c.checkId === 'vc.ldp.verification-method')?.message).toMatch(/G-20/);
  });

  it('a credential without proof does not decode', () => {
    expect(() => inspectLdpVc(JSON.stringify({ type: ['VerifiableCredential'] }), null)).toThrow(
      /no proof/,
    );
  });

  it('did:web → did.json URL (portless root, %3A port, path form of FLOW-13)', () => {
    expect(didWebUrl('did:web:192.0.2.10')).toBe('https://192.0.2.10/.well-known/did.json');
    expect(didWebUrl('did:web:192.0.2.10#key-0')).toBe('https://192.0.2.10/.well-known/did.json');
    expect(didWebUrl('did:web:192.0.2.10%3A8091')).toBe(
      'https://192.0.2.10:8091/.well-known/did.json',
    );
    expect(didWebUrl('did:web:192.0.2.10:iae')).toBe('https://192.0.2.10/iae/did.json');
    expect(didWebUrl('did:jwk:abc')).toBeNull();
  });

  it('claim paths resolve against credentialSubject (S-199 point 5); type_values sets', () => {
    expect(ldpClaimPresent(CRED, ['fullName'])).toBe(true);
    expect(ldpClaimPresent(CRED, ['nope'])).toBe(false);
    // root-relative form: the wallet finds it, Inji Verify rejects it at submit (S-199 e4)
    expect(ldpClaimPresent(CRED, ['credentialSubject', 'fullName'])).toBe(true);
    const type = CRED.type as string[];
    expect(ldpTypeMatches(type, [['VerifiableCredential', 'FarmerCredential']])).toBe(true);
    expect(ldpTypeMatches(type, [['VerifiableCredential', 'Other']])).toBe(false);
    expect(ldpTypeMatches(type, undefined)).toBe(true);
  });
});
