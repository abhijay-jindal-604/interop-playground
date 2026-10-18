/**
 * `X-Playground-Self` (API-70, ADR-27, 04 §8.1): a per-process 32-byte random token that
 * `CapturingHttp` adds to calls into the BFF's own gateway listeners. The gateway compares it in
 * constant time and ALWAYS strips the header before forwarding upstream, so an outsider cannot
 * suppress capture by sending it. Never logged, never persisted.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SELF_HEADER = 'x-playground-self';

export function generateSelfToken(): string {
  return randomBytes(32).toString('base64url');
}

/** constant-time comparison (both sides hashed to 32 bytes, so length leaks nothing either) */
export function isSelfCall(
  headerValue: string | string[] | null | undefined,
  token: string,
): boolean {
  if (typeof headerValue !== 'string' || !token) return false;
  const a = createHash('sha256').update(headerValue).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}

/** removes every `X-Playground-Self` header (any case) from a header list or record, match or not */
export function stripSelfHeader<T extends [string, string][] | Record<string, unknown>>(
  headers: T,
): T {
  if (Array.isArray(headers)) {
    return headers.filter(([n]) => n.toLowerCase() !== SELF_HEADER) as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() !== SELF_HEADER) out[k] = v;
  return out as T;
}
