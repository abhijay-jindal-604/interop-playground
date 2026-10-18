/**
 * BFF request guard (02 §6.3, 04 §1 "Guard" and "Content"): CSRF and DNS-rebinding defence for the
 * local single-user tool. Runs as the first hook on every request to the 3100 listener.
 *  1. `Host` must be one of ALLOWED_HOSTS (every method, every path; SSE and /return/vp included);
 *  2. every non-GET/HEAD request must carry `Origin` equal to the UI origin of that Host;
 *  3. every non-GET/HEAD request must send `Content-Type: application/json` (415 otherwise), except
 *     API-37 (`application/gzip`) and the SDK pass-through, which forwards bodies byte for byte (ADR-34).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ALLOWED_HOSTS } from '../config/index.js';
import { ApiError, sendError } from '../errors/index.js';

const SAFE_METHODS = new Set(['GET', 'HEAD']);
/** Paths whose non-GET bodies are not JSON (04 §1 "Content"). */
const CONTENT_TYPE_EXEMPT: readonly { prefix: string; types: readonly string[] | null }[] = [
  { prefix: '/api/v1/runs/import', types: ['application/gzip'] },
  { prefix: '/proxy/verify/', types: null },
];

export interface GuardOptions {
  allowedHosts?: readonly string[];
}

export type GuardFailure = { reason: 'host' | 'origin' } | { mediaType: true; expected: string };

function mediaType(header: string | undefined): string | null {
  if (header === undefined) return null;
  const t = header.split(';')[0]?.trim().toLowerCase();
  return t === undefined || t === '' ? null : t;
}

/** Pure check, exported for unit tests. Returns null when the request passes. */
export function checkRequest(
  req: Pick<FastifyRequest, 'method' | 'url' | 'headers'>,
  allowedHosts: readonly string[] = ALLOWED_HOSTS,
): GuardFailure | null {
  const host = req.headers.host?.toLowerCase();
  if (host === undefined || !allowedHosts.includes(host)) return { reason: 'host' };
  if (SAFE_METHODS.has(req.method)) return null;
  const origin = req.headers.origin;
  if (origin === undefined || origin !== `http://${host}`) return { reason: 'origin' };
  const path = req.url.split('?')[0] ?? '';
  const type = mediaType(req.headers['content-type']);
  const exempt = CONTENT_TYPE_EXEMPT.find((e) => path.startsWith(e.prefix));
  if (exempt !== undefined) {
    if (exempt.types === null) return null;
    if (type !== null && exempt.types.includes(type)) return null;
    return { mediaType: true, expected: exempt.types.join(' | ') };
  }
  if (type !== 'application/json') return { mediaType: true, expected: 'application/json' };
  return null;
}

export function registerGuard(app: FastifyInstance, opts: GuardOptions = {}): void {
  const allowed = opts.allowedHosts ?? ALLOWED_HOSTS;
  app.addHook('onRequest', async (request, reply) => {
    const failure = checkRequest(request, allowed);
    if (failure === null) return;
    if ('reason' in failure) {
      return sendError(
        reply,
        new ApiError('request_guard_failed', undefined, { reason: failure.reason }),
      );
    }
    return sendError(
      reply,
      new ApiError('unsupported_media_type', undefined, { expected: failure.expected }),
    );
  });
}
