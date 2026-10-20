/**
 * T-47 unit: `issuer.fixture` (03 FLOW-14) and the committed fixture credentials
 * (`fixtures/credentials`): the SD-JWTs verify against the fixture issuer's x5c leaf, the expired
 * one has `exp < 2021-01-01`, and the run-time mint binds the run's holder key.
 */
import { X509Certificate, createPublicKey, verify as nodeVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HolderKeyRef } from '../contracts.js';
import { fakeRun, stepTrail } from '../testing/fake-context.js';
import { generateHolderKey } from '../wallets/keys.js';
import { decodeSdJwt } from '../wallets/sd-jwt.js';
import { DEFAULT_FIXTURES_DIR, flipSignature, loadHolderKey } from './fixture-mint.js';
import { FixtureIssuer } from './fixture.js';

const read = (f: string): string => readFileSync(path.join(DEFAULT_FIXTURES_DIR, f), 'utf8').trim();

function signatureValid(compact: string): boolean {
  const d = decodeSdJwt(compact);
  const x5c = d.header.x5c as string[];
  const cert = new X509Certificate(Buffer.from(x5c[0] ?? '', 'base64'));
  const [h, p, s] = d.issuerJwt.split('.') as [string, string, string];
  return nodeVerify(
    'sha256',
    Buffer.from(`${h}.${p}`, 'ascii'),
    {
      key: createPublicKey(cert.publicKey.export({ type: 'spki', format: 'pem' })),
      dsaEncoding: 'ieee-p1363',
    },
    Buffer.from(s, 'base64url'),
  );
}

describe('fixture credentials (committed)', () => {
  it('sdjwt-valid.txt: x5c-signed, key-bound, no exp', () => {
    const raw = read('sdjwt-valid.txt');
    const d = decodeSdJwt(raw);
    expect(d.header).toMatchObject({ alg: 'ES256', typ: 'dc+sd-jwt' });
    expect((d.header.x5c as string[]).length).toBe(1);
    expect(d.payload.exp).toBeUndefined();
    expect(d.payload.vct).toBe('PlaygroundSdJwt');
    // IANA hash name; local Inji Verify rejects "sha256" with ERR_INVALID_SD_ALG (T-47 live run)
    expect(d.payload._sd_alg).toBe('sha-256');
    expect((d.payload.cnf as { kid: string }).kid).toBe(`${loadHolderKey().ref.didJwk}#0`);
    expect(signatureValid(raw)).toBe(true);
  });

  it('sdjwt-expired.txt: signature valid and exp < 2021-01-01 (TMP-39)', () => {
    const raw = read('sdjwt-expired.txt');
    const d = decodeSdJwt(raw);
    expect(d.payload.exp as number).toBeLessThan(Date.UTC(2021, 0, 1) / 1000);
    expect(signatureValid(raw)).toBe(true);
  });

  it('flipSignature breaks only the signature (TMP-30)', () => {
    const raw = read('sdjwt-valid.txt');
    const bad = flipSignature(raw);
    expect(bad).not.toBe(raw);
    expect(bad.split('.')[1]).toBe(raw.split('.')[1]);
    expect(signatureValid(bad)).toBe(false);
  });
});

describe('issuer.fixture fixture() (FLOW-14)', () => {
  const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
  async function load(configurationId: string) {
    const holder = generateHolderKey('ES256');
    const run = fakeRun(() => ({ status: 500 }), { spec: { configurationId } });
    run.ctx.holderKey = (): Promise<HolderKeyRef> => Promise.resolve(holder.ref);
    const held = await new FixtureIssuer({ now: () => NOW }).fixture(run.ctx, 'dc+sd-jwt');
    return { run, held, holder };
  }

  it('valid: one capture-none step, an engine.call, bound to the run key, no exchanges', async () => {
    const { run, held, holder } = await load('PlaygroundSdJwt');
    expect(stepTrail(run.events)).toEqual(['vci.fixture.load:start', 'vci.fixture.load:pass:none']);
    expect(run.exchanges).toHaveLength(0);
    expect(run.events.find((e) => e.type === 'engine.call')).toMatchObject({
      engine: 'playground-ts',
      op: 'load-fixture',
    });
    expect(held).toMatchObject({ format: 'dc+sd-jwt', issuerAdapter: 'issuer.fixture' });
    const d = decodeSdJwt(held.raw);
    expect((d.payload.cnf as { kid: string }).kid).toBe(`${holder.ref.didJwk}#0`);
    expect(d.payload.exp).toBeUndefined();
    expect(signatureValid(held.raw)).toBe(true);
  });

  it('expired: iat now-2d, exp now-1d, signature valid (08 §5)', async () => {
    const { held } = await load('PlaygroundSdJwtExpired');
    const d = decodeSdJwt(held.raw);
    const now = Math.floor(NOW / 1000);
    expect(d.payload.iat).toBe(now - 2 * 86_400);
    expect(d.payload.exp).toBe(now - 86_400);
    expect(signatureValid(held.raw)).toBe(true);
  });

  it('invalid: signature broken', async () => {
    const { held } = await load('PlaygroundSdJwtInvalid');
    expect(signatureValid(held.raw)).toBe(false);
  });

  it('refuses mso_mdoc (T-48 cut) and unknown configurations', async () => {
    const run = fakeRun(() => ({ status: 500 }));
    await expect(new FixtureIssuer().fixture(run.ctx, 'mso_mdoc')).rejects.toThrow(/T-48/);
    await expect(
      new FixtureIssuer().fixture(
        fakeRun(() => ({ status: 500 }), { spec: { configurationId: 'X' } }).ctx,
        'dc+sd-jwt',
      ),
    ).rejects.toThrow(/unknown configuration/);
  });

  it('probe: available with the committed key', async () => {
    await expect(new FixtureIssuer().probe()).resolves.toMatchObject({ available: true });
  });
});
