/**
 * SD-JWT VC handling inside `wallet.playground-ts` (03 FLOW-04, FLOW-30; SD-JWT VC draft, ported
 * from research/spikes/vp-sdjwt.mjs, S-020): decode `<issuer-jwt>~<disclosure>~…~[<kb-jwt>]`,
 * the structural lints of `vci.credential.inspect`, disclosure selection for a DCQL claim set and
 * the KB-JWT `sd_hash`. Decoding is for display and matching only; no signature is verified here.
 */
import { createHash } from 'node:crypto';
import type { CheckResult } from '../contracts.js';

export interface Disclosure {
  /** the base64url disclosure exactly as received */
  raw: string;
  salt: string;
  /** claim name (object property disclosures); null for array-element disclosures */
  name: string | null;
  value: unknown;
  /** base64url SHA-256 of `raw` (the `_sd` digest, `_sd_alg` sha-256) */
  digest: string;
}

export interface DecodedSdJwt {
  issuerJwt: string;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  disclosures: Disclosure[];
  /** the trailing KB-JWT (never present at issuance) */
  kbJwt: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function jsonOf(b64: string): unknown {
  return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as unknown;
}

export function digestOf(raw: string): string {
  return createHash('sha256').update(raw, 'ascii').digest('base64url');
}

/** throws on a malformed compact SD-JWT (the caller records it as a failed lint) */
export function decodeSdJwt(compact: string): DecodedSdJwt {
  const parts = compact.split('~');
  const issuerJwt = parts[0] ?? '';
  const segs = issuerJwt.split('.');
  if (segs.length !== 3) throw new Error('issuer JWT is not a compact JWS');
  const header = jsonOf(segs[0] ?? '');
  const payload = jsonOf(segs[1] ?? '');
  if (!isObj(header) || !isObj(payload)) throw new Error('issuer JWT header/payload not objects');
  const last = parts.at(-1) ?? '';
  const kbJwt = parts.length > 1 && last.length > 0 && last.split('.').length === 3 ? last : null;
  const discRaw = parts.slice(1, kbJwt ? -1 : undefined).filter((d) => d.length > 0);
  const disclosures = discRaw.map((raw): Disclosure => {
    const arr = jsonOf(raw);
    if (!Array.isArray(arr) || (arr.length !== 2 && arr.length !== 3))
      throw new Error('disclosure is not a 2- or 3-element array');
    const [salt, a, b] = arr as [unknown, unknown, unknown];
    return {
      raw,
      salt: String(salt),
      name: arr.length === 3 ? String(a) : null,
      value: arr.length === 3 ? b : a,
      digest: digestOf(raw),
    };
  });
  return { issuerJwt, header, payload, disclosures, kbJwt };
}

/** every `_sd` digest in the payload, recursively */
function sdDigests(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) for (const x of v) sdDigests(x, out);
  else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (k === '_sd' && Array.isArray(x))
        for (const d of x)
          if (typeof d === 'string') out.add(d);
          else sdDigests(x, out);
    }
  }
  return out;
}

/** the decoded artifact `vci.credential.inspect` emits (03 FLOW-04 artifact list) */
export interface SdJwtInspection {
  format: 'dc+sd-jwt';
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  disclosures: { name: string | null; value: unknown; digest: string }[];
  artifacts: {
    'credential-header': {
      x5cPresent: boolean;
      x5cLength: number;
      kid: string | null;
      typ: unknown;
    };
    credential: { vct: unknown; cnfKid: string | null; cnfJwkPresent: boolean; iss: unknown };
    disclosures: { count: number; names: (string | null)[] };
  };
}

export function inspectSdJwt(
  compact: string,
  stepExchangeIds: readonly string[] = [],
): { inspection: SdJwtInspection; checks: CheckResult[] } {
  const d = decodeSdJwt(compact);
  const cnf = isObj(d.payload.cnf) ? d.payload.cnf : {};
  const x5c = Array.isArray(d.header.x5c) ? d.header.x5c : [];
  const inspection: SdJwtInspection = {
    format: 'dc+sd-jwt',
    header: d.header,
    payload: d.payload,
    disclosures: d.disclosures.map((x) => ({ name: x.name, value: x.value, digest: x.digest })),
    artifacts: {
      'credential-header': {
        x5cPresent: x5c.length > 0,
        x5cLength: x5c.length,
        kid: typeof d.header.kid === 'string' ? d.header.kid : null,
        typ: d.header.typ,
      },
      credential: {
        vct: d.payload.vct,
        cnfKid: typeof cnf.kid === 'string' ? cnf.kid : null,
        cnfJwkPresent: isObj(cnf.jwk),
        iss: d.payload.iss,
      },
      disclosures: { count: d.disclosures.length, names: d.disclosures.map((x) => x.name) },
    },
  };
  const digests = sdDigests(d.payload);
  const unbound = d.disclosures.filter((x) => !digests.has(x.digest)).map((x) => x.name);
  const exchangeIds = [...stepExchangeIds];
  const checks: CheckResult[] = [
    {
      checkId: 'vc.sd-jwt.disclosure-count',
      outcome: 'info',
      source: 'playground-lint',
      message: `${d.disclosures.length} disclosure(s)${d.disclosures.length === 0 ? ' (no selectively disclosable claim, G-17)' : ''}`,
      specClause: 'SD-JWT VC "Selective Disclosure"',
      exchangeIds,
    },
    {
      checkId: 'vc.sd-jwt.disclosure-digests',
      outcome: unbound.length === 0 ? 'pass' : 'fail',
      source: 'playground-lint',
      message:
        unbound.length === 0
          ? 'every disclosure digest is listed in _sd'
          : `disclosures without an _sd digest: ${unbound.join(', ')}`,
      specClause: 'SD-JWT "Verification of the SD-JWT"',
      exchangeIds,
    },
    {
      checkId: 'vc.sd-jwt.holder-binding',
      outcome: 'info',
      source: 'playground-lint',
      message: isObj(cnf.jwk)
        ? 'cnf.jwk present'
        : typeof cnf.kid === 'string'
          ? 'cnf.kid only, no cnf.jwk (FP-02 evidence)'
          : 'no cnf claim',
      specClause: 'SD-JWT VC "Key Binding"',
      exchangeIds,
    },
  ];
  return { inspection, checks };
}

/** the value of a claim path in the credential: a disclosure, or a plain payload claim */
export function findClaim(
  d: DecodedSdJwt,
  path: readonly string[],
): { via: 'disclosure'; disclosure: Disclosure } | { via: 'payload' } | null {
  const [first, ...rest] = path;
  if (first === undefined) return null;
  // top-level selectively disclosable claims (the PlaygroundSdJwt shape, 03 FLOW-04)
  if (rest.length === 0) {
    const disc = d.disclosures.find((x) => x.name === first);
    if (disc) return { via: 'disclosure', disclosure: disc };
  }
  let cur: unknown = d.payload;
  for (const p of path) {
    if (!isObj(cur) || !(p in cur)) return null;
    cur = cur[p];
  }
  return { via: 'payload' };
}

/** `<issuer-jwt>~<d1>~…~` (the string the KB-JWT `sd_hash` covers) */
export function presentationOf(d: DecodedSdJwt, chosen: readonly Disclosure[]): string {
  return [d.issuerJwt, ...chosen.map((x) => x.raw)].join('~') + '~';
}

export function sdHashOf(presented: string): string {
  return createHash('sha256').update(presented, 'ascii').digest('base64url');
}
