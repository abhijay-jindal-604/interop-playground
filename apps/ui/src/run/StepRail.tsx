/**
 * `StepList` / StepRail (06 UI-13, UI-50): the accessible text form of the diagram and the keyboard
 * control for selecting steps. One row per flow step in flow order, grouped by block; roving
 * tabindex, ↑/↓ move, Enter/Space select and move focus to the inspector.
 */
import { useEffect, useRef } from 'react';
import { Icon } from '../components/Icon.js';
import type { BadgeState } from '../components/StatusBadge.js';
import { runCopy } from '../copy.js';
import { announce } from '../lib/announce.js';
import type { RailStep } from './flows.js';
import type { RunView, StepView } from './reduce.js';

type Word = keyof typeof runCopy.rail.outcome;

export function outcomeWord(s: StepView | undefined): Word {
  if (!s || s.state === 'pending') return 'pending';
  if (s.state === 'running') return 'running';
  return s.outcome ?? 'pending';
}

const BADGE: Record<Word, BadgeState> = {
  pending: 'not-run',
  running: 'running',
  pass: 'pass',
  fail: 'fail',
  skipped: 'n/a',
};
const TONE: Record<Word, string> = {
  pending: 'skipped',
  running: 'info',
  pass: 'pass',
  fail: 'fail',
  skipped: 'skipped',
};

export function CaptureBadge({
  capture,
  note,
}: {
  capture: StepView['capture'];
  note: string | null;
}) {
  if (!capture) return null;
  const text = runCopy.capture[capture];
  const tip =
    capture === 'full'
      ? runCopy.capture.fullTip
      : capture === 'partial'
        ? runCopy.capture.partialTip(note ?? '')
        : runCopy.capture.noneTip;
  return (
    <span className={`chip chip-outline capture-${capture}`} title={tip}>
      {text}
    </span>
  );
}

function Row({
  row,
  step,
  selected,
  focusable,
  onSelect,
  onKey,
  buttonRef,
  onDelivery,
}: {
  /** set on the row of the `…deliver` step once its delivery event exists (UI-16) */
  onDelivery?: (() => void) | undefined;
  row: RailStep;
  step: StepView | undefined;
  selected: boolean;
  focusable: boolean;
  onSelect: () => void;
  onKey: (e: React.KeyboardEvent) => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
}) {
  const word = outcomeWord(step);
  const done = step?.state === 'done';
  const skipped = done && step?.outcome === 'skipped';
  const messages = step?.exchangeIds.length ?? 0;
  const checks = step?.checks.filter((c) => c.outcome !== 'info').length ?? 0;
  return (
    <li className={`step-row${selected ? ' is-selected' : ''}${skipped ? ' is-skipped' : ''}`}>
      <button
        ref={buttonRef}
        type="button"
        className="step-button"
        aria-current={selected ? 'true' : undefined}
        tabIndex={focusable ? 0 : -1}
        data-step={row.stepKey}
        onClick={onSelect}
        onKeyDown={onKey}
      >
        <span className="step-order mono" aria-hidden="true">
          {row.order}
        </span>
        <span className="step-main">
          <span className="step-label">{row.label}</span>
          <span className="step-key mono">{row.stepKey}</span>
          {skipped && step?.skipReason ? (
            <span className="step-note">{step.skipReason}</span>
          ) : null}
          {done && step?.capture === 'partial' && step.coverageNote ? (
            <span className="step-note">{step.coverageNote}</span>
          ) : null}
        </span>
        <span className="step-meta">
          <span className={`badge badge-sm tone-${TONE[word]}`}>
            <Icon name={`st-${BADGE[word]}`} size={16} />
            <span>{runCopy.rail.outcome[word]}</span>
          </span>
          {done && !skipped ? (
            <CaptureBadge capture={step?.capture ?? null} note={step?.coverageNote ?? null} />
          ) : null}
          {done && !skipped && step?.durationMs !== null && step?.durationMs !== undefined ? (
            <span className="muted small mono">{step.durationMs} ms</span>
          ) : null}
          {messages > 0 ? (
            <span className="muted small">{runCopy.rail.messages(messages)}</span>
          ) : null}
          {checks > 0 ? <span className="muted small">{runCopy.rail.checks(checks)}</span> : null}
        </span>
      </button>
      {onDelivery ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm step-delivery"
          title={runCopy.diagram.deliveryTip}
          data-action="delivery"
          onClick={onDelivery}
        >
          <Icon name="qr" size={16} />
          <span>{runCopy.diagram.delivery}</span>
        </button>
      ) : null}
    </li>
  );
}

