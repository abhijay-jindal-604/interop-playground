/**
 * EventSink (02 §4.1, §6.2; 05 §4–§6; ADR-36, ADR-37): the ONLY writer of the event tables
 * (`run_events`, `blobs`, `artifacts`, `exchanges`, `checks`, `tamper_results`,
 * `unattributed_exchanges`, `env_events`; lint rule `sink-only-writer`).
 *
 * `append` runs, in one `BEGIN IMMEDIATE` transaction: redaction → caps → blob storage → the event
 * row → its projections. The projection code is the same function `rebuildProjections` replays, so a
 * rebuild reproduces the stored projections exactly (ADR-36).
 */
import type { RunSpec } from '@interop-playground/adapters';
import type { EventEnvelope, EventType, Headers, PayloadMap } from '@interop-playground/api';
import { SecretRegistry } from '../redact/registry.js';
import {
  canonicalJson,
  encodeBlob,
  prepareBody,
  toBodyRef,
  type PreparedBody,
  type RawBody,
  type StoredBodyRef,
} from './bodies.js';
import type { SqlDriver } from './driver.js';
import {
  BODY_SHA_HEADER,
  capHeaders,
  capPayload,
  capSummary,
  capUrl,
  cut,
  LIMITS,
} from './limits.js';
import { sha256Hex, StoreError } from './migrate.js';
import { diffSnapshots, snapshotProjections } from './reader.js';

// ---------- inputs ----------
type ExchangeRequestIn = Omit<PayloadMap['exchange.request'], 'body' | 'bodyState'> & {
  body: RawBody | null;
};
type ExchangeResponseIn = Omit<PayloadMap['exchange.response'], 'body' | 'bodyState'> & {
  body: RawBody | null;
};
type PlainType = Exclude<
  EventType,
  'exchange.request' | 'exchange.response' | 'run.created' | `env.${string}`
>;
/** an event as a capture point / the orchestrator hands it to the sink (bodies raw, no seq/ts) */
export type SinkEvent =
  | { type: 'exchange.request'; stepKey: string; payload: ExchangeRequestIn }
  | { type: 'exchange.response'; stepKey: string; payload: ExchangeResponseIn }
  | { [K in PlainType]: { type: K; stepKey?: string; payload: PayloadMap[K] } }[PlainType];

export type EnvEventType = Extract<EventType, `env.${string}`> | 'gateway.denied';

export interface NewSuite {
  suiteId: string;
  name: string;
  triggerKind: 'interactive' | 'nightly' | 'ci' | 'manual-suite';
  envClass: 'local' | 'collab' | 'mixed';
  gitSha?: string | null;
  appVersion: string;
}

export interface NewRun {
  runId: string;
  suiteId: string;
  triggerKind: 'interactive' | 'nightly' | 'ci' | 'derive';
  origin?: 'local' | 'imported';
  flowId: string;
  spec: RunSpec;
  specVersion?: number;
  label?: string | null;
  queuePosition?: number;
  /** computed by the orchestrator from the adapters' knob defaults */
  knobsAllDefault: boolean;
  targetStepKey: string;
  evidenceTier: 'automated' | 'best-effort' | 'manual';
  appVersion: string;
}

export interface NewArtifact {
  stepKey: string;
  kind:
    | 'credential'
    | 'credential-header'
    | 'mdoc-cbor'
    | 'x509-leaf'
    | 'did-document'
    | 'request-object'
    | 'token'
    | 'issuer-metadata'
    | 'vp-token'
    | 'tamper-before'
    | 'tamper-after';
  contentType: string;
  bytes: Uint8Array | string;
  sourceExchangeId?: string | null;
  tmpId?: string | null;
}

export interface NewUnattributed {
  port: number;
  actor: string;
  counterpart: string;
  method: string;
  url: string;
  status: number | null;
  requestHeaders: Headers;
  responseHeaders: Headers | null;
  requestBody: RawBody | null;
  responseBody: RawBody | null;
  durationMs: number | null;
}

