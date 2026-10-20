/**
 * Read side of the store (SELECT only): event replay with bodies re-inlined (02 §4.3, 05 §4.3),
 * blob reads, and the projection snapshots the rebuild check compares (ADR-36).
 */
import type { EventEnvelope } from '@interop-playground/api';
import { decodeBlob, toBodyRef, type StoredBodyRef } from './bodies.js';
import type { Row, SqlDriver } from './driver.js';
import { BODY_SHA_HEADER } from './limits.js';

export type ProjectionSnapshot = Record<string, string[]>;

const PROJECTIONS: { table: string; cols: string; order: string }[] = [
  {
    table: 'runs',
    cols: 'run_id, state, outcome, outcome_reason, failed_step_key, capture_limited, last_seq, ended_at, duration_ms, cause_fingerprint_id, counterfactual_result',
    order: 'run_id',
  },
  { table: 'run_versions', cols: '*', order: 'run_id, role' },
  { table: 'steps', cols: '*', order: 'run_id, step_key' },
  { table: 'exchanges', cols: '*', order: 'run_id, exchange_id' },
  { table: 'checks', cols: '*', order: 'run_id, seq' },
  { table: 'fingerprint_matches', cols: '*', order: 'run_id, seq' },
];

/** canonical text of every projection row of the given runs, per table */
export function snapshotProjections(db: SqlDriver, runIds: string[]): ProjectionSnapshot {
  const out: ProjectionSnapshot = {};
  const ids = new Set(runIds);
  for (const p of PROJECTIONS) {
    out[p.table] = db
      .all(`SELECT ${p.cols} FROM ${p.table} ORDER BY ${p.order}`)
      .filter((r) => ids.has(String(r.run_id)))
      .map((r) => JSON.stringify(r));
  }
  return out;
}

/** Lists the differences between two projection snapshots; empty means a replay reproduced the same rows. */
export function diffSnapshots(a: ProjectionSnapshot, b: ProjectionSnapshot): string[] {
  const diffs: string[] = [];
  for (const table of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = new Set(a[table] ?? []);
    const y = new Set(b[table] ?? []);
    for (const r of x) if (!y.has(r)) diffs.push(`${table}: stored row not rebuilt: ${r}`);
    for (const r of y) if (!x.has(r)) diffs.push(`${table}: rebuilt row not stored: ${r}`);
  }
  return diffs;
}

/** Read-only queries over the store; re-inlines stored bodies so callers get complete events. */
export class StoreReader {
  constructor(private readonly db: SqlDriver) {}

  getRunRow(runId: string): Row | undefined {
    return this.db.get('SELECT * FROM runs WHERE run_id = ?', runId);
  }

  /** decompressed stored bytes of a blob, or null when pruned / absent */
  getBlob(sha256: string): Buffer | null {
    const b = this.db.get<{ enc: string; data: Uint8Array }>(
      'SELECT enc, data FROM blobs WHERE sha256 = ?',
      sha256,
    );
    return b ? decodeBlob(b.enc, b.data) : null;
  }

  /**
   * Run stream replay (04 §7.1): events with `seq > after`, bodies re-inlined up to 64 KiB; a body
   * whose blob is gone is `body: null, bodyState: 'pruned'` (05 §4.3).
   */
  readEvents(runId: string, after = 0, limit = 500): EventEnvelope[] {
    const rows = this.db.all<{
      seq: number;
      ts: string;
      type: string;
      step_key: string | null;
      payload_json: string;
    }>(
      'SELECT seq, ts, type, step_key, payload_json FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      runId,
      after,
      limit,
    );
    return rows.map((r) => {
      const payload = JSON.parse(r.payload_json) as Record<string, unknown>;
      delete payload.captureLimited;
      if (r.type === 'exchange.request' || r.type === 'exchange.response') {
        const ref = payload.body as StoredBodyRef | null;
        if (ref) {
          const stored = this.getBlob(ref.$blob);
          if (stored) {
            const full = ref.truncated ? headerValue(payload.headers, BODY_SHA_HEADER) : ref.$blob;
            payload.body = toBodyRef(ref, stored, full ?? ref.$blob);
          } else {
            payload.body = null;
            payload.bodyState = 'pruned';
          }
        }
      }
      const env: EventEnvelope = {
        v: 1,
        runId,
        seq: r.seq,
        ts: r.ts,
        type: r.type as EventEnvelope['type'],
        payload: payload as never,
      };
      if (r.step_key !== null) env.stepKey = r.step_key;
      return env;
    });
  }
}

function headerValue(headers: unknown, name: string): string | null {
  if (!Array.isArray(headers)) return null;
  const h = (headers as [string, string][]).find(([n]) => n === name);
  return h ? h[1] : null;
}
