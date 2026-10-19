/**
 * API-24 derive (plan/12 T-42; 04 §2.3, §5.4, ADR-21): `POST /api/v1/runs/:runId/derive` with a
 * `DeriveRequest` → the queued child `Run` (201). Checks and the child spec live in
 * orchestrator/derive.ts; an `Idempotency-Key` replays the same child (06 UI-25: one key per panel).
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ApiError, issueDetails } from '../errors/index.js';
import type { Orchestrator } from '../orchestrator/index.js';
import { getRun } from '../runs/index.js';
import type { Store } from '../store/index.js';
import { canonicalJson } from '../store/bodies.js';
import { IDEMPOTENCY_WINDOW_MS } from './runs.js';

export interface DeriveRouteOptions {
  store: Store;
  orchestrator: Orchestrator;
  now?: () => number;
}

export function registerDerive(app: FastifyInstance, opts: DeriveRouteOptions): void {
  const { store, orchestrator } = opts;
  const now = opts.now ?? Date.now;
  const idem = new Map<string, { hash: string; runId: string; at: number }>();
  app.post<{ Params: { runId: string } }>('/api/v1/runs/:runId/derive', (request, reply) => {
    const keyHeader = request.headers['idempotency-key'];
    const key = typeof keyHeader === 'string' ? keyHeader : undefined;
    if (key !== undefined && (key.length < 1 || key.length > 64))
      throw new ApiError(
        'validation_failed',
        undefined,
        issueDetails([{ path: '$.headers.Idempotency-Key', message: '1 to 64 characters' }]),
      );
    const hash = createHash('sha256')
      .update(canonicalJson({ parent: request.params.runId, body: request.body ?? null }))
      .digest('hex');
    if (key !== undefined) {
      for (const [k, v] of idem) if (now() - v.at > IDEMPOTENCY_WINDOW_MS) idem.delete(k);
      const prior = idem.get(key);
      if (prior) {
        if (prior.hash !== hash)
          throw new ApiError(
            'idempotency_conflict',
            'This Idempotency-Key was used with another body.',
            { runId: prior.runId },
          );
        return reply.code(200).header('Idempotent-Replay', 'true').send(getRun(store, prior.runId));
      }
    }
    const runId = orchestrator.derive(request.params.runId, request.body);
    if (key !== undefined) idem.set(key, { hash, runId, at: now() });
    return reply.code(201).send(getRun(store, runId));
  });
}
