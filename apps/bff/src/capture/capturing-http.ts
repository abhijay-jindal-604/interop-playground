/**
 * `CapturingHttp` (02 §3.2, 04 §8.1, §8.3; API-70, API-73): the single outbound HTTP client of the
 * BFF. Every call takes an explicit `CaptureContext` (no global "current run") and becomes
 * `exchange.request` (persisted before sending) + `exchange.response` / `exchange.error` through
 * the EventSink. Polls are coalesced, gateway self-calls carry `X-Playground-Self`, and a per-run
 * cookie jar is used when `ctx.cookieJar` is set.
 */
import { createHash } from 'node:crypto';
import type { CaptureContext, CapturingHttp } from '@interop-playground/adapters';
import type { RawBody } from '../store/bodies.js';
import type { EventSink } from '../store/sink.js';
import { PollCoalescer } from './coalesce.js';
import { CookieJar } from './cookie-jar.js';
import { SELF_HEADER } from './self-token.js';

type HeaderList = [string, string][];

/** ADR-38: nothing in the bundle talks to GitHub (test `egress.github-denied`) */
export class EgressDeniedError extends Error {
  constructor(readonly host: string) {
    super(`egress to ${host} is not allowed (ADR-38)`);
    this.name = 'EgressDeniedError';
  }
}
const DENIED_HOSTS = [/^(api\.)?github\.com$/i, /(^|\.)githubusercontent\.com$/i];

export interface CapturingHttpOptions {
  sink: EventSink;
  /** `X-Playground-Self` token of this process (self-token.ts) */
  selfToken: string;
  /** `host:port` of the BFF's own gateway listeners (02 §2.3); calls to them carry the token */
  gatewayOrigins?: Iterable<string>;
  /** injected transport; defaults to the global fetch */
  fetch?: typeof fetch;
  /** ms clock for durations (FakeClock in tests) */
  now?: () => number;
}

interface PollData {
  request: { method: string; url: string; headers: HeaderList; body: RawBody | null };
  outcome:
    | {
        kind: 'response';
        status: number;
        statusText: string | null;
        headers: HeaderList;
        body: RawBody | null;
        durationMs: number;
      }
    | { kind: 'error'; errorClass: string; message: string; durationMs: number };
  ctx: CaptureContext;
}

function hostPort(u: URL): string {
  const port = u.port || (u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '');
  return `${u.hostname.toLowerCase()}:${port}`;
}
function normaliseOrigin(o: string): string {
  return hostPort(new URL(o.includes('://') ? o : `https://${o}`));
}

async function requestBytes(body: RequestInit['body']): Promise<Buffer | null> {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  // FormData / streams: let Request serialise them so the captured bytes are the sent bytes
  const r = new Request('http://capture.invalid/', {
    method: 'POST',
    body,
    duplex: 'half',
  });
  return Buffer.from(await r.arrayBuffer());
}

export class CaptureHttp implements CapturingHttp {
  private readonly sink: EventSink;
  private readonly token: string;
  private readonly gateways: Set<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly polls = new PollCoalescer<PollData>();
  private readonly jars = new Map<string, CookieJar>();

  constructor(opts: CapturingHttpOptions) {
    this.sink = opts.sink;
    this.token = opts.selfToken;
    this.gateways = new Set([...(opts.gatewayOrigins ?? [])].map(normaliseOrigin));
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? (() => performance.now());
  }

  /** the run's cookie jar (created on first use) */
  jar(runId: string): CookieJar {
    let j = this.jars.get(runId);
    if (!j) {
      j = new CookieJar();
      this.jars.set(runId, j);
    }
    return j;
  }

