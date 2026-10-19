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
 *
 * T-24/T-26: `wallet.playground-ts` is part of `bundleAdapters()`; its holder keys come from the
 * orchestrator's key service (`HolderKeyService` over the store's `holder_keys` / `run_keys`
 * tables, 05 §4.1, §6: the private JWK is read back only by `sign`).
 *
 * T-43: `issuer.waltid` (peers profile) is part of `bundleAdapters()` too; its KNOB-01 `present`
 * material is read from `/certs/peers` (`PEERS_CERT_DIR` overrides, `WALTID_ISSUER_URL` the base).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import {
  HolderKeyService,
  bundleAdapters,
  x5cMaterialFromFiles,
} from '@interop-playground/adapters';
import type {
  GatewayCorrelation,
  HolderKeyRef,
  HolderKeyStore,
  WalletAdapter,
} from '@interop-playground/adapters';
import { generateSelfToken } from './capture/self-token.js';
import { LOOPBACK_HOST, loadConfig } from './config/index.js';
import { CorrelationIndex, LISTENERS, startGateway } from './gateway/index.js';
import type { Gateway, RouteEntry, UnattributedItem } from './gateway/index.js';
import type { AdapterSet } from './orchestrator/index.js';
import { startServer } from './server.js';
import type { SqlDriver, Store } from './store/index.js';

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

/** the `holder_keys` / `run_keys` repository (05 §4.1; the only reader of `private_jwk_json`) */
export function sqlHolderKeyStore(
  db: SqlDriver,
  now: () => Date = () => new Date(),
): HolderKeyStore {
  return {
    keyOfRun(runId) {
      const r = db.get<{ key_id: string; alg: string; public_jwk_json: string; did_jwk: string }>(
        'SELECT h.key_id, h.alg, h.public_jwk_json, h.did_jwk FROM run_keys r JOIN holder_keys h ON h.key_id = r.key_id WHERE r.run_id = ? ORDER BY h.created_at LIMIT 1',
        runId,
      );
      if (!r) return null;
      const ref: HolderKeyRef = {
        keyId: r.key_id,
        alg: r.alg as HolderKeyRef['alg'],
        publicJwk: JSON.parse(r.public_jwk_json) as HolderKeyRef['publicJwk'],
        didJwk: r.did_jwk,
      };
      return ref;
    },
    insert(key, rootRunId) {
      db.run(
        "INSERT INTO holder_keys (key_id, kind, alg, public_jwk_json, did_jwk, private_jwk_json, root_run_id, created_at) VALUES (?, 'holder', ?, ?, ?, ?, ?, ?)",
        key.ref.keyId,
        key.ref.alg,
        JSON.stringify(key.ref.publicJwk),
        key.ref.didJwk,
        JSON.stringify(key.privateJwk),
        rootRunId,
        now().toISOString(),
      );
    },
    link(runId, keyId) {
      db.run('INSERT OR IGNORE INTO run_keys (run_id, key_id) VALUES (?, ?)', runId, keyId);
    },
    privateJwk(keyId) {
      const r = db.get<{ private_jwk_json: string }>(
        'SELECT private_jwk_json FROM holder_keys WHERE key_id = ?',
        keyId,
      );
      return r
        ? (JSON.parse(r.private_jwk_json) as ReturnType<HolderKeyStore['privateJwk']>)
        : null;
    },
  };
}

/** the orchestrator's key service over a store */
export function holderKeysFor(store: Pick<Store, 'driver'>): HolderKeyService {
  const repo = sqlHolderKeyStore(store.driver);
  return new HolderKeyService(() => repo);
}

/**
 * 03 FLOW-08 "key redacted": the walt.id issuer key's private `d` that KNOB-01 `present` sends in
 * the mint body goes into the store's secret registry, so the sink redacts it before anything
 * is stored (02 §6.2). No key file (no peers profile material): nothing to register.
 */
export function registerPeerSecrets(store: Pick<Store, 'sink'>, env: NodeJS.ProcessEnv): string[] {
  const dir = env.PEERS_CERT_DIR ?? '/certs/peers';
  const key = path.join(dir, 'waltid-issuer.key');
  const cert = path.join(dir, 'waltid-issuer.pem');
  if (!existsSync(key) || !existsSync(cert)) return [];
  const d = x5cMaterialFromFiles(key, cert)().issuerJwk.d;
  if (!d) return [];
  store.sink.registry.add('WALTID_ISSUER_KEY_D', d);
  return ['WALTID_ISSUER_KEY_D'];
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
    ...(env.WALTID_ISSUER_URL ? { waltidIssuerBase: env.WALTID_ISSUER_URL } : {}),
    ...(env.PEERS_CERT_DIR ? { peersCertDir: env.PEERS_CERT_DIR } : {}),
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
  // holder keys (T-24): late-bound to the store startServer opens (no run starts before it)
  let keyRepo: HolderKeyStore | null = null;
  const app = await startServer(env, {
    selfToken,
    gatewayOrigins,
    adapters,
    keys: new HolderKeyService(() => keyRepo),
    onEnvReady: () => refreshGateway?.(),
  });
  const store = (app as unknown as { playgroundStore?: Store | null }).playgroundStore ?? null;
  if (store) {
    keyRepo = sqlHolderKeyStore(store.driver);
    registerPeerSecrets(store, env);
  }
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
