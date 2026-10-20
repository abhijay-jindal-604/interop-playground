/**
 * `ldp_vc` support of `wallet.playground-ts` (plan/12 T-46; 03 FLOW-03, FLOW-31 tier 2; S-199).
 *
 * Issuance side: the structural lints of `vci.credential.inspect` (FLOW-03: placeholder literals
 * G-14/G-15, `proof.verificationMethod` DID versus `issuer` G-20, `%3A` in the issuer DID G-107,
 * subject binding S-199 point 1) and the did:web URL of `vci.issuer.did`.
 * Presentation side: the holder-signed JSON-LD `VerifiablePresentation` that S-199 proved at
 * local Inji Verify (`research/spikes/r5d10/vpbuild/build-vp-es256.mjs`, result p1):
 * `JsonWebSignature2020`, detached ES256 JWS `{alg:ES256,b64:false,crit:[b64]}` over
 * `sha256(URDNA2015(proof options)) || sha256(URDNA2015(VP without proof))`, signed by the
 * credential's own P-256 issuance key, `holder` = its did:jwk, `verificationMethod` = `#0`,
 * `proofPurpose` `authentication`, `domain` = the full clientId, `challenge` = the nonce.
 *
 * Canonicalisation is URDNA2015 by the `jsonld` package (the library S-199 used), loaded lazily
 * so the module typechecks without it; JSON-LD contexts come from the offline copies in
 * `ldp-contexts/` (the vc-verifier test contexts the S-199 golden signature verifies against),
 * never from the network (ADR-96).
 */
import { createHash, createPublicKey, verify as verifySig } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckResult } from '../contracts.js';
import { isRecord, str } from '../support.js';

/** URDNA2015 N-Quads of a JSON-LD document */
export type Canonize = (doc: Record<string, unknown>) => Promise<string>;

export const VC_V1 = 'https://www.w3.org/2018/credentials/v1';
export const JWS_2020_V1 = 'https://w3id.org/security/suites/jws-2020/v1';
/** S-199 point 3 / `build-vp-es256.mjs`: the VP and proof context */
export const VP_CONTEXT: readonly string[] = [VC_V1, JWS_2020_V1];
/** `{alg:ES256,b64:false,crit:[b64]}` (RFC 7797 detached, unencoded payload) */
export const DETACHED_ES256_HEADER = { alg: 'ES256', b64: false, crit: ['b64'] } as const;

const here = path.dirname(fileURLToPath(import.meta.url));
export const LDP_CONTEXT_DIR = path.join(here, 'ldp-contexts');
/** offline JSON-LD contexts (URL → file in `ldp-contexts/`) */
export const LDP_CONTEXT_FILES: Readonly<Record<string, string>> = {
  [VC_V1]: 'credentials-v1.json',
  [JWS_2020_V1]: 'jws-2020-v1.json',
  'https://w3id.org/security/suites/ed25519-2020/v1': 'ed25519-2020-v1.json',
  'https://inji.github.io/inji-config/contexts/farmer.json': 'inji-farmer.json',
};

const contextCache = new Map<string, unknown>();
/** jsonld `documentLoader` over the offline contexts; an unknown URL is an error (no network) */
export function offlineDocumentLoader(
  url: string,
  dir = LDP_CONTEXT_DIR,
): Promise<{ contextUrl: null; documentUrl: string; document: unknown }> {
  const file = LDP_CONTEXT_FILES[url];
  if (!file)
    return Promise.reject(new Error(`JSON-LD context ${url} is not in the offline set (ADR-96)`));
  const key = path.join(dir, file);
  if (!contextCache.has(key)) contextCache.set(key, JSON.parse(readFileSync(key, 'utf8')));
  return Promise.resolve({ contextUrl: null, documentUrl: url, document: contextCache.get(key) });
}

interface JsonLdLike {
  canonize(doc: unknown, opts: Record<string, unknown>): Promise<string>;
}

/** the `jsonld` module name, kept in a variable so the import stays optional at typecheck time */
const JSONLD_MODULE = 'jsonld';

/**
 * URDNA2015 via `jsonld` with the offline loader (`safe:false`, as in S-199). Rejects with a
 * readable reason when the package is not installed.
 */
export async function loadJsonldCanonize(): Promise<Canonize> {
  let mod: unknown;
  try {
    mod = await import(/* @vite-ignore */ JSONLD_MODULE);
  } catch {
    throw new Error('the jsonld package is not installed (ldp_vc presentation needs it, ADR-96)');
  }
  const m = mod as { default?: JsonLdLike } & Partial<JsonLdLike>;
  const lib: JsonLdLike | undefined =
    m.default && typeof m.default.canonize === 'function'
      ? m.default
      : typeof m.canonize === 'function'
        ? (m as JsonLdLike)
        : undefined;
  if (!lib) throw new Error('the jsonld package has no canonize()');
  return (doc) =>
    lib.canonize(doc, {
      algorithm: 'URDNA2015',
      format: 'application/n-quads',
      documentLoader: (url: string) => offlineDocumentLoader(url),
      safe: false,
    });
}

