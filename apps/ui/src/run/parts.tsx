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

/**
 * The facts under the run title (ADR-128): the three roles as one inline definition list, then
 * format, grant, mode, environment and proof as one muted line; versions stay in a disclosure.
 */
export function RunHeaderFacts({ view, run }: { view: RunView; run: Run | null }) {
  const name = useAdapterName();
  const spec = view.spec;
  if (!spec) return null;
  const changed = Object.entries(spec.knobs);
  const meta: { key: string; node: React.ReactNode; title?: string }[] = [
    { key: 'format', node: FORMAT_LABEL[spec.format] },
  ];
  if (spec.grant) meta.push({ key: 'grant', node: spec.grant });
  if (spec.presentationMode) meta.push({ key: 'mode', node: spec.presentationMode });
  meta.push({
    key: 'env',
    node: runCopy.facts.envLine([...new Set(Object.values(spec.env))].join(' + ')),
  });
  if (view.proofAlg) meta.push({ key: 'proof', node: runCopy.facts.proof(view.proofAlg) });
  for (const [k, v] of changed)
    meta.push({ key: `knob-${k}`, node: runCopy.facts.changed(k, String(v)) });
  if (spec.parentRunId)
    meta.push({
      key: 'parent',
      node: (
        <Link to={`/runs/${spec.parentRunId}`}>
          {runCopy.facts.rerunOf(shortId(spec.parentRunId))}
        </Link>
      ),
    });
  if (run?.origin === 'imported')
    meta.push({ key: 'imported', node: runCopy.facts.imported, title: runCopy.facts.importedTip });
  return (
    <div className="run-facts">
      <dl className="run-roles">
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
      <ul className="run-meta" aria-label={runCopy.facts.region}>
        {meta.map((m) => (
          <li key={m.key} title={m.title}>
            {m.node}
          </li>
        ))}
      </ul>
      <details className="disclosure run-versions">
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

/**
 * The verdict glyph (ADR-128): drawn once with a stroke when the result appears. The silhouettes
 * stay distinct without colour (UI-74): circle and tick for pass, square and cross for fail or
 * blocked, triangle for inconclusive, circle and bar for the neutral outcomes.
 */
export function VerdictGlyph({ outcome }: { outcome: Outcome }) {
  const fail = outcome === 'fail' || outcome === 'blocked';
  return (
    <svg className="verdict-glyph" viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
      {fail ? (
        <rect className="vg-shape" x="3" y="3" width="34" height="34" rx="9" pathLength={1} />
      ) : outcome === 'inconclusive' ? (
        <path className="vg-shape" d="M20 3.5 37 34.5H3z" pathLength={1} />
      ) : (
        <circle className="vg-shape" cx="20" cy="20" r="17" pathLength={1} />
      )}
      {outcome === 'pass' ? (
        <path className="vg-mark" d="M12.5 20.5l5 5 10-10.5" pathLength={1} />
      ) : fail ? (
        <path className="vg-mark" d="M14 14l12 12M26 14L14 26" pathLength={1} />
      ) : outcome === 'inconclusive' ? (
        <path className="vg-mark" d="M20 14v9M20 28.5v.5" pathLength={1} />
      ) : (
        <path className="vg-mark" d="M13 20h14" pathLength={1} />
      )}
    </svg>
  );
}

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
  const tone = outcomeTone(v.outcome);
  return (
    <section
      role="region"
      aria-label={runCopy.result.region}
      className={`result-card tone-${tone}`}
      data-outcome={v.outcome}
    >
      <div className="result-verdict">
        <p className="result-word">
          <VerdictGlyph outcome={v.outcome} />
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
