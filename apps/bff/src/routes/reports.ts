/**
 * Report routes (plan/12 T-32; 04 §2.4 API-45): `GET /api/v1/reports/runs/:runId?format=json|markdown`.
 * Errors: `not_found` (unknown run), `run_not_terminal` (409 before the terminal event),
 * `validation_failed` (unknown query parameter or format).
 */
import type { FastifyInstance } from 'fastify';
import { ApiError, issueDetails } from '../errors/index.js';
import type { FlowTable } from '../orchestrator/index.js';
import { buildRunReport, renderRunReportMarkdown } from '../report/index.js';
import type { Store } from '../store/index.js';

export interface ReportRouteOptions {
  store: Store;
  flows: FlowTable;
  now?: () => Date;
}

export function registerReports(app: FastifyInstance, opts: ReportRouteOptions): void {
  app.get<{ Params: { runId: string }; Querystring: Record<string, string | undefined> }>(
    '/api/v1/reports/runs/:runId',
    (request, reply) => {
      for (const k of Object.keys(request.query))
        if (k !== 'format')
          throw new ApiError(
            'validation_failed',
            undefined,
            issueDetails([{ path: `$.query.${k}`, message: 'unknown parameter' }]),
          );
      const format = request.query.format ?? 'json';
      if (format !== 'json' && format !== 'markdown')
        throw new ApiError(
          'validation_failed',
          undefined,
          issueDetails([{ path: '$.query.format', message: 'json or markdown' }]),
        );
      const report = buildRunReport(opts.store, opts.flows, request.params.runId, opts.now);
      void reply.header('Cache-Control', 'no-cache');
      if (format === 'markdown')
        return reply
          .type('text/markdown; charset=utf-8')
          .header('Content-Disposition', `inline; filename="run-${request.params.runId}.md"`)
          .send(renderRunReportMarkdown(report));
      return reply.send(report);
    },
  );
}
