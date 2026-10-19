/**
 * The flow definitions behind a run (06 UI-09 step 2, API-06): issuance flow, then presentation flow
 * (absent for `scope = issuance`). A format-delta file is resolved against its base exactly like the
 * BFF validator: start from the base steps, replace by stepKey, insert after `after` (03 §3.1).
 */
import { useEffect, useState } from 'react';
import type { FlowDefinition, FlowStep, RunSpec } from '@interop-playground/api';
import { apiGet } from '../api/client.js';

export interface RailStep {
  stepKey: string;
  order: number;
  label: string;
  kind: FlowStep['kind'];
  flowId: string;
  block: 'issuance' | 'presentation';
  /** 03 §1.15 capture default: http steps are captured, engine/ui/manual steps never are */
  captureDefault: 'full' | 'none';
}

export interface RunFlows {
  issuance: FlowDefinition | null;
  presentation: FlowDefinition | null;
  steps: RailStep[];
  /** base files of format-delta flows (`extends`), for the diagram's merged steps */
  bases?: Record<string, FlowDefinition>;
}

export function mergeSteps(def: FlowDefinition, base: FlowDefinition | null): FlowStep[] {
  if (!def.extends || !base) return def.steps;
  const steps = [...base.steps];
  for (const s of def.steps) {
    const at = steps.findIndex((b) => b.stepKey === s.stepKey);
    if (at >= 0) {
      steps[at] = s;
      continue;
    }
    const after = s.after ? steps.findIndex((b) => b.stepKey === s.after) : -1;
    steps.splice(after >= 0 ? after + 1 : steps.length, 0, s);
  }
  return steps;
}

/** UI-13: the label "without placeholders": known ones filled from the spec, others shown as `…` */
export function plainLabel(label: string, spec: RunSpec | null): string {
  return label.replace(/\{(\w+)\}/g, (_m, name: string) => {
    if (name === 'id' && spec) return spec.configurationId;
    if (name === 'channel' && spec) return spec.delivery;
    return '…';
  });
}

export function railSteps(
  issuance: FlowDefinition | null,
  presentation: FlowDefinition | null,
  bases: Record<string, FlowDefinition>,
  spec: RunSpec | null,
): RailStep[] {
  const rows: RailStep[] = [];
  for (const [def, block] of [
    [issuance, 'issuance'],
    [presentation, 'presentation'],
  ] as const) {
    if (!def) continue;
    const base = def.extends ? (bases[def.extends] ?? null) : null;
    for (const s of mergeSteps(def, base)) {
      if (s.deprecated) continue;
      rows.push({
        stepKey: s.stepKey,
        order: s.order,
        label: plainLabel(s.label, spec),
        kind: s.kind,
        flowId: def.flowId,
        block,
        captureDefault: s.kind === 'http' ? 'full' : 'none',
      });
    }
  }
  return rows;
}

export type FlowLoad =
  | { status: 'loading' }
  | { status: 'ready'; flows: RunFlows }
  | { status: 'error'; error: unknown };

/** Fetch the run's flow files (and their bases) once the spec is known. */
export function useRunFlows(
  spec: RunSpec | null,
  fetchFlow: (id: string) => Promise<FlowDefinition> = (id) =>
    apiGet<FlowDefinition>(`/flows/${encodeURIComponent(id)}`),
): FlowLoad {
  const [load, setLoad] = useState<FlowLoad>({ status: 'loading' });
  const issuanceId = spec?.issuanceFlowId ?? null;
  const presentationId = spec?.scope === 'issuance' ? null : (spec?.presentationFlowId ?? null);
  useEffect(() => {
    if (!issuanceId) return;
    let live = true;
    const get = async (id: string | null) => (id ? fetchFlow(id) : null);
    void (async () => {
      try {
        const [i, p] = await Promise.all([get(issuanceId), get(presentationId)]);
        const bases: Record<string, FlowDefinition> = {};
        for (const d of [i, p]) {
          if (d?.extends && !bases[d.extends]) bases[d.extends] = await fetchFlow(d.extends);
        }
        if (live)
          setLoad({
            status: 'ready',
            flows: {
              issuance: i,
              presentation: p,
              steps: railSteps(i, p, bases, spec),
              bases,
            },
          });
      } catch (error) {
        if (live) setLoad({ status: 'error', error });
      }
    })();
    return () => {
      live = false;
    };
    // the spec is immutable per run (ADR-21): the flow ids identify it
  }, [issuanceId, presentationId]);
  return load;
}
