/**
 * Catalog routes (04 §2.1): API-02 `GET /adapters`, API-04 `GET /knobs?adapter=&format=`,
 * API-07 `GET /presets`, API-08 `GET /configurations?issuer=&format=`, API-09
 * `GET /incompatibilities`. Unknown query keys or values are `validation_failed`.
 */
import type { FastifyInstance } from 'fastify';
import { ADAPTER_IDS } from '@interop-playground/adapters';
import type { AdapterId, CredentialFormat } from '@interop-playground/api';
import {
  adapterList,
  configurationList,
  incompatibilityList,
  knobCatalog,
  presetList,
} from '../catalog/index.js';
import type { AvailabilityView } from '../catalog/index.js';
import { ApiError, issueDetails } from '../errors/index.js';

const FORMATS: readonly string[] = ['ldp_vc', 'dc+sd-jwt', 'mso_mdoc', 'jwt_vc_json'];
type Query = Record<string, string | undefined>;

function checkQuery(q: Query, allowed: Record<string, (v: string) => boolean>): void {
  const issues: { path: string; message: string }[] = [];
  for (const [k, v] of Object.entries(q)) {
    const ok = allowed[k];
    if (ok === undefined) issues.push({ path: `$.query.${k}`, message: 'unknown parameter' });
    else if (v === undefined || !ok(v))
      issues.push({ path: `$.query.${k}`, message: `invalid value ${String(v)}` });
  }
  if (issues.length > 0) throw new ApiError('validation_failed', undefined, issueDetails(issues));
}

const isAdapter =
  (role?: string) =>
  (v: string): boolean =>
    (ADAPTER_IDS as readonly string[]).includes(v) &&
    (role === undefined || v.startsWith(`${role}.`));
const isFormat = (v: string): boolean => FORMATS.includes(v);

/** Registers the read-only catalogue endpoints: adapters, knobs, presets, configurations, incompatibilities. */
export function registerCatalog(
  app: FastifyInstance,
  deps: { availability: AvailabilityView },
): void {
  app.get<{ Querystring: Query }>('/api/v1/adapters', (request, reply) => {
    checkQuery(request.query, {});
    return reply.header('Cache-Control', 'no-cache').send(adapterList(deps.availability));
  });
  app.get<{ Querystring: Query }>('/api/v1/knobs', (request, reply) => {
    const q = request.query;
    checkQuery(q, { adapter: isAdapter(), format: isFormat });
    return reply.send(
      knobCatalog({
        ...(q.adapter ? { adapter: q.adapter as AdapterId } : {}),
        ...(q.format ? { format: q.format as CredentialFormat } : {}),
      }),
    );
  });
  app.get<{ Querystring: Query }>('/api/v1/presets', (request, reply) => {
    checkQuery(request.query, {});
    return reply.send(presetList());
  });
  app.get<{ Querystring: Query }>('/api/v1/configurations', (request, reply) => {
    const q = request.query;
    checkQuery(q, { issuer: isAdapter('issuer'), format: isFormat });
    return reply.send(
      configurationList({
        ...(q.issuer ? { issuer: q.issuer as AdapterId } : {}),
        ...(q.format ? { format: q.format as CredentialFormat } : {}),
      }),
    );
  });
  app.get<{ Querystring: Query }>('/api/v1/incompatibilities', (request, reply) => {
    checkQuery(request.query, {});
    return reply.send(incompatibilityList());
  });
}
