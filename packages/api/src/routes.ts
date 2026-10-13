/**
 * The route table of plan/04-api-contracts.md §2 as data. Paths are the OpenAPI path keys of
 * `openapi.yaml` (BFF routes carry their `/api/v1` prefix; API-35 and API-55 have none; API-53/54
 * are served by the 8443 gateway listener; API-60..69 by the sidecar). API-70..74 are contracts,
 * not routes (04 §2.8).
 */
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export type RouteServer = 'bff' | 'gateway' | 'sidecar';

export interface RouteDef {
  apiId: `API-${string}`;
  method: HttpMethod;
  path: string;
  server: RouteServer;
}

export const ROUTES: readonly RouteDef[] = [
  // 2.1 Catalog and selector
  { apiId: 'API-01', method: 'GET', path: '/api/v1/health', server: 'bff' },
  { apiId: 'API-02', method: 'GET', path: '/api/v1/adapters', server: 'bff' },
  { apiId: 'API-03', method: 'POST', path: '/api/v1/runs/preview', server: 'bff' },
  { apiId: 'API-04', method: 'GET', path: '/api/v1/knobs', server: 'bff' },
  { apiId: 'API-05', method: 'GET', path: '/api/v1/flows', server: 'bff' },
  { apiId: 'API-06', method: 'GET', path: '/api/v1/flows/{flowId}', server: 'bff' },
  { apiId: 'API-07', method: 'GET', path: '/api/v1/presets', server: 'bff' },
  { apiId: 'API-08', method: 'GET', path: '/api/v1/configurations', server: 'bff' },
  { apiId: 'API-09', method: 'GET', path: '/api/v1/incompatibilities', server: 'bff' },
  // 2.2 Environment and streams
  { apiId: 'API-10', method: 'GET', path: '/api/v1/env', server: 'bff' },
  { apiId: 'API-11', method: 'POST', path: '/api/v1/env/probe', server: 'bff' },
  { apiId: 'API-12', method: 'POST', path: '/api/v1/internal/tunnel', server: 'bff' },
  { apiId: 'API-15', method: 'GET', path: '/api/v1/streams/{streamId}/events', server: 'bff' },
  // 2.3 Runs
  { apiId: 'API-20', method: 'POST', path: '/api/v1/runs', server: 'bff' },
  { apiId: 'API-21', method: 'GET', path: '/api/v1/runs', server: 'bff' },
  { apiId: 'API-22', method: 'GET', path: '/api/v1/runs/{runId}', server: 'bff' },
  { apiId: 'API-23', method: 'POST', path: '/api/v1/runs/{runId}/cancel', server: 'bff' },
  { apiId: 'API-24', method: 'POST', path: '/api/v1/runs/{runId}/derive', server: 'bff' },
  { apiId: 'API-25', method: 'DELETE', path: '/api/v1/runs/{runId}', server: 'bff' },
  { apiId: 'API-26', method: 'GET', path: '/api/v1/runs/{runId}/steps', server: 'bff' },
  {
    apiId: 'API-27',
    method: 'GET',
    path: '/api/v1/runs/{runId}/exchanges/{exchangeId}',
    server: 'bff',
  },
  {
    apiId: 'API-28',
    method: 'GET',
    path: '/api/v1/runs/{runId}/artifacts/{artifactId}',
    server: 'bff',
  },
  { apiId: 'API-29', method: 'POST', path: '/api/v1/runs/{runId}/observations', server: 'bff' },
  { apiId: 'API-30', method: 'GET', path: '/api/v1/runs/{runId}/diagnosis', server: 'bff' },
  {
    apiId: 'API-31',
    method: 'GET',
    path: '/api/v1/runs/{runId}/compare/{otherRunId}',
    server: 'bff',
  },
  { apiId: 'API-32', method: 'GET', path: '/api/v1/runs/{runId}/export', server: 'bff' },
  { apiId: 'API-33', method: 'GET', path: '/api/v1/runs/{runId}/lineage', server: 'bff' },
  { apiId: 'API-34', method: 'POST', path: '/api/v1/return/vp', server: 'bff' },
  { apiId: 'API-35', method: 'GET', path: '/return/vp', server: 'bff' },
  { apiId: 'API-36', method: 'PATCH', path: '/api/v1/runs/{runId}', server: 'bff' },
  { apiId: 'API-37', method: 'POST', path: '/api/v1/runs/import', server: 'bff' },
  { apiId: 'API-80', method: 'GET', path: '/api/v1/versions', server: 'bff' },
  // 2.4 Suites, matrix, reports, stats, issue drafts
  { apiId: 'API-40', method: 'POST', path: '/api/v1/suites', server: 'bff' },
  { apiId: 'API-41', method: 'GET', path: '/api/v1/suites', server: 'bff' },
  { apiId: 'API-42', method: 'GET', path: '/api/v1/suites/{suiteId}', server: 'bff' },
  { apiId: 'API-43', method: 'POST', path: '/api/v1/suites/{suiteId}/cancel', server: 'bff' },
  { apiId: 'API-44', method: 'GET', path: '/api/v1/matrix', server: 'bff' },
  { apiId: 'API-38', method: 'DELETE', path: '/api/v1/suites/{suiteId}', server: 'bff' },
  { apiId: 'API-39', method: 'POST', path: '/api/v1/matrix/snapshots', server: 'bff' },
  { apiId: 'API-56', method: 'GET', path: '/api/v1/matrix/snapshots', server: 'bff' },
  {
    apiId: 'API-57',
    method: 'GET',
    path: '/api/v1/matrix/snapshots/{snapshotId}',
    server: 'bff',
  },
  { apiId: 'API-59', method: 'GET', path: '/api/v1/suites/{suiteId}/export', server: 'bff' },
  { apiId: 'API-45', method: 'GET', path: '/api/v1/reports/runs/{runId}', server: 'bff' },
  { apiId: 'API-46', method: 'GET', path: '/api/v1/reports/suites/{suiteId}', server: 'bff' },
  { apiId: 'API-47', method: 'GET', path: '/api/v1/stats', server: 'bff' },
  { apiId: 'API-48', method: 'GET', path: '/api/v1/issue-drafts', server: 'bff' },
  { apiId: 'API-49', method: 'PATCH', path: '/api/v1/issue-drafts/{draftId}', server: 'bff' },
  // 2.5 Tamper
  { apiId: 'API-50', method: 'GET', path: '/api/v1/tamper/cases', server: 'bff' },
  { apiId: 'API-51', method: 'GET', path: '/api/v1/tamper/cases/{tmpId}', server: 'bff' },
  { apiId: 'API-52', method: 'GET', path: '/api/v1/tamper/baselines', server: 'bff' },
  { apiId: 'API-58', method: 'POST', path: '/api/v1/tamper/baselines/confirm', server: 'bff' },
  { apiId: 'API-53', method: 'GET', path: '/tamper/request/{runId}', server: 'gateway' },
  { apiId: 'API-54', method: 'POST', path: '/tamper/request/{runId}', server: 'gateway' },
  // 2.6 SDK pass-through
  { apiId: 'API-55', method: 'GET', path: '/proxy/verify/{runId}/{path}', server: 'bff' },
  { apiId: 'API-55', method: 'POST', path: '/proxy/verify/{runId}/{path}', server: 'bff' },
  // 2.7 Sidecar (BFF → http://sidecar:7070, internal)
  { apiId: 'API-60', method: 'GET', path: '/health', server: 'sidecar' },
  { apiId: 'API-61', method: 'POST', path: '/vci/sessions', server: 'sidecar' },
  { apiId: 'API-62', method: 'GET', path: '/vci/sessions/{id}/pending', server: 'sidecar' },
  { apiId: 'API-63', method: 'POST', path: '/vci/sessions/{id}/answers/{cbId}', server: 'sidecar' },
  { apiId: 'API-64', method: 'GET', path: '/vci/sessions/{id}/result', server: 'sidecar' },
  { apiId: 'API-65', method: 'DELETE', path: '/vci/sessions/{id}', server: 'sidecar' },
  { apiId: 'API-66', method: 'POST', path: '/vp/authenticate', server: 'sidecar' },
  { apiId: 'API-67', method: 'POST', path: '/vp/unsigned-token', server: 'sidecar' },
  { apiId: 'API-68', method: 'POST', path: '/vp/response', server: 'sidecar' },
  { apiId: 'API-69', method: 'POST', path: '/vc/verify', server: 'sidecar' },
];

/** 04 §2.8: conventions and file contracts that have an API id but no route. */
export const NON_ROUTE_CONTRACTS = [
  { apiId: 'API-70', kind: 'header contract', subject: 'X-Playground-Self gateway bypass' },
  { apiId: 'API-71', kind: 'response contract', subject: 'gateway deny response' },
  { apiId: 'API-72', kind: 'file contract', subject: 'flows/<flowId>.json flow definitions' },
  { apiId: 'API-73', kind: 'client contract', subject: 'CapturingHttp poll coalescing' },
  { apiId: 'API-74', kind: 'wire contract', subject: 'event envelope, SSE framing' },
] as const;
