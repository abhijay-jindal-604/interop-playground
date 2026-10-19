/**
 * Run routes (plan/12 T-20; 04 §2.1 API-03, §2.3 API-20..23, API-26): preview, create, list, get,
 * steps, cancel. Resolution and scheduling live in the orchestrator; DTOs in runs/.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ApiError, issueDetails } from '../errors/index.js';
import type { Orchestrator } from '../orchestrator/index.js';
import { getRun, getRunRow, isTerminal, apiState, listRuns, listSteps } from '../runs/index.js';
import type { Store } from '../store/index.js';
import { canonicalJson } from '../store/bodies.js';

export const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;

export interface RunRouteOptions {
  store: Store;
  orchestrator: Orchestrator;
  now?: () => number;
}

export function registerRuns(app: FastifyInstance, opts: RunRouteOptions): void {
  const { store, orchestrator } = opts;
  const now = opts.now ?? Date.now;
  const idem = new Map<string, { hash: string; runId: string; at: number }>();

  app.post('/api/v1/runs/preview', (request, reply) =>
    reply.send(orchestrator.preview(request.body)),
  );

  app.post('/api/v1/runs', (request, reply) => {
    const keyHeader = request.headers['idempotency-key'];
    const key = typeof keyHeader === 'string' ? keyHeader : undefined;
    if (key !== undefined && (key.length < 1 || key.length > 64))
      throw new ApiError(
        'validation_failed',
        undefined,
        issueDetails([{ path: '$.headers.Idempotency-Key', message: '1 to 64 characters' }]),
      );
    const hash = createHash('sha256')
      .update(canonicalJson(request.body ?? null))
      .digest('hex');
    if (key !== undefined) {
      for (const [k, v] of idem) if (now() - v.at > IDEMPOTENCY_WINDOW_MS) idem.delete(k);
      const prior = idem.get(key);
      if (prior) {
        if (prior.hash !== hash)
          throw new ApiError(
            'idempotency_conflict',
            'This Idempotency-Key was used with another body.',
          );
        return reply.code(200).header('Idempotent-Replay', 'true').send(getRun(store, prior.runId));
      }
    }
    const runId = orchestrator.create(request.body);
    if (key !== undefined) idem.set(key, { hash, runId, at: now() });
    return reply.code(201).send(getRun(store, runId));
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/api/v1/runs', (request, reply) =>
    reply.send(listRuns(store, request.query)),
  );

  app.get<{ Params: { runId: string } }>('/api/v1/runs/:runId', (request, reply) => {
    const run = getRun(store, request.params.runId);
    if (isTerminal(run.state))
      void reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    else void reply.header('Cache-Control', 'no-cache');
    return reply.send(run);
  });

  app.get<{ Params: { runId: string } }>('/api/v1/runs/:runId/steps', (request, reply) =>
    reply.send({ steps: listSteps(store, orchestrator.flows, request.params.runId) }),
  );

  app.post<{ Params: { runId: string } }>('/api/v1/runs/:runId/cancel', async (request, reply) => {
    const { runId } = request.params;
    const state = apiState(getRunRow(store, runId).state);
    if (state === 'completed' || state === 'failed')
      throw new ApiError('run_not_cancellable', `The run is already ${state}.`, { state });
    if (state !== 'cancelled') await orchestrator.cancel(runId);
    return reply.send(getRun(store, runId));
  });
}