const b64u = (b: Uint8Array | string): string =>
  (typeof b === 'string' ? Buffer.from(b, 'utf8') : Buffer.from(b)).toString('base64url');
const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

export type LdpProofOptions = {
  type: 'JsonWebSignature2020';
  created: string;
  verificationMethod: string;
  proofPurpose: 'authentication';
  challenge: string;
  domain: string;
};

export type LdpVp = {
  '@context': string[];
  type: string[];
  holder: string;
  verifiableCredential: unknown[];
  proof?: LdpProofOptions & { jws: string };
};

/** `created` in the S-199 form: ISO 8601 without milliseconds */
export function proofCreated(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
}

/**
 * The bytes the detached JWS signs (JsonWebSignature2020, RFC 7797 b64:false):
 * `<b64u(header)>.` + sha256(canon(proof options with the VP context)) + sha256(canon(VP)).
 */
export async function ldpSigningInput(
  vp: Omit<LdpVp, 'proof'>,
  proof: LdpProofOptions,
  canonize: Canonize,
): Promise<{ header: string; input: Buffer }> {
  const header = b64u(JSON.stringify(DETACHED_ES256_HEADER));
  const proofDoc = { '@context': vp['@context'], ...proof };
  const hash = Buffer.concat([sha256(await canonize(proofDoc)), sha256(await canonize(vp))]);
  return { header, input: Buffer.concat([Buffer.from(`${header}.`, 'ascii'), hash]) };
}

/** the unsigned VP and proof options for one held `ldp_vc` (S-199 point 3) */
export function unsignedVp(p: {
  credential: unknown;
  holderDid: string;
  domain: string;
  challenge: string;
  created: string;
}): { vp: Omit<LdpVp, 'proof'>; proof: LdpProofOptions } {
  return {
    vp: {
      '@context': [...VP_CONTEXT],
      type: ['VerifiablePresentation'],
      holder: p.holderDid,
      verifiableCredential: [p.credential],
    },
    proof: {
      type: 'JsonWebSignature2020',
      created: p.created,
      verificationMethod: `${p.holderDid}#0`,
      proofPurpose: 'authentication',
      challenge: p.challenge,
      domain: p.domain,
    },
  };
}

/** signs the VP: `sign` returns the ES256 P1363 signature (64 bytes) over the input */
export async function signLdpVp(
  vp: Omit<LdpVp, 'proof'>,
  proof: LdpProofOptions,
  canonize: Canonize,
  sign: (data: Uint8Array) => Promise<Uint8Array>,
): Promise<LdpVp> {
  const { header, input } = await ldpSigningInput(vp, proof, canonize);
  const sig = await sign(input);
  return { ...vp, proof: { ...proof, jws: `${header}..${b64u(sig)}` } };
}

/** the public JWK of a `did:jwk:<b64u JWK>[#0]` */
export function jwkOfDidJwk(did: string): JsonWebKey | null {
  const m = /^did:jwk:([A-Za-z0-9_-]+)(#.*)?$/.exec(did);
  if (!m?.[1]) return null;
  try {
    const jwk = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) as unknown;
    return isRecord(jwk) ? jwk : null;
  } catch {
    return null;
  }
}

