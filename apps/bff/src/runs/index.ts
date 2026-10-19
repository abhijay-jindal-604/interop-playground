/**
 * Read model of the run routes (API-21, API-22, API-26; 04 §3.2): the `Run` and `Step` DTOs built
 * from the store's projections. G-129: `runs.state = 'created'` is the API's `queued`.
 */
import type {
  CheckResult,
  FingerprintId,
  Run,
  RunListResponse,
  RunSpec,
  RunState,
  RunVerdict,
  Step,
} from '@interop-playground/api';
import { ApiError, issueDetails } from '../errors/index.js';
import type { Store } from '../store/index.js';
import type { SqlValue } from '../store/driver.js';
import { planRun } from '../orchestrator/flows.js';
import type { FlowTable } from '../orchestrator/flows.js';

type RunRow = {
  run_id: string;
  spec_json: string;
  state: string;
  started_at: string;
  ended_at: string | null;
  last_seq: number;
  parent_run_id: string | null;
  control_run_id: string | null;
  pinned: number;
  note: string | null;
  heavy_pruned_at: string | null;
  origin: 'local' | 'imported';
  counterfactual_result: Run['counterfactualResult'];
};

export function apiState(dbState: string): RunState {
  return dbState === 'created' ? 'queued' : (dbState as RunState);
}

export const isTerminal = (s: RunState): boolean =>
  s === 'completed' || s === 'failed' || s === 'cancelled';

function eventPayload<T>(
  store: Store,
  runId: string,
  type: string,
): { ts: string; payload: T } | null {
  const r = store.driver.get<{ ts: string; payload_json: string }>(
    'SELECT ts, payload_json FROM run_events WHERE run_id = ? AND type = ? ORDER BY seq DESC LIMIT 1',
    runId,
    type,
  );
  return r ? { ts: r.ts, payload: JSON.parse(r.payload_json) as T } : null;
}

export function toRun(store: Store, row: RunRow): Run {
  const runId = row.run_id;
  const spec = JSON.parse(row.spec_json) as RunSpec;
  const state = apiState(row.state);
  const created = eventPayload<{ label: string | null }>(store, runId, 'run.created');
  const started = eventPayload<{ startedAt: string }>(store, runId, 'run.started');
  const completed =
    state === 'completed'
      ? eventPayload<{ verdict: RunVerdict }>(store, runId, 'run.completed')
      : null;
  const failed =
    state === 'failed' ? eventPayload<{ errorCode: string }>(store, runId, 'run.failed') : null;
  const steps = store.driver.all<{ outcome: string | null; capture: string | null }>(
    'SELECT outcome, capture FROM steps WHERE run_id = ?',
    runId,
  );
  const count = (o: string): number => steps.filter((s) => s.outcome === o).length;
  const children = store.driver.all<{ run_id: string }>(
    'SELECT run_id FROM runs WHERE parent_run_id = ? ORDER BY run_id',
    runId,
  );
  return {
    runId,
    spec,
    label: created?.payload.label ?? null,
    state,
    createdAt: row.started_at,
    startedAt: started?.ts ?? null,
    finishedAt: row.ended_at,
    verdict: completed?.payload.verdict ?? null,
    errorCode: failed?.payload.errorCode ?? null,
    counterfactualResult: row.counterfactual_result,
    awaiting: null,
    uiDriven: spec.verifier === 'verifier.inji-verify-sdk',
    holderKeyId:
      store.driver.get<{ key_id: string }>(
        'SELECT key_id FROM run_keys WHERE run_id = ? LIMIT 1',
        runId,
      )?.key_id ?? null,
    pinned: row.pinned === 1,
    note: row.note,
    heavyPrunedAt: row.heavy_pruned_at,
    origin: row.origin,
    eventCount: row.last_seq,
    stepSummary: {
      total: steps.length,
      pass: count('pass'),
      fail: count('fail'),
      skipped: count('skipped'),
      partialOrNone: steps.filter(
        (s) => s.outcome !== 'skipped' && (s.capture === 'partial' || s.capture === 'none'),
      ).length,
    },
    links: {
      parentRunId: row.parent_run_id,
      controlRunId: row.control_run_id,
      childRunIds: children.map((c) => c.run_id),
    },
  };
}

export function getRunRow(store: Store, runId: string): RunRow {
  const row = store.driver.get<RunRow>('SELECT * FROM runs WHERE run_id = ?', runId);
  if (!row) throw new ApiError('not_found', 'No such run.', { resource: 'run', id: runId });
  return row;
}

