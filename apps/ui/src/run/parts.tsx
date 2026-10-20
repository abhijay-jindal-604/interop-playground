/**
 * Run screen pieces (06 UI-10 header, UI-11 status banner + result card, UI-14 coverage banner).
 * Every word comes from `runCopy` (copy.ts); status is glyph + word, never colour alone (UI-74).
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AdapterId, Run } from '@interop-playground/api';
import { Icon } from '../components/Icon.js';
import { shortId } from '../components/RunLink.js';
import { StatusBadge, type BadgeState } from '../components/StatusBadge.js';
import { runCopy } from '../copy.js';
import { FORMAT_LABEL } from '../lib/labels.js';
import { useStore } from '../state/store.js';
import {
  awaitingText,
  coverageItems,
  errorDetail,
  labelOf,
  queuedReason,
  resultSentence,
  runningText,
} from './derive.js';
import type { RailStep } from './flows.js';
import type { RunView, ViewState } from './reduce.js';

/** Returns a function that turns an adapter id into its display name, falling back to the id while the catalogue loads. */
export function useAdapterName(): (id: AdapterId) => string {
  const adapters = useStore((s) => s.catalog.adapters);
  return (id) => {
    if (adapters.status !== 'ready') return id;
    const all = [...adapters.data.issuers, ...adapters.data.wallets, ...adapters.data.verifiers];
    return all.find((a) => a.descriptor.id === id)?.descriptor.displayName ?? id;
  };
}

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

/** StateChip / VerdictChip (UI-10): the shared badge silhouette with the UI-10 words */
export function Chip({ state, word }: { state: BadgeState; word: string }) {
  return (
    <span className="run-chip" data-state={state}>
      <StatusBadge state={state} size="md" />
      <span className="visually-hidden">{word}</span>
    </span>
  );
}

export interface HeaderActions {
  onCancel: () => void;
  onPin: () => void;
  onNote: () => void;
  onDelete: () => void;
}

/** The facts line under the run title: adapters, format, grant and environment. */
export function RunHeaderFacts({ view, run }: { view: RunView; run: Run | null }) {
  const name = useAdapterName();
  const spec = view.spec;
  if (!spec) return null;
  const changed = Object.entries(spec.knobs);
  return (
    <div className="run-facts">
      <dl className="facts facts-inline">
        <div>
          <dt>{runCopy.facts.issuer}</dt>
          <dd>{name(spec.issuer)}</dd>
        </div>
        <div>
          <dt>{runCopy.facts.wallet}</dt>
          <dd>{name(spec.wallet)}</dd>
        </div>
        <div>
          <dt>{runCopy.facts.verifier}</dt>
          <dd>{name(spec.verifier)}</dd>
        </div>
      </dl>
      <ul className="chip-row" aria-label="Run facts">
        <li className="chip">{FORMAT_LABEL[spec.format]}</li>
        {spec.grant ? <li className="chip chip-outline">{spec.grant}</li> : null}
        {spec.presentationMode ? (
          <li className="chip chip-outline">{spec.presentationMode}</li>
        ) : null}
        <li className="chip chip-outline">
          {runCopy.facts.env}: {[...new Set(Object.values(spec.env))].join(' + ')}
        </li>
        {view.proofAlg ? (
          <li className="chip chip-outline">{runCopy.facts.proof(view.proofAlg)}</li>
        ) : null}
        {changed.map(([k, v]) => (
          <li key={k} className="chip tone-info">
            {runCopy.facts.changed(k, String(v))}
          </li>
        ))}
        {spec.parentRunId ? (
          <li className="chip chip-outline">
            <Link to={`/runs/${spec.parentRunId}`}>
              {runCopy.facts.rerunOf(shortId(spec.parentRunId))}
            </Link>
          </li>
        ) : null}
        {run?.origin === 'imported' ? (
          <li className="chip chip-outline" title={runCopy.facts.importedTip}>
            {runCopy.facts.imported}
          </li>
        ) : null}
      </ul>
      <details className="disclosure">
        <summary>{runCopy.facts.versions}</summary>
        <ul className="disclosure-body mono small">
          {(['issuer', 'wallet', 'verifier'] as const).map((role) => (
            <li key={role}>
              {spec[role]}: {spec.versions[role]}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/** State badge shown beside the run title. */
export function RunTitleChips({ vs, view }: { vs: ViewState; view: RunView }) {
  if (vs === 'loading') return null;
  const s = stateBadge(vs);
  return (
    <span className="title-chips">
      <span className={`state-word tone-${s.state === 'failed' ? 'warn' : 'info'}`}>{s.word}</span>
      {view.verdict && vs.startsWith('done-') ? (
        <StatusBadge state={view.verdict.outcome} size="md" />
      ) : null}
    </span>
  );
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
      <Link className="btn btn-secondary btn-sm" to={`/?clone=${runId}`}>
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

const VERDICT_WORD = runCopy.verdictChip;

/** UI-11 ResultCard for terminal `completed` runs */
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
  if (!v || !spec) return null;
  const failing = v.failedStepKey ? labelOf(v.failedStepKey, steps) : null;
  const rows: [string, string][] = [
    [runCopy.facts.issuer, name(spec.issuer)],
    [runCopy.facts.wallet, name(spec.wallet)],
    [runCopy.facts.verifier, name(spec.verifier)],
    [runCopy.facts.format, FORMAT_LABEL[spec.format]],
    [runCopy.result.proofAlg, view.proofAlg ?? 'not recorded'],
    [runCopy.facts.grant, spec.grant ?? 'none'],
    [
      runCopy.facts.mode,
      spec.presentationMode ??
        (spec.scope === 'issuance' ? 'issuance only' : 'credential only (no OID4VP)'),
    ],
    [runCopy.facts.env, [...new Set(Object.values(spec.env))].join(' + ')],
    [runCopy.result.outcome, VERDICT_WORD[v.outcome]],
  ];
  if (failing) rows.push([runCopy.result.failingStep, failing]);
  const tone =
    v.outcome === 'pass'
      ? 'pass'
      : v.outcome === 'fail' || v.outcome === 'blocked'
        ? 'fail'
        : v.outcome === 'inconclusive'
          ? 'warn'
          : 'neutral';
  return (
    <section
      role="region"
      aria-label={runCopy.result.region}
      className={`result-card tone-${tone}`}
    >
      <div className="result-verdict">
        <p className="result-word">
          <Icon name={`st-${v.outcome}`} size={28} />
          <span>{VERDICT_WORD[v.outcome]}</span>
        </p>
        <p className="result-sentence">{resultSentence(view, steps, target)}</p>
        {note ? (
          <p className="result-note">
            <span className="muted">{runCopy.result.note}: </span>
            {note}
          </p>
        ) : null}
      </div>
      <dl className="facts result-facts">
        {rows.map(([k, val]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{val}</dd>
          </div>
        ))}
      </dl>
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
