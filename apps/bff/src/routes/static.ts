/**
 * Static SPA serving (plan/12 T-07): `apps/ui/dist` on the 3100 listener. Files are served as they
 * exist; any other GET outside /api/, /proxy/, /return/ falls back to index.html so client-side
 * routes (UI-50) deep-link. Without a built UI every such GET is a 404 envelope.
 */
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { uiDistPresent } from '../config/index.js';
import { ApiError, sendError } from '../errors/index.js';

const NON_SPA_PREFIXES = ['/api/', '/proxy/', '/return/'];

export async function registerStatic(app: FastifyInstance, uiDistDir: string): Promise<void> {
  const present = uiDistPresent(uiDistDir);
  if (present) {
    await app.register(fastifyStatic, {
      root: uiDistDir,
      prefix: '/',
      wildcard: true,
      index: ['index.html'],
      cacheControl: true,
      maxAge: 0,
    });
  }
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? '/';
    const spaRoute =
      present &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      !NON_SPA_PREFIXES.some((p) => path.startsWith(p)) &&
      !/\.[a-z0-9]{1,8}$/i.test(path);
    if (spaRoute) return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    return sendError(reply, new ApiError('not_found', undefined, { resource: 'route', id: path }));
  });
}
