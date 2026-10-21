/**
 * UI-26 child banner and fix result card, UI-27 compact side-by-side strip, UI-28 lineage strip
 * (angle A, 09 A5.3..A5.6). The claim sentence comes from API-31 verbatim; the words "fixed",
 * "proved", "the fix works" appear only for `counterfactualResult = fixed` (UI-26 hard rule).
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type {
  CompareResponse,
  KnobEntry,
  LineageResponse,
  Run,
  RunSpec,
} from '@interop-playground/api';
import { ApiError, apiSend } from '../api/client.js';
import { InlineError } from '../components/InlineError.js';
import { shortId } from '../components/RunLink.js';
import { Skeleton } from '../components/Skeleton.js';
import { Icon } from '../components/Icon.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { angleCopy as c, screenCopy } from '../copy.js';
import { announce } from '../lib/announce.js';
import {
  CLASS_TONE,
  changeOf,
  knobEntry,
  orderCompareRows,
  type Classification,
  type CompareRow,
} from './model.js';

export type Load<T> =
  { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: unknown };

type Delta = NonNullable<RunSpec['knobDelta']>;
const CLASS_GLYPH = {
  fixed: 'st-pass',
  moved: 'st-inconclusive',
  'not-fixed': 'st-fail',
  inconclusive: 'st-inconclusive',
} as const satisfies Record<Classification, string>;
const knobName = (knobs: readonly KnobEntry[], d: Delta) =>
  knobEntry(knobs, d.knobId)?.def.name ?? d.knobId;

/** UI-26 ChildBanner (`role="status"`), from `queued` to the terminal event, then one line */
export function ChildBanner({
  parentRunId,
  delta,
  knobs,
  fingerprintId,
  terminal,
}: {
  parentRunId: string;
  delta: Delta;
  knobs: readonly KnobEntry[];
  fingerprintId: string | null;
  terminal: boolean;
}) {
  const pid = shortId(parentRunId);
  const name = knobName(knobs, delta);
  const text = terminal
    ? c.child.bannerShort(pid, name, delta.from, delta.to)
    : c.child.banner(pid, name, delta.from, delta.to, fingerprintId);
  // the parent id in the sentence is a run link
  const [before, after] = text.split(pid, 2) as [string, string | undefined];
  return (
    <div className="banner tone-info child-banner" role="status" data-testid="child-banner">
      <p>
        {before}
        <Link to={`/runs/${parentRunId}`} className="mono" title={parentRunId}>
          {pid}
        </Link>
        {after ?? ''}
      </p>
    </div>
  );
}