  async fetch(ctx: CaptureContext, url: string | URL, init: RequestInit = {}): Promise<Response> {
    const u = new URL(url);
    if (DENIED_HOSTS.some((re) => re.test(u.hostname))) throw new EgressDeniedError(u.hostname);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    headers.delete(SELF_HEADER); // only this class ever sets it
    if (ctx.cookieJar) {
      const fromJar = this.jar(ctx.runId).header(u);
      if (fromJar) {
        const own = headers.get('cookie');
        headers.set('cookie', own ? `${own}; ${fromJar}` : fromJar);
      }
    }
    const reqBody = await requestBytes(init.body);
    const recorded: HeaderList = [...headers.entries()];
    const raw = (b: Buffer | null, ct: string | null): RawBody | null =>
      b && b.length ? { bytes: b, contentType: ct } : null;
    const request = {
      method,
      url: u.toString(),
      headers: recorded,
      body: raw(reqBody, headers.get('content-type')),
    };
    // the token is added after `recorded` was taken: it is never persisted (04 §8.1)
    if (this.gateways.has(hostPort(u))) headers.set(SELF_HEADER, this.token);

    let exchangeId: string | null = null;
    if (!ctx.poll) {
      exchangeId = this.sink.nextExchangeId(ctx.runId);
      this.sink.append(ctx.runId, {
        type: 'exchange.request',
        stepKey: ctx.stepKey,
        payload: {
          exchangeId,
          direction: 'outbound',
          actor: ctx.actor,
          counterpart: ctx.counterpart,
          ...request,
          poll: null,
        },
      });
    }
    const t0 = this.now();
    let res: Response;
    try {
      res = await this.fetchImpl(u, {
        ...init,
        method,
        headers,
        body: reqBody ?? null,
        redirect: init.redirect ?? 'manual', // every hop is its own exchange
      });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      const outcome = {
        kind: 'error' as const,
        errorClass: e.cause?.code ?? e.name ?? 'Error',
        message: e.message,
        durationMs: Math.round(this.now() - t0),
      };
      if (exchangeId) {
        const { kind: _k, ...p } = outcome;
        this.sink.append(ctx.runId, {
          type: 'exchange.error',
          stepKey: ctx.stepKey,
          payload: { exchangeId, ...p },
        });
      } else {
        this.observePoll(ctx, `error:${outcome.errorClass}`, { request, outcome, ctx });
      }
      throw err;
    }
    const respBytes = Buffer.from(await res.arrayBuffer());
    const durationMs = Math.round(this.now() - t0);
    if (ctx.cookieJar) this.jar(ctx.runId).store(u, res.headers.getSetCookie());
    const outcome = {
      kind: 'response' as const,
      status: res.status,
      statusText: res.statusText || null,
      headers: [...res.headers.entries()] as HeaderList,
      body: raw(respBytes, res.headers.get('content-type')),
      durationMs,
    };
    if (exchangeId) {
      const { kind: _k, ...p } = outcome;
      this.sink.append(ctx.runId, {
        type: 'exchange.response',
        stepKey: ctx.stepKey,
        payload: { exchangeId, ...p, poll: null },
      });
    } else {
      const bodySha = createHash('sha256').update(respBytes).digest('hex');
      this.observePoll(ctx, `${res.status}:${bodySha}`, { request, outcome, ctx });
    }
    const nullBody = res.status === 204 || res.status === 304 || respBytes.length === 0;
    return new Response(nullBody ? null : respBytes, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }

  private observePoll(ctx: CaptureContext, signature: string, data: PollData): void {
    const group = ctx.poll?.group ?? '';
    const key = PollCoalescer.key(ctx.runId, ctx.stepKey, group);
    const { persist } = this.polls.observe(key, signature, data);
    for (const p of persist) this.persistPoll(p.data, group, p.index, null);
  }

  private persistPoll(d: PollData, group: string, index: number, total: number | null): void {
    const { ctx } = d;
    const exchangeId = this.sink.nextExchangeId(ctx.runId);
    this.sink.append(ctx.runId, {
      type: 'exchange.request',
      stepKey: ctx.stepKey,
      payload: {
        exchangeId,
        direction: 'outbound',
        actor: ctx.actor,
        counterpart: ctx.counterpart,
        method: d.request.method,
        url: d.request.url,
        headers: d.request.headers,
        body: d.request.body,
        poll: { group, index, total: null },
      },
    });
    if (d.outcome.kind === 'response') {
      const { kind: _k, ...p } = d.outcome;
      this.sink.append(ctx.runId, {
        type: 'exchange.response',
        stepKey: ctx.stepKey,
        payload: { exchangeId, ...p, poll: { group, index, total } },
      });
    } else {
      const { kind: _k, ...p } = d.outcome;
      this.sink.append(ctx.runId, {
        type: 'exchange.error',
        stepKey: ctx.stepKey,
        payload: { exchangeId, ...p },
      });
    }
  }

  /** flushes the group's latest unpersisted poll and sets `poll.total` on it (04 §8.3) */
  closePoll(ctx: CaptureContext, group: string): Promise<void> {
    const closed = this.polls.close(PollCoalescer.key(ctx.runId, ctx.stepKey, group));
    if (closed) this.persistPoll(closed.pair.data, group, closed.pair.index, closed.total);
    return Promise.resolve();
  }

  /** the orchestrator calls this before `step.completed` (automatic `closePoll`, 04 §8.3) */
  async flushStep(runId: string, stepKey: string): Promise<void> {
    for (const key of this.polls.openKeys(PollCoalescer.key(runId, stepKey, ''))) {
      const group = key.split('\u0000')[2] ?? '';
      await this.closePoll({ runId, stepKey, actor: '', counterpart: '' }, group);
    }
  }

  /** at the terminal event: flush every open poll group and drop the run's jar */
  async endRun(runId: string): Promise<void> {
    for (const key of this.polls.openKeys(`${runId}\u0000`)) {
      const [, stepKey = '', group = ''] = key.split('\u0000');
      await this.closePoll({ runId, stepKey, actor: '', counterpart: '' }, group);
    }
    this.jars.delete(runId);
  }
}
