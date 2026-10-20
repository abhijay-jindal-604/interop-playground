/**
 * The evidence view C12 evaluates (02 §7, 09 A3): built only from a run's persisted state — the
 * `run_events` log (bodies re-inlined by the reader), the `artifacts` rows with their blobs and the
 * `env` stream — so a history replay re-diagnoses identically. Each item carries `full`: whether it
 * sits on a step that completed with `capture: full` (ADR-19, ADR-26 evidence rule).
 */
import type {
  BodyRef,
  CheckResult,
  Coverage,
  EventEnvelope,
  RunSpec,
} from '@interop-playground/api';
import type { Store } from '../store/index.js';

/** One step of the run as the rules see it: outcome and how fully it was captured. */
export interface EvStep {
  stepKey: string;
  seq: number;
  outcome: 'pass' | 'fail' | 'skipped';
  capture: Coverage;
  note: string | null;
}
/** One HTTP exchange, merged from its request and response events. */
export interface EvExchange {
  exchangeId: string;
  stepKey: string;
  seqs: number[];
  counterpart: string;
  method: string;
  url: string;
  status: number | null;
  /** the response body as text (utf8 or decoded base64), null when none / pruned */
  body: string | null;
  full: boolean;
}
/** A recorded check result; `full` marks evidence from a step captured completely. */
export interface EvCheck {
  seq: number;
  stepKey: string;
  check: CheckResult;
  full: boolean;
}
/** An exception raised inside an engine call. */
export interface EvException {
  seq: number;
  stepKey: string;
  engine: string;
  exceptionClass: string;
  message: string;
}
/** A product-library call (sidecar or in-process) with its summarised output. */
export interface EvCall {
  seq: number;
  stepKey: string;
  engine: string;
  op: string;
  outputSummary: unknown;
}
/** A captured credential, token or document with its decoded content. */
export interface EvArtifact {
  artifactId: string;
  stepKey: string;
  seq: number;
  kind: string;
  /** parsed content: JSON value, or the decoded payload of a compact JWS / SD-JWT */
  value: unknown;
  /** decoded protected header when the content is a compact JWS / SD-JWT */
  header: unknown;
  exchangeIds: string[];
  full: boolean;
}
/** Result of an upstream health probe taken during the run. */
export interface EvProbe {
  upstream: string;
  ok: boolean;
  detail: string | null;
  versionFingerprint: string | null;
}

/** The complete, replayable evidence for one run; the only input the diagnosis rules may read. */
export interface RunEvidence {
  runId: string;
  spec: RunSpec;
  steps: EvStep[];
  exchanges: EvExchange[];
  checks: EvCheck[];
  exceptions: EvException[];
  calls: EvCall[];
  artifacts: EvArtifact[];
  probes: Map<string, EvProbe>;
  /** first step that completed `fail`, in log order */
  failedStepKey: string | null;
}

/** credential strings / objects of a credential endpoint response body */
function credentialsIn(body: string): string[] {
  let j: unknown;
  try {
    j = JSON.parse(body) as unknown;
  } catch {
    return [];
  }
  if (j === null || typeof j !== 'object') return [];
  const o = j as { credentials?: unknown; credential?: unknown };
  const list: unknown[] = Array.isArray(o.credentials)
    ? (o.credentials as unknown[]).map((c): unknown =>
        c !== null && typeof c === 'object' ? (c as { credential?: unknown }).credential : c,
      )
    : o.credential !== undefined
      ? [o.credential]
      : [];
  return list
    .filter((c) => c !== undefined && c !== null)
    .map((c) => (typeof c === 'string' ? c : JSON.stringify(c)));
}

function bodyText(b: BodyRef | null | undefined): string | null {
  if (!b) return null;
  return b.encoding === 'base64' ? Buffer.from(b.text, 'base64').toString('utf8') : b.text;
}

