/** Reads `flows/FLOW-xx.json` (API-72) and resolves a format-delta file against its base (03 §3.1). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FlowDefinition, FlowStep } from '@interop-playground/api';
import { FLOWS_DIR } from './paths.js';

export function readFlowFile(flowId: string, dir: string = FLOWS_DIR): FlowDefinition {
  return JSON.parse(readFileSync(path.join(dir, `${flowId}.json`), 'utf8')) as FlowDefinition;
}

/** Same rule as the UI and the BFF validator: start from the base, replace by stepKey, insert after `after`. */
export function mergeFlow(def: FlowDefinition, base: FlowDefinition | null): FlowStep[] {
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

export function resolvedSteps(flowId: string, dir: string = FLOWS_DIR): FlowStep[] {
  const def = readFlowFile(flowId, dir);
  return mergeFlow(def, def.extends ? readFlowFile(def.extends, dir) : null);
}
