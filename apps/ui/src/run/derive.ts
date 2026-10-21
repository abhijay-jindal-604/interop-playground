/** Pure derivations of the run screen from the reduced view and the flow rows (06 UI-11, UI-13, UI-14). */
import { runCopy } from '../copy.js';
import type { RailStep, RunFlows } from './flows.js';
import type { RunView, StepView } from './reduce.js';

/** The display label of a step key, or a neutral phrase when no step is known. */
export function labelOf(stepKey: string | null, steps: readonly RailStep[]): string {
  if (!stepKey) return 'an earlier step';
  return steps.find((s) => s.stepKey === stepKey)?.label ?? stepKey;
}

/** "Running. Step {n} of {N}: {step label}." n counts the rail rows up to the running step */
export function runningText(view: RunView, steps: readonly RailStep[]): string | null {
  const current = view.currentStepKey ?? view.seen.at(-1) ?? null;
  const at = steps.findIndex((s) => s.stepKey === current);
  if (at < 0 || steps.length === 0) return null;
  return runCopy.banner.running(at + 1, steps.length, steps[at]?.label ?? '');
}

/** The banner text explaining why a run is still queued (a shared collab environment is slower to free up). */
export function queuedReason(view: RunView): string {
  const env = view.spec?.env;
  const collab = env ? Object.values(env).includes('collab') : false;
  return collab ? runCopy.banner.queuedCollab : runCopy.banner.queuedLocal;
}

/** The banner text telling the user what the run is waiting for. */
export function awaitingText(view: RunView): string {
  const first = view.awaiting?.expects[0] ?? '';
  return runCopy.banner.awaiting(runCopy.awaitingHeading[first] ?? '');
}

/** The user-facing explanation of why a run failed, chosen by its error code; includes the request id for internal errors. */
export function errorDetail(view: RunView, requestId = 'not given'): string {
  const f = view.failed;
  if (!f) return runCopy.errorCode.internal_error(requestId);
  switch (f.errorCode) {
    case 'env_not_ready':
      return runCopy.errorCode.env_not_ready(f.message);
    case 'sidecar_unavailable':
      return runCopy.errorCode.sidecar_unavailable;
    case 'engine_exception':
      return runCopy.errorCode.engine_exception(f.message);
    case 'ui_not_connected':
      return runCopy.errorCode.ui_not_connected;
    case 'bff_restarted':
      return runCopy.errorCode.bff_restarted;
    default:
      return runCopy.errorCode.internal_error(requestId);
  }
}

function trim(text: string | null, n = 160): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** code + message of the first failing check of the step, else the last response (UI-11) */
export function failureOf(step: StepView | undefined): { code: string; message: string } {
  const check = step?.checks.find((c) => c.outcome === 'fail');
  // the template adds the closing period itself
  if (check) return { code: check.code ?? '', message: (check.message ?? '').replace(/\.$/, '') };
  const r = step?.lastResponse;
  if (r) return { code: String(r.status), message: trim(r.text) };
  return { code: '', message: '' };
}

/** the run's target step: the presentation flow's, else the issuance flow's (05 §4.1) */
export function targetStepKey(flows: RunFlows | null): string | null {
  return (flows?.presentation ?? flows?.issuance)?.targetStepKey ?? null;
}

/** the step whose failure the verdict names: the failed step, else the step carrying the failing check */
function failingKeyOf(view: RunView, steps: readonly RailStep[]): string | null {
  return (
    view.verdict?.failedStepKey ??
    steps.find((s) => view.steps[s.stepKey]?.checks.some((c) => c.outcome === 'fail'))?.stepKey ??
    null
  );
}

/**
 * The ResultCard sentence for a terminal `completed` run (UI-11 table). ADR-136: plain words with
 * the step's plain title; the verbatim code and message are `resultError`'s field, not the sentence.
 */
export function resultSentence(
  view: RunView,
  steps: readonly RailStep[],
  target: string | null,
): string {
  const v = view.verdict;
  if (!v) return runCopy.result.inconclusive(runCopy.result.inconclusiveManual);
  const failingKey = v.failedStepKey;
  const failing = labelOf(failingKey, steps);
  switch (v.outcome) {
    case 'pass':
      if (v.verification === 'valid-but-expired') return runCopy.result.passExpired;
      if (v.verification === null) return runCopy.result.passIssued;
      return runCopy.result.passValid;
    case 'fail': {
      // a verifier that answers "invalid" with every step passed (FLOW-40) names its failing
      // check at the step that carries it
      if (v.verification === 'invalid' && failingKey === null)
        return runCopy.result.failInvalidChecks;
      return v.verification === 'invalid'
        ? runCopy.result.failInvalid(labelOf(failingKeyOf(view, steps), steps))
        : runCopy.result.failAt(failing);
    }
    case 'blocked':
      return runCopy.result.blocked(labelOf(target, steps), failing);
    case 'lenient':
      return runCopy.result.lenient;
    case 'inconclusive':
      return runCopy.result.inconclusive(
        view.spec?.tamperCase
          ? runCopy.result.inconclusiveControl
          : runCopy.result.inconclusiveManual,
      );
    case 'no-submission':
      return v.kind === 'probe' ? runCopy.result.probe : runCopy.result.noSubmission;
  }
}

/** The verbatim error of a failed run ("invalid_request Client id …"), or null (ADR-136). */
export function resultError(view: RunView, steps: readonly RailStep[]): string | null {
  if (view.verdict?.outcome !== 'fail') return null;
  const key = failingKeyOf(view, steps);
  const f = failureOf(key ? view.steps[key] : undefined);
  const text = `${f.code} ${f.message}`.trim();
  return text || null;
}

export interface CoverageItem {
  stepKey: string;
  text: string;
  /** an engine step whose registry default is `none` (listed muted, not counted) */
  expected: boolean;
}

/** UI-14 banner rows: completed, not skipped, capture not full */
export function coverageItems(view: RunView, steps: readonly RailStep[]): CoverageItem[] {
  const items: CoverageItem[] = [];
  for (const row of steps) {
    const s = view.steps[row.stepKey];
    if (!s || s.state !== 'done' || s.outcome === 'skipped' || !s.capture || s.capture === 'full')
      continue;
    if (s.capture === 'partial') {
      items.push({
        stepKey: row.stepKey,
        expected: false,
        text: runCopy.coverage.partialItem(row.label, s.coverageNote ?? ''),
      });
    } else {
      items.push({
        stepKey: row.stepKey,
        expected: row.captureDefault === 'none',
        text: runCopy.coverage.noneItem(row.label, s.engines[0] ?? 'a library'),
      });
    }
  }
  return items;
}

/** UI-09 terminal-run load: the first failing step, or the last step that ran on pass */
export function defaultStep(view: RunView, steps: readonly RailStep[]): string | null {
  const ran = steps.filter((r) => view.steps[r.stepKey]?.state === 'done');
  const failing = ran.find((r) => view.steps[r.stepKey]?.outcome === 'fail');
  if (failing) return failing.stepKey;
  return (
    [...ran].reverse().find((r) => view.steps[r.stepKey]?.outcome !== 'skipped')?.stepKey ?? null
  );
}

/** Reads the selected step from a `#step=<key>` URL hash. */
export function stepFromHash(hash: string): string | null {
  const m = /(?:^#|&)step=([^&]+)/.exec(hash);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}
