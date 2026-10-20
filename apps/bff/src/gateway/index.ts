/**
 * Edge gateway (plan/12 T-11; 02 §2.3–§2.5, §3.3, §6.3; 04 §8.1, §8.2; ADR-19, ADR-22, ADR-27, ADR-66).
 *
 *   startGateway(opts) -> one listener per port of LISTENERS (http or https with the playground
 *   CA leaf), each forwarding to exactly one upstream on playground_net. Every inbound exchange
 *   is recorded through the EventSink: on the run stream when a correlation key resolves it,
 *   otherwise in `unattributed_exchanges` and handed to `onUnattributed`. Self-calls
 *   (`X-Playground-Self` = this process's token) are forwarded unrecorded; the header is always
 *   stripped. Denied requests get 403 `gateway_denied` (API-71) and never reach the upstream.
 *
 * The gateway is a recorder, not a participant: no caching, no retries, no response rewriting.
 */
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { ErrorCode, ErrorEnvelope, EventEnvelope, Headers } from '@interop-playground/api';
import { ulid } from 'ulid';
import { isSelfCall, SELF_HEADER } from '../capture/self-token.js';
import type { EventSink } from '../store/sink.js';
import { Allowlists, normalisePath } from './allowlist.js';
import type { MetadataFetch } from './allowlist.js';
import { CorrelationIndex } from './correlation.js';
import type { Attribution } from './correlation.js';
import { LISTENERS, PROXY_UPSTREAM_TIMEOUT_MS } from './listeners.js';
import type { ListenerSpec, PathRoute } from './listeners.js';

export { PROXY_UPSTREAM_TIMEOUT_MS, LISTENERS, listenerFor } from './listeners.js';
export type { ListenerSpec, AllowKind, Profile } from './listeners.js';
export { Allowlists, normalisePath, hardDenyRule, advertisedRules } from './allowlist.js';
export type { Decision, MetadataFetch } from './allowlist.js';
export { CorrelationIndex, tokenKey } from './correlation.js';
export type { Attribution, RouteEntry } from './correlation.js';

/** request bodies are buffered (correlation reads the form body); larger requests get 413 */
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
/** captured copy of a response body; the sink truncates to 256 KiB and keeps size + SHA-256 */
const CAPTURE_MAX_BYTES = 4 * 1024 * 1024;
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Where an inbound connection came from; decides how strictly the allowlist treats it. */
export type Remote = 'loopback' | 'lan' | 'tunnel';

/** one unattributed inbound exchange (02 §3.3), after it was persisted */
export interface UnattributedExchange {
  kind: 'exchange';
  /** row id in `unattributed_exchanges` */
  id: number;
  port: number;
  actor: string;
  counterpart: string;
  method: string;
  url: string;
  status: number | null;
  errorClass: string | null;
  durationMs: number | null;
  remote: Remote;
}
/** one denied request (API-71), after its `gateway.denied` event was persisted */
export interface DeniedRequest {
  kind: 'denied';
  event: EventEnvelope<'gateway.denied'>;
}
export type UnattributedItem = UnattributedExchange | DeniedRequest;