export interface SinkOptions {
  registry?: SecretRegistry;
  now?: () => Date;
}

export interface RebuildResult {
  runs: number;
  events: number;
  /** rows that differ between the stored and the rebuilt projections (empty = identical) */
  differences: string[];
}

const TERMINAL = new Set(['run.completed', 'run.failed', 'run.cancelled']);
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
/** the "set once / frozen after terminal" triggers a rebuild lifts inside its own transaction */
const LIFECYCLE_TRIGGERS = ['runs_terminal_final', 'runs_cause_once', 'runs_cf_result_once'];

interface RunCaps {
  /** steps that lost an exchange or a body to a cap; their step.completed is downgraded */
  limitedSteps: Set<string>;
  anyLimited: boolean;
  bodyBytes: number;
  exchangeN: number;
  artifactN: number;
}

type StoredPayload = Record<string, unknown>;

class RollbackSignal extends Error {}

export class EventSink {
  readonly registry: SecretRegistry;
  private readonly now: () => Date;
  private readonly caps = new Map<string, RunCaps>();

  constructor(
    private readonly db: SqlDriver,
    opts: SinkOptions = {},
  ) {
    this.registry = opts.registry ?? new SecretRegistry();
    this.now = opts.now ?? (() => new Date());
  }

  private ts(): string {
    return this.now().toISOString();
  }

  private runCaps(runId: string): RunCaps {
    let c = this.caps.get(runId);
    if (!c) {
      const ex = this.db.get<{ n: number; bytes: number | null }>(
        `SELECT count(*) AS n,
           sum(CASE WHEN req_body_state IN ('stored','truncated') THEN min(coalesce(req_size,0), ?) ELSE 0 END +
               CASE WHEN resp_body_state IN ('stored','truncated') THEN min(coalesce(resp_size,0), ?) ELSE 0 END) AS bytes
         FROM exchanges WHERE run_id = ?`,
        LIMITS.bodyBytes,
        LIMITS.bodyBytes,
        runId,
      );
      const art = this.db.get<{ n: number }>(
        'SELECT count(*) AS n FROM artifacts WHERE run_id = ?',
        runId,
      );
      c = {
        limitedSteps: new Set(),
        anyLimited: false,
        bodyBytes: ex?.bytes ?? 0,
        exchangeN: ex?.n ?? 0,
        artifactN: art?.n ?? 0,
      };
      this.caps.set(runId, c);
    }
    return c;
  }

  private limit(runId: string, stepKey: string | undefined): void {
    const c = this.runCaps(runId);
    c.anyLimited = true;
    if (stepKey) c.limitedSteps.add(stepKey);
  }

  /** `<runId>:<n>` (04 §3.2 `CapturedMessage.exchangeId`) */
  nextExchangeId(runId: string): string {
    const c = this.runCaps(runId);
    c.exchangeN += 1;
    return `${runId}:${c.exchangeN}`;
  }

