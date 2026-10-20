/**
 * API-31 compare (04 §2.3, 06 OI-4): `GET /api/v1/runs/:runId/compare/:otherRunId?includeVolatile=`.
 * Parent first; the BFF swaps a child-first pair (runs/compare.ts).
 */
import type { FastifyInstance } from 'fastify';
import type { FlowTable } from '../orchestrator/index.js';
import { compareRuns } from '../runs/compare.js';
import type { Store } from '../store/index.js';

export interface CompareRouteOptions {
  store: Store;
  flows: FlowTable;
}

/** Registers `GET /api/v1/runs/:runId/compare/:otherRunId`: a step-by-step diff of two runs. */
export function registerCompare(app: FastifyInstance, opts: CompareRouteOptions): void {
  app.get<{
    Params: { runId: string; otherRunId: string };
    Querystring: Record<string, string | undefined>;
  }>('/api/v1/runs/:runId/compare/:otherRunId', (request, reply) => {
    void reply.header('Cache-Control', 'no-cache');
    return reply.send(
      compareRuns(
        opts.store,
        opts.flows,
        request.params.runId,
        request.params.otherRunId,
        request.query,
      ),
    );
  });
}