/** checks a JsonWebSignature2020 ES256 VP proof against its did:jwk verification method */
export async function verifyLdpVp(vp: LdpVp, canonize: Canonize): Promise<boolean> {
  if (!vp.proof) return false;
  const { jws, ...proof } = vp.proof;
  const [h, empty, s] = jws.split('.');
  if (h === undefined || empty !== '' || s === undefined) return false;
  const jwk = jwkOfDidJwk(proof.verificationMethod);
  if (!jwk) return false;
  // every member but `proof` (a VP may carry more, like `id`)
  const bare = Object.fromEntries(Object.entries(vp).filter(([k]) => k !== 'proof')) as Omit<
    LdpVp,
    'proof'
  >;
  const { header, input } = await ldpSigningInput(bare, proof, canonize);
  if (header !== h) return false;
  return verifySig(
    'sha256',
    input,
    { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
    Buffer.from(s, 'base64url'),
  );
}

// ---------------- issuance-side inspection (FLOW-03) ----------------

const PLACEHOLDER = /\$\{[A-Za-z_]+\}/g;
const didOf = (didUrl: string): string => didUrl.split('#')[0] ?? didUrl;

/** `did:web:<host>[:path]` → its did.json URL (did:web method §3.2); null for other methods */
export function didWebUrl(did: string): string | null {
  const m = /^did:web:([^#?]+)$/.exec(didOf(did));
  if (!m?.[1]) return null;
  const [host, ...segs] = m[1].split(':');
  if (!host) return null;
  const origin = `https://${decodeURIComponent(host)}`;
  return segs.length === 0
    ? `${origin}/.well-known/did.json`
    : `${origin}/${segs.map(decodeURIComponent).join('/')}/did.json`;
}

export interface LdpInspection {
  format: 'ldp_vc';
  credential: unknown;
  artifacts: {
    credential: {
      type: string[];
      issuer: string | null;
      subjectId: string | null;
      proofType: string | null;
      verificationMethod: string | null;
      placeholders: string[];
      issuanceDate: string | null;
      expirationDate: string | null;
    };
  };
}

function issuerIdOf(vc: Record<string, unknown>): string | null {
  return str(vc.issuer) ?? (isRecord(vc.issuer) ? str(vc.issuer.id) : null);
}

/** decodes a held `ldp_vc` (JSON text) and runs the FLOW-03 lints (all `info`: FP evidence) */
export function inspectLdpVc(
  raw: string,
  holderDid: string | null,
  exchangeIds: readonly string[] = [],
): { inspection: LdpInspection; checks: CheckResult[] } {
  const vc = JSON.parse(raw) as unknown;
  if (!isRecord(vc)) throw new Error('the ldp_vc is not a JSON object');
  const proof = isRecord(vc.proof) ? vc.proof : null;
  if (!proof) throw new Error('the ldp_vc has no proof');
  const subject = isRecord(vc.credentialSubject) ? vc.credentialSubject : {};
  const issuer = issuerIdOf(vc);
  const vm = str(proof.verificationMethod);
  const placeholders = [...new Set(JSON.stringify(subject).match(PLACEHOLDER) ?? [])];
  const subjectId = str(subject.id);
  const inspection: LdpInspection = {
    format: 'ldp_vc',
    credential: vc,
    artifacts: {
      credential: {
        type: Array.isArray(vc.type) ? vc.type.map(String) : [],
        issuer,
        subjectId,
        proofType: str(proof.type),
        verificationMethod: vm,
        placeholders,
        issuanceDate: str(vc.issuanceDate),
        expirationDate: str(vc.expirationDate),
      },
    },
  };
  const ids = [...exchangeIds];
  const lint = (checkId: string, message: string, specClause: string): CheckResult => ({
    checkId,
    outcome: 'info',
    source: 'playground-lint',
    message,
    specClause,
    exchangeIds: ids,
  });
  const vmDid = vm ? didOf(vm) : null;
  const checks: CheckResult[] = [
    lint(
      'vc.ldp.placeholders',
      placeholders.length === 0
        ? 'no ${…} template literal in credentialSubject'
        : `template literals left in credentialSubject: ${placeholders.join(', ')} (G-14/G-15, FP-09 evidence)`,
      'W3C VC Data Model 1.1 §4.4 Credential Subject',
    ),
    lint(
      'vc.ldp.verification-method',
      vmDid === null
        ? 'proof.verificationMethod missing'
        : vmDid === issuer
          ? 'proof.verificationMethod is a key of the issuer DID'
          : `proof.verificationMethod DID ${vmDid} differs from issuer ${String(issuer)} (G-20, FP-10 evidence)`,
      'W3C VC Data Integrity "verificationMethod"',
    ),
    lint(
      'vc.ldp.issuer-did',
      issuer?.includes('%3A')
        ? `issuer DID ${issuer} carries %3A (a port in did:web; G-107, FP-18 evidence)`
        : `issuer ${String(issuer)}`,
      'did:web Method Specification §3.2',
    ),
    lint(
      'vc.ldp.holder-binding',
      holderDid === null
        ? `credentialSubject.id ${String(subjectId)}`
        : subjectId === `${holderDid}#0` || subjectId === holderDid
          ? 'credentialSubject.id is the issuance key (did:jwk): the VP can be holder-bound (S-199)'
          : `credentialSubject.id ${String(subjectId)} is not the issuance key ${holderDid} (S-199 point 1)`,
      'W3C VC Data Model 1.1 §5.8 (holder binding)',
    ),
  ];
  return { inspection, checks };
}

/**
 * DCQL claim path of an `ldp_vc` query: Inji Verify resolves it relative to `credentialSubject`
 * (S-199 point 5, `DcqlValidator.java:572-607`); a root-relative path is tried second.
 */
export function ldpClaimPresent(
  vc: Record<string, unknown>,
  claimPath: readonly string[],
): boolean {
  const walk = (start: unknown): boolean => {
    let cur = start;
    for (const p of claimPath) {
      if (!isRecord(cur) || !(p in cur)) return false;
      cur = cur[p];
    }
    return claimPath.length > 0;
  };
  return walk(vc.credentialSubject) || walk(vc);
}

/** DCQL `meta.type_values`: some listed type set is contained in the credential's `type` */
export function ldpTypeMatches(vcType: readonly string[], typeValues: unknown): boolean {
  if (!Array.isArray(typeValues)) return true;
  return typeValues.some(
    (set) => Array.isArray(set) && set.every((t) => typeof t === 'string' && vcType.includes(t)),
  );
}
