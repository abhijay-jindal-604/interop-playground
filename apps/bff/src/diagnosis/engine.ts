/**
 * Diagnosis engine C12 (plan/12 T-41; 02 §7, 09 A1–A3, A6, ADR-26). Pure evaluation of the
 * fingerprint library over a run's evidence (`evidence.ts`), plus `DiagnosisEngine`, which reads
 * the persisted run and appends the diagnosis events through the sink at run close (ADR-80).
 *
 * Rules kept here:
 *  - candidates: `status: active` fingerprints whose `scope` matches the RunSpec (A3.1);
 *  - predicates read only full evidence (A3.2). A fingerprint that holds only when partial / none
 *    hops are admitted is reported `confidence: observed`, never `exact` (A6, RISK-22); so are
 *    `evidenceClass: observed-only` fingerprints and rules with a `manual` predicate;
 *  - `run-failed` fingerprints are evaluated for the failed step equal to their `stepKey`,
 *    `always` ones on every closed run, `environment` ones on runs ending `run.failed` (A3.3);
 *  - one full-evidence cause → `exact`; two or more → all `possible`, no offer; none →
 *    unclassified (A3.4); `always` matches off the failed step are `role: finding` (A3.5) and get a
 *    `playground-lint` `info` check `diag.<FP-id>`;
 *  - an offer needs an exact cause with a `fix` whose knob is applied by one of the run's
 *    adapters, `proven` for its format (and adapter), and currently at `fix.from` (A5.1).
 */
import { KNOB_CATALOG } from '@interop-playground/adapters';
import type {
  CheckResult,
  CounterfactualOfferedPayload,
  DiagnosisResponse,
  FingerprintMatchedPayload,
  RunSpec,
} from '@interop-playground/api';
import type { Store } from '../store/index.js';
import type { RunEvidence } from './evidence.js';
import { loadEvidence } from './evidence.js';
import type { Fingerprint, NoFixReason, Predicate } from './types.js';

// ---------- JSONPath subset (09 A2: `$`, `.key`, `['key']`, `[n]`, `[*]`, `..key`, `$..`) ----------
type Seg =
  | { kind: 'key'; key: string; deep: boolean }
  | { kind: 'index'; i: number }
  | { kind: 'all'; deep: boolean };

