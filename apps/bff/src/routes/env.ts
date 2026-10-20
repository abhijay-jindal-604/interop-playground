/**
 * Environment routes (04 §2.2): API-10 `GET /env`, API-11 `POST /env/probe` (1 per 5 s),
 * API-12 `POST /internal/tunnel` (loopback peer + `X-Admin-Token`, 02 §2.6).
 */
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { LOOPBACK_PEERS } from '../config/index.js';
import type { EnvManager } from '../env/index.js';
import { ApiError, issueDetails } from '../errors/index.js';

export interface EnvRouteDeps {
  env: EnvManager;
  /** reads the admin token (default: the file named by config.adminTokenFile) */
  adminToken: () => string | null;
}

/** Returns a reader for a token file that yields null when the file is missing or empty. */
export function fileToken(file: string): () => string | null {
  return () => {
    try {
      const t = readFileSync(file, 'utf8').trim();
      return t === '' ? null : t;
    } catch {
      return null;
    }
  };
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Registers the environment endpoints: current snapshot and the rate-limited upstream probe. */
export function registerEnv(app: FastifyInstance, deps: EnvRouteDeps): void {
  app.get('/api/v1/env', (_request, reply) =>
    reply.header('Cache-Control', 'no-cache').send(deps.env.snapshot()),
  );
  app.post('/api/v1/env/probe', async (request, reply) => {
    const body = request.body;
    if (
      body !== undefined &&
      body !== null &&
      (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0)
    )
      throw new ApiError(
        'validation_failed',
        undefined,
        issueDetails([{ path: '$', message: 'the body is {}' }]),
      );
    return reply.send(await deps.env.probeNow());
  });
  app.post('/api/v1/internal/tunnel', (request, reply) => {
    const peer = request.socket.remoteAddress ?? '';
    const header = request.headers['x-admin-token'];
    const expected = deps.adminToken();
    if (
      !LOOPBACK_PEERS.includes(peer) ||
      typeof header !== 'string' ||
      expected === null ||
      !sameToken(header, expected)
    )
      throw new ApiError('unauthorized');
    return reply.send(deps.env.registerTunnel(request.body));
  });
}