/** A buffered inbound request handed to the relay. */
export interface RelayRequest {
  method: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
/** An upstream (or synthesised) response relayed back to the caller. */
export interface RelayResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

/** Logger the gateway writes listener and relay notices to. */
export interface GatewayLog {
  info(msg: string): void;
  warn(msg: string): void;
}

/** Everything `startGateway` needs; the optional hooks exist so tests can bind free ports and fake upstreams. */
export interface GatewayOptions {
  sink: EventSink;
  /** `X-Playground-Self` token of this process (the one CaptureHttp sends) */
  selfToken: string;
  /** unattributed traffic and denials, called after they are persisted (the `unattributed` stream) */
  onUnattributed: (item: UnattributedItem) => void;
  /** run-attributed events, called after they are persisted (the `run:<runId>` stream) */
  onRunEvent?: (ev: EventEnvelope) => void;
  correlation?: CorrelationIndex;
  /** bind address (0.0.0.0 in the container) */
  host?: string;
  listeners?: readonly ListenerSpec[];
  /** subset of listener ports to start (default all) */
  ports?: readonly number[];
  /** port actually bound for a listener (tests: 0 = ephemeral) */
  bindPort?: (spec: ListenerSpec) => number;
  /** PEM leaf + key for the https listeners; null/absent = https listeners are not started */
  tls?: { cert: string | Buffer; key: string | Buffer } | null;
  upstreamTimeoutMs?: number;
  fetchMetadata?: MetadataFetch;
  /** API-53/54 relay; null = window closed (404 `relay-closed`) */
  relay?: (runId: string, req: RelayRequest) => Promise<RelayResponse | null>;
  /** whether a 443 path route's profile is active (default: always) */
  routeActive?: (r: PathRoute) => boolean;
  log?: GatewayLog;
}

/** A listener that bound: its configured port, the actual port (differs when tests ask for port 0) and scheme. */
export interface BoundListener {
  port: number;
  boundPort: number;
  scheme: 'http' | 'https';
}

/** Handle to the running gateway: the bound/failed listeners, shared allowlists and correlation index, and shutdown. */
export interface Gateway {
  readonly listening: readonly BoundListener[];
  readonly failed: readonly { port: number; error: string }[];
  readonly allowlists: Allowlists;
  readonly correlation: CorrelationIndex;
  /** reloads the M1 allowlists (call after `env.ready`) */
  refresh(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Classifies a peer address. The tunnel port (9000) is always 'tunnel'; loopback addresses are
 * 'loopback'; everything else, including a missing address, is 'lan'.
 */
export function remoteClass(addr: string | undefined, listenerPort: number): Remote {
  if (listenerPort === 9000) return 'tunnel';
  if (!addr) return 'lan';
  const a = addr.replace(/^::ffff:/, '');
  return a === '::1' || a.startsWith('127.') ? 'loopback' : 'lan';
}

function headerList(h: http.IncomingHttpHeaders | http.OutgoingHttpHeaders): Headers {
  const out: Headers = [];
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    if (k.toLowerCase() === SELF_HEADER) continue;
    if (Array.isArray(v)) for (const x of v) out.push([k, String(x)]);
    else out.push([k, String(v)]);
  }
  return out;
}

/**
 * Fetches an upstream's issuer metadata over plain HTTP (3 s timeout); null on any failure or non-200.
 * Default metadata fetch: plain GET on playground_net, 3 s, JSON or null.
 */
export const defaultFetchMetadata: MetadataFetch = (upstream, path) =>
  new Promise((resolve) => {
    const req = http.get(new URL(path, upstream), { timeout: 3000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        } catch {
          resolve(null);
        }
      });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
  });

function readBody(req: http.IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > max) over = true;
      else chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendEnvelope(
  res: http.ServerResponse,
  code: ErrorCode,
  status: number,
  message: string,
  details: Record<string, unknown>,
): void {
  const body: ErrorEnvelope = {
    error: {
      code,
      message,
      status,
      requestId: ulid(),
      retryable: status === 429 || status === 503,
      details,
    },
  };
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...(status === 503 ? { 'retry-after': '5' } : {}),
  });
  res.end(text);
}

/**
 * Starts one listener per entry of the listener table, each forwarding to exactly one upstream.
 * Every inbound exchange is persisted through the event sink before it is published, secrets are
 * redacted by the sink, and anything off the allowlist is denied and recorded as `gateway.denied`.
 * A listener that cannot bind is reported in `failed` instead of aborting the others.
 */