/** Parses the supported JSONPath subset (`$`, `.key`, `[n]`, `[*]`, `..`) into segments; null for anything else. */
function parsePath(path: string): Seg[] | null {
  if (!path.startsWith('$')) return null;
  const segs: Seg[] = [];
  let i = 1;
  while (i < path.length) {
    const deep = path.startsWith('..', i);
    if (deep || path[i] === '.') {
      i += deep ? 2 : 1;
      if (i >= path.length) {
        segs.push({ kind: 'all', deep: true });
        break;
      }
      if (path[i] === '*') {
        segs.push({ kind: 'all', deep });
        i += 1;
        continue;
      }
      const m = /^[^.[]+/.exec(path.slice(i));
      if (!m) return null;
      segs.push({ kind: 'key', key: m[0], deep });
      i += m[0].length;
    } else if (path[i] === '[') {
      const end = path.indexOf(']', i);
      if (end < 0) return null;
      const inner = path.slice(i + 1, end);
      if (inner === '*') segs.push({ kind: 'all', deep: false });
      else if (/^\d+$/.test(inner)) segs.push({ kind: 'index', i: Number(inner) });
      else if (/^'.*'$|^".*"$/.test(inner))
        segs.push({ kind: 'key', key: inner.slice(1, -1), deep: false });
      else return null;
      i = end + 1;
    } else return null;
  }
  return segs;
}

/** The value and all values nested inside it, for `..` selection. */
function descendants(v: unknown): unknown[] {
  const out: unknown[] = [v];
  if (v !== null && typeof v === 'object')
    for (const c of Object.values(v as Record<string, unknown>)) out.push(...descendants(c));
  return out;
}

/** Evaluates a small JSONPath-like selector against a value and returns every match (empty for an invalid path). */
export function selectPath(root: unknown, path: string): unknown[] {
  const segs = parsePath(path);
  if (segs === null) return [];
  let cur: unknown[] = [root];
  for (const s of segs) {
    const next: unknown[] = [];
    for (const v of cur) {
      const pool = 'deep' in s && s.deep ? descendants(v) : [v];
      for (const p of pool) {
        if (p === null || typeof p !== 'object') continue;
        if (s.kind === 'all') {
          if (s.deep) next.push(p);
          else next.push(...Object.values(p as Record<string, unknown>));
        } else if (s.kind === 'index') {
          if (Array.isArray(p) && s.i < p.length) next.push(p[s.i]);
        } else if (!Array.isArray(p) && Object.prototype.hasOwnProperty.call(p, s.key)) {
          next.push((p as Record<string, unknown>)[s.key]);
        }
      }
    }
    cur = next;
  }
  return cur.filter((v) => v !== undefined);
}

const text = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

/** Applies a predicate's value operator (exists, equals, contains and so on) to the selected values. */
function valueOp(found: unknown[], op: string, value: string | undefined, root: unknown): boolean {
  switch (op) {
    case 'exists':
      return found.length > 0;
    case 'absent':
      return found.length === 0;
    case 'eq':
      return found.some((v) => text(v) === value);
    case 'contains':
      return found.some((v) => text(v).includes(value ?? ''));
    case 'regex': {
      const re = new RegExp(value ?? '');
      return found.some((v) => re.test(text(v)));
    }
    case 'count-eq': {
      const n = found.length === 1 && Array.isArray(found[0]) ? found[0].length : found.length;
      return n === Number(value);
    }
    case 'equals-path':
    case 'differs-from-path': {
      const other = selectPath(root, value ?? '');
      const same = found.length > 0 && text(found) === text(other);
      return op === 'equals-path' ? same : found.length > 0 && !same;
    }
    default:
      return false;
  }
}

/** Compiles a URL path glob (`*` within a segment, `**` across segments) to a regular expression. */
function globRe(glob: string): RegExp {
  const esc = glob
    .split('**')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*');
  return new RegExp(`^${esc}$`);
}

/** The path part of a URL, or the input unchanged if it does not parse. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

/** Parses a stored body as JSON; undefined when it is missing or not JSON. */
function parseBody(body: string | null): unknown {
  if (body === null) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

// ---------- predicate evaluation ----------
interface Hit {
  exchangeIds: string[];
  seqs: number[];
}

/** one predicate over the evidence; `strict` admits only full evidence */
/**
 * Evaluates one fingerprint predicate against the evidence. In strict mode only evidence from fully
 * captured steps counts, so a partial capture can never produce a confident match.
 * @returns the hit with its evidence references, or null when the predicate does not hold
 */
export function evalPredicate(
  p: Predicate,
  ev: RunEvidence,
  strict: boolean,
  stepKey: string | undefined,
): Hit | null {
  switch (p.on) {
    case 'exchange': {
      const pool = ev.exchanges.filter(
        (x) =>
          (!strict || x.full) &&
          (p.present !== false || stepKey === undefined || x.stepKey === stepKey),
      );
      const hits = pool.filter((x) => {
        if (x.counterpart !== p.counterpart) return false;
        if (p.method && x.method.toUpperCase() !== p.method.toUpperCase()) return false;
        if (p.pathGlob && !globRe(p.pathGlob).test(pathOf(x.url))) return false;
        if (p.status !== undefined && x.status !== p.status) return false;
        if (p.bodyPath && p.op) {
          const root = parseBody(x.body);
          if (root === undefined) return p.op === 'absent';
          const found =
            p.bodyPath === '$..' || p.bodyPath === '$'
              ? [x.body ?? '']
              : selectPath(root, p.bodyPath);
          return valueOp(found, p.op, p.value, root);
        }
        return true;
      });
      if (p.present === false) {
        // absence is only observable on a fully captured step
        if (
          strict &&
          stepKey !== undefined &&
          !ev.steps.some((s) => s.stepKey === stepKey && s.capture === 'full')
        )
          return null;
        return hits.length === 0 ? { exchangeIds: [], seqs: [] } : null;
      }
      return hits.length > 0
        ? { exchangeIds: hits.map((x) => x.exchangeId), seqs: hits.flatMap((x) => x.seqs) }
        : null;
    }
    case 'engine.call': {
      const hits = ev.calls.filter((c) => {
        if (c.engine !== p.engine || c.op !== p.op) return false;
        const out = c.outputSummary;
        const failed = out === null || (typeof out === 'object' && out !== null && 'error' in out);
        return p.result === 'error' ? failed : !failed;
      });
      return hits.length > 0 ? { exchangeIds: [], seqs: hits.map((c) => c.seq) } : null;
    }
    case 'engine.exception': {
      const hits = ev.exceptions.filter(
        (x) =>
          x.engine === p.engine &&
          (p.exceptionClass === undefined || x.exceptionClass === p.exceptionClass) &&
          x.message.includes(p.messageContains),
      );
      return hits.length > 0 ? { exchangeIds: [], seqs: hits.map((x) => x.seq) } : null;
    }
    case 'check': {
      const hits = ev.checks.filter(
        (c) =>
          (!strict || c.full) &&
          c.check.checkId === p.checkId &&
          c.check.outcome === p.outcome &&
          (p.code === undefined || c.check.code === p.code) &&
          (p.messageContains === undefined || (c.check.message ?? '').includes(p.messageContains)),
      );
      return hits.length > 0
        ? {
            exchangeIds: hits.flatMap((c) => [...c.check.exchangeIds]),
            seqs: hits.map((c) => c.seq),
          }
        : null;
    }
    case 'artifact': {
      if (p.path.startsWith('cbor:') || p.path.startsWith('x509:')) return null; // decoders arrive with the mDoc / x5c fingerprints
      const header = p.kind === 'credential-header';
      const pool = ev.artifacts.filter(
        (a) =>
          (!strict || a.full) &&
          (a.kind === p.kind || (header && a.kind === 'credential' && a.header !== undefined)),
      );
      if (pool.length === 0) return null;
      const hits = pool.filter((a) => {
        const root = header && a.kind === 'credential' ? a.header : a.value;
        return valueOp(selectPath(root, p.path), p.op, p.value, root);
      });
      return hits.length > 0
        ? { exchangeIds: hits.flatMap((a) => a.exchangeIds), seqs: hits.map((a) => a.seq) }
        : null;
    }
    case 'env': {
      const probe = ev.probes.get(p.probe);
      const val = probe ? (probe.detail ?? probe.versionFingerprint ?? '') : null;
      const ok =
        p.op === 'absent'
          ? val === null || (p.value !== undefined && !val.includes(p.value))
          : val !== null && (p.op === 'eq' ? val === p.value : val.includes(p.value ?? ''));
      return ok ? { exchangeIds: [], seqs: [] } : null;
    }
    case 'manual': {
      const hits = ev.calls.filter(
        (c) => c.op === 'manual-observation' && text(c.outputSummary).includes(p.shown),
      );
      return hits.length > 0 ? { exchangeIds: [], seqs: hits.map((c) => c.seq) } : null;
    }
    default:
      return null;
  }
}

/** Evaluates a fingerprint's rules in order and returns the first hit; in strict mode only fully captured evidence counts. */
function evalRules(fp: Fingerprint, ev: RunEvidence, strict: boolean): Hit | null {
  let any: Hit | null = null;
  for (const rule of fp.match) {
    const hits = rule.map((p) => evalPredicate(p, ev, strict, fp.stepKey));
    if (hits.some((h) => h === null)) continue;
    any ??= { exchangeIds: [], seqs: [] };
    for (const h of hits as Hit[]) {
      any.exchangeIds.push(...h.exchangeIds);
      any.seqs.push(...h.seqs);
    }
  }
  return any;
}

// ---------- scope and ranking ----------
const ROLE_OF = { issuer: 'issuer', wallet: 'wallet', verifier: 'verifier' } as const;

/** True when the run's issuer, wallet, verifier, format and client-id scheme all fall inside the fingerprint's scope. */
export function inScope(fp: Fingerprint, spec: RunSpec): boolean {
  const s = fp.scope;
  if (s.issuers && !s.issuers.includes(spec.issuer)) return false;
  if (s.wallets && !s.wallets.includes(spec.wallet)) return false;
  if (s.verifiers && !s.verifiers.includes(spec.verifier)) return false;
  if (s.formats && !s.formats.includes(spec.format)) return false;
  if (s.clientIdSchemes && !s.clientIdSchemes.includes(spec.clientIdScheme)) return false;
  if (s.envs) {
    const side =
      fp.deviatingSide in ROLE_OF ? ROLE_OF[fp.deviatingSide as keyof typeof ROLE_OF] : null;
    const envs = side
      ? [spec.env[side]]
      : fp.deviatingSide === 'issuer+verifier'
        ? [spec.env.issuer, spec.env.verifier]
        : Object.values(spec.env);
    if (!envs.every((e) => s.envs?.includes(e))) return false;
  }
  return true;
}

export interface DiagnosisEmission {
  stepKey: string | null;
  match: FingerprintMatchedPayload;
  offer: CounterfactualOfferedPayload | null;
  /** the A3.5 lint check of a finding */
  lint: CheckResult | null;
}

export interface DiagnosisResult {
  emissions: DiagnosisEmission[];
  noFixReason: NoFixReason | null;
}

function payload(
  fp: Fingerprint,
  hit: Hit,
  confidence: FingerprintMatchedPayload['confidence'],
  role: FingerprintMatchedPayload['role'],
): FingerprintMatchedPayload {
  return {
    fingerprintId: fp.id,
    gapIds: [...fp.gapIds],
    confidence,
    role,
    deviatingSide: fp.deviatingSide, // G-151: the six sides of 09 A2, unmapped
    specClause: fp.specClause ? `${fp.specClause.spec} ${fp.specClause.section}` : '',
    evidenceSIds: [...fp.evidence.sIds],
    matchedExchangeIds: [...new Set(hit.exchangeIds)],
    matchedEventSeqs: [...new Set(hit.seqs)].sort((a, b) => a - b),
    fingerprintVersion: fp.version,
    title: fp.title,
    component: { ...fp.component },
  };
}

/**
 * Builds the fix-it offer for a matched fingerprint, or null when it has no fix, the run is itself a tamper run, or no adapter in the run owns that knob.
 * A5.1: the knob offer for an exact cause, or null.
 */
export function offerFor(fp: Fingerprint, spec: RunSpec): CounterfactualOfferedPayload | null {
  if (!fp.fix || spec.tamperCase !== null) return null;
  const knob = KNOB_CATALOG.find((k) => k.def.id === fp.fix?.knobId);
  if (!knob) return null;
  const adapter = [spec.issuer, spec.wallet, spec.verifier].find((id) =>
    knob.adapters.includes(id),
  );
  if (adapter === undefined) return null;
  if (knob.requiresWallet !== undefined && spec.wallet !== knob.requiresWallet) return null;
  const status =
    knob.status[`${spec.format}@${spec.wallet}`] ??
    knob.status[`${spec.format}@${adapter}`] ??
    knob.status[spec.format];
  if (status !== 'proven') return null;
  if (spec.knobs[knob.def.id] !== fp.fix.from) return null;
  return {
    fingerprintId: fp.id,
    knobId: knob.def.id,
    from: fp.fix.from,
    to: fp.fix.to,
    knobStatus: 'proven',
    applyKind: knob.def.appliesAt,
    provenBy: [...knob.provenBy],
  };
}

/**
 * Explains, for a failed run with no fix-it offer, why none was made; null when nothing needs explaining.
 * 09 A9.3 wording key of a closed run from its stored matches and offers.
 */
export function noFixReasonOf(
  failed: boolean,
  tamper: boolean,
  matches: readonly Pick<FingerprintMatchedPayload, 'confidence' | 'role'>[],
  offers: number,
): NoFixReason | null {
  if (!failed || offers > 0) return null;
  if (tamper) return 'tamper-run';
  const causes = matches.filter((m) => m.role === 'cause');
  if (causes.some((m) => m.confidence === 'possible')) return 'several-causes';
  if (causes.some((m) => m.confidence === 'exact')) return 'no-proven-knob';
  if (causes.length > 0) return 'observed-only';
  return 'unclassified';
}

/** evaluates the library over one run's evidence (no side effects) */
/**
 * Runs the whole fingerprint library over a run's evidence. Pure and deterministic: the same
 * evidence and terminal state always give the same matches, offers and reasons.
 */
export function diagnose(
  library: readonly Fingerprint[],
  ev: RunEvidence,
  terminal: 'completed' | 'failed',
): DiagnosisResult {
  const failedStep = ev.failedStepKey;
  const runFailed = failedStep !== null || terminal === 'failed';
  const found: { fp: Fingerprint; hit: Hit; full: boolean; cause: boolean }[] = [];
  for (const fp of library) {
    if (fp.status !== 'active' || !inScope(fp, ev.spec)) continue;
    let cause: boolean;
    if (fp.appliesWhen === 'run-failed') {
      if (failedStep === null || (fp.stepKey !== undefined && fp.stepKey !== failedStep)) continue;
      cause = true;
    } else if (fp.appliesWhen === 'environment') {
      if (terminal !== 'failed') continue;
      cause = true;
    } else cause = failedStep !== null && fp.stepKey === failedStep;
    const observedOnly =
      fp.evidenceClass === 'observed-only' ||
      fp.match.every((r) => r.some((p) => p.on === 'manual'));
    const strict = evalRules(fp, ev, true);
    if (strict) {
      found.push({ fp, hit: strict, full: !observedOnly, cause });
      continue;
    }
    const lenient = evalRules(fp, ev, false);
    if (lenient) found.push({ fp, hit: lenient, full: false, cause });
  }
  const fullCauses = found.filter((f) => f.cause && f.full);
  const emissions: DiagnosisEmission[] = found.map((f) => {
    const confidence = !f.full
      ? 'observed'
      : f.cause && fullCauses.length > 1
        ? 'possible'
        : 'exact';
    const role = f.cause ? 'cause' : 'finding';
    const match = payload(f.fp, f.hit, confidence, role);
    const stepKey =
      (f.cause ? (f.fp.stepKey ?? failedStep) : f.fp.stepKey) ??
      ev.exchanges.find((x) => f.hit.exchangeIds.includes(x.exchangeId))?.stepKey ??
      null;
    const offer =
      f.cause && confidence === 'exact' && fullCauses.length === 1 ? offerFor(f.fp, ev.spec) : null;
    const lint: CheckResult | null =
      role === 'finding'
        ? {
            checkId: `diag.${f.fp.id}`,
            outcome: 'info',
            source: 'playground-lint',
            message: f.fp.title,
            ...(match.specClause ? { specClause: match.specClause } : {}),
            exchangeIds: match.matchedExchangeIds,
          }
        : null;
    return { stepKey, match, offer, lint };
  });
  return {
    emissions,
    noFixReason: noFixReasonOf(
      runFailed,
      ev.spec.tamperCase !== null,
      emissions.map((e) => e.match),
      emissions.filter((e) => e.offer).length,
    ),
  };
}

// ---------- the module the orchestrator calls ----------
export class DiagnosisEngine {
  constructor(
    private readonly store: Store,
    readonly library: readonly Fingerprint[],
  ) {}

  /**
   * Evaluates the library over the run's persisted events and appends `verdict.check` (findings),
   * `fingerprint.matched` and `counterfactual.offered` through the sink. Called by the orchestrator
   * once, after `endRun` and before the terminal event (the sink sets `cause_fingerprint_id` from
   * the stored matches at `run.completed`).
   */
  diagnoseRun(runId: string, terminal: 'completed' | 'failed'): DiagnosisResult {
    const result = diagnose(this.library, loadEvidence(this.store, runId), terminal);
    const sink = this.store.sink;
    for (const e of result.emissions) {
      const step = e.stepKey !== null ? { stepKey: e.stepKey } : {};
      if (e.lint)
        sink.append(runId, { type: 'verdict.check', ...step, payload: { check: e.lint } });
      sink.append(runId, { type: 'fingerprint.matched', ...step, payload: e.match });
      if (e.offer)
        sink.append(runId, { type: 'counterfactual.offered', ...step, payload: e.offer });
    }
    return result;
  }
}

// ---------- read side (API-30 shape, used by the report) ----------
export function readDiagnosis(store: Store, runId: string): DiagnosisResponse {
  const matches: FingerprintMatchedPayload[] = [];
  const offers: CounterfactualOfferedPayload[] = [];
  const rows = store.driver.all<{ type: string; payload_json: string }>(
    "SELECT type, payload_json FROM run_events WHERE run_id = ? AND type IN ('fingerprint.matched','counterfactual.offered') ORDER BY seq",
    runId,
  );
  for (const r of rows) {
    if (r.type === 'fingerprint.matched')
      matches.push(JSON.parse(r.payload_json) as FingerprintMatchedPayload);
    else offers.push(JSON.parse(r.payload_json) as CounterfactualOfferedPayload);
  }
  const run = store.driver.get<{
    state: string;
    outcome: string | null;
    tamper_case: string | null;
  }>('SELECT state, outcome, tamper_case FROM runs WHERE run_id = ?', runId);
  const failed = run?.state === 'failed' || run?.outcome === 'fail' || run?.outcome === 'blocked';
  const steps = store.driver.all<{ step_key: string; payload_json: string }>(
    "SELECT step_key, payload_json FROM run_events WHERE run_id = ? AND type = 'step.completed' ORDER BY seq",
    runId,
  );
  const coverageBanner: DiagnosisResponse['coverageBanner'] = [];
  for (const s of steps) {
    const p = JSON.parse(s.payload_json) as {
      outcome: string;
      capture: DiagnosisResponse['coverageBanner'][number]['capture'];
      coverageNote: string | null;
    };
    if (p.outcome !== 'skipped' && (p.capture === 'partial' || p.capture === 'none'))
      coverageBanner.push({
        stepKey: s.step_key,
        capture: p.capture,
        reason: p.coverageNote ?? null,
      });
  }
  return {
    matches,
    offers,
    noFixReason: noFixReasonOf(failed, (run?.tamper_case ?? null) !== null, matches, offers.length),
    coverageBanner,
  };
}
