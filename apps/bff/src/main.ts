/**
 * BFF process entry (plan/12 T-11; 02 §1.2): the API/UI server on 3100 (`startServer`) and the
 * edge gateway listeners (`startGateway`) in one process, sharing one store. The image CMD and
 * `playground serve` run this file.
 *
 * Stream wiring: when the stream module (T-08) exists, the store's sink is attached to its default
 * bus, so every gateway write (run events, unattributed exchanges, gateway.denied) is published
 * after commit by the sink itself and the gateway callbacks only log. Without it they log only.
 *
 * Adapters (T-23, T-25): `issuer.certify-preauth` and `verifier.inji-verify-local` are built here
 * and passed to `startServer`; the keys they create go into the gateway's correlation index (one
 * index, created before both and handed to `startGateway`), so inbound wallet hops on the
 * gateway listeners are attributed to the run and its step (02 §3.3).
 */
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { bundleAdapters } from '@interop-playground/adapters';
import type { GatewayCorrelation, WalletAdapter } from '@interop-playground/adapters';
import { generateSelfToken } from './capture/self-token.js';
import { LOOPBACK_HOST, loadConfig } from './config/index.js';
import { CorrelationIndex, LISTENERS, startGateway } from './gateway/index.js';
import type { Gateway, RouteEntry, UnattributedItem } from './gateway/index.js';
import type { AdapterSet } from './orchestrator/index.js';
import { startServer } from './server.js';
import type { Store } from './store/index.js';

export interface Main {
  app: FastifyInstance;
  adapters: AdapterSet;
  correlation: CorrelationIndex;
  gateway: Gateway | null;
  /** how the unattributed / run streams are fed: `bus` (T-08 present) or `log` (stub) */
  streamWiring: 'bus' | 'log' | 'none';
  close(): Promise<void>;
}

type StreamModule = {
  defaultBus: unknown;
  attachBus: (store: Store, bus: unknown) => void;
};

async function attachStream(store: Store): Promise<boolean> {
  const specifier = './stream/index.js';
  try {
    const mod = (await import(specifier)) as Partial<StreamModule>;
    if (typeof mod.attachBus !== 'function' || mod.defaultBus === undefined) return false;
    mod.attachBus(store, mod.defaultBus);
    return true;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ERR_MODULE_NOT_FOUND') return false;
    // already attached to a bus by startServer: the sink publishes either way
    if (/already attached/.test((e as Error).message)) return true;
    throw e;
  }
}

function readTls(env: NodeJS.ProcessEnv): { cert: Buffer; key: Buffer } | null {
  const cert = env.GATEWAY_TLS_CERT ?? '/certs/gateway.pem';
  const key = env.GATEWAY_TLS_KEY ?? '/certs/gateway.key';
  if (!existsSync(cert) || !existsSync(key)) return null;
  return { cert: readFileSync(cert), key: readFileSync(key) };
}

/** the adapters' view of the gateway index; route tables are merged per run (issuer + verifier) */
export function gatewayCorrelation(index: CorrelationIndex): GatewayCorrelation {
  const tables = new Map<string, RouteEntry[]>();
  return {
    register: (runId, key, stepKey, actor = null) => index.register(runId, key, stepKey, actor),
    addRoutes: (runId, routes) => {
      const t = [...(tables.get(runId) ?? []), ...routes];
      tables.set(runId, t);
      index.setRoutes(runId, t);
    },
  };
}

export interface MainOptions {
  /** wallets of later tasks (T-24) or tests */
  wallets?: Readonly<Record<string, WalletAdapter>>;
}

/** the AdapterSet registered with the orchestrator (env overrides are for host-side runs) */
export function adaptersFor(
  env: NodeJS.ProcessEnv,
  correlation: CorrelationIndex,
  opts: MainOptions = {},
): AdapterSet {
  const config = loadConfig(env);
  return bundleAdapters({
    publicHost: config.publicHost ?? LOOPBACK_HOST,
    ...(env.CERTIFY_PREAUTH_URL ? { certifyPreauthBase: env.CERTIFY_PREAUTH_URL } : {}),
    ...(env.VERIFY_SERVICE_URL ? { verifyServiceBase: env.VERIFY_SERVICE_URL } : {}),
    configDir: config.configDir,
    gateway: gatewayCorrelation(correlation),
    ...(opts.wallets ? { wallets: opts.wallets } : {}),
  });
}

export async function main(
  env: NodeJS.ProcessEnv = process.env,
  opts: MainOptions = {},
): Promise<Main> {
  const config = loadConfig(env);
  // ADR-27 c: the token CaptureHttp sends on self-calls; held in memory only. Shared by the
  // orchestrator's CaptureHttp and the gateway so a BFF self-call is recorded once.
  const selfToken = generateSelfToken();
  // self-calls go to the advertised gateway URLs (ADR-06: built from PUBLIC_HOST)
  const hosts = config.publicHost ? [config.publicHost] : [];
  const gatewayOrigins = LISTENERS.flatMap((l) => hosts.map((h) => `${l.scheme}://${h}:${l.port}`));
  const correlation = new CorrelationIndex();
  const adapters = adaptersFor(env, correlation, opts);
  // T-12: the env manager refreshes the gateway allowlists after env.ready (late-bound: the
  // gateway starts after the server)
  let refreshGateway: (() => Promise<void>) | null = null;
  const app = await startServer(env, {
    selfToken,
    gatewayOrigins,
    adapters,
    onEnvReady: () => refreshGateway?.(),
  });
  const store = (app as unknown as { playgroundStore?: Store | null }).playgroundStore ?? null;
  if (!store || env.GATEWAY_DISABLED === '1') {
    app.log.warn('gateway not started (no store, or GATEWAY_DISABLED=1)');
    return {
      app,
      adapters,
      correlation,
      gateway: null,
      streamWiring: 'none',
      close: () => app.close(),
    };
  }
  const bus = await attachStream(store);
  const streamWiring = bus ? 'bus' : 'log';
  const logItem = (i: UnattributedItem): void => {
    if (bus) return; // published by the attached sink
    if (i.kind === 'denied') {
      app.log.info({ gatewayDenied: i.event.payload }, 'gateway.denied');
    } else {
      app.log.info({ port: i.port, method: i.method, status: i.status }, 'gateway unattributed');
    }
  };
  const gateway = await startGateway({
    sink: store.sink,
    selfToken,
    correlation,
    onUnattributed: logItem,
    host: config.listenHost,
    tls: readTls(env),
    log: { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) },
  });
  refreshGateway = () => gateway.refresh();
  app.log.info(`gateway stream wiring: ${streamWiring}`);
  return {
    app,
    adapters,
    correlation,
    gateway,
    streamWiring,
    close: async () => {
      await gateway.close();
      await app.close();
    },
  };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