export function StepRail({
  steps,
  view,
  selected,
  onSelect,
  onActivate,
  deliveryStep = null,
  onDelivery,
}: {
  steps: readonly RailStep[];
  view: RunView;
  selected: string | null;
  deliveryStep?: string | null;
  onDelivery?: () => void;
  onSelect: (stepKey: string) => void;
  /** Enter/Space: select and move focus to the inspector */
  onActivate: (stepKey: string) => void;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const focusKey =
    selected && steps.some((s) => s.stepKey === selected) ? selected : (steps[0]?.stepKey ?? null);
  const move = (from: string, delta: number) => {
    const at = steps.findIndex((s) => s.stepKey === from);
    const next = steps[Math.min(steps.length - 1, Math.max(0, at + delta))];
    if (!next) return;
    onSelect(next.stepKey);
    refs.current.get(next.stepKey)?.focus();
  };
  const blocks = (['issuance', 'presentation'] as const)
    .map((b) => ({ block: b, rows: steps.filter((s) => s.block === b) }))
    .filter((b) => b.rows.length > 0);
  return (
    <nav className="step-rail" aria-label={runCopy.rail.heading}>
      {blocks.map(({ block, rows }) => (
        <section key={block} className="step-block" aria-labelledby={`rail-${block}`}>
          <h3 id={`rail-${block}`} className="step-block-title">
            {runCopy.rail[block]}
          </h3>
          <ol className="step-list" role="list">
            {rows.map((row) => (
              <Row
                key={row.stepKey}
                row={row}
                step={view.steps[row.stepKey]}
                selected={row.stepKey === selected}
                focusable={row.stepKey === focusKey}
                buttonRef={(el) => {
                  if (el) refs.current.set(row.stepKey, el);
                  else refs.current.delete(row.stepKey);
                }}
                onSelect={() => onSelect(row.stepKey)}
                onDelivery={row.stepKey === deliveryStep ? onDelivery : undefined}
                onKey={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    move(row.stepKey, 1);
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    move(row.stepKey, -1);
                  } else if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onActivate(row.stepKey);
                  }
                }}
              />
            ))}
          </ol>
        </section>
      ))}
    </nav>
  );
}

/** UI-13 live announcements: one sentence per completed step and one on the terminal event */
export function useStepAnnouncements(
  view: RunView,
  steps: readonly RailStep[],
  live: boolean,
): void {
  const seen = useRef<Set<string> | null>(null);
  const finished = useRef(false);
  useEffect(() => {
    const done = Object.values(view.steps).filter((s) => s.state === 'done');
    if (seen.current === null || !live) {
      // the first render (a reload or a finished run) announces nothing
      seen.current = new Set(done.map((s) => s.stepKey));
      finished.current =
        view.verdict !== null || view.state === 'failed' || view.state === 'cancelled';
      return;
    }
    for (const s of done) {
      if (seen.current.has(s.stepKey)) continue;
      seen.current.add(s.stepKey);
      const label = steps.find((r) => r.stepKey === s.stepKey)?.label ?? s.stepKey;
      announce(runCopy.rail.announceStep(label, runCopy.rail.outcome[outcomeWord(s)]));
    }
    if (!finished.current && view.verdict) {
      finished.current = true;
      announce(runCopy.rail.announceDone(runCopy.verdictChip[view.verdict.outcome]));
    }
  }, [view, steps, live]);
}