  // ---------- suites and runs ----------
  createSuite(s: NewSuite): void {
    this.db.run(
      `INSERT INTO suites (suite_id, name, trigger_kind, env_class, git_sha, app_version, state, started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
      s.suiteId,
      this.registry.redactString(s.name),
      s.triggerKind,
      s.envClass,
      s.gitSha ?? null,
      s.appVersion,
      this.ts(),
    );
  }

  /** inserts the run row, its `run_versions` and `run.created` (seq 1) in one transaction (05 §4.1) */
  createRun(n: NewRun): EventEnvelope<'run.created'> {
    const spec = this.registry.redactDeep(n.spec);
    const specJson = canonicalJson(spec);
    if (specJson.length > LIMITS.runSpecJsonChars) {
      throw new StoreError(
        'spec_too_large',
        `RunSpec is ${specJson.length} characters (cap 16 KiB)`,
      );
    }
    const controlJson = canonicalJson({
      ...spec,
      tamperCase: null,
      parentRunId: null,
      knobDelta: null,
    });
    const knobDelta = spec.knobDelta
      ? canonicalJson({ ...spec.knobDelta, causeFingerprintId: spec.causeFingerprintId })
      : null;
    const ts = this.ts();
    const payload = {
      spec,
      label: n.label ? this.registry.redactString(n.label) : null,
      queuePosition: n.queuePosition ?? 0,
    };
    return this.db.transaction(() => {
      this.db.run(
        `INSERT INTO runs (run_id, suite_id, trigger_kind, origin, flow_id, spec_version, spec_json, spec_hash,
           control_key, versions_key, parent_run_id, control_run_id, knob_delta_json, knobs_all_default,
           target_step_key, evidence_tier, started_at, app_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        n.runId,
        n.suiteId,
        n.triggerKind,
        n.origin ?? 'local',
        n.flowId,
        n.specVersion ?? 1,
        specJson,
        sha256Hex(specJson),
        sha256Hex(controlJson),
        versionsKey(spec),
        spec.parentRunId,
        spec.controlRunId,
        knobDelta,
        n.knobsAllDefault ? 1 : 0,
        n.targetStepKey,
        n.evidenceTier,
        ts,
        n.appVersion,
      );
      this.insertRunVersions(n.runId, spec);
      const stored = payload as unknown as StoredPayload;
      this.insertEvent(n.runId, 1, ts, 'run.created', null, stored);
      this.project(n.runId, 1, ts, 'run.created', null, stored);
      return { v: 1, runId: n.runId, seq: 1, ts, type: 'run.created', payload };
    });
  }

  private insertRunVersions(runId: string, spec: RunSpec): void {
    for (const role of ['issuer', 'wallet', 'verifier'] as const) {
      const v = spec.versions[role];
      this.db.run(
        'INSERT INTO run_versions (run_id, role, component, version_label, fingerprint) VALUES (?, ?, ?, ?, ?)',
        runId,
        role,
        spec[role],
        v,
        v,
      );
    }
  }

  // ---------- the run event log ----------
  /**
   * Appends one event (redacted, capped) and its projections in one transaction. Returns the wire
   * envelope (bodies inlined up to 64 KiB) for the bus, or `null` when the 4,000-event cap dropped an
   * `exchange.*` event (05 §5). Throws `run_closed` after the terminal event (02 §4.1).
   */
  append(runId: string, ev: SinkEvent): EventEnvelope | null {
    return this.db.transaction(() => {
      const run = this.db.get<{ state: string; last_seq: number }>(
        'SELECT state, last_seq FROM runs WHERE run_id = ?',
        runId,
      );
      if (!run) throw new StoreError('run_unknown', `unknown run ${runId}`);
      if (TERMINAL_STATES.has(run.state)) {
        throw new StoreError(
          'run_closed',
          `run ${runId} is closed; its log is append-only and final`,
        );
      }
      const stepKey = ev.stepKey ?? null;
      if (ev.type.startsWith('exchange.') && run.last_seq >= LIMITS.eventsPerRun) {
        this.limit(runId, stepKey ?? undefined);
        return null;
      }
      const seq = run.last_seq + 1;
      const ts = this.ts();
      const { stored, wire } = this.preparePayload(runId, ev);
      this.insertEvent(runId, seq, ts, ev.type, stepKey, stored);
      this.project(runId, seq, ts, ev.type, stepKey, stored);
      if (TERMINAL.has(ev.type)) this.caps.delete(runId);
      const env: EventEnvelope = {
        v: 1,
        runId,
        seq,
        ts,
        type: ev.type,
        payload: wire as never,
      };
      if (stepKey !== null) env.stepKey = stepKey;
      return env;
    });
  }

  private insertEvent(
    runId: string,
    seq: number,
    ts: string,
    type: string,
    stepKey: string | null,
    payload: StoredPayload,
  ): void {
    this.db.run(
      'INSERT INTO run_events (run_id, seq, envelope_v, ts, type, step_key, payload_json) VALUES (?, ?, 1, ?, ?, ?, ?)',
      runId,
      seq,
      ts,
      type,
      stepKey,
      JSON.stringify(payload),
    );
  }

  private putBlob(stored: Buffer): void {
    const b = encodeBlob(stored);
    this.db.run(
      'INSERT OR IGNORE INTO blobs (sha256, raw_size, enc, data, created_at) VALUES (?, ?, ?, ?, ?)',
      b.sha256,
      b.rawSize,
      b.enc,
      b.data,
      this.ts(),
    );
  }

  /** body → blob + ref, under the per-run 24 MiB budget (05 §5) */
  private storeBody(
    runId: string,
    stepKey: string | undefined,
    raw: RawBody | null,
  ): {
    ref: StoredBodyRef | null;
    prepared: PreparedBody | null;
    state: 'none' | 'stored' | 'dropped_run_cap';
  } {
    if (!raw) return { ref: null, prepared: null, state: 'none' };
    const prepared = prepareBody(raw, this.registry);
    const c = this.runCaps(runId);
    if (c.bodyBytes + prepared.stored.length > LIMITS.bodyBytesPerRun) {
      this.limit(runId, stepKey);
      return { ref: null, prepared: null, state: 'dropped_run_cap' };
    }
    c.bodyBytes += prepared.stored.length;
    this.putBlob(prepared.stored);
    return { ref: prepared.ref, prepared, state: 'stored' };
  }

  private preparePayload(
    runId: string,
    ev: SinkEvent,
  ): { stored: StoredPayload; wire: StoredPayload } {
    const reg = this.registry;
    switch (ev.type) {
      case 'exchange.request':
      case 'exchange.response': {
        const { body, ...rest } = ev.payload;
        const meta = reg.redactDeep(rest) as Record<string, unknown> & { headers: Headers };
        const b = this.storeBody(runId, ev.stepKey, body);
        const headers = capHeaders(meta.headers);
        if (b.prepared?.ref.truncated) headers.push([BODY_SHA_HEADER, b.prepared.fullSha256]);
        const base: StoredPayload = { ...meta, headers };
        if (ev.type === 'exchange.request') base.url = capUrl(String(meta.url));
        const stored = capPayload({ ...base, body: b.ref, bodyState: b.state });
        const wire = {
          ...stored,
          body: b.prepared
            ? toBodyRef(b.prepared.ref, b.prepared.stored, b.prepared.fullSha256)
            : null,
        };
        return { stored, wire };
      }
      case 'engine.call': {
        const p = reg.redactDeep(ev.payload);
        const stored = capPayload({
          ...p,
          inputSummary: capSummary(p.inputSummary),
          outputSummary: capSummary(p.outputSummary),
        });
        return { stored, wire: stored };
      }
      case 'verdict.check': {
        const p = reg.redactDeep(ev.payload);
        const check = { ...p.check };
        if (check.message !== undefined)
          check.message = cut(check.message, LIMITS.checkMessageChars);
        const stored = capPayload({ ...p, check });
        return { stored, wire: stored };
      }
      case 'step.completed': {
        const p: StoredPayload = { ...reg.redactDeep(ev.payload) };
        const c = this.runCaps(runId);
        if (ev.stepKey && c.limitedSteps.has(ev.stepKey)) {
          if (p.capture === 'full') p.capture = 'partial';
          p.coverageNote ??= 'capture limit reached (05 §5)';
          p.captureLimited = true;
        }
        const stored = capPayload(p);
        return { stored, wire: stored };
      }
      default: {
        const p: StoredPayload = { ...(reg.redactDeep(ev.payload) as object) };
        if (TERMINAL.has(ev.type) && this.runCaps(runId).anyLimited) p.captureLimited = true;
        const stored = capPayload(p);
        return { stored, wire: stored };
      }
    }
  }

  // ---------- projections (live append and rebuild share this function) ----------
  private project(
    runId: string,
    seq: number,
    ts: string,
    type: string,
    stepKey: string | null,
    p: StoredPayload,
  ): void {
    const db = this.db;
    switch (type) {
      case 'run.started':
        db.run("UPDATE runs SET state = 'running' WHERE run_id = ?", runId);
        break;
      case 'step.started':
        db.run(
          `INSERT OR IGNORE INTO steps (run_id, step_key, ordinal, started_at)
           VALUES (?, ?, (SELECT count(*) + 1 FROM steps WHERE run_id = ?), ?)`,
          runId,
          stepKey ?? '',
          runId,
          ts,
        );
        break;
      case 'step.completed':
        db.run(
          `INSERT INTO steps (run_id, step_key, ordinal, outcome, capture, reason, completed_at)
           VALUES (?, ?, (SELECT count(*) + 1 FROM steps WHERE run_id = ?), ?, ?, ?, ?)
           ON CONFLICT (run_id, step_key) DO UPDATE SET
             outcome = excluded.outcome, capture = excluded.capture, reason = excluded.reason,
             completed_at = excluded.completed_at`,
          runId,
          stepKey ?? '',
          runId,
          str(p.outcome),
          str(p.capture),
          str(p.skipReason),
          ts,
        );
        break;
      case 'exchange.request': {
        const ref = p.body as StoredBodyRef | null;
        const poll = p.poll as { group: string; index: number } | null;
        let coalesced = 1;
        if (poll) {
          const prev = db.get<{ i: number | null }>(
            `SELECT max(json_extract(payload_json, '$.poll.index')) AS i FROM run_events
             WHERE run_id = ? AND type = 'exchange.request' AND step_key IS ? AND seq < ?
               AND json_extract(payload_json, '$.poll.group') = ?`,
            runId,
            stepKey,
            seq,
            poll.group,
          );
          coalesced = Math.max(1, poll.index - (prev?.i ?? 0));
        }
        db.run(
          `INSERT INTO exchanges (run_id, exchange_id, step_key, direction, actor, counterpart, method, url,
             req_headers_json, req_blob_sha, req_size, req_truncated, req_body_state, content_type,
             req_seq, started_at, coalesced_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          runId,
          String(p.exchangeId),
          stepKey ?? '',
          String(p.direction),
          String(p.actor),
          String(p.counterpart),
          String(p.method),
          String(p.url),
          JSON.stringify(p.headers),
          ref?.$blob ?? null,
          ref?.size ?? null,
          ref?.truncated ? 1 : 0,
          bodyState(ref, p.bodyState),
          headerValue(p.headers, 'content-type'),
          seq,
          ts,
          coalesced,
        );
        db.run(
          'UPDATE steps SET exchange_count = exchange_count + 1 WHERE run_id = ? AND step_key = ?',
          runId,
          stepKey ?? '',
        );
        break;
      }
      case 'exchange.response': {
        const ref = p.body as StoredBodyRef | null;
        db.run(
          `UPDATE exchanges SET status = ?, resp_headers_json = ?, resp_blob_sha = ?, resp_size = ?,
             resp_truncated = ?, resp_body_state = ?, content_type = coalesce(?, content_type),
             resp_seq = ?, duration_ms = ?
           WHERE run_id = ? AND exchange_id = ?`,
          num(p.status),
          JSON.stringify(p.headers),
          ref?.$blob ?? null,
          ref?.size ?? null,
          ref?.truncated ? 1 : 0,
          bodyState(ref, p.bodyState),
          headerValue(p.headers, 'content-type'),
          seq,
          num(p.durationMs),
          runId,
          String(p.exchangeId),
        );
        break;
      }
      case 'exchange.error':
        db.run(
          'UPDATE exchanges SET error_class = ?, resp_seq = ?, duration_ms = ? WHERE run_id = ? AND exchange_id = ?',
          String(p.errorClass),
          seq,
          num(p.durationMs),
          runId,
          String(p.exchangeId),
        );
        break;
      case 'verdict.check': {
        const c = p.check as Record<string, unknown>;
        db.run(
          `INSERT INTO checks (run_id, seq, step_key, check_id, outcome, source, code, message, spec_clause,
             exchange_ids_json, tamper_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          runId,
          seq,
          stepKey ?? '',
          String(c.checkId),
          String(c.outcome),
          String(c.source),
          str(c.code),
          str(c.message),
          str(c.specClause),
          JSON.stringify(c.exchangeIds ?? []),
          c.tamper === undefined ? null : JSON.stringify(c.tamper),
        );
        break;
      }
      case 'fingerprint.matched':
        db.run(
          `INSERT INTO fingerprint_matches (run_id, seq, fingerprint_id, fingerprint_version, title, component_json,
             gap_ids_json, confidence, role, deviating_side, spec_clause, evidence_sids_json,
             matched_exchange_ids_json, matched_event_seqs_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          runId,
          seq,
          String(p.fingerprintId),
          num(p.fingerprintVersion) ?? 1,
          String(p.title),
          JSON.stringify(p.component ?? {}),
          JSON.stringify(p.gapIds ?? []),
          String(p.confidence),
          String(p.role),
          String(p.deviatingSide),
          str(p.specClause),
          JSON.stringify(p.evidenceSIds ?? []),
          JSON.stringify(p.matchedExchangeIds ?? []),
          JSON.stringify(p.matchedEventSeqs ?? []),
        );
        break;
      case 'counterfactual.offered':
        db.run(
          `UPDATE fingerprint_matches SET offer_json = ?
           WHERE run_id = ? AND seq = (SELECT max(seq) FROM fingerprint_matches WHERE run_id = ? AND fingerprint_id = ?)`,
          JSON.stringify(p),
          runId,
          runId,
          String(p.fingerprintId),
        );
        break;
      case 'run.completed': {
        const v = p.verdict as { outcome: string; failedStepKey: string | null };
        const cause =
          v.outcome === 'fail' || v.outcome === 'blocked'
            ? db.all<{ f: string }>(
                "SELECT fingerprint_id AS f FROM fingerprint_matches WHERE run_id = ? AND confidence = 'exact' AND role = 'cause'",
                runId,
              )
            : [];
        db.run(
          `UPDATE runs SET state = 'completed', outcome = ?, failed_step_key = ?, ended_at = ?,
             duration_ms = CAST(round((julianday(?) - julianday(started_at)) * 86400000) AS INTEGER),
             cause_fingerprint_id = ?, counterfactual_result = ?
           WHERE run_id = ?`,
          v.outcome,
          v.failedStepKey ?? null,
          ts,
          ts,
          cause.length === 1 ? (cause[0]?.f ?? null) : null,
          str(p.counterfactualResult),
          runId,
        );
        break;
      }
      case 'run.failed':
        db.run(
          `UPDATE runs SET state = 'failed', outcome = 'inconclusive', outcome_reason = ?, failed_step_key = ?,
             ended_at = ?, duration_ms = CAST(round((julianday(?) - julianday(started_at)) * 86400000) AS INTEGER)
           WHERE run_id = ?`,
          p.errorCode === 'bff_restart' ? 'bff_restart' : 'environment',
          str(p.stepKey),
          ts,
          ts,
          runId,
        );
        break;
      case 'run.cancelled':
        db.run(
          `UPDATE runs SET state = 'cancelled', ended_at = ?,
             duration_ms = CAST(round((julianday(?) - julianday(started_at)) * 86400000) AS INTEGER)
           WHERE run_id = ?`,
          ts,
          ts,
          runId,
        );
        break;
      default:
        break;
    }
    const limited = p.captureLimited === true || p.bodyState === 'dropped_run_cap';
    db.run(
      `UPDATE runs SET last_seq = ?${limited ? ', capture_limited = 1' : ''} WHERE run_id = ?`,
      seq,
      runId,
    );
  }

  // ---------- artifacts, environment, unattributed ----------
  /**
   * Stores an extracted artifact (05 §4.3, cap 1 MiB). Over the cap nothing is stored, the step is
   * downgraded to `partial` and `null` is returned.
   */
  putArtifact(runId: string, a: NewArtifact): string | null {
    return this.db.transaction(() => {
      const run = this.db.get<{ last_seq: number }>(
        'SELECT last_seq FROM runs WHERE run_id = ?',
        runId,
      );
      if (!run) throw new StoreError('run_unknown', `unknown run ${runId}`);
      const prepared = prepareBody({ bytes: a.bytes, contentType: a.contentType }, this.registry);
      if (prepared.ref.size > LIMITS.artifactBytes) {
        this.limit(runId, a.stepKey);
        return null;
      }
      this.putBlob(prepared.stored);
      const c = this.runCaps(runId);
      c.artifactN += 1;
      const id = `${runId}:a${c.artifactN}`;
      const light = a.kind === 'tamper-before' || a.kind === 'tamper-after';
      this.db.run(
        `INSERT INTO artifacts (artifact_id, run_id, step_key, kind, source_exchange_id, tmp_id, content_type,
           blob_sha, size, tier, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        runId,
        a.stepKey,
        a.kind,
        a.sourceExchangeId ?? null,
        a.tmpId ?? null,
        a.contentType,
        prepared.ref.$blob,
        prepared.ref.size,
        light ? 'light' : 'heavy',
        run.last_seq,
      );
      return id;
    });
  }

  /** the `env` stream (02 §4.3): returns the envelope with its seq */
  appendEnv<T extends EnvEventType>(type: T, payload: PayloadMap[T]): EventEnvelope<T> {
    const stored = capPayload({ ...(this.registry.redactDeep(payload) as object) });
    const ts = this.ts();
    return this.db.transaction(() => {
      this.db.run(
        'INSERT INTO env_events (ts, type, payload_json) VALUES (?, ?, ?)',
        ts,
        type,
        JSON.stringify(stored),
      );
      const seq = Number(this.db.get<{ id: number }>('SELECT last_insert_rowid() AS id')?.id ?? 0);
      return { v: 1, runId: 'env', seq, ts, type, payload: stored as PayloadMap[T] };
    });
  }

  /** gateway traffic that matched no run (02 §3.3): same redaction and body caps, 24 h retention */
  appendUnattributed(x: NewUnattributed): number {
    return this.db.transaction(() => {
      const bodies = [x.requestBody, x.responseBody].map((raw) => {
        if (!raw) return null;
        const p = prepareBody(raw, this.registry);
        this.putBlob(p.stored);
        return p.ref.$blob;
      });
      const reg = this.registry;
      this.db.run(
        `INSERT INTO unattributed_exchanges (received_at, port, actor, counterpart, method, url, status,
           req_headers_json, resp_headers_json, req_blob_sha, resp_blob_sha, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        this.ts(),
        x.port,
        x.actor,
        x.counterpart,
        x.method,
        capUrl(reg.redactString(x.url)),
        x.status,
        JSON.stringify(capHeaders(reg.redactDeep(x.requestHeaders))),
        x.responseHeaders ? JSON.stringify(capHeaders(reg.redactDeep(x.responseHeaders))) : null,
        bodies[0] ?? null,
        bodies[1] ?? null,
        x.durationMs,
      );
      return Number(this.db.get<{ id: number }>('SELECT last_insert_rowid() AS id')?.id ?? 0);
    });
  }

  // ---------- rebuild (ADR-36, `store rebuild-projections`) ----------
  /**
   * Deletes and replays the projections (`steps`, `exchanges`, `checks`, `fingerprint_matches`,
   * `run_versions`, run lifecycle columns) from `run_events`, in one transaction. The lifecycle
   * triggers are lifted for the duration of that transaction only. `dryRun` rolls back and only
   * reports the differences. `tamper_results` is written by the tamper engine (T-later), not replayed.
   */
  rebuildProjections(opts: { runId?: string; dryRun?: boolean } = {}): RebuildResult {
    const db = this.db;
    let result: RebuildResult = { runs: 0, events: 0, differences: [] };
    try {
      db.transaction(() => {
        const runIds = opts.runId
          ? db.all<{ run_id: string }>('SELECT run_id FROM runs WHERE run_id = ?', opts.runId)
          : db.all<{ run_id: string }>('SELECT run_id FROM runs ORDER BY run_id');
        const ids = runIds.map((r) => r.run_id);
        const before = snapshotProjections(db, ids);
        const triggers = db.all<{ name: string; sql: string }>(
          `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${LIFECYCLE_TRIGGERS.map(() => '?').join(',')})`,
          ...LIFECYCLE_TRIGGERS,
        );
        for (const t of triggers) db.exec(`DROP TRIGGER ${t.name}`);
        let events = 0;
        for (const runId of ids) {
          for (const table of [
            'steps',
            'exchanges',
            'checks',
            'fingerprint_matches',
            'run_versions',
          ]) {
            db.run(`DELETE FROM ${table} WHERE run_id = ?`, runId);
          }
          db.run(
            `UPDATE runs SET state = 'created', outcome = NULL, outcome_reason = NULL, failed_step_key = NULL,
               capture_limited = 0, last_seq = 0, ended_at = NULL, duration_ms = NULL,
               cause_fingerprint_id = NULL, counterfactual_result = NULL
             WHERE run_id = ?`,
            runId,
          );
          const spec = db.get<{ spec_json: string }>(
            'SELECT spec_json FROM runs WHERE run_id = ?',
            runId,
          );
          if (spec) this.insertRunVersions(runId, JSON.parse(spec.spec_json) as RunSpec);
          const rows = db.all<{
            seq: number;
            ts: string;
            type: string;
            step_key: string | null;
            payload_json: string;
          }>(
            'SELECT seq, ts, type, step_key, payload_json FROM run_events WHERE run_id = ? ORDER BY seq',
            runId,
          );
          for (const r of rows) {
            this.project(
              runId,
              r.seq,
              r.ts,
              r.type,
              r.step_key,
              JSON.parse(r.payload_json) as StoredPayload,
            );
          }
          events += rows.length;
        }
        for (const t of triggers) db.exec(t.sql);
        const after = snapshotProjections(db, ids);
        result = { runs: ids.length, events, differences: diffSnapshots(before, after) };
        if (opts.dryRun) throw new RollbackSignal();
      });
    } catch (err) {
      if (!(err instanceof RollbackSignal)) throw err;
    }
    this.caps.clear();
    return result;
  }
}

// ---------- helpers ----------
function versionsKey(spec: RunSpec): string {
  const tuples = (['issuer', 'wallet', 'verifier'] as const)
    .map((role) => [role, spec[role], spec.versions[role], spec.versions[role]].join('\u001f'))
    .sort();
  return sha256Hex(tuples.join('\u001e'));
}

function bodyState(ref: StoredBodyRef | null, state: unknown): string {
  if (ref) return ref.truncated ? 'truncated' : 'stored';
  return state === 'dropped_run_cap' ? 'dropped_run_cap' : 'none';
}

function headerValue(headers: unknown, name: string): string | null {
  if (!Array.isArray(headers)) return null;
  const h = (headers as [string, string][]).find(([n]) => n.toLowerCase() === name);
  return h ? h[1] : null;
}

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return `${v}`;
  return JSON.stringify(v) ?? null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
