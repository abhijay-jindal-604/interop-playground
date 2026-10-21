/**
 * Run screen pieces (06 UI-10 header, UI-11 status banner + result card, UI-14 coverage banner).
 * Every word comes from `runCopy` (copy.ts); status is glyph + word, never colour alone (UI-74).
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AdapterId, Run } from '@interop-playground/api';
import { Icon } from '../components/Icon.js';
import { shortId } from '../components/RunLink.js';
import type { BadgeState } from '../components/StatusBadge.js';
import { runCopy, screenCopy, selectorCopy } from '../copy.js';
import { FORMAT_SHORT } from '../lib/labels.js';
import { useStore } from '../state/store.js';
import {
  awaitingText,
  coverageItems,
  errorDetail,
  labelOf,
  queuedReason,
  resultError,
  resultSentence,
  runningText,
} from './derive.js';
import type { RailStep } from './flows.js';
import type { RunView, ViewState } from './reduce.js';
import { Stamp, stampDate, stampOf } from '../components/Stamp.js';

/** Returns a function that turns an adapter id into its display name, falling back to the id while the catalogue loads. */
export function useAdapterName(): (id: AdapterId) => string {
  const adapters = useStore((s) => s.catalog.adapters);
  return (id) => {
    if (adapters.status !== 'ready') return id;
    const all = [...adapters.data.issuers, ...adapters.data.wallets, ...adapters.data.verifiers];
    return all.find((a) => a.descriptor.id === id)?.descriptor.displayName ?? id;
  };
}

const VERDICT_WORD = runCopy.verdictChip;

function stateBadge(vs: ViewState): { state: BadgeState; word: string } {
  switch (vs) {
    case 'queued':
      return { state: 'queued', word: runCopy.stateChip.queued };
    case 'running':
      return { state: 'running', word: runCopy.stateChip.running };
    case 'awaiting':
      return { state: 'running', word: runCopy.stateChip.awaiting };
    case 'cancelled':
      return { state: 'cancelled', word: runCopy.stateChip.cancelled };
    case 'error':
      return { state: 'failed', word: runCopy.stateChip.failed };
    default:
      return { state: 'pass', word: runCopy.stateChip.completed };
  }
}

export interface HeaderActions {
  onCancel: () => void;
  onPin: () => void;
  onNote: () => void;
  onDelete: () => void;
}

/** "Cross-device (QR)" for a presentation mode, "Issue only" or "Credential only" without one */
export function modeWord(spec: NonNullable<RunView['spec']>): string {
  if (spec.presentationMode)
    return selectorCopy.recipe.modes[spec.presentationMode] ?? spec.presentationMode;
  return spec.scope === 'issuance'
    ? selectorCopy.issueOnly
    : (selectorCopy.recipe.modes['credential-level'] ?? 'credential-level');
}

