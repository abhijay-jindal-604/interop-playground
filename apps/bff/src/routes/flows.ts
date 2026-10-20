/** API-05 `GET /api/v1/flows`, API-06 `GET /api/v1/flows/{flowId}` (04 §2.1) from the validated files. */
import type { FastifyInstance } from 'fastify';
import type {
  AdapterId,
  CredentialFormat,
  FlowDefinition,
  FlowIndexEntry,
  FlowIndexResponse,
} from '@interop-playground/api';
import { ApiError, issueDetails } from '../errors/index.js';

function indexEntry(def: FlowDefinition): FlowIndexEntry {
  const adapters = new Set<AdapterId>();
  const formats = new Set<CredentialFormat>();
  for (const s of def.steps) {
    for (const a of s.appliesTo?.adapters ?? []) adapters.add(a);
    for (const f of s.appliesTo?.formats ?? []) formats.add(f);
  }
  return {
    flowId: def.flowId,
    kind: def.kind,
    title: def.title,
    adapters: [...adapters].sort(),
    formats: [...formats].sort(),
    stepKeys: def.steps.map((s) => s.stepKey),
  };
}

/** Registers `GET /api/v1/flows`: the loaded flow definitions, optionally filtered by query. */
export function registerFlows(app: FastifyInstance, flows: Map<string, FlowDefinition>): void {
  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/api/v1/flows',
    (request, reply) => {
      const unknown = Object.keys(request.query).filter((k) => k !== 'kind');
      const kind = request.query.kind;
      if (
        unknown.length > 0 ||
        (kind !== undefined && kind !== 'issuance' && kind !== 'presentation')
      ) {
        const issue = { path: '$.query', message: 'only ?kind=issuance|presentation is accepted' };
        throw new ApiError('validation_failed', undefined, issueDetails([issue]));
      }
      const body: FlowIndexResponse = {
        flows: [...flows.values()]
          .filter((f) => kind === undefined || f.kind === kind)
          .map(indexEntry),
      };
      return reply.send(body);
    },
  );
  app.get<{ Params: { flowId: string } }>('/api/v1/flows/:flowId', (request, reply) => {
    const def = flows.get(request.params.flowId);
    if (def === undefined)
      throw new ApiError('not_found', 'No such flow definition.', {
        resource: 'flow',
        id: request.params.flowId,
      });
    return reply.send(def);
  });
}
