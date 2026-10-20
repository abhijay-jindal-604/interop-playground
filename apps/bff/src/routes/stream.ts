/**
 * API-15 `GET /api/v1/streams/{streamId}/events` (04 §2.2, §7.1, API-74; 02 §4.3; ADR-20).
 *
 * SSE (default): `retry: 3000`, then `id/event/data` frames from the store replay followed by the
 * live tail; `Last-Event-ID` or `?after=` resume strictly after that seq; `: hb` every 15 s; after a
 * run's terminal event one `event: stream.end` frame (no id) and close. JSON (`?format=json`): one
 * `EventPage` of the same sequence.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { EventEnvelope, EventPage, StreamEndFrame } from '@interop-playground/api';
import { EVENT_TYPES } from '@interop-playground/api';
import { ApiError, issueDetails } from '../errors/index.js';
import type { Store } from '../store/index.js';
import { TERMINAL_TYPES, streamKeyOf, storeSource } from '../stream/index.js';
import type { EventBus, Subscription } from '../stream/index.js';

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const HEARTBEAT_MS = 15_000;
const QUERY_KEYS = new Set(['format', 'after', 'limit', 'type']);

export interface StreamRouteOptions {
  store: Store;
  bus: EventBus;
  heartbeatMs?: number;
}

interface ParsedQuery {
  json: boolean;
  after: number;
  limit: number;
  types: Set<string> | null;
}

/** A validation error for a bad query parameter. */
function bad(path: string, message: string): ApiError {
  return new ApiError('validation_failed', undefined, issueDetails([{ path, message }]));
}

/** Parses a non-negative integer parameter or throws a validation error. */
function nonNegInt(v: string, path: string): number {
  if (!/^\d{1,15}$/.test(v)) throw bad(path, 'must be a non-negative integer');
  return Number(v);
}

/** Validates the stream query (`after`, `format`, and so on) and applies defaults. */
function parseQuery(req: FastifyRequest<{ Querystring: Record<string, string> }>): ParsedQuery {
  const q = req.query;
  for (const k of Object.keys(q))
    if (!QUERY_KEYS.has(k)) throw bad(`$.query.${k}`, 'unknown parameter');
  if (q.format !== undefined && q.format !== 'sse' && q.format !== 'json')
    throw bad('$.query.format', 'one of sse, json');
  let after = 0;
  if (q.after !== undefined) after = nonNegInt(q.after, '$.query.after');
  const lastId = req.headers['last-event-id'];
  if (typeof lastId === 'string' && lastId !== '') {
    after = Math.max(after, nonNegInt(lastId.trim(), '$.headers.Last-Event-ID'));
  }
  let limit = 500;
  if (q.limit !== undefined) {
    limit = nonNegInt(q.limit, '$.query.limit');
    if (limit < 1 || limit > 1000) throw bad('$.query.limit', 'between 1 and 1000');
  }
  let types: Set<string> | null = null;
  if (q.type !== undefined) {
    types = new Set(q.type.split(',').filter((t) => t !== ''));
    for (const t of types)
      if (!(EVENT_TYPES as readonly string[]).includes(t))
        throw bad('$.query.type', `unknown event type ${t}`);
  }
  return { json: q.format === 'json', after, limit, types };
}

/** One SSE frame: the sequence number as `id`, so a client can resume with `Last-Event-ID`. */
function frame(ev: EventEnvelope): string {
  return `id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}

/** The final SSE frame, telling the client the stream is complete. */
function endFrame(end: StreamEndFrame): string {
  return `event: stream.end\ndata: ${JSON.stringify(end)}\n\n`;
}

interface OpenStream {
  close(reason: StreamEndFrame['reason'], lastSeq?: number): void;
}

/** Registers the SSE endpoint: replays stored events after `Last-Event-ID` (or `?after=`), then tails live ones, with heartbeats. */
export function registerStream(app: FastifyInstance, opts: StreamRouteOptions): void {
  const { store, bus } = opts;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const source = storeSource(store);
  const open = new Set<OpenStream>();

  app.addHook('preClose', (done) => {
    for (const s of [...open]) s.close('server-shutdown');
    done();
  });

  app.get<{ Params: { streamId: string }; Querystring: Record<string, string> }>(
    '/api/v1/streams/:streamId/events',
    (request, reply) => {
      const { streamId } = request.params;
      const isRun = streamId !== 'env' && streamId !== 'unattributed';
      if (isRun && !ULID_RE.test(streamId))
        throw bad('$.path.streamId', 'a run ULID, env or unattributed');
      const q = parseQuery(request);
      let terminalSeq: number | null = null;
      if (isRun) {
        const row = store.reader.getRunRow(streamId) as
          { state: string; last_seq: number } | undefined;
        if (!row)
          throw new ApiError('not_found', 'No such run.', { resource: 'run', id: streamId });
        if (row.state === 'completed' || row.state === 'failed' || row.state === 'cancelled')
          terminalSeq = row.last_seq;
      }
      const key = streamKeyOf(streamId);
      const keep = (ev: EventEnvelope): boolean => q.types === null || q.types.has(ev.type);

      if (q.json) {
        const raw = source(key, q.after, q.limit);
        const last = raw.length > 0 ? (raw[raw.length - 1] as EventEnvelope).seq : q.after;
        const closed =
          raw.some((e) => TERMINAL_TYPES.has(e.type)) ||
          (terminalSeq !== null && last >= terminalSeq);
        const page: EventPage = {
          streamId,
          events: raw.filter(keep),
          nextAfter: raw.length === q.limit && !closed ? last : null,
          closed,
        };
        return reply.header('Cache-Control', 'no-cache').send(page);
      }
      return serveSse(request, reply, { key: key, isRun, terminalSeq, keep, after: q.after });
    },
  );

  function serveSse(
    request: FastifyRequest,
    reply: FastifyReply,
    s: {
      key: ReturnType<typeof streamKeyOf>;
      isRun: boolean;
      terminalSeq: number | null;
      keep: (ev: EventEnvelope) => boolean;
      after: number;
    },
  ): FastifyReply {
    void reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Request-Id': String(request.id),
    });
    res.write('retry: 3000\n\n');
    let sub: Subscription | null = null;
    let ended = false;
    const hb = setInterval(() => {
      if (!ended) res.write(': hb\n\n');
    }, heartbeatMs);
    hb.unref();
    const handle: OpenStream = {
      close(reason, last) {
        if (ended) return;
        ended = true;
        clearInterval(hb);
        open.delete(handle);
        const lastSeq = last ?? sub?.position ?? s.after;
        sub?.close();
        if (!res.writableEnded) {
          if (reason !== 'closed') res.write(endFrame({ reason, lastSeq }));
          res.end();
        }
      },
    };
    open.add(handle);
    request.raw.on('close', () => {
      // the client went away: no frame, just stop
      if (ended) return;
      ended = true;
      clearInterval(hb);
      open.delete(handle);
      sub?.close();
    });
    // a closed run resumed at or after its terminal event: nothing left to send
    if (s.isRun && s.terminalSeq !== null && s.after >= s.terminalSeq) {
      handle.close('terminal', s.terminalSeq);
      return reply;
    }
    sub = bus.subscribe(s.key, s.after);
    const current = sub;
    void (async () => {
      for await (const ev of current) {
        if (ended) break;
        if (s.keep(ev)) res.write(frame(ev));
        if (s.isRun && TERMINAL_TYPES.has(ev.type)) {
          handle.close('terminal');
          break;
        }
      }
    })();
    return reply;
  }
}
