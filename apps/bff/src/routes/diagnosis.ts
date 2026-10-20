/**
 * API-30 diagnosis (04 §2.3, §3.4 `DiagnosisResponse`): `GET /api/v1/runs/:runId/diagnosis`. The
 * stored `fingerprint.matched` / `counterfactual.offered` payloads (C12, ADR-80) plus `noFixReason`
 * (09 A9.3 keys, 06 OI-7). An offer whose environment no longer holds (ADR-21: a version changed,
 * the tunnel moved) stays listed, and `noFixReason` turns `version-drift` / `environment-changed`,
 * so the fix-it button is not shown (09 A5.1; ADR-85).
 */
import type { FastifyInstance } from 'fastify';
import type { DiagnosisResponse, RunSpec } from '@interop-playground/api';
import { readDiagnosis } from '../diagnosis/index.js';
import { driftOf } from '../orchestrator/index.js';
import type { ResolveEnv } from '../orchestrator/index.js';
import { getRunRow } from '../runs/index.js';
import type { Store } from '../store/index.js';

export interface DiagnosisRouteOptions {
  store: Store;
  env: ResolveEnv;
}

/** Builds the diagnosis response for a run: matches, plus fix-it offers only when the offer is still valid in the current environment. */
export function diagnosisOf(store: Store, env: ResolveEnv, runId: string): DiagnosisResponse {
  const row = getRunRow(store, runId);
  const d = readDiagnosis(store, runId);
  if (d.offers.length > 0 && d.noFixReason === null) {
    const drift = driftOf(JSON.parse(row.spec_json) as RunSpec, env);
    if (drift !== null)
      d.noFixReason = drift.code === 'version_drift' ? 'version-drift' : 'environment-changed';
  }
  return d;
}

/** Registers `GET /api/v1/runs/:runId/diagnosis`. */
export function registerDiagnosis(app: FastifyInstance, opts: DiagnosisRouteOptions): void {
  app.get<{ Params: { runId: string } }>('/api/v1/runs/:runId/diagnosis', (request, reply) => {
    void reply.header('Cache-Control', 'no-cache');
    return reply.send(diagnosisOf(opts.store, opts.env, request.params.runId));
  });
}