export function getRun(store: Store, runId: string): Run {
  return toRun(store, getRunRow(store, runId));
}

// ---------- API-26 ----------
export function listSteps(store: Store, flows: FlowTable, runId: string): Step[] {
  const row = getRunRow(store, runId);
  const spec = JSON.parse(row.spec_json) as RunSpec;
  const done = new Map(
    store.driver
      .all<{
        step_key: string;
        outcome: Step['outcome'];
        capture: Step['capture'];
        reason: string | null;
        started_at: string | null;
        completed_at: string | null;
      }>('SELECT * FROM steps WHERE run_id = ?', runId)
      .map((s) => [s.step_key, s]),
  );
  const exchanges = store.driver.all<{ step_key: string; exchange_id: string }>(
    'SELECT step_key, exchange_id FROM exchanges WHERE run_id = ? ORDER BY req_seq',
    runId,
  );
  const artifacts = store.driver.all<{ step_key: string; artifact_id: string }>(
    'SELECT step_key, artifact_id FROM artifacts WHERE run_id = ? ORDER BY seq',
    runId,
  );
  const checks = store.driver.all<{
    step_key: string;
    check_id: string;
    outcome: CheckResult['outcome'];
    source: CheckResult['source'];
    code: string | null;
    message: string | null;
    spec_clause: string | null;
    exchange_ids_json: string;
    tamper_json: string | null;
  }>('SELECT * FROM checks WHERE run_id = ? ORDER BY seq', runId);
  const fps = store.driver.all<{ step_key: string | null; fingerprint_id: string }>(
    `SELECT e.step_key AS step_key, f.fingerprint_id AS fingerprint_id FROM fingerprint_matches f
       JOIN run_events e ON e.run_id = f.run_id AND e.seq = f.seq WHERE f.run_id = ? ORDER BY f.seq`,
    runId,
  );
  const durations = new Map(
    store.driver
      .all<{ step_key: string; payload_json: string }>(
        "SELECT step_key, payload_json FROM run_events WHERE run_id = ? AND type = 'step.completed'",
        runId,
      )
      .map((r) => [r.step_key, (JSON.parse(r.payload_json) as { durationMs: number }).durationMs]),
  );
  return planRun(flows, spec).map((p): Step => {
    const s = done.get(p.stepKey);
    const finished = s?.outcome !== null && s?.outcome !== undefined;
    return {
      stepKey: p.stepKey,
      order: p.order,
      flowId: p.flowId,
      state: s === undefined ? 'pending' : finished ? 'done' : 'running',
      outcome: s?.outcome ?? null,
      capture: s?.capture ?? null,
      skipReason: s?.outcome === 'skipped' ? s.reason : null,
      startedAt: s?.started_at ?? null,
      finishedAt: s?.completed_at ?? null,
      durationMs: finished ? (durations.get(p.stepKey) ?? null) : null,
      exchangeIds: exchanges.filter((x) => x.step_key === p.stepKey).map((x) => x.exchange_id),
      artifactIds: artifacts.filter((x) => x.step_key === p.stepKey).map((x) => x.artifact_id),
      checks: checks
        .filter((c) => c.step_key === p.stepKey)
        .map((c) => {
          const r: CheckResult = {
            checkId: c.check_id,
            outcome: c.outcome,
            source: c.source,
            exchangeIds: JSON.parse(c.exchange_ids_json) as string[],
          };
          if (c.code !== null) r.code = c.code;
          if (c.message !== null) r.message = c.message;
          if (c.spec_clause !== null) r.specClause = c.spec_clause;
          if (c.tamper_json !== null) r.tamper = JSON.parse(c.tamper_json) as CheckResult['tamper'];
          return r;
        }),
      fingerprintIds: fps
        .filter((f) => f.step_key === p.stepKey)
        .map((f) => f.fingerprint_id as FingerprintId),
    };
  });
}

// ---------- API-21 ----------
const LIST_KEYS = new Set([
  'limit',
  'cursor',
  'issuer',
  'wallet',
  'verifier',
  'format',
  'grant',
  'mode',
  'env',
  'state',
  'outcome',
  'kind',
  'version',
  'versionRole',
  'trigger',
  'hasCauseFingerprint',
  'pinned',
  'tamperCase',
  'hasTamper',
  'suiteId',
  'parentRunId',
  'derived',
  'from',
  'to',
]);
const BOOL = new Set(['true', 'false']);

