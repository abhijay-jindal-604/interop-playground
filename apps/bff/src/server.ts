/**
 * BFF core server (plan/12 T-07; 02 §6.3, 04 §1, §6, ADR-33): one Fastify instance on 3100 that
 * serves `/api/v1/*`, the built UI and (later) the stream, proxy and return routes.
 *
 *   createServer(opts)  -> a configured, not yet listening instance (tests use `inject`)
 *   startServer()       -> validates content, opens the store, listens (process entry)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import { loadConfig } from './config/index.js';
import type { BffConfig } from './config/index.js';
import { registerErrorHandling } from './errors/index.js';
import { registerGuard } from './guard/index.js';
import { registerFlows } from './routes/flows.js';
import { registerHealth } from './routes/health.js';
import type { SidecarProbe } from './routes/health.js';
import { registerStatic } from './routes/static.js';
import { validateContent } from './validate/index.js';
import type { ContentFiles } from './validate/index.js';

/** 04 §1 "Content": max request body 1 MiB (API-37's 64 MiB arrives with T-50). */
export const BODY_LIMIT = 1024 * 1024;

export interface CreateServerOptions {
  config?: Partial<BffConfig>;
  /** the run store (session A's `openStore(path)`); kept opaque until the run routes use it */
  store?: unknown;
  /** already validated content; default: validate `config.flowsDir` / `config.fingerprintsDir` */
  content?: ContentFiles;
  probeSidecar?: SidecarProbe;
  /** Fastify logger; default off (tests), `startServer` turns it on */
  logger?: boolean | { level: string };
}

function bffVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function defaultSidecarProbe(baseUrl: string): SidecarProbe {
  return async () => {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { reachable: false, version: null };
    const body = (await res.json().catch(() => ({}))) as { version?: unknown };
    return { reachable: true, version: typeof body.version === 'string' ? body.version : null };
  };
}

export async function createServer(opts: CreateServerOptions = {}): Promise<FastifyInstance> {
  const config: BffConfig = { ...loadConfig(), ...opts.config };
  const content = opts.content ?? validateContent(config.flowsDir, config.fingerprintsDir);
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: BODY_LIMIT,
    genReqId: () => ulid(),
    requestIdHeader: false,
  });
  app.decorate('playgroundStore', opts.store ?? null);
  app.addHook('onRequest', async (request, reply) => {
    void reply.header('X-Request-Id', request.id);
  });
  registerErrorHandling(app);
  registerGuard(app);
  registerHealth(app, {
    version: bffVersion(),
    startedAt: Date.now(),
    probeSidecar: opts.probeSidecar ?? defaultSidecarProbe(config.sidecarUrl),
  });
  registerFlows(app, content.flows);
  await registerStatic(app, config.uiDistDir);
  return app;
}

/** Opens session A's store when its module exists (wave 2 runs both in parallel). */
async function openStoreIfPresent(dataDir: string): Promise<unknown> {
  const specifier = './store/index.js';
  try {
    const mod = (await import(specifier)) as { openStore?: (p: string) => unknown };
    if (typeof mod.openStore !== 'function') return null;
    return await mod.openStore(path.join(dataDir, 'playground.db'));
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') return null;
    throw e;
  }
}

export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<FastifyInstance> {
  const config = loadConfig(env);
  const store = await openStoreIfPresent(config.dataDir);
  const app = await createServer({ config, store, logger: { level: config.logLevel } });
  await app.listen({ host: config.listenHost, port: config.port });
  return app;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startServer().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