export async function startGateway(opts: GatewayOptions): Promise<Gateway> {
  const table = opts.listeners ?? LISTENERS;
  const wanted = table.filter((l) => !opts.ports || opts.ports.includes(l.port));
  const correlation = opts.correlation ?? new CorrelationIndex();
  const allowlists = new Allowlists(table, opts.fetchMetadata ?? defaultFetchMetadata, Date.now, {
    ...(opts.routeActive ? { routeActive: opts.routeActive } : {}),
  });
  const timeoutMs = opts.upstreamTimeoutMs ?? PROXY_UPSTREAM_TIMEOUT_MS;
  const host = opts.host ?? '0.0.0.0';
  const log = opts.log ?? { info: () => undefined, warn: (m: string) => console.warn(m) };
  const { sink } = opts;

  const persistRun = (runId: string, ev: Parameters<EventSink['append']>[1]): void => {
    const env = sink.append(runId, ev);
    if (env) opts.onRunEvent?.(env);
  };

  function deny(
    l: ListenerSpec,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rule: string,
    attribution: Attribution | null,
  ): void {
    const path = normalisePath(req.url ?? '/') ?? (req.url ?? '/').split('?')[0] ?? '/';
    const payload = {
      method: (req.method ?? 'GET').toUpperCase(),
      path,
      port: l.port,
      rule,
      remote: remoteClass(req.socket.remoteAddress, l.port),
    };
    try {
      if (attribution) {
        persistRun(attribution.runId, { type: 'gateway.denied', payload });
      } else {
        const event = sink.appendEnv('gateway.denied', payload);
        opts.onUnattributed({ kind: 'denied', event });
      }
    } catch (e) {
      log.warn(`gateway: could not record gateway.denied: ${(e as Error).message}`);
    }
    if (rule === 'relay-closed') {
      sendEnvelope(res, 'not_found', 404, 'No such route or resource.', { port: l.port, rule });
    } else {
      sendEnvelope(res, 'gateway_denied', 403, 'The gateway does not forward this request.', {
        port: l.port,
        rule,
      });
    }
  }

  async function handle(
    l: ListenerSpec,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const rawUrl = req.url ?? '/';
    const self = isSelfCall(req.headers[SELF_HEADER], opts.selfToken);
    delete req.headers[SELF_HEADER]; // stripped match or not (04 §8.1)
    const remote = remoteClass(req.socket.remoteAddress, l.port);

    const body = await readBody(req, MAX_REQUEST_BYTES);
    if (body === null) {
      sendEnvelope(res, 'payload_too_large', 413, 'The request body is larger than the limit.', {
        limit: MAX_REQUEST_BYTES,
      });
      return;
    }
    const attribution = self
      ? null
      : correlation.resolve({ method, url: rawUrl, headers: req.headers, body });

    const decision = await allowlists.decide(l, method, rawUrl);
    if (decision.kind === 'deny') return deny(l, req, res, decision.rule, attribution);
    if (decision.kind === 'relay') {
      const r = opts.relay
        ? await opts.relay(decision.runId, { method, headers: req.headers, body })
        : null;
      if (!r) return deny(l, req, res, 'relay-closed', attribution);
      res.writeHead(r.status, r.headers);
      res.end(r.body);
      return;
    }

    const target = new URL(rawUrl, decision.upstream);
    const actor = attribution?.actor ?? `inbound→${decision.counterpart}`;
    const publicUrl = `${l.scheme}://${req.headers.host ?? `gateway:${l.port}`}${rawUrl}`;
    const reqHeaders: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) reqHeaders[k] = v;
    }
    const upstreamUrl = new URL(decision.upstream);
    reqHeaders.host = upstreamUrl.host;
    if (req.headers.host) reqHeaders['x-forwarded-host'] = req.headers.host;
    reqHeaders['x-forwarded-proto'] = l.scheme;
    const xff = req.headers['x-forwarded-for'];
    const peer = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    reqHeaders['x-forwarded-for'] = xff ? `${String(xff)}, ${peer}` : peer;
    if (body.length > 0 || !['GET', 'HEAD', 'OPTIONS', 'DELETE'].includes(method)) {
      reqHeaders['content-length'] = String(body.length);
    }

    let exchangeId: string | null = null;
    const recordedHeaders = headerList(req.headers);
    const ct = (h: Headers): string | null =>
      h.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? null;
    if (attribution) {
      // persisted before the request is forwarded (02 §4.1)
      exchangeId = sink.nextExchangeId(attribution.runId);
      persistRun(attribution.runId, {
        type: 'exchange.request',
        stepKey: attribution.stepKey,
        payload: {
          exchangeId,
          direction: 'inbound',
          actor,
          counterpart: decision.counterpart,
          method,
          url: publicUrl,
          headers: recordedHeaders,
          body: body.length ? { bytes: body, contentType: ct(recordedHeaders) } : null,
          poll: null,
        },
      });
    }

    const t0 = performance.now();
    const finish = (
      status: number | null,
      respHeaders: Headers | null,
      respBody: Buffer | null,
      errorClass: string | null,
      message: string | null,
    ): void => {
      if (self) return;
      const durationMs = Math.round(performance.now() - t0);
      try {
        if (attribution && exchangeId) {
          if (status === null) {
            persistRun(attribution.runId, {
              type: 'exchange.error',
              stepKey: attribution.stepKey,
              payload: {
                exchangeId,
                errorClass: errorClass ?? 'Error',
                message: message ?? '',
                durationMs,
              },
            });
          } else {
            persistRun(attribution.runId, {
              type: 'exchange.response',
              stepKey: attribution.stepKey,
              payload: {
                exchangeId,
                status,
                statusText: http.STATUS_CODES[status] ?? null,
                headers: respHeaders ?? [],
                body:
                  respBody && respBody.length
                    ? { bytes: respBody, contentType: ct(respHeaders ?? []) }
                    : null,
                durationMs,
                poll: null,
              },
            });
          }
          return;
        }
        const id = sink.appendUnattributed({
          port: l.port,
          actor,
          counterpart: decision.counterpart,
          method,
          url: publicUrl,
          status,
          requestHeaders: recordedHeaders,
          responseHeaders: respHeaders,
          requestBody: body.length ? { bytes: body, contentType: ct(recordedHeaders) } : null,
          responseBody:
            respBody && respBody.length
              ? { bytes: respBody, contentType: ct(respHeaders ?? []) }
              : null,
          durationMs,
        });
        opts.onUnattributed({
          kind: 'exchange',
          id,
          port: l.port,
          actor,
          counterpart: decision.counterpart,
          method,
          url: publicUrl,
          status,
          errorClass,
          durationMs,
          remote,
        });
      } catch (e) {
        log.warn(`gateway: could not record an exchange on ${l.port}: ${(e as Error).message}`);
      }
    };

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const up = http.request(target, { method, headers: reqHeaders, timeout: timeoutMs }, (ur) => {
        const status = ur.statusCode ?? 502;
        const outHeaders: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(ur.headers)) {
          if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) outHeaders[k] = v;
        }
        res.writeHead(status, ur.statusMessage, outHeaders);
        const chunks: Buffer[] = [];
        let kept = 0;
        ur.on('data', (c: Buffer) => {
          if (kept < CAPTURE_MAX_BYTES) {
            chunks.push(c);
            kept += c.length;
          }
          res.write(c);
        });
        ur.on('end', () => {
          res.end();
          finish(status, headerList(ur.headers), Buffer.concat(chunks), null, null);
          done();
        });
        ur.on('error', (e) => {
          res.destroy();
          finish(null, null, null, 'ECONNRESET', e.message);
          done();
        });
      });
      up.on('timeout', () => {
        up.destroy(
          Object.assign(new Error(`upstream timeout after ${timeoutMs} ms`), { code: 'timeout' }),
        );
      });
      up.on('error', (e: Error & { code?: string }) => {
        if (settled) return;
        const errorClass = e.code ?? 'Error';
        const down = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH'].includes(
          errorClass,
        );
        if (down) {
          sendEnvelope(res, 'env_not_ready', 503, 'The upstream service is not running.', {
            port: l.port,
            upstream: decision.counterpart,
          });
        } else {
          sendEnvelope(res, 'upstream_unreachable', 502, 'The upstream did not answer.', {
            port: l.port,
            upstream: decision.counterpart,
            errorClass,
          });
        }
        finish(null, null, null, errorClass, e.message);
        done();
      });
      // a client that goes away aborts the upstream call too
      res.on('close', () => {
        if (!res.writableFinished) up.destroy();
      });
      up.end(body.length ? body : undefined);
    });
  }

  const listening: BoundListener[] = [];
  const failed: { port: number; error: string }[] = [];
  const servers: (http.Server | https.Server)[] = [];
  for (const l of wanted) {
    if (l.scheme === 'https' && !opts.tls) {
      failed.push({ port: l.port, error: 'no TLS leaf (certs/gateway.pem)' });
      continue;
    }
    const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
      handle(l, req, res).catch((e: unknown) => {
        log.warn(`gateway: ${l.port} ${req.method} failed: ${(e as Error).message}`);
        sendEnvelope(res, 'internal_error', 500, 'The gateway hit an unexpected fault.', {
          port: l.port,
        });
      });
    };
    const server =
      l.scheme === 'https' && opts.tls
        ? https.createServer({ cert: opts.tls.cert, key: opts.tls.key }, handler)
        : http.createServer(handler);
    // the 55 s long poll must not be cut by the server side either (S-202)
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    server.keepAliveTimeout = 5_000;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.bindPort ? opts.bindPort(l) : l.port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      servers.push(server);
      listening.push({
        port: l.port,
        boundPort: (server.address() as AddressInfo).port,
        scheme: l.scheme,
      });
    } catch (e) {
      failed.push({ port: l.port, error: (e as Error).message });
    }
  }
  for (const f of failed) log.warn(`gateway: listener ${f.port} not started: ${f.error}`);
  log.info(`gateway: listening on ${listening.map((x) => x.port).join(', ') || 'nothing'}`);
  // first allowlist load in the background; decide() loads lazily until it succeeds
  void allowlists.refresh();

  return {
    listening,
    failed,
    allowlists,
    correlation,
    refresh: () => allowlists.refresh(),
    close: async () => {
      await Promise.all(
        servers.map(
          (s) =>
            new Promise<void>((resolve) => {
              s.close(() => resolve());
              s.closeAllConnections();
            }),
        ),
      );
    },
  };
}
