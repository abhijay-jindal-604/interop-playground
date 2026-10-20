/**
 * Flow-file loader for the orchestrator (API-72, 04 §10, ADR-27, ADR-29). The files are validated at
 * BFF start by `validate/flows.ts`; this module resolves `extends` into the merged step list
 * (rule 5), evaluates the closed AND-filter `appliesTo` against a RunSpec (rule 1) and lays out
 * the step plan of a run: issuance steps, then presentation steps, each marked applicable or not.
 */
import type { FlowDefinition, FlowStep, RunSpec } from '@interop-playground/api';
import { loadFlows } from '../validate/index.js';

export interface PlannedStep {
  flowId: FlowDefinition['flowId'];
  stepKey: string;
  /** 1-based position in the merged flow file */
  order: number;
  /** position in the whole run (issuance then presentation), 1-based */
  index: number;
  kind: FlowStep['kind'];
  label: string;
  applies: boolean;
  /** `skipReason` of the file, default "not applicable" */
  skipReason: string;
}

export type FlowTable = ReadonlyMap<string, FlowDefinition>;

/**
 * Loads and validates the flow files in `dir`; throws on the first invalid file.
 * Reads and merges `flows/` (throws on the first invalid file, like the startup validator)
 */
export function loadFlowTable(dir: string): Map<string, FlowDefinition> {
  const r = loadFlows(dir);
  if (r.errors.length > 0) {
    const e = r.errors[0] as { file: string; errors: string[] };
    throw new Error(`invalid flow file ${e.file}: ${e.errors.join('; ')}`);
  }
  return r.flows;
}

/**
 * Returns a flow's steps with its `extends` parent resolved; a child step with the same key replaces the parent's step in place.
 * The merged step list of a flow (04 §10 rule 5), steps in file order, renumbered 1..
 */
export function mergedSteps(flows: FlowTable, flowId: string): FlowStep[] {
  const def = flows.get(flowId);
  if (!def) throw new Error(`flow ${flowId} is not loaded`);
  if (def.extends === undefined) return def.steps.map((s) => ({ ...s }));
  const merged = mergedSteps(flows, def.extends);
  for (const s of def.steps) {
    const at = merged.findIndex((b) => b.stepKey === s.stepKey);
    if (at >= 0) {
      merged[at] = { ...s };
      continue;
    }
    const pos = merged.findIndex((b) => b.stepKey === s.after);
    merged.splice(pos < 0 ? merged.length : pos + 1, 0, { ...s });
  }
  return merged.filter((s) => s.deprecated !== true).map((s, i) => ({ ...s, order: i + 1 }));
}

/**
 * True when the step's `appliesTo` filter (all listed conditions must hold) matches the run spec; no filter means it applies.
 * 04 §10 `appliesTo`: closed AND-filter, omitted = always applies.
 */
export function stepApplies(step: FlowStep, spec: RunSpec): boolean {
  const f = step.appliesTo;
  if (!f) return true;
  const roles = [spec.issuer, spec.wallet, spec.verifier];
  if (f.adapters && !f.adapters.some((a) => roles.includes(a))) return false;
  if (f.formats && !f.formats.includes(spec.format)) return false;
  if (f.grants && (spec.grant === null || !f.grants.includes(spec.grant))) return false;
  if (f.modes && (spec.presentationMode === null || !f.modes.includes(spec.presentationMode)))
    return false;
  if (f.deliveries && !f.deliveries.includes(spec.delivery)) return false;
  if (f.envs && !Object.values(spec.env).some((e) => f.envs?.includes(e))) return false;
  if (f.clientIdSchemes && !f.clientIdSchemes.includes(spec.clientIdScheme)) return false;
  if (f.withTxCode !== undefined && f.withTxCode !== spec.withTxCode) return false;
  if (f.withIae !== undefined && f.withIae !== spec.withIae) return false;
  return true;
}

/**
 * Lays out the run's steps: issuance flow first, then the presentation flow when the scope is full, each step marked applicable or not.
 * The run's step plan: issuance flow (unless fixture-only) then presentation flow.
 */
export function planRun(flows: FlowTable, spec: RunSpec): PlannedStep[] {
  const ids = [spec.issuanceFlowId, spec.scope === 'full' ? spec.presentationFlowId : null].filter(
    (x): x is FlowDefinition['flowId'] => x !== null,
  );
  const out: PlannedStep[] = [];
  for (const flowId of ids) {
    for (const s of mergedSteps(flows, flowId)) {
      out.push({
        flowId,
        stepKey: s.stepKey,
        order: s.order,
        index: out.length + 1,
        kind: s.kind,
        label: s.label,
        applies: stepApplies(s, spec),
        skipReason: s.skipReason ?? 'not applicable',
      });
    }
  }
  return out;
}

/**
 * The flow and step a run's diagnosis refers to: the presentation flow for full runs, else the issuance flow.
 * The flow whose `targetStepKey` answers the run (05 §4.1): presentation for full runs.
 */
export function targetOf(flows: FlowTable, spec: RunSpec): { flowId: string; stepKey: string } {
  const flowId =
    spec.scope === 'full' && spec.presentationFlowId !== null
      ? spec.presentationFlowId
      : spec.issuanceFlowId;
  const def = flows.get(flowId);
  if (!def) throw new Error(`flow ${flowId} is not loaded`);
  return { flowId, stepKey: def.targetStepKey };
}
