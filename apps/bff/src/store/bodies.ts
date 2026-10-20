/**
 * Body and blob helpers (05 §4.3, ADR-36/37): redaction of the bytes, the 256 KiB cap, content-addressed
 * gzip blobs, canonical JSON. Pure functions; the only writer of `blobs` is sink.ts.
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import type { BodyRef } from '@interop-playground/api';
import type { SecretRegistry } from '../redact/registry.js';
import { isTextual, LIMITS } from './limits.js';
import { sha256Hex } from './migrate.js';

/** what a capture point hands the sink: the raw body as sent / received */
export interface RawBody {
  bytes: Uint8Array | string;
  contentType?: string | null;
}

/** the body reference stored in `run_events.payload_json` in place of the body (05 §4.3) */
export interface StoredBodyRef {
  $blob: string;
  /** original (redacted) byte length */
  size: number;
  truncated: boolean;
  enc: 'utf8' | 'base64';
}

export interface PreparedBody {
  ref: StoredBodyRef;
  /** the stored (possibly truncated) redacted bytes */
  stored: Buffer;
  /** SHA-256 of the full redacted body */
  fullSha256: string;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
function isUtf8(b: Uint8Array): boolean {
  try {
    utf8.decode(b);
    return true;
  } catch {
    return false;
  }
}

/** redact first, then hash, then cap (05 §6 order) */
/**
 * Turns a raw captured body into its stored form: secrets redacted first, then the 256 KiB cap
 * applied, with the SHA-256 and size of the full redacted body kept. Order matters: hashing and
 * truncating happen after redaction so no secret ever reaches a blob.
 */
export function prepareBody(raw: RawBody, registry: SecretRegistry): PreparedBody {
  const ct = raw.contentType ?? null;
  let full: Buffer;
  let enc: 'utf8' | 'base64';
  if (typeof raw.bytes === 'string') {
    full = Buffer.from(registry.redactString(raw.bytes), 'utf8');
    enc = ct === null || isTextual(ct) ? 'utf8' : 'base64';
  } else {
    const bytes = Buffer.from(raw.bytes.buffer, raw.bytes.byteOffset, raw.bytes.byteLength);
    const text = (ct === null || isTextual(ct)) && isUtf8(bytes);
    enc = text ? 'utf8' : 'base64';
    full = text
      ? Buffer.from(registry.redactString(bytes.toString('utf8')), 'utf8')
      : registry.redactBytes(bytes);
  }
  const fullSha256 = sha256Hex(full);
  const truncated = full.length > LIMITS.bodyBytes;
  let stored = truncated ? full.subarray(0, LIMITS.bodyBytes) : full;
  if (truncated && enc === 'utf8') stored = trimPartialUtf8(stored);
  return {
    ref: { $blob: sha256Hex(stored), size: full.length, truncated, enc },
    stored: Buffer.from(stored),
    fullSha256,
  };
}

/** drop a UTF-8 sequence split by the cut so the stored text stays decodable */
function trimPartialUtf8(b: Buffer): Buffer {
  let end = b.length;
  let i = end - 1;
  let back = 0;
  while (i >= 0 && back < 4 && (b[i]! & 0xc0) === 0x80) {
    i--;
    back++;
  }
  if (i >= 0) {
    const lead = b[i]!;
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (need > back + 1) end = i;
  }
  return b.subarray(0, end);
}

export interface BlobRecord {
  sha256: string;
  rawSize: number;
  enc: 'identity' | 'gzip';
  data: Buffer;
}

/**
 * Content-addresses a stored body; gzips it when large enough to benefit.
 * Gzip level 6 for ≥ 1 KiB, identity below (05 §4.3)
 */
export function encodeBlob(stored: Buffer): BlobRecord {
  const gz = stored.length >= LIMITS.gzipFromBytes;
  return {
    sha256: sha256Hex(stored),
    rawSize: stored.length,
    enc: gz ? 'gzip' : 'identity',
    data: gz ? gzipSync(stored, { level: 6 }) : stored,
  };
}

/** Inverse of `encodeBlob`: returns the stored bytes whether or not they were gzipped. */
export function decodeBlob(enc: string, data: Uint8Array): Buffer {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return enc === 'gzip' ? gunzipSync(b) : b;
}

/** wire form of a stored body (04 §7.3): inline at most 64 KiB, `truncated` when cut or stored truncated */
export function toBodyRef(
  ref: StoredBodyRef,
  stored: Buffer,
  fullSha256: string,
  inlineLimit: number = LIMITS.wireInlineBytes,
): BodyRef {
  const cutHere = stored.length > inlineLimit;
  let slice = cutHere ? stored.subarray(0, inlineLimit) : stored;
  if (cutHere && ref.enc === 'utf8') slice = trimPartialUtf8(slice);
  return {
    encoding: ref.enc,
    text: ref.enc === 'utf8' ? slice.toString('utf8') : slice.toString('base64'),
    size: ref.size,
    truncated: ref.truncated || cutHere,
    sha256: fullSha256,
  };
}

/**
 * JSON with object keys sorted recursively, so equal values always serialise to the same text (stable hashes).
 * RFC 8785-style canonical JSON: object keys sorted recursively, no whitespace (05 §1)
 */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object' && !(v instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}
