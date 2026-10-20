/**
 * Store readers of the three stream kinds (04 §7.4), SELECT only.
 *
 *  - `run:<id>`     `run_events` (dense `seq`, bodies re-inlined by StoreReader.readEvents)
 *  - `env`          `env_events` (its AUTOINCREMENT `seq`); this table also holds `gateway.denied`,
 *                   which therefore travels on the `env` stream (ADR-64)
 *  - `unattributed` `unattributed_exchanges`: row `id` n is the pair `exchange.request` (seq 2n-1) and
 *                   `exchange.response` / `exchange.error` (seq 2n) (ADR-64)
 */
import type { BodyRef, BodyState, EventEnvelope, Headers } from '@interop-playground/api';
import { createHash } from 'node:crypto';
import type { Store } from '../store/index.js';
import type { StreamKey, StreamSource } from './bus.js';

type UnattributedRow = {
  id: number;
  received_at: string;
  port: number;
  actor: string;
  counterpart: string;
  method: string;
  url: string;
  status: number | null;
  req_headers_json: string;
  resp_headers_json: string | null;
  req_blob_sha: string | null;
  resp_blob_sha: string | null;
  duration_ms: number | null;
};

function inlineBody(store: Store, sha: string | null): { body: BodyRef | null; state: BodyState } {
  if (sha === null) return { body: null, state: 'none' };
  const bytes = store.reader.getBlob(sha);
  if (!bytes) return { body: null, state: 'pruned' };
  const text = bytes.toString('utf8');
  const utf8 = Buffer.from(text, 'utf8').equals(bytes);
  const cut = 64 * 1024;
  const slice = bytes.subarray(0, cut);
  return {
    body: {
      encoding: utf8 ? 'utf8' : 'base64',
      text: utf8 ? slice.toString('utf8') : slice.toString('base64'),
      size: bytes.length,
      truncated: bytes.length > cut,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    state: 'stored',
  };
}

/** Turns a stored unattributed exchange into the request and response events the stream carries. */
export function unattributedEvents(store: Store, row: UnattributedRow): EventEnvelope[] {
  const exchangeId = `unattributed:${row.id}`;
  const req = inlineBody(store, row.req_blob_sha);
  const base = { v: 1 as const, runId: 'unattributed', ts: row.received_at };
  const out: EventEnvelope[] = [
    {
      ...base,
      seq: 2 * row.id - 1,
      type: 'exchange.request',
      payload: {
        exchangeId,
        direction: 'inbound',
        actor: row.actor,
        counterpart: row.counterpart,
        method: row.method,
        url: row.url,
        headers: JSON.parse(row.req_headers_json) as Headers,
        body: req.body,
        bodyState: req.state,
        poll: null,
      },
    },
  ];
  if (row.status === null) {
    out.push({
      ...base,
      seq: 2 * row.id,
      type: 'exchange.error',
      payload: {
        exchangeId,
        errorClass: 'upstream',
        message: 'no upstream response',
        durationMs: row.duration_ms ?? 0,
      },
    });
  } else {
    const resp = inlineBody(store, row.resp_blob_sha);
    out.push({
      ...base,
      seq: 2 * row.id,
      type: 'exchange.response',
      payload: {
        exchangeId,
        status: row.status,
        statusText: null,
        headers: row.resp_headers_json ? (JSON.parse(row.resp_headers_json) as Headers) : [],
        body: resp.body,
        bodyState: resp.state,
        durationMs: row.duration_ms ?? 0,
        poll: null,
      },
    });
  }
  return out;
}

/** Reads one unattributed-exchange row by id. */
export function readUnattributedRow(store: Store, id: number): UnattributedRow | undefined {
  return store.driver.get<UnattributedRow>('SELECT * FROM unattributed_exchanges WHERE id = ?', id);
}

/** the StreamSource over one store */
export function storeSource(store: Store): StreamSource {
  return (key: StreamKey, after: number, limit: number): EventEnvelope[] => {
    if (key === 'env') {
      const rows = store.driver.all<{
        seq: number;
        ts: string;
        type: string;
        payload_json: string;
      }>(
        'SELECT seq, ts, type, payload_json FROM env_events WHERE seq > ? ORDER BY seq LIMIT ?',
        after,
        limit,
      );
      return rows.map((r) => ({
        v: 1,
        runId: 'env',
        seq: r.seq,
        ts: r.ts,
        type: r.type as EventEnvelope['type'],
        payload: JSON.parse(r.payload_json) as never,
      }));
    }
    if (key === 'unattributed') {
      const rows = store.driver.all<UnattributedRow>(
        'SELECT * FROM unattributed_exchanges WHERE id > ? ORDER BY id LIMIT ?',
        Math.floor(after / 2),
        Math.ceil(limit / 2) + 1,
      );
      return rows
        .flatMap((r) => unattributedEvents(store, r))
        .filter((e) => e.seq > after)
        .slice(0, limit);
    }
    return store.reader.readEvents(key.slice(4), after, limit);
  };
}
