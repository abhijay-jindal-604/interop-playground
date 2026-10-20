/**
 * Minting of fixture `dc+sd-jwt` credentials for `issuer.fixture` (plan/11 §fixtures, 08 §5,
 * TMP-39): ES256 over the throwaway issuer key in `fixtures/credentials/fixture-issuer.json`
 * (TEST-ONLY), `x5c` = the self-signed certificate (G-55: Inji Verify needs `x5c`), `cnf.kid` =
 * the holder's `did:jwk#0` (the S-060 shape). Pure functions: the clock and key come from the caller.
 */
import { createHash, createPrivateKey, randomBytes, sign as nodeSign } from 'node:crypto';
import type { JsonWebKey, KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HolderKeyRef } from '../contracts.js';
import { didJwkOf } from '../wallets/keys.js';

export const FIXTURE_VCT = 'PlaygroundSdJwt';
export const FIXTURE_ISSUER = 'https://fixture-issuer.interop-playground.test';
const DAY = 86_400;

export interface FixtureIssuerKey {
  privateKey: KeyObject;
  /** base64 DER certificates, leaf first */
  x5c: string[];
}

export interface FixtureHolderKey {
  privateKey: KeyObject;
  ref: HolderKeyRef;
}

/** `fixtures/credentials` of the product repo, relative to this file (src or dist) */
export const DEFAULT_FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'credentials',
);

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function p8(v: unknown, file: string): KeyObject {
  if (typeof v !== 'string') throw new Error(`${file}: pkcs8Der missing`);
  return createPrivateKey({ key: Buffer.from(v, 'base64'), format: 'der', type: 'pkcs8' });
}

export function loadIssuerKey(dir: string = DEFAULT_FIXTURES_DIR): FixtureIssuerKey {
  const file = path.join(dir, 'fixture-issuer.json');
  const j = readJson(file);
  const x5c = Array.isArray(j.x5c) ? j.x5c.filter((x): x is string => typeof x === 'string') : [];
  if (x5c.length === 0) throw new Error(`${file}: x5c missing`);
  return { privateKey: p8(j.pkcs8Der, file), x5c };
}

export function loadHolderKey(dir: string = DEFAULT_FIXTURES_DIR): FixtureHolderKey {
  const file = path.join(dir, 'fixture-holder.json');
  const j = readJson(file);
  const publicJwk = j.publicJwk as JsonWebKey;
  return {
    privateKey: p8(j.pkcs8Der, file),
    ref: { keyId: 'fixture-holder', alg: 'ES256', publicJwk, didJwk: didJwkOf(publicJwk) },
  };
}

const b64u = (v: unknown): string => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');

function disclosure(name: string, value: unknown): { raw: string; digest: string } {
  const raw = Buffer.from(
    JSON.stringify([randomBytes(16).toString('base64url'), name, value]),
    'utf8',
  ).toString('base64url');
  return { raw, digest: createHash('sha256').update(raw, 'ascii').digest('base64url') };
}

export interface MintOptions {
  issuer: FixtureIssuerKey;
  holder: Pick<HolderKeyRef, 'didJwk'>;
  /** seconds since the epoch */
  iat: number;
  /** seconds since the epoch; omitted = no `exp` */
  exp?: number;
  claims?: Record<string, string>;
}

/** the compact `<issuer-jwt>~<disclosure>~…~` (no KB-JWT: that is the wallet's) */
export function mintSdJwt(o: MintOptions): string {
  const claims = o.claims ?? {
    fullName: 'Priya Sharma',
    dateOfBirth: '1995-04-12',
    gender: 'Female',
  };
  const discs = Object.entries(claims).map(([k, v]) => disclosure(k, v));
  const payload: Record<string, unknown> = {
    iss: FIXTURE_ISSUER,
    vct: FIXTURE_VCT,
    iat: o.iat,
    ...(o.exp !== undefined ? { exp: o.exp } : {}),
    cnf: { kid: `${o.holder.didJwk}#0` },
    _sd: discs.map((d) => d.digest),
    _sd_alg: 'sha-256', // IANA hash name (SD-JWT §4.1.1); Verify rejects "sha256" (ERR_INVALID_SD_ALG, T-47 live)
  };
  const signingInput = `${b64u({ alg: 'ES256', typ: 'dc+sd-jwt', x5c: o.issuer.x5c })}.${b64u(payload)}`;
  const sig = nodeSign('sha256', Buffer.from(signingInput, 'ascii'), {
    key: o.issuer.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${sig.toString('base64url')}~${discs.map((d) => d.raw).join('~')}~`;
}

/** TMP-30: the issuer signature's first byte XOR 0x01 (the Invalid fixture) */
export function flipSignature(compact: string): string {
  const [jwt = '', ...rest] = compact.split('~');
  const [h = '', p = '', s = ''] = jwt.split('.');
  const sig = Buffer.from(s, 'base64url');
  sig[0] = (sig[0] ?? 0) ^ 0x01;
  return [`${h}.${p}.${sig.toString('base64url')}`, ...rest].join('~');
}

/** valid: no `exp`; expired: iat now − 2 d, exp now − 1 d (08 §5, TMP-39) */
export function mintFixture(
  kind: 'valid' | 'expired' | 'invalid',
  o: { issuer: FixtureIssuerKey; holder: Pick<HolderKeyRef, 'didJwk'>; nowMs: number },
): string {
  const now = Math.floor(o.nowMs / 1000);
  const base = { issuer: o.issuer, holder: o.holder };
  if (kind === 'expired') return mintSdJwt({ ...base, iat: now - 2 * DAY, exp: now - DAY });
  const valid = mintSdJwt({ ...base, iat: now });
  return kind === 'invalid' ? flipSignature(valid) : valid;
}
