/**
 * Holder keys of `wallet.playground-ts` (02 §1.3 item 4, 02 §6.2, 05 §4.1 `holder_keys`/`run_keys`):
 * one ES256 (P-256) key per root run, reused by derived runs, private JWK kept only in the key
 * store (the BFF's `holder_keys` table; never in an event, export or report). Signatures are
 * IEEE P1363 (r‖s, 64 bytes) for ES256, as JOSE requires.
 *
 * `HolderKeyService` is the orchestrator's `KeyService` (apps/bff/src/orchestrator/engine.ts):
 * `AdapterContext.holderKey()` and `AdapterContext.sign()` end here.
 */
import { createPrivateKey, generateKeyPairSync, randomUUID, sign as signRaw } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import type { HolderKeyRef } from '../contracts.js';

export interface StoredHolderKey {
  ref: HolderKeyRef;
  /** the private JWK; only `HolderKeyStore.privateJwk` returns it again */
  privateJwk: JsonWebKey;
}

/** the persistence port (05 §6: the repository has no other function returning the private key) */
export interface HolderKeyStore {
  /** the key a run uses (its `run_keys` row), public part only */
  keyOfRun(runId: string): HolderKeyRef | null;
  /** inserts the key (`holder_keys`, `root_run_id` = the run that created it) */
  insert(key: StoredHolderKey, rootRunId: string): void;
  /** links a run to a key (`run_keys`) */
  link(runId: string, keyId: string): void;
  /** `getSigningKey(keyId)` of 05 §6 */
  privateJwk(keyId: string): JsonWebKey | null;
}

const b64u = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

/** `did:jwk:` of the public JWK members only (kty, crv, x, y), as the spikes did (S-020) */
export function didJwkOf(publicJwk: JsonWebKey): string {
  const { kty, crv, x, y } = publicJwk;
  const pub: Record<string, unknown> = { kty, crv, x };
  if (y !== undefined) pub.y = y;
  return `did:jwk:${b64u(JSON.stringify(pub))}`;
}

export function generateHolderKey(alg: 'ES256' | 'EdDSA' = 'ES256'): StoredHolderKey {
  const pair =
    alg === 'ES256'
      ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
      : generateKeyPairSync('ed25519');
  const full = pair.publicKey.export({ format: 'jwk' });
  const publicJwk: JsonWebKey =
    alg === 'ES256'
      ? { kty: full.kty, crv: full.crv, x: full.x, y: full.y }
      : { kty: full.kty, crv: full.crv, x: full.x };
  const privateJwk = pair.privateKey.export({ format: 'jwk' });
  return {
    ref: { keyId: `hk_${randomUUID()}`, alg, publicJwk, didJwk: didJwkOf(publicJwk) },
    privateJwk,
  };
}

/** ES256 → P1363 (64 bytes); EdDSA → Ed25519 (64 bytes) */
export function signWithJwk(
  privateJwk: JsonWebKey,
  alg: 'ES256' | 'EdDSA',
  data: Uint8Array,
): Uint8Array {
  const key = createPrivateKey({ key: privateJwk, format: 'jwk' });
  if (alg === 'ES256')
    return new Uint8Array(signRaw('sha256', data, { key, dsaEncoding: 'ieee-p1363' }));
  return new Uint8Array(signRaw(null, data, key));
}

/** an in-memory store (unit tests) */
export function memoryHolderKeyStore(): HolderKeyStore & { size(): number } {
  const keys = new Map<string, StoredHolderKey>();
  const runs = new Map<string, string>();
  return {
    keyOfRun: (runId) => {
      const id = runs.get(runId);
      return id ? (keys.get(id)?.ref ?? null) : null;
    },
    insert: (key) => void keys.set(key.ref.keyId, key),
    link: (runId, keyId) => void runs.set(runId, keyId),
    privateJwk: (keyId) => keys.get(keyId)?.privateJwk ?? null,
    size: () => keys.size,
  };
}

export class KeyUnavailable extends Error {
  readonly runErrorCode = 'key_unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'KeyUnavailable';
  }
}

export class HolderKeyService {
  /** `store` is a getter so the BFF can attach its store after the server opened it */
  constructor(private readonly store: () => HolderKeyStore | null) {}

  private s(): HolderKeyStore {
    const s = this.store();
    if (!s) throw new KeyUnavailable('holder key store not attached');
    return s;
  }

  /** the run's key; a derived run reuses its parent's (02 §1.3 item 4), a root run creates one */
  holderKey(runId: string, spec: { parentRunId: string | null }): Promise<HolderKeyRef> {
    try {
      const s = this.s();
      const own = s.keyOfRun(runId);
      if (own) return Promise.resolve(own);
      if (spec.parentRunId !== null) {
        const parent = s.keyOfRun(spec.parentRunId);
        if (!parent)
          throw new KeyUnavailable(`parent run ${spec.parentRunId} has no holder key (imported?)`);
        s.link(runId, parent.keyId);
        return Promise.resolve(parent);
      }
      const key = generateHolderKey('ES256');
      s.insert(key, runId);
      s.link(runId, key.ref.keyId);
      return Promise.resolve(key.ref);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  sign(key: HolderKeyRef, alg: 'ES256' | 'EdDSA', data: Uint8Array): Promise<Uint8Array> {
    try {
      const jwk = this.s().privateJwk(key.keyId);
      if (!jwk) throw new KeyUnavailable(`holder key ${key.keyId} not found`);
      if (alg !== key.alg) throw new Error(`key ${key.keyId} is ${key.alg}, asked for ${alg}`);
      return Promise.resolve(signWithJwk(jwk, alg, data));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
}