function bad(path: string, message: string): ApiError {
  return new ApiError('validation_failed', undefined, issueDetails([{ path, message }]));
}

export function listRuns(store: Store, q: Record<string, string | undefined>): RunListResponse {
  const where: string[] = [];
  const args: SqlValue[] = [];
  for (const k of Object.keys(q))
    if (!LIST_KEYS.has(k)) throw bad(`$.query.${k}`, 'unknown parameter');
  const add = (sql: string, ...a: SqlValue[]): void => {
    where.push(sql);
    args.push(...a);
  };
  const bool = (k: string): boolean | undefined => {
    const v = q[k];
    if (v === undefined) return undefined;
    if (!BOOL.has(v)) throw bad(`$.query.${k}`, 'true or false');
    return v === 'true';
  };
  let limit = 50;
  if (q.limit !== undefined) {
    limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw bad('$.query.limit', 'between 1 and 200');
  }
  if (q.cursor !== undefined) {
    let c: [string, string];
    try {
      c = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as [string, string];
      if (!Array.isArray(c) || c.length !== 2) throw new Error('shape');
    } catch {
      throw bad('$.query.cursor', 'bad cursor');
    }
    add('(started_at < ? OR (started_at = ? AND run_id < ?))', c[0], c[0], c[1]);
  }
  for (const [k, col] of [
    ['issuer', 'issuer'],
    ['wallet', 'wallet'],
    ['verifier', 'verifier'],
    ['format', 'format'],
    ['grant', 'grant_type'],
    ['mode', 'presentation_mode'],
    ['tamperCase', 'tamper_case'],
    ['suiteId', 'suite_id'],
    ['parentRunId', 'parent_run_id'],
    ['outcome', 'outcome'],
  ] as const) {
    const v = q[k];
    if (v !== undefined) add(`${col} = ?`, v);
  }
  if (q.state !== undefined) add('state = ?', q.state === 'queued' ? 'created' : q.state);
  if (q.env !== undefined)
    add(
      "(json_extract(spec_json,'$.env.issuer') = ? OR json_extract(spec_json,'$.env.wallet') = ? OR json_extract(spec_json,'$.env.verifier') = ?)",
      q.env,
      q.env,
      q.env,
    );
  if (q.kind !== undefined) {
    if (q.kind === 'tamper') add('tamper_case IS NOT NULL');
    else if (q.kind === 'probe') add("tamper_case IS NULL AND presentation_mode = 'dc-api'");
    else if (q.kind === 'interop')
      add("tamper_case IS NULL AND coalesce(presentation_mode,'') <> 'dc-api'");
    else throw bad('$.query.kind', 'interop, tamper or probe');
  }
  if (q.trigger !== undefined)
    add('trigger_kind = ?', q.trigger === 'manual' ? 'interactive' : q.trigger);
  if (q.version !== undefined) {
    if (q.versionRole !== undefined)
      add(
        'EXISTS (SELECT 1 FROM run_versions v WHERE v.run_id = runs.run_id AND v.version_label = ? AND v.role = ?)',
        q.version,
        q.versionRole,
      );
    else
      add(
        'EXISTS (SELECT 1 FROM run_versions v WHERE v.run_id = runs.run_id AND v.version_label = ?)',
        q.version,
      );
  }
  const hc = bool('hasCauseFingerprint');
  if (hc !== undefined)
    add(hc ? 'cause_fingerprint_id IS NOT NULL' : 'cause_fingerprint_id IS NULL');
  const pinned = bool('pinned');
  if (pinned !== undefined) add('pinned = ?', pinned ? 1 : 0);
  const ht = bool('hasTamper');
  if (ht !== undefined) add(ht ? 'tamper_case IS NOT NULL' : 'tamper_case IS NULL');
  const der = bool('derived');
  if (der !== undefined) add(der ? 'parent_run_id IS NOT NULL' : 'parent_run_id IS NULL');
  if (q.from !== undefined) add('started_at >= ?', q.from);
  if (q.to !== undefined) add('started_at <= ?', q.to);
  const rows = store.driver.all<RunRow>(
    `SELECT * FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY started_at DESC, run_id DESC LIMIT ?`,
    ...args,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => toRun(store, r)),
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(JSON.stringify([last.started_at, last.run_id]), 'utf8').toString('base64url')
        : null,
  };
}