/** UI-26 ChildResultCard (terminal derived runs only) */
export function ChildResultCard({
  childRunId,
  parentRunId,
  classification,
  delta,
  knobs,
  compare,
  fingerprintId,
  childFailingCheckId,
}: {
  childRunId: string;
  parentRunId: string;
  classification: Classification;
  delta: Delta;
  knobs: readonly KnobEntry[];
  compare: Load<CompareResponse>;
  fingerprintId: string | null;
  childFailingCheckId: string | null;
}) {
  const navigate = useNavigate();
  const pid = shortId(parentRunId);
  const hid = useId();
  const key = useRef<string>(crypto.randomUUID());
  const [again, setAgain] = useState<{ sending: boolean; error: unknown }>({
    sending: false,
    error: null,
  });
  const announced = useRef(false);
  useEffect(() => {
    if (announced.current) return;
    announced.current = true;
    announce(c.child.announce(c.child.chip[classification]));
  }, [classification]);
  const label = knobEntry(knobs, delta.knobId)?.label ?? null;
  const gone =
    compare.status === 'error' &&
    compare.error instanceof ApiError &&
    (compare.error.code === 'not_found' || compare.error.code === 'compare_not_comparable');
  const claim = compare.status === 'ready' ? compare.data.claimSentence : null;

  const runAgain = async () => {
    setAgain({ sending: true, error: null });
    try {
      const child = await apiSend<Run>(
        'POST',
        `/runs/${encodeURIComponent(parentRunId)}/derive`,
        { knobId: delta.knobId, value: delta.to },
        { 'Idempotency-Key': key.current },
      );
      void navigate(`/runs/${child.runId}`);
    } catch (error) {
      setAgain({ sending: false, error });
    }
  };

  let sentence: React.ReactNode;
  if (gone)
    sentence = (
      <p>
        {compare.status === 'error' &&
        compare.error instanceof ApiError &&
        compare.error.code === 'not_found'
          ? c.child.parentDeleted
          : c.child.notComparable}
      </p>
    );
  else if (classification === 'fixed')
    sentence =
      compare.status === 'loading' ? (
        <Skeleton width="80%" height="1rem" />
      ) : (
        <>
          {claim ? (
            <blockquote className="claim-block" data-testid="claim">
              {claim}
            </blockquote>
          ) : null}
          {label ? <p className="small muted">({label})</p> : null}
        </>
      );
  else if (classification === 'moved')
    sentence = <p>{c.child.moved(childFailingCheckId ?? '?')}</p>;
  else if (classification === 'not-fixed')
    sentence = <p>{c.child.notFixed(fingerprintId ?? '?')}</p>;
  else sentence = <p>{c.child.inconclusive}</p>;

  return (
    <section
      className={`child-result tone-${CLASS_TONE[classification]}`}
      aria-labelledby={hid}
      data-classification={classification}
      data-testid="child-result"
    >
      <div className="diagnosis-head">
        <span className="child-glyph" aria-hidden="true">
          <Icon name={CLASS_GLYPH[classification]} size={28} />
        </span>
        <span className="child-kind">{c.child.chip[classification]}</span>
        <h2 id={hid}>{c.child.heading[classification]}</h2>
      </div>
      {sentence}
      {again.error ? <InlineError error={again.error} /> : null}
      {gone ? null : (
        <p className="child-actions">
          {classification === 'inconclusive' ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={again.sending}
              onClick={() => void runAgain()}
            >
              {c.child.runAgain}
            </button>
          ) : null}
          <Link
            className="btn btn-secondary btn-sm"
            to={`/runs/${parentRunId}/compare/${childRunId}`}
          >
            {c.child.compare(pid)}
          </Link>
          <Link className="btn btn-secondary btn-sm" to={`/runs/${parentRunId}`}>
            {c.child.open(pid)}
          </Link>
          {classification === 'fixed' && claim ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(claim)
                  .then(() => announce(c.child.copied))
                  .catch(() => undefined);
              }}
            >
              {c.child.copyClaim}
            </button>
          ) : null}
        </p>
      )}
    </section>
  );
}

function OutcomeCell({ step }: { step: CompareRow['parent'] }) {
  const o = step?.outcome ?? null;
  return (
    <>
      <StatusBadge state={o === 'skipped' ? 'n/a' : o === 'pass' || o === 'fail' ? o : 'not-run'} />
      {step?.capture && step.capture !== 'full' && o !== 'skipped' ? (
        <span className="capture-note">{`capture ${step.capture}`}</span>
      ) : null}
    </>
  );
}