/** One form field (ADR-134 form language): a small muted label above, the value on a hairline. */
export function Field({
  label,
  children,
  mono = false,
  className,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={`doc-field${mono ? ' is-mono' : ''}${className ? ` ${className}` : ''}`}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * The facts under the run title (ADR-136): the three roles as one plain sentence, the re-run link,
 * and everything technical (format, grant, mode, environment, proof, changed setting, versions)
 * behind one "Details" disclosure as form fields.
 */
export function RunHeaderFacts({ view, run }: { view: RunView; run: Run | null }) {
  const name = useAdapterName();
  const spec = view.spec;
  if (!spec) return null;
  const sentence =
    spec.scope === 'issuance'
      ? runCopy.rolesIssueOnly(name(spec.issuer), name(spec.wallet))
      : runCopy.roles(name(spec.issuer), name(spec.wallet), name(spec.verifier));
  return (
    <div className="run-facts">
      <p className="run-roles">{sentence}</p>
      {spec.parentRunId ? (
        <p className="run-parent">
          <Link to={`/runs/${spec.parentRunId}`}>
            {runCopy.facts.rerunOf(shortId(spec.parentRunId))}
          </Link>
        </p>
      ) : null}
      <details className="disclosure run-details">
        <summary>{runCopy.details}</summary>
        <dl className="doc-fields disclosure-body" aria-label={runCopy.facts.region}>
          <Field label={runCopy.facts.format}>{FORMAT_SHORT[spec.format]}</Field>
          <Field label={runCopy.facts.mode}>{modeWord(spec)}</Field>
          {spec.grant ? (
            <Field label={runCopy.facts.grant}>
              {selectorCopy.grantWord[spec.grant] ?? spec.grant}
            </Field>
          ) : null}
          <Field label={runCopy.facts.env}>
            {[...new Set(Object.values(spec.env))].join(' + ')}
          </Field>
          {view.proofAlg ? (
            <Field label={runCopy.facts.proofAlg} mono>
              {view.proofAlg}
            </Field>
          ) : null}
          {Object.entries(spec.knobs).map(([k, v]) => (
            <Field key={k} label={runCopy.facts.changedSetting} mono>
              {k} = {String(v)}
            </Field>
          ))}
          {run?.origin === 'imported' ? (
            <Field label={runCopy.facts.origin}>
              <span title={runCopy.facts.importedTip}>{runCopy.facts.imported}</span>
            </Field>
          ) : null}
          {(['issuer', 'wallet', 'verifier'] as const).map((role) => (
            <Field
              key={role}
              label={`${runCopy.facts[role]} ${runCopy.facts.versions.toLowerCase()}`}
              mono
            >
              {spec[role]} {spec.versions[role]}
            </Field>
          ))}
        </dl>
      </details>
    </div>
  );
}

/** The one status line under the run title: a small dot, the state word, the verdict once done. */
export function RunStatusLine({ vs, view, live }: { vs: ViewState; view: RunView; live: boolean }) {
  if (vs === 'loading') return null;
  const s = stateBadge(vs);
  const verdict = view.verdict && vs.startsWith('done-') ? view.verdict.outcome : null;
  const tone = verdict ? outcomeTone(verdict) : STATE_TONE[s.state];
  return (
    <p className={`run-status tone-${tone}`}>
      <span className="run-status-dot" aria-hidden="true" />
      <span>{s.word}</span>
      {verdict ? <span className="run-status-verdict">{VERDICT_WORD[verdict]}</span> : null}
      {live ? <span className="run-status-live">{runCopy.live}</span> : null}
    </p>
  );
}

const STATE_TONE: Record<BadgeState, string> = {
  pass: 'pass',
  fail: 'fail',
  blocked: 'fail',
  lenient: 'neutral',
  inconclusive: 'warn',
  'no-submission': 'neutral',
  'n/a': 'skipped',
  'not-run': 'skipped',
  queued: 'info',
  running: 'info',
  cancelled: 'skipped',
  failed: 'warn',
};

type Outcome = NonNullable<RunView['verdict']>['outcome'];
/** status tone of a verdict outcome (status colour on the glyph and word only) */
function outcomeTone(o: Outcome): string {
  return o === 'pass'
    ? 'pass'
    : o === 'fail' || o === 'blocked'
      ? 'fail'
      : o === 'inconclusive'
        ? 'warn'
        : 'neutral';
}

/** The run's action buttons (cancel while running; pin, note and export), shown according to the run state. */
export function RunActions({
  runId,
  vs,
  run,
  actions,
}: {
  runId: string;
  vs: ViewState;
  run: Run | null;
  actions: HeaderActions;
}) {
  const terminal = vs.startsWith('done-') || vs === 'cancelled' || vs === 'error';
  const tip = terminal ? undefined : runCopy.actions.whenEnded;
  return (
    <div className="run-actions">
      {vs === 'queued' || vs === 'running' || vs === 'awaiting' ? (
        <button type="button" className="btn btn-secondary btn-sm" onClick={actions.onCancel}>
          {runCopy.actions.cancel}
        </button>
      ) : null}
      <Link className="btn btn-primary btn-sm" to={`/?clone=${runId}`}>
        {runCopy.actions.runAgain}
      </Link>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={!terminal}
        title={tip ?? runCopy.actions.pinTip}
        aria-pressed={run?.pinned ?? false}
        onClick={actions.onPin}
      >
        {run?.pinned ? runCopy.actions.unpin : runCopy.actions.pin}
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={!terminal}
        title={tip}
        onClick={actions.onNote}
      >
        {runCopy.actions.note}
      </button>
      {terminal ? (
        <a
          className="btn btn-ghost btn-sm"
          href={`/api/v1/runs/${runId}/export?format=json`}
          download
        >
          {runCopy.actions.export}
        </a>
      ) : (
        <button type="button" className="btn btn-ghost btn-sm" disabled title={tip}>
          {runCopy.actions.export}
        </button>
      )}
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={!terminal}
        title={tip}
        onClick={actions.onDelete}
      >
        {runCopy.actions.delete}
      </button>
      {terminal ? (
        <Link className="btn btn-ghost btn-sm" to={`/runs/${runId}/report`}>
          {runCopy.actions.report}
        </Link>
      ) : (
        <button type="button" className="btn btn-ghost btn-sm" disabled title={tip}>
          {runCopy.actions.report}
        </button>
      )}
    </div>
  );
}

function Elapsed({ from }: { from: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!from) return null;
  const s = Math.max(0, Math.floor((now - Date.parse(from)) / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return (
    <span className="mono elapsed" aria-hidden="true">
      {mm}:{ss}
    </span>
  );
}

/** UI-11 StatusBanner: non-terminal states, cancelled and error; `role="status"` */
export function StatusBanner({
  vs,
  view,
  steps,
  onCancel,
}: {
  vs: ViewState;
  view: RunView;
  steps: readonly RailStep[];
  onCancel: () => void;
}) {
  let text: string | null;
  let tone = 'info';
  let extra: React.ReactNode = null;
  switch (vs) {
    case 'queued':
      text = runCopy.banner.queued(queuedReason(view));
      extra = (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>
          {runCopy.actions.cancel}
        </button>
      );
      break;
    case 'running':
      text = runningText(view, steps);
      extra = <Elapsed from={view.startedAt} />;
      break;
    case 'awaiting':
      text = awaitingText(view);
      tone = 'warn';
      break;
    case 'cancelled':
      text = `${runCopy.banner.cancelled[view.cancelled?.reason ?? 'user']} ${runCopy.banner.noVerdict}`;
      tone = 'skipped';
      break;
    case 'error':
      text = runCopy.banner.error(errorDetail(view));
      tone = 'warn';
      break;
    default:
      text = null;
  }
  return (
    <div role="status" className="status-banner">
      {text ? (
        <div className={`banner tone-${tone}`}>
          {vs === 'running' ? (
            <span className="run-spinner" aria-hidden="true" />
          ) : (
            <Icon
              name={
                vs === 'error'
                  ? 'st-failed'
                  : vs === 'cancelled'
                    ? 'st-cancelled'
                    : vs === 'queued'
                      ? 'st-queued'
                      : 'st-running'
              }
              size={20}
            />
          )}
          <p>{text}</p>
          {extra}
          {vs === 'error' && view.failed?.errorCode === 'env_not_ready' ? (
            <Link to="/environment">Environment</Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** UI-11 ResultCard for terminal `completed` runs: the stamp, the plain sentence, form fields (ADR-137) */
export function ResultCard({
  view,
  steps,
  target,
  note,
}: {
  view: RunView;
  steps: readonly RailStep[];
  target: string | null;
  note: string | null;
}) {
  const name = useAdapterName();
  const v = view.verdict;
  const spec = view.spec;
  const stamp = stampOf(v);
  if (!v || !spec || !stamp) return null;
  const failing = v.failedStepKey ? labelOf(v.failedStepKey, steps) : null;
  const error = resultError(view, steps);
  const decidedBy = spec.scope === 'issuance' ? name(spec.issuer) : name(spec.verifier);
  const date = stampDate(view.finishedAt);
  const tone = outcomeTone(v.outcome);
  return (
    <section
      role="region"
      aria-label={runCopy.result.region}
      className={`result-card tone-${tone}`}
      data-outcome={v.outcome}
    >
      <div className="result-verdict verdict">
        <Stamp
          word={stamp.word}
          status={stamp.status}
          line={[date, decidedBy].filter(Boolean).join(' · ')}
          className="result-stamp"
        />
        <div className="result-text verdict-sentence">
          <p className="result-sentence">{resultSentence(view, steps, target)}</p>
          {note ? (
            <p className="result-note">
              <span className="muted">{runCopy.result.note}: </span>
              {note}
            </p>
          ) : null}
        </div>
      </div>
      <dl className="doc-fields result-facts">
        <Field label={runCopy.facts.issuer}>{name(spec.issuer)}</Field>
        <Field label={runCopy.facts.wallet}>{name(spec.wallet)}</Field>
        <Field label={runCopy.facts.verifier}>
          {spec.scope === 'issuance' ? selectorCopy.verifierUnused : name(spec.verifier)}
        </Field>
        <Field label={runCopy.facts.format}>{FORMAT_SHORT[spec.format]}</Field>
        <Field label={runCopy.facts.mode}>{modeWord(spec)}</Field>
        <Field label={runCopy.result.outcome}>
          <span className="result-word">{VERDICT_WORD[v.outcome]}</span>
        </Field>
        {failing ? (
          <Field label={runCopy.result.failingStep} className="is-wide">
            {failing}
          </Field>
        ) : null}
        {error ? (
          <Field label={runCopy.result.errorDetail} mono className="is-wide">
            {error}
          </Field>
        ) : null}
      </dl>
      <details className="disclosure result-details">
        <summary>{runCopy.details}</summary>
        <dl className="doc-fields disclosure-body">
          <Field label={runCopy.result.proofAlg} mono>
            {view.proofAlg ?? 'not recorded'}
          </Field>
          <Field label={runCopy.facts.grant}>
            {spec.grant ? (selectorCopy.grantWord[spec.grant] ?? spec.grant) : 'none'}
          </Field>
          <Field label={runCopy.facts.env}>
            {[...new Set(Object.values(spec.env))].join(' + ')}
          </Field>
          {v.failedStepKey ? (
            <Field label={screenCopy.step.stepId} mono>
              {v.failedStepKey}
            </Field>
          ) : null}
        </dl>
      </details>
    </section>
  );
}

/** UI-14 CoverageBanner: shown once a step completed outside full capture */
export function CoverageBanner({
  view,
  steps,
  onSelect,
}: {
  view: RunView;
  steps: readonly RailStep[];
  onSelect: (stepKey: string) => void;
}) {
  const items = coverageItems(view, steps);
  const counted = items.filter((i) => !i.expected);
  if (counted.length === 0) return null;
  const expected = items.filter((i) => i.expected);
  return (
    <details className="coverage-banner banner tone-info" open>
      <summary>{runCopy.coverage.heading(counted.length)}</summary>
      <ul>
        {counted.map((i) => (
          <li key={i.stepKey}>
            <button type="button" className="btn-link" onClick={() => onSelect(i.stepKey)}>
              {i.text}
            </button>
          </li>
        ))}
      </ul>
      {expected.length > 0 ? (
        <>
          <p className="muted small">{runCopy.coverage.engineSteps}</p>
          <ul className="muted small">
            {expected.map((i) => (
              <li key={i.stepKey}>
                <button type="button" className="btn-link" onClick={() => onSelect(i.stepKey)}>
                  {i.text}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="small">{runCopy.coverage.footer}</p>
    </details>
  );
}
