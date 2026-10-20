/**
 * Child classification (plan/12 T-42; 09 A5.3, ADR-84): the `counterfactualResult` of a derived
 * run that closes `run.completed`, from the persisted evidence of the parent and the child (the
 * child's own C12 matches are already stored: the orchestrator classifies after diagnosing).
 * A child ending `run.failed` / cancelled is `inconclusive` in the sink, not here.
 */
import type {
  Coverage,
  FingerprintMatchedPayload,
  Run,
  RunSpec,
  RunVerdict,
} from '@interop-playground/api';
import type { Store } from '../store/index.js';
import { loadEvidence } from './evidence.js';
import type { RunEvidence } from './evidence.js';

export type ChildResult = NonNullable<Run['counterfactualResult']>;

const RANK: Record<Coverage, number> = { full: 2, partial: 1, none: 0 };

export interface StoredMatch {
  stepKey: string | null;
  match: FingerprintMatchedPayload;
}

/** Reads the fingerprint matches already stored for a run, so a replay reuses them instead of re-deriving. */
export function storedMatches(store: Store, runId: string): StoredMatch[] {
  return store.driver
    .all<{ step_key: string | null; payload_json: string }>(
      "SELECT step_key, payload_json FROM run_events WHERE run_id = ? AND type = 'fingerprint.matched' ORDER BY seq",
      runId,
    )
    .map((r) => ({
      stepKey: r.step_key,
      match: JSON.parse(r.payload_json) as FingerprintMatchedPayload,
    }));
}

/** the steps the parent's cause diagnosis relied on: the match's step and its exchanges' steps */
export function diagnosisSteps(parent: RunEvidence, matches: readonly StoredMatch[]): string[] {
  const out = new Set<string>();
  for (const m of matches) {
    if (m.match.role !== 'cause') continue;
    if (m.stepKey !== null) out.add(m.stepKey);
    for (const x of parent.exchanges)
      if (m.match.matchedExchangeIds.includes(x.exchangeId)) out.add(x.stepKey);
  }
  return [...out];
}

const failingChecks = (ev: RunEvidence): string[] => [
  ...new Set(ev.checks.filter((c) => c.check.outcome === 'fail').map((c) => c.check.checkId)),
];

/**
 * 09 A5.3, evaluated in this order:
 *  1. `inconclusive`: a step the parent's diagnosis relied on ran in the child with a lower capture;
 *  2. `not-fixed`: the parent's cause fingerprint matches the child as a cause;
 *  3. child `pass`: `fixed` when every check that failed in the parent passes in the child, else
 *     `inconclusive` (the check did not run, so nothing is proven);
 *  4. child `fail` / `blocked`: `moved` when it fails at another check or another fingerprint is
 *     the cause; the same failing checks with no cause matched is `not-fixed` (ADR-84);
 *  5. any other outcome (`no-submission`, `inconclusive`, `lenient`): `inconclusive`.
 */
export function classifyChild(
  parent: RunEvidence,
  parentMatches: readonly StoredMatch[],
  child: RunEvidence,
  childMatches: readonly StoredMatch[],
  causeFingerprintId: string | null,
  verdict: Pick<RunVerdict, 'outcome'>,
): ChildResult {
  // only steps the child performed: a step it skipped (blocked earlier) lost no capture
  const childCapture = new Map(
    child.steps.filter((s) => s.outcome !== 'skipped').map((s) => [s.stepKey, s.capture]),
  );
  for (const key of diagnosisSteps(parent, parentMatches)) {
    const p = parent.steps.find((s) => s.stepKey === key)?.capture;
    const c = childCapture.get(key);
    if (p !== undefined && c !== undefined && RANK[c] < RANK[p]) return 'inconclusive';
  }
  const childCauses = childMatches.filter((m) => m.match.role === 'cause');
  if (
    causeFingerprintId !== null &&
    childCauses.some((m) => m.match.fingerprintId === causeFingerprintId)
  )
    return 'not-fixed';
  const parentFails = failingChecks(parent);
  if (verdict.outcome === 'pass') {
    const passed = new Set(
      child.checks.filter((c) => c.check.outcome === 'pass').map((c) => c.check.checkId),
    );
    return parentFails.every((id) => passed.has(id)) ? 'fixed' : 'inconclusive';
  }
  if (verdict.outcome === 'fail' || verdict.outcome === 'blocked') {
    const childFails = failingChecks(child);
    const otherCheck = childFails.some((id) => !parentFails.includes(id));
    const otherCause = childCauses.some((m) => m.match.fingerprintId !== causeFingerprintId);
    return otherCheck || otherCause ? 'moved' : 'not-fixed';
  }
  return 'inconclusive';
}

/** the orchestrator's `classify` hook: reads both runs from the store */
export function classifyStoredChild(
  store: Store,
  childRunId: string,
  verdict: Pick<RunVerdict, 'outcome'>,
): Run['counterfactualResult'] {
  const row = store.driver.get<{ spec_json: string }>(
    'SELECT spec_json FROM runs WHERE run_id = ?',
    childRunId,
  );
  if (!row) return null;
  const spec = JSON.parse(row.spec_json) as RunSpec;
  if (spec.parentRunId === null) return null;
  return classifyChild(
    loadEvidence(store, spec.parentRunId),
    storedMatches(store, spec.parentRunId),
    loadEvidence(store, childRunId),
    storedMatches(store, childRunId),
    spec.causeFingerprintId,
    verdict,
  );
}