/** UI-27 compact strip: a disclosure under the result card, knob's direct effect first */
export function CompareStrip({
  parentRunId,
  childRunId,
  delta,
  knobs,
  compare,
  stepLabel,
  onRetry,
  onDiffers,
}: {
  parentRunId: string;
  childRunId: string;
  delta: Delta;
  knobs: readonly KnobEntry[];
  compare: Load<CompareResponse>;
  stepLabel: (stepKey: string) => string;
  onRetry: () => void;
  onDiffers: (stepKey: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const pid = shortId(parentRunId);
  const bodyId = useId();
  let body: React.ReactNode = null;
  if (open) {
    if (compare.status === 'loading')
      body = (
        <div aria-busy="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height="1.5rem" />
          ))}
        </div>
      );
    else if (compare.status === 'error') {
      const code = compare.error instanceof ApiError ? compare.error.code : null;
      body =
        code === 'not_found' ? (
          <p>{c.strip.parentDeleted}</p>
        ) : code === 'compare_not_comparable' ? (
          <p>{c.strip.notComparable}</p>
        ) : (
          <InlineError error={compare.error} onRetry={onRetry} />
        );
    } else {
      const { shown, unchanged } = orderCompareRows(compare.data.steps);
      const rows = showAll ? [...shown, ...unchanged] : shown;
      body = (
        <>
          {shown.length === 0 ? <p>{c.strip.empty}</p> : null}
          {rows.length > 0 ? (
            <div className="table-wrap">
              <table className="compare-strip">
                <thead>
                  <tr>
                    <th scope="col">{c.strip.step}</th>
                    <th scope="col">{c.strip.original(pid)}</th>
                    <th scope="col">
                      {c.strip.rerun(shortId(childRunId), knobName(knobs, delta), delta.to)}
                    </th>
                    <th scope="col">{c.strip.change}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const ch = changeOf(r);
                    const from = r.parent?.outcome ?? null;
                    const to = r.child?.outcome ?? null;
                    const flipped = from !== null && to !== null && from !== to;
                    return (
                      <tr
                        key={r.stepKey}
                        data-step-row={r.stepKey}
                        data-direct={r.directEffect}
                        data-flip={flipped ? `${from}-${to}` : undefined}
                      >
                        <th scope="row">
                          {stepLabel(r.stepKey)}
                          {r.directEffect ? (
                            <span className="compare-direct">{c.strip.direct(delta.knobId)}</span>
                          ) : null}
                        </th>
                        <td>
                          <OutcomeCell step={r.parent} />
                        </td>
                        <td>
                          <span className="flip-cell">
                            {flipped ? (
                              <span
                                className="flip-arrow"
                                title={screenCopy.strip.flipped}
                                aria-hidden="true"
                              >
                                →
                              </span>
                            ) : null}
                            <OutcomeCell step={r.child} />
                          </span>
                        </td>
                        <td>
                          {ch.kind === 'differs' ? (
                            <button
                              type="button"
                              className="btn-link"
                              onClick={() => onDiffers(r.stepKey)}
                            >
                              {c.strip.differs(ch.n)}
                            </button>
                          ) : ch.kind === 'same' ? (
                            c.strip.same
                          ) : ch.kind === 'only-parent' ? (
                            c.strip.onlyParent
                          ) : ch.kind === 'only-child' ? (
                            c.strip.onlyChild
                          ) : (
                            c.strip.skipped(ch.side)
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
          {!showAll && unchanged.length > 0 ? (
            <button type="button" className="btn-link" onClick={() => setShowAll(true)}>
              {c.strip.showUnchanged(unchanged.length)}
            </button>
          ) : null}
        </>
      );
    }
  }
  return (
    <div className="compare-strip-wrap" data-testid="compare-strip">
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
      >
        {c.strip.disclosure(pid)}
      </button>
      <div id={bodyId} hidden={!open} className="compare-strip-body">
        {body}
        <p className="small muted">{c.strip.volatile}</p>
        <Link to={`/runs/${parentRunId}/compare/${childRunId}`}>{c.strip.full}</Link>
      </div>
    </div>
  );
}

/** UI-28 lineage strip: rendered only when the chain has more than one run */
export function LineageStrip({
  runId,
  lineage,
  knobs,
}: {
  runId: string;
  lineage: LineageResponse;
  knobs: readonly KnobEntry[];
}) {
  const chain = lineage.chain;
  if (chain.length <= 1) return null;
  return (
    <nav className="lineage-strip" aria-labelledby="lineage-h">
      <h2 id="lineage-h" className="lineage-heading">
        {c.lineage.heading}
      </h2>
      <ol aria-label={c.lineage.heading}>
        {chain.map((link, i) => {
          const current = link.runId === runId;
          const word =
            link.result ?? (link.state === 'queued' || link.state === 'running' ? 'running' : null);
          return (
            <li key={link.runId} aria-current={current ? 'step' : undefined}>
              {i > 0 && link.knobDelta ? (
                <span className="lineage-link">
                  <code>{knobName(knobs, link.knobDelta)}</code> {link.knobDelta.from} →{' '}
                  {link.knobDelta.to}
                  {word ? ` · ${c.lineage.result[word]}` : ''}
                </span>
              ) : null}
              <Link to={`/runs/${link.runId}`} className="mono" title={link.runId}>
                {c.lineage.run(shortId(link.runId))}
              </Link>
              {current ? <span className="lineage-current">{c.lineage.current}</span> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
