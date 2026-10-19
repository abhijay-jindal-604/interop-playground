/**
 * API-01 `GET /api/v1/health` (04 §2.1): liveness of the BFF plus sidecar reachability and the
 * env manager's per-adapter availability summary (T-12, G-143). Always 200 while
 * the process serves requests (the compose healthcheck and `up.sh` probe rely on that); a missing
 * sidecar makes `status: degraded`.
 */
import type { FastifyInstance } from 'fastify';
import type { Health } from '@interop-playground/api';

export interface SidecarProbe {
  (): Promise<{ reachable: boolean; version: string | null }>;
}

export interface HealthDeps {
  version: string;
  startedAt: number;
  probeSidecar: SidecarProbe;
  /** per-adapter availability (G-143: `EnvManager.adapterSummary()`); default: none */
  adapters?: () => Health['adapters'];
}

export function registerHealth(app: FastifyInstance, deps: HealthDeps): void {
  app.get('/api/v1/health', async (_request, reply) => {
    const sidecar = await deps.probeSidecar().catch(() => ({ reachable: false, version: null }));
    const body: Health = {
      status: sidecar.reachable ? 'ok' : 'degraded',
      bff: { version: deps.version, uptimeS: Math.floor((Date.now() - deps.startedAt) / 1000) },
      sidecar,
      adapters: deps.adapters?.() ?? [],
    };
    return reply.header('Cache-Control', 'no-cache').send(body);
  });
}
