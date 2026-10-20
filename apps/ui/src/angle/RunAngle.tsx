/**
 * Angle A on the run screen (06 UI-09 "diagnosis" region): loads API-30 (diagnosis, terminal
 * fail/blocked runs), API-31 (compare, terminal derived runs; parent first, OI-4) and API-33
 * (lineage, terminal runs) once the run is terminal, and renders UI-24..UI-28 from the components
 * of this folder. The child banner (UI-26) lives in the banners region: `ChildBannerSlot`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CompareResponse,
  DiagnosisResponse,
  EventEnvelope,
  LineageResponse,
  Run,
} from '@interop-playground/api';
import { apiGet } from '../api/client.js';
import { Skeleton } from '../components/Skeleton.js';
import { angleCopy as c, copy } from '../copy.js';
import { buildModel } from '../inspector/model.js';
import type { RailStep } from '../run/flows.js';
import { labelOf } from '../run/derive.js';
import { isTerminal, type RunView } from '../run/reduce.js';
import { useAdapterName } from '../run/parts.js';
import { useStore } from '../state/store.js';
import { ChildBanner, ChildResultCard, CompareStrip, LineageStrip, type Load } from './ChildRun.js';
import { DiagnosisCard } from './DiagnosisCard.js';
import { knobList, type Classification, type Match } from './model.js';

/** fetch once per key (null = do not fetch); `reload` refetches */
function useLoad<T>(path: string | null): [Load<T> | null, () => void] {
  const [state, setState] = useState<{ path: string; load: Load<T> } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setState({ path, load: { status: 'loading' } });
    apiGet<T>(path)
      .then((data) => live && setState({ path, load: { status: 'ready', data } }))
      .catch((error: unknown) => live && setState({ path, load: { status: 'error', error } }));
    return () => {
      live = false;
    };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  if (!path) return [null, reload];
  return [state && state.path === path ? state.load : { status: 'loading' }, reload];
}

/** The knob catalogue as a list, empty until it has loaded. */
export function useKnobs() {
  const knobs = useStore((s) => s.catalog.knobs);
  return useMemo(() => (knobs.status === 'ready' ? knobList(knobs.data) : []), [knobs]);
}

function completedResult(events: readonly EventEnvelope[]): Classification | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'run.completed')
      return (e as EventEnvelope<'run.completed'>).payload.counterfactualResult;
  }
  return null;
}

/** UI-26 banner, shown from `queued` on for every derived run */
export function ChildBannerSlot({ view, run }: { view: RunView; run: Run | null }) {
  const knobs = useKnobs();
  const spec = view.spec ?? run?.spec ?? null;
  if (!spec?.parentRunId || !spec.knobDelta) return null;
  return (
    <ChildBanner
      parentRunId={spec.parentRunId}
      delta={spec.knobDelta}
      knobs={knobs}
      fingerprintId={spec.causeFingerprintId ?? null}
      terminal={isTerminal(view)}
    />
  );
}

/** The diagnosis and fix-it section of the run screen: shows the matched cause and, when allowed, the one-knob re-run offer. */
export function RunAngle({
  runId,
  view,
  run,
  events,
  steps,
  onShowMessages,
  onShowCheck,
}: {
  runId: string;
  view: RunView;
  run: Run | null;
  events: readonly EventEnvelope[];
  steps: readonly RailStep[];
  onShowMessages: (stepKey: string, exchangeIds: string[]) => void;
  onShowCheck: (stepKey: string) => void;
}) {
  const knobs = useKnobs();
  const adapterName = useAdapterName();
  const spec = view.spec ?? run?.spec ?? null;
  const terminal =
    isTerminal(view) || (run !== null && run.state !== 'queued' && run.state !== 'running');
  const outcome = view.verdict?.outcome ?? run?.verdict?.outcome ?? null;
  const completed = (view.state ?? run?.state) === 'completed';
  const tamper = Boolean(spec?.tamperCase);
  const diagnosable =
    terminal && completed && !tamper && (outcome === 'fail' || outcome === 'blocked');
  const parentRunId = spec?.parentRunId ?? null;
  const delta = spec?.knobDelta ?? null;
  const enc = encodeURIComponent(runId);

  const [diagnosis, reloadDiagnosis] = useLoad<DiagnosisResponse>(
    diagnosable ? `/runs/${enc}/diagnosis` : null,
  );
  const [lineage] = useLoad<LineageResponse>(terminal ? `/runs/${enc}/lineage` : null);
  const [compare, reloadCompare] = useLoad<CompareResponse>(
    terminal && parentRunId && delta
      ? `/runs/${encodeURIComponent(parentRunId)}/compare/${enc}`
      : null,
  );
  const model = useMemo(() => buildModel(events), [events]);
  const failing = useMemo(
    () => model.checks.find((v) => v.check.outcome === 'fail') ?? null,
    [model],
  );
  const failedStepKey = view.verdict?.failedStepKey ?? run?.verdict?.failedStepKey ?? null;
  const classification = completedResult(events) ?? run?.counterfactualResult ?? null;
  const childFailing = failing?.check.checkId ?? null;

  const showMessages = (m: Match) => {
    const ids = m.matchedExchangeIds;
    const owner = model.exchanges.find((x) => ids.includes(x.exchangeId))?.stepKey ?? failedStepKey;
    if (owner) onShowMessages(owner, ids);
  };
  const failingKey = failing?.stepKey ?? failedStepKey;

  return (
    <>
      {terminal && parentRunId && delta && classification ? (
        <>
          <ChildResultCard
            childRunId={runId}
            parentRunId={parentRunId}
            classification={classification}
            delta={delta}
            knobs={knobs}
            compare={compare ?? { status: 'loading' }}
            fingerprintId={spec?.causeFingerprintId ?? null}
            childFailingCheckId={childFailing}
          />
          <CompareStrip
            parentRunId={parentRunId}
            childRunId={runId}
            delta={delta}
            knobs={knobs}
            compare={compare ?? { status: 'loading' }}
            stepLabel={(k) => labelOf(k, steps)}
            onRetry={reloadCompare}
            onDiffers={(k) => onShowMessages(k, [])}
          />
        </>
      ) : null}
      {diagnosis === null ? null : diagnosis.status === 'loading' ? (
        <div className="diagnosis-card" aria-busy="true" data-testid="diagnosis-loading">
          <p className="muted">{c.card.loading}</p>
          <Skeleton height="4rem" />
        </div>
      ) : diagnosis.status === 'error' ? (
        <div className="diagnosis-card">
          <div className="inline-error" role="alert">
            <p className="inline-error-text">{c.card.loadError}</p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={reloadDiagnosis}>
              {copy.tryAgain}
            </button>
          </div>
        </div>
      ) : (
        <DiagnosisCard
          runId={runId}
          diagnosis={diagnosis.data}
          origin={run?.origin ?? null}
          outcome={outcome}
          failingStepKey={failingKey}
          failingCheck={failing?.check ?? null}
          knobs={knobs}
          peerName={(id) => adapterName(id as Parameters<typeof adapterName>[0])}
          onShowMessages={showMessages}
          onShowCheck={failingKey ? () => onShowCheck(failingKey) : undefined}
        />
      )}
      {lineage?.status === 'ready' ? (
        <LineageStrip runId={runId} lineage={lineage.data} knobs={knobs} />
      ) : null}
    </>
  );
}
