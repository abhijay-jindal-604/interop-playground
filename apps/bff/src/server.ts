/**
 * BFF core server (plan/12 T-07; 02 §6.3, 04 §1, §6, ADR-33): one Fastify instance on 3100 that
 * serves `/api/v1/*`, the built UI and (later) the stream, proxy and return routes.
 *
 *   createServer(opts)  -> a configured, not yet listening instance (tests use `inject`)
 *   startServer()       -> validates content, opens the store, listens (process entry)
 *
 * With a store (T-08/T-20): the sink is attached to the event bus, API-15 streams, the
 * orchestrator (runs left open by an earlier process are failed `bff_restarted`) and the run routes.
 * Always: the catalog routes (T-21: API-02/04/07/08/09) and the environment manager (T-12:
 * API-10..12), which is the orchestrator's `ResolveEnv`; `startServer` starts its probe loop.
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
import type { CaptureContext, CapturingHttp } from '@interop-playground/adapters';
import { EnvManager } from './env/index.js';
import { registerCatalog } from './routes/catalog.js';
import { fileToken, registerEnv } from './routes/env.js';
import { registerFlows } from './routes/flows.js';
import { registerHealth } from './routes/health.js';
import type { SidecarProbe } from './routes/health.js';
import { registerStatic } from './routes/static.js';
import { validateContent } from './validate/index.js';
import { CaptureHttp, generateSelfToken } from './capture/index.js';
import { Orchestrator } from './orchestrator/index.js';
import type { AdapterSet, CaptureHooks, KeyService, ResolveEnv } from './orchestrator/index.js';
import { registerRuns } from './routes/runs.js';
import { registerStream } from './routes/stream.js';
import { openStore } from './store/index.js';
import type { Store } from './store/index.js';
import { attachBus, defaultBus } from './stream/index.js';
import type { EventBus } from './stream/index.js';
import type { ContentFiles } from './validate/index.js';

/** 04 §1 "Content": max request body 1 MiB (API-37's 64 MiB arrives with T-50). */
export const BODY_LIMIT = 1024 * 1024;

export interface CreateServerOptions {
  config?: Partial<BffConfig>;
  /** the run store (`openStore(path)`); without one only health, flows and static files are served */
  store?: Store | null;
  /** event bus the sink publishes to (default: the process-wide `defaultBus`) */
  bus?: EventBus;
  /** adapters by id (real ones arrive with T-23..T-26; none = every create answers adapter_unavailable) */
  adapters?: AdapterSet;
  /** CapturingHttp + flush hooks (default: a CaptureHttp over the store's sink) */
  capture?: CaptureHooks;
  /** X-Playground-Self token for the default CaptureHttp (main.ts shares the gateway's; default: fresh) */
  selfToken?: string;
  /** `host:port` of the gateway listeners; the default CaptureHttp sends the token to them */
  gatewayOrigins?: Iterable<string>;
  /** environment view for resolution; default: the environment manager below (T-12) */
  resolveEnv?: ResolveEnv;
  /** a ready environment manager (tests); default: built from `config` (probe loop not started) */
  env?: EnvManager;
  /** the client the env probes go through (default: an uncaptured probe client, ADR-73) */
  envProbeHttp?: CapturingHttp;
  /** start the env probe loop (default false; `startServer` passes true) */
  startEnvProbes?: boolean;
  /** called after each transition to env ready (main.ts: the gateway's `refresh()`) */
  onEnvReady?: () => void | Promise<void>;
  /** API-12 admin token source (default: `config.adminTokenFile`) */
  adminToken?: () => string | null;
  keys?: KeyService;
  /** a ready orchestrator (tests); default: built from the options above */
  orchestrator?: Orchestrator;
  /** SSE heartbeat (default 15 s) */
  heartbeatMs?: number;
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

/** the orchestrator's view of a CaptureHttp (T-09): the client plus its flush points */
export function captureHooks(c: CaptureHttp): CaptureHooks {
  return { http: c, flushStep: (r, k) => c.flushStep(r, k), endRun: (r) => c.endRun(r) };
}

/**
 * The env probe client (ADR-73): the `CapturingHttp` contract without a run log. Probe results are
 * recorded as `env.probe` events on the `env` stream; CaptureHttp's exchanges need a run.
 */
export function envProbeHttp(
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): CapturingHttp {
  return {
    fetch: (_ctx: CaptureContext, url: string | URL, init?: RequestInit) => fetchImpl(url, init),
    closePoll: () => Promise.resolve(),
  };
}

function imageDigests(file: string): Record<string, string> {
  try {
    const lock = JSON.parse(readFileSync(file, 'utf8')) as { images?: Record<string, string> };
    return lock.images ?? {};
  } catch {
    return {};
  }
}

const NO_ADAPTERS: AdapterSet = {
  issuer: () => undefined,
  wallet: () => undefined,
  verifier: () => undefined,
};

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
  const store = opts.store ?? null;
  const env =
    opts.env ??
    new EnvManager({
      http: opts.envProbeHttp ?? envProbeHttp(),
      sink: store?.sink ?? null,
      mode: config.mode,
      publicHost: config.publicHost ?? '',
      bffVersion: bffVersion(),
      imageDigests: imageDigests(config.versionsLockFile),
      intervalMs: config.envProbeIntervalMs,
      ...(opts.onEnvReady ? { onReady: opts.onEnvReady } : {}),
    });
  app.decorate('playgroundEnv', env);
  app.addHook('onClose', () => {
    env.stop();
    return Promise.resolve();
  });
  registerCatalog(app, { availability: (id) => env.entry(id) });
  registerEnv(app, { env, adminToken: opts.adminToken ?? fileToken(config.adminTokenFile) });
  if (store !== null) {
    const bus = opts.bus ?? defaultBus;
    attachBus(store, bus);
    registerStream(app, {
      store,
      bus,
      ...(opts.heartbeatMs ? { heartbeatMs: opts.heartbeatMs } : {}),
    });
    const orchestrator =
      opts.orchestrator ??
      new Orchestrator({
        store,
        flows: content.flows,
        adapters: opts.adapters ?? NO_ADAPTERS,
        capture:
          opts.capture ??
          captureHooks(
            new CaptureHttp({
              sink: store.sink,
              selfToken: opts.selfToken ?? generateSelfToken(),
              ...(opts.gatewayOrigins ? { gatewayOrigins: opts.gatewayOrigins } : {}),
            }),
          ),
        env: opts.resolveEnv ?? env,
        keys: opts.keys ?? null,
        appVersion: bffVersion(),
      });
    if (opts.orchestrator === undefined) orchestrator.recover();
    app.decorate('playgroundOrchestrator', orchestrator);
    app.addHook('onClose', async () => orchestrator.stop());
    registerRuns(app, { store, orchestrator });
  }
  await registerStatic(app, config.uiDistDir);
  if (opts.startEnvProbes === true) env.start();
  return app;
}

/**
 * Process entry: opens `<DATA_DIR>/playground.db`, builds the server and listens. `extra` lets the
 * process entry (main.ts) inject the gateway's CaptureHttp, adapters or a bus.
 */
export async function startServer(
  env: NodeJS.ProcessEnv = process.env,
  extra: Omit<CreateServerOptions, 'config' | 'store'> = {},
): Promise<FastifyInstance> {
  const config = loadConfig(env);
  const store = openStore(path.join(config.dataDir, 'playground.db'));
  const app = await createServer({
    logger: { level: config.logLevel },
    startEnvProbes: true,
    ...extra,
    config,
    store,
  });
  app.addHook('onClose', () => {
    store.close();
    return Promise.resolve();
  });
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
