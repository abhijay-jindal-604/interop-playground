/**
 * BFF process entry (plan/12 T-11; 02 §1.2): the API/UI server on 3100 (`startServer`) and the
 * edge gateway listeners (`startGateway`) in one process, sharing one store. The image CMD and
 * `playground serve` run this file.
 *
 * Stream wiring: when the stream module (T-08) exists, the store's sink is attached to its default
 * bus, so every gateway write (run events, unattributed exchanges, gateway.denied) is published
 * after commit by the sink itself and the gateway callbacks only log. Without it they log only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { generateSelfToken } from './capture/self-token.js';
import { loadConfig } from './config/index.js';
import { LISTENERS, startGateway } from './gateway/index.js';
import type { Gateway, UnattributedItem } from './gateway/index.js';
import { startServer } from './server.js';
import type { Store } from './store/index.js';

export interface Main {
  app: FastifyInstance;
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

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<Main> {
  const config = loadConfig(env);
  // ADR-27 c: the token CaptureHttp sends on self-calls; held in memory only. Shared by the
  // orchestrator's CaptureHttp and the gateway so a BFF self-call is recorded once.
  const selfToken = generateSelfToken();
  // self-calls go to the advertised gateway URLs (ADR-06: built from PUBLIC_HOST)
  const hosts = config.publicHost ? [config.publicHost] : [];
  const gatewayOrigins = LISTENERS.flatMap((l) => hosts.map((h) => `${l.scheme}://${h}:${l.port}`));
  const app = await startServer(env, { selfToken, gatewayOrigins });
  const store = (app as unknown as { playgroundStore?: Store | null }).playgroundStore ?? null;
  if (!store || env.GATEWAY_DISABLED === '1') {
    app.log.warn('gateway not started (no store, or GATEWAY_DISABLED=1)');
    return { app, gateway: null, streamWiring: 'none', close: () => app.close() };
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
    onUnattributed: logItem,
    host: config.listenHost,
    tls: readTls(env),
    log: { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) },
  });
  app.log.info(`gateway stream wiring: ${streamWiring}`);
  return {
    app,
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
