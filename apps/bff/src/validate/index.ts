/** Startup validators (plan/12 T-07): the BFF refuses to start on a malformed content file. */
import type { FlowDefinition } from '@interop-playground/api';
import { loadFingerprints } from './fingerprints.js';
import { loadFlows } from './flows.js';

export { validateFlowFile, loadFlows, isRegisteredStepKey } from './flows.js';
export { validateFingerprint, validateKnobs, loadFingerprints } from './fingerprints.js';

/** Thrown at start-up when any flow or fingerprint file is invalid; lists every problem per file. */
export class StartupValidationError extends Error {
  readonly problems: { file: string; errors: string[] }[];
  constructor(problems: { file: string; errors: string[] }[]) {
    super(
      'startup validation failed:\n' +
        problems.map((p) => `  ${p.file}\n    ${p.errors.join('\n    ')}`).join('\n'),
    );
    this.name = 'StartupValidationError';
    this.problems = problems;
  }
}

export interface ContentFiles {
  flows: Map<string, FlowDefinition>;
  fingerprintCount: number;
}

/** Loads and checks all flow and fingerprint files; throws `StartupValidationError` if any is invalid. */
export function validateContent(flowsDir: string, fingerprintsDir: string): ContentFiles {
  const f = loadFlows(flowsDir);
  const fp = loadFingerprints(fingerprintsDir);
  const problems = [...f.errors, ...fp.errors];
  if (problems.length > 0) throw new StartupValidationError(problems);
  return { flows: f.flows, fingerprintCount: fp.count };
}
