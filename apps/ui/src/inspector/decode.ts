/**
 * Browser-side decoders for the inspector (06 UI-20 Pretty/Decoded modes, UI-21). Hand-written
 * base64url + JSON (plan/10 §2 lists no JOSE library for the UI): JWT header/payload, SD-JWT issuer
 * JWT + disclosures + KB-JWT, form-encoded bodies. Signatures are never checked here (UI-21 copy).
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Decodes base64url text to bytes; null if the text is not valid base64url. */
export function base64urlToBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(s)) return null;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  try {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Decodes base64url text to a UTF-8 string; null if it is not valid. */
export function base64urlToText(s: string): string | null {
  const bytes = base64urlToBytes(s);
  if (!bytes) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Parses JSON text; undefined when it is not JSON. */
export function parseJson(text: string): Json | undefined {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}

const b64urlJson = (s: string): Json | undefined => {
  const t = base64urlToText(s);
  return t === null ? undefined : parseJson(t);
};

const isObject = (v: Json | undefined): v is { [k: string]: Json } =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export interface DecodedJwt {
  header: { [k: string]: Json };
  payload: Json;
  signature: string;
}

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*$/;

/** a compact JWS whose header decodes to a JSON object with `alg` */
export function decodeJwt(token: string): DecodedJwt | null {
  const t = token.trim();
  if (!JWT_RE.test(t)) return null;
  const [h = '', p = '', sig = ''] = t.split('.');
  const header = b64urlJson(h);
  if (!isObject(header) || typeof header.alg !== 'string') return null;
  const payload = b64urlJson(p);
  return {
    header,
    payload: payload === undefined ? (base64urlToText(p) ?? p) : payload,
    signature: sig,
  };
}

export interface Disclosure {
  raw: string;
  salt: string;
  /** null for an array-element disclosure `[salt, value]` */
  name: string | null;
  value: Json;
}

export interface DecodedSdJwt {
  issuerJwt: DecodedJwt;
  disclosures: Disclosure[];
  kbJwt: DecodedJwt | null;
}

/** `<issuer-jwt>~<disclosure>~…~[<kb-jwt>]` (SD-JWT VC, RFC 9901 §4) */
export function decodeSdJwt(token: string): DecodedSdJwt | null {
  const t = token.trim();
  if (!t.includes('~')) return null;
  const parts = t.split('~');
  const issuerJwt = decodeJwt(parts[0] ?? '');
  if (!issuerJwt) return null;
  const last = parts.at(-1) ?? '';
  const kbJwt = last === '' ? null : decodeJwt(last);
  const middle = parts.slice(1, kbJwt ? -1 : parts.length);
  const disclosures: Disclosure[] = [];
  for (const raw of middle) {
    if (raw === '') continue;
    const arr = b64urlJson(raw);
    if (!Array.isArray(arr) || arr.length < 2 || typeof arr[0] !== 'string') return null;
    disclosures.push(
      arr.length >= 3
        ? {
            raw,
            salt: arr[0],
            name: typeof arr[1] === 'string' ? arr[1] : JSON.stringify(arr[1]),
            value: arr[2] ?? null,
          }
        : { raw, salt: arr[0], name: null, value: arr[1] ?? null },
    );
  }
  return { issuerJwt, disclosures, kbJwt };
}

/** Parses `a=b&c=d` form text into pairs; null when the text does not look like a form body. */
export function parseForm(text: string): [string, string][] | null {
  if (!/^[^=&\s]+=[^\s]*$/.test(text.trim())) return null;
  try {
    return [...new URLSearchParams(text.trim()).entries()];
  } catch {
    return null;
  }
}

export type BodyKind = 'json' | 'form' | 'jwt' | 'sd-jwt' | 'text';

/** Classifies a body so the viewer picks the right display: SD-JWT, JWT, JSON, form, or plain text. */
export function bodyKind(text: string): BodyKind {
  const t = text.trim();
  if (decodeSdJwt(t)) return 'sd-jwt';
  if (decodeJwt(t)) return 'jwt';
  if ((t.startsWith('{') || t.startsWith('[')) && parseJson(t) !== undefined) return 'json';
  if (parseForm(t)) return 'form';
  return 'text';
}

/** One decodable item found in a body (UI-21 ArtifactCard). */
export interface DecodedItem {
  /** JSON path of the value inside the body, like `credentials[0].credential`, or '' for the body */
  path: string;
  /** the field name the value sat under (drives the card title) */
  field: string | null;
  kind: 'jwt' | 'sd-jwt';
  jwt: DecodedJwt;
  sdJwt: DecodedSdJwt | null;
}

function classify(value: string, path: string, field: string | null): DecodedItem | null {
  const sd = decodeSdJwt(value);
  if (sd) return { path, field, kind: 'sd-jwt', jwt: sd.issuerJwt, sdJwt: sd };
  const jwt = decodeJwt(value);
  if (jwt) return { path, field, kind: 'jwt', jwt, sdJwt: null };
  return null;
}

function walk(v: Json, path: string, field: string | null, out: DecodedItem[]): void {
  if (typeof v === 'string') {
    const item = classify(v, path, field);
    if (item) {
      out.push(item);
      return;
    }
    const t = v.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      const inner = parseJson(t);
      if (inner !== undefined && typeof inner === 'object') walk(inner, path, field, out);
    }
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => walk(x, `${path}[${i}]`, field, out));
    return;
  }
  if (isObject(v)) {
    for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, k, out);
  }
}

/** every JWT / SD-JWT inside a body: the body itself, JSON values, form fields (and JSON in them) */
export function findDecodable(text: string): DecodedItem[] {
  const t = text.trim();
  const out: DecodedItem[] = [];
  const direct = classify(t, '', null);
  if (direct) return [direct];
  const json = t.startsWith('{') || t.startsWith('[') ? parseJson(t) : undefined;
  if (json !== undefined) {
    walk(json, '', null, out);
    return out;
  }
  const form = parseForm(t);
  if (form) for (const [k, v] of form) walk(v, k, k, out);
  return out;
}

export const REDACTION_RE = /«redacted:([^»]+)»/g;

/** split a string into text and `«redacted:NAME»` pieces (UI-19 redaction chips) */
export function splitRedactions(s: string): ({ text: string } | { redacted: string })[] {
  const out: ({ text: string } | { redacted: string })[] = [];
  let at = 0;
  for (const m of s.matchAll(REDACTION_RE)) {
    const i = m.index;
    if (i > at) out.push({ text: s.slice(at, i) });
    out.push({ redacted: m[1] ?? '' });
    at = i + m[0].length;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out;
}

/** Pretty-prints a value as indented JSON. */
export function pretty(v: unknown): string {
  return JSON.stringify(v, null, 2);
}
