/**
 * Display labels of 06 §1 conventions (REQ-25 formats, grants, modes, environments).
 * `jwt_vc_json` has no label in 06 §1; it follows the same pattern.
 */
import type { CredentialFormat, Run } from '@interop-playground/api';
import type { BadgeState } from '../components/StatusBadge.js';

export const FORMAT_LABEL: Record<CredentialFormat, string> = {
  ldp_vc: 'W3C VC (JSON-LD, ldp_vc)',
  'dc+sd-jwt': 'SD-JWT VC (dc+sd-jwt)',
  mso_mdoc: 'mDoc / mDL (mso_mdoc)',
  jwt_vc_json: 'JWT VC (jwt_vc_json)',
};
export const FORMAT_SHORT: Record<CredentialFormat, string> = {
  ldp_vc: 'JSON-LD',
  'dc+sd-jwt': 'SD-JWT VC',
  mso_mdoc: 'mDoc',
  jwt_vc_json: 'JWT VC',
};

/** The badge for a run: the verdict when terminal, else its run state (UI-74 rule f). */
export function runBadge(run: Pick<Run, 'state' | 'verdict'>): BadgeState {
  if (run.state === 'completed' && run.verdict) return run.verdict.outcome;
  if (run.state === 'completed') return 'inconclusive';
  return run.state;
}
