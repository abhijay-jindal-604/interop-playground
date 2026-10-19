/**
 * The run screen body (06 UI-09 layout): banners, result, and the workspace with the diagram pane
 * (diagram slot for T-29 + StepRail) and the inspector pane (slot for T-28). The awaiting panel slot
 * (T-31) sits in the banners region. Pure over the reduced view; data wiring is in RunPage.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EventEnvelope, Run } from '@interop-playground/api';
import { ConnectionBanner } from '../components/ConnectionBanner.js';
import { InlineError } from '../components/InlineError.js';
import { Skeleton } from '../components/Skeleton.js';
import { runCopy } from '../copy.js';
import type { StreamStatus } from '../state/stream.js';
import { AwaitingPanel } from '../delivery/AwaitingPanel.js';
import { Inspector } from '../inspector/Inspector.js';
import { latestDelivery } from '../inspector/model.js';
import { defaultStep, stepFromHash, targetStepKey } from './derive.js';
import type { FlowLoad } from './flows.js';
import { CoverageBanner, ResultCard, StatusBanner } from './parts.js';
import { isTerminal, viewStateOf, type RunView } from './reduce.js';
import { StepRail, useStepAnnouncements } from './StepRail.js';

/** `#step=<stepKey>` with replaceState: selecting a step never pushes history (UI-09) */
export function useStepHash(): [string | null, (key: string) => void] {
  const [step, setStep] = useState<string | null>(() => stepFromHash(window.location.hash));
  useEffect(() => {
    const on = () => setStep(stepFromHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const select = useCallback((key: string) => {
    const { pathname, search } = window.location;
    window.history.replaceState(
      window.history.state,
      '',
      `${pathname}${search}#step=${encodeURIComponent(key)}`,
    );
    setStep(key);
  }, []);
  return [step, select];
}

const NO_EVENTS: readonly EventEnvelope[] = [];

export function RunScreen({
  view,
  events = NO_EVENTS,
  flows,
  run,
  stream,
  onRetryLive,
  onCancel,
}: {
  view: RunView;
  /** the ordered log the view was reduced from (inspector, delivery) */
  events?: readonly EventEnvelope[];
  flows: FlowLoad;
  run: Run | null;
  stream: StreamStatus | null;
  onRetryLive: () => void;
  onCancel: () => void;
}) {
  const ready = flows.status === 'ready';
  const steps = useMemo(() => (flows.status === 'ready' ? flows.flows.steps : []), [flows]);
  const vs = viewStateOf(view, ready);
  const [hashStep, select] = useStepHash();
  const terminal = isTerminal(view);
  const selected =
    hashStep && steps.some((s) => s.stepKey === hashStep)
      ? hashStep
      : terminal
        ? defaultStep(view, steps)
        : (view.currentStepKey ?? null);
  const inspector = useRef<HTMLElement>(null);
  const liveRef = useRef(!terminal);
  useStepAnnouncements(view, steps, liveRef.current && ready);

  const target = flows.status === 'ready' ? targetStepKey(flows.flows) : null;
  const delivery = useMemo(() => latestDelivery(events), [events]);

  return (
    <>
      <div className="run-region" data-region="banners">
        <ConnectionBanner status={stream} onRetry={onRetryLive} />
        <StatusBanner vs={vs} view={view} steps={steps} onCancel={onCancel} />
        <div data-slot="awaiting">
          {view.awaiting && !terminal ? (
            <AwaitingPanel awaiting={view.awaiting} delivery={delivery} />
          ) : null}
        </div>
        {ready ? <CoverageBanner view={view} steps={steps} onSelect={select} /> : null}
      </div>
      <div className="run-region" data-region="diagnosis" data-slot="diagnosis" />
      {vs.startsWith('done-') ? (
        <div className="run-region" data-region="result">
          <ResultCard view={view} steps={steps} target={target} note={run?.note ?? null} />
        </div>
      ) : null}
      {flows.status === 'error' ? <InlineError error={flows.error} alert={false} /> : null}
      <div className="run-workspace" data-region="workspace">
        <div className="run-pane run-pane-diagram">
          <div data-slot="diagram" className="diagram-slot" />
          {ready ? (
            <StepRail
              steps={steps}
              view={view}
              selected={selected}
              onSelect={select}
              onActivate={(key) => {
                select(key);
                inspector.current?.focus();
              }}
            />
          ) : (
            <div className="step-rail" aria-busy="true">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="step-skeleton">
                  <Skeleton height="2.5rem" />
                </div>
              ))}
            </div>
          )}
        </div>
        <section
          ref={inspector}
          tabIndex={-1}
          className="run-pane run-pane-inspector"
          aria-label={runCopy.inspector.region}
          data-slot="inspector"
          onKeyDown={(e) => {
            if (e.key === 'Escape' && selected) {
              document.querySelector<HTMLElement>(`[data-step="${CSS.escape(selected)}"]`)?.focus();
            }
          }}
        >
          {!ready ? (
            <p className="muted">{runCopy.loading}</p>
          ) : (
            <Inspector
              events={events}
              view={view}
              steps={steps}
              selected={selected}
              following={!terminal && !hashStep && selected !== null}
              terminal={terminal}
              onSelect={select}
            />
          )}
        </section>
      </div>
    </>
  );
}
