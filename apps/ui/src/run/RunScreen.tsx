/**
 * The run screen body (06 UI-09 layout): banners, result, and the workspace with the diagram pane
 * (diagram slot for T-29 + StepRail) and the inspector pane (slot for T-28). The awaiting panel slot
 * (T-31) sits in the banners region. Pure over the reduced view; data wiring is in RunPage.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AdapterId, EventEnvelope, Run } from '@interop-playground/api';
import { ConnectionBanner } from '../components/ConnectionBanner.js';
import { InlineError } from '../components/InlineError.js';
import { Skeleton } from '../components/Skeleton.js';
import { runCopy } from '../copy.js';
import type { StreamStatus } from '../state/stream.js';
import { AwaitingPanel } from '../delivery/AwaitingPanel.js';
import { DeliveryDialog } from '../delivery/Delivery.js';
import { DiagramPane } from '../diagram/Diagram.js';
import { lifelineNames } from '../diagram/model.js';
import { Inspector, type InspectorFocus } from '../inspector/Inspector.js';
import { ChildBannerSlot, RunAngle } from '../angle/RunAngle.js';
import { latestDelivery, type DeliveryOutput } from '../inspector/model.js';
import { defaultStep, stepFromHash, targetStepKey } from './derive.js';
import type { FlowLoad } from './flows.js';
import { CoverageBanner, ResultCard, StatusBanner, useAdapterName } from './parts.js';
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
  const adapterName = useAdapterName();
  const names = lifelineNames(view.spec, (id) => adapterName(id as AdapterId));
  const [dialog, setDialog] = useState<DeliveryOutput | null>(null);
  const [focus, setFocus] = useState<InspectorFocus | null>(null);
  const showTab = useCallback(
    (stepKey: string, tab: InspectorFocus['tab'], exchangeIds: string[]) => {
      select(stepKey);
      setFocus({ stepKey, tab, exchangeIds });
      inspector.current?.focus();
    },
    [select],
  );
  const runId = view.runId ?? run?.runId ?? null;
  const opener = useRef<HTMLElement | null>(null);
  const openDelivery = useCallback(() => {
    opener.current = document.activeElement as HTMLElement | null;
    setDialog(delivery);
  }, [delivery]);

  return (
    <>
      <div className="run-region" data-region="banners">
        <ConnectionBanner status={stream} onRetry={onRetryLive} />
        <ChildBannerSlot view={view} run={run} />
        <StatusBanner vs={vs} view={view} steps={steps} onCancel={onCancel} />
        <div data-slot="awaiting">
          {view.awaiting && !terminal ? (
            <AwaitingPanel awaiting={view.awaiting} delivery={delivery} />
          ) : null}
        </div>
        {ready ? <CoverageBanner view={view} steps={steps} onSelect={select} /> : null}
      </div>
      <div className="run-region" data-region="diagnosis" data-slot="diagnosis">
        {runId && ready ? (
          <RunAngle
            runId={runId}
            view={view}
            run={run}
            events={events}
            steps={steps}
            onShowMessages={(k, ids) => showTab(k, 'messages', ids)}
            onShowCheck={(k) => showTab(k, 'checks', [])}
          />
        ) : null}
      </div>
      {vs.startsWith('done-') ? (
        <div className="run-region" data-region="result">
          <ResultCard view={view} steps={steps} target={target} note={run?.note ?? null} />
        </div>
      ) : null}
      {flows.status === 'error' ? <InlineError error={flows.error} alert={false} /> : null}
      <div className="run-workspace" data-region="workspace">
        <div className="run-pane run-pane-diagram">
          <div
            data-slot="diagram"
            className="diagram-slot"
            role="figure"
            aria-label={runCopy.diagram.region}
          >
            {flows.status === 'ready' ? (
              <DiagramPane
                flows={flows.flows}
                view={view}
                events={events}
                names={names}
                selected={selected}
                deliveryStep={delivery?.stepKey ?? null}
                onSelect={select}
                onDelivery={openDelivery}
              />
            ) : null}
          </div>
          {ready ? (
            <StepRail
              steps={steps}
              view={view}
              selected={selected}
              deliveryStep={delivery?.stepKey ?? null}
              onDelivery={openDelivery}
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
              focus={focus}
            />
          )}
        </section>
      </div>
      <DeliveryDialog
        delivery={dialog}
        onClose={() => {
          setDialog(null);
          opener.current?.focus();
        }}
      />
    </>
  );
}