function b64urlJson(seg: string | undefined): unknown {
  if (!seg) return undefined;
  try {
    return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Decodes stored artifact text: a compact JWS / SD-JWT becomes {header, payload}; JSON is parsed; anything else stays a string.
 * `{header, value}` of a compact JWS / SD-JWT (`h.p.s~d~…~kb`), else the parsed JSON text.
 */
export function parseArtifactText(text: string): { header: unknown; value: unknown } {
  const t = text.trim();
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*(~|$)/.test(t)) {
    const [h, p] = (t.split('~')[0] ?? '').split('.');
    return { header: b64urlJson(h), value: b64urlJson(p) };
  }
  try {
    return { header: undefined, value: JSON.parse(t) as unknown };
  } catch {
    return { header: undefined, value: t };
  }
}

/** Reads every persisted event of a run, paging 2000 at a time in sequence order. */
export function readAllEvents(store: Store, runId: string): EventEnvelope[] {
  const out: EventEnvelope[] = [];
  for (;;) {
    const page = store.reader.readEvents(runId, out.at(-1)?.seq ?? 0, 2000);
    out.push(...page);
    if (page.length < 2000) return out;
  }
}

/** pure part: the evidence from an event list and the artifact rows (tests feed fixtures here) */
/**
 * Folds a run's events and artifact rows into the evidence view. Pure: the same inputs always give
 * the same evidence, which is what makes a stored run re-diagnose identically on replay.
 */
export function buildEvidence(
  runId: string,
  spec: RunSpec,
  events: readonly EventEnvelope[],
  artifacts: readonly {
    artifactId: string;
    stepKey: string;
    seq: number;
    kind: string;
    sourceExchangeId: string | null;
    text: string | null;
  }[] = [],
  probes: Map<string, EvProbe> = new Map(),
): RunEvidence {
  const steps: EvStep[] = [];
  const xs = new Map<string, EvExchange>();
  const checks: Omit<EvCheck, 'full'>[] = [];
  const exceptions: EvException[] = [];
  const calls: EvCall[] = [];
  for (const e of events) {
    const stepKey = e.stepKey ?? '';
    switch (e.type) {
      case 'step.completed': {
        const p = e.payload as {
          outcome: EvStep['outcome'];
          capture: Coverage;
          coverageNote: string | null;
          skipReason: string | null;
        };
        steps.push({
          stepKey,
          seq: e.seq,
          outcome: p.outcome,
          capture: p.capture,
          note: p.coverageNote ?? p.skipReason ?? null,
        });
        break;
      }
      case 'exchange.request': {
        const p = e.payload as {
          exchangeId: string;
          counterpart: string;
          method: string;
          url: string;
        };
        xs.set(p.exchangeId, {
          exchangeId: p.exchangeId,
          stepKey,
          seqs: [e.seq],
          counterpart: p.counterpart,
          method: p.method,
          url: p.url,
          status: null,
          body: null,
          full: false,
        });
        break;
      }
      case 'exchange.response': {
        const p = e.payload as { exchangeId: string; status: number; body: BodyRef | null };
        const x = xs.get(p.exchangeId);
        if (x) {
          x.status = p.status;
          x.body = bodyText(p.body);
          x.seqs.push(e.seq);
        }
        break;
      }
      case 'verdict.check':
        checks.push({ seq: e.seq, stepKey, check: (e.payload as { check: CheckResult }).check });
        break;
      case 'engine.exception': {
        const p = e.payload as { engine: string; exceptionClass: string; message: string };
        exceptions.push({ seq: e.seq, stepKey, ...p });
        break;
      }
      case 'engine.call': {
        const p = e.payload as { engine: string; op: string; outputSummary: unknown };
        calls.push({
          seq: e.seq,
          stepKey,
          engine: p.engine,
          op: p.op,
          outputSummary: p.outputSummary,
        });
        break;
      }
      default:
        break;
    }
  }
  const capture = new Map<string, Coverage>();
  for (const s of steps) if (s.outcome !== 'skipped') capture.set(s.stepKey, s.capture);
  const isFull = (stepKey: string): boolean => capture.get(stepKey) === 'full';
  const exchanges = [...xs.values()].map((x) => ({ ...x, full: isFull(x.stepKey) }));
  const fullX = new Set(exchanges.filter((x) => x.full).map((x) => x.exchangeId));
  const stored = artifacts.filter((a) => a.text !== null);
  // until an adapter stores a `credential` artifact itself, extract it from the credential
  // endpoint's response (OID4VCI 1.0 `credentials[].credential`, draft `credential`)
  const derived = stored.some((a) => a.kind === 'credential')
    ? []
    : exchanges
        .filter((x) => x.stepKey === 'vci.credential' && x.body !== null)
        .flatMap((x) =>
          credentialsIn(x.body ?? '').map((text, i) => ({
            artifactId: `${x.exchangeId}#credential${i}`,
            stepKey: x.stepKey,
            seq: x.seqs.at(-1) ?? 0,
            kind: 'credential',
            sourceExchangeId: x.exchangeId,
            text,
          })),
        );
  return {
    runId,
    spec,
    steps,
    exchanges,
    // a check is full evidence when every exchange it rests on is (a check without exchanges is an engine check)
    checks: checks.map((c) => ({ ...c, full: c.check.exchangeIds.every((id) => fullX.has(id)) })),
    exceptions,
    calls,
    artifacts: [...stored, ...derived].map((a) => {
      const parsed = parseArtifactText(a.text ?? '');
      return {
        artifactId: a.artifactId,
        stepKey: a.stepKey,
        seq: a.seq,
        kind: a.kind,
        value: parsed.value,
        header: parsed.header,
        exchangeIds: a.sourceExchangeId ? [a.sourceExchangeId] : [],
        full: a.sourceExchangeId ? fullX.has(a.sourceExchangeId) : isFull(a.stepKey),
      };
    }),
    probes,
    failedStepKey: steps.find((s) => s.outcome === 'fail')?.stepKey ?? null,
  };
}

/**
 * Loads a run from the store and builds its evidence. Throws if the run id is unknown.
 * The evidence of a stored run (02 §7: persisted events only)
 */
export function loadEvidence(store: Store, runId: string): RunEvidence {
  const row = store.driver.get<{ spec_json: string }>(
    'SELECT spec_json FROM runs WHERE run_id = ?',
    runId,
  );
  if (!row) throw new Error(`unknown run ${runId}`);
  const spec = JSON.parse(row.spec_json) as RunSpec;
  const arts = store.driver
    .all<{
      artifact_id: string;
      step_key: string;
      seq: number;
      kind: string;
      source_exchange_id: string | null;
      blob_sha: string;
    }>(
      "SELECT artifact_id, step_key, seq, kind, source_exchange_id, blob_sha FROM artifacts WHERE run_id = ? AND kind NOT IN ('tamper-before','tamper-after') ORDER BY seq",
      runId,
    )
    .map((a) => ({
      artifactId: a.artifact_id,
      stepKey: a.step_key,
      seq: a.seq,
      kind: a.kind,
      sourceExchangeId: a.source_exchange_id,
      text: store.reader.getBlob(a.blob_sha)?.toString('utf8') ?? null,
    }));
  const probes = new Map<string, EvProbe>();
  for (const r of store.driver.all<{ payload_json: string }>(
    "SELECT payload_json FROM env_events WHERE type = 'env.probe' ORDER BY seq",
  )) {
    const p = JSON.parse(r.payload_json) as EvProbe;
    probes.set(p.upstream, p);
  }
  return buildEvidence(runId, spec, readAllEvents(store, runId), arts, probes);
}
