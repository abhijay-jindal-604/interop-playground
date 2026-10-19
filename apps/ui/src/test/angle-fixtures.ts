/**
 * Angle A fixtures (T-45) for unit tests and e2e, shaped like the API-30 / API-31 / API-33 / API-04
 * answers session B serves this wave (04 §3): an S-077-shaped parent (FP-01 exact + KNOB-01 offer),
 * the S-120 unclassified case, a two-cause "possible" case, an observed-only case, and the derived
 * child of the T-44 flow (KNOB-01 absent → present, `fixed`, with its compare and lineage).
 */
import type {
  CompareResponse,
  CounterfactualOfferedPayload,
  DiagnosisResponse,
  FingerprintMatchedPayload,
  KnobEntry,
  LineageResponse,
} from '@interop-playground/api';

export const PARENT_ID = '01J8PPPPPPPPPPPPPPPPPPPPPP';
export const CHILD_ID = '01J8CCCCCCCCCCCCCCCCCCCCCC';
export const POSSIBLE_ID = '01J8QQQQQQQQQQQQQQQQQQQQQQ';

export const KNOB01: KnobEntry = {
  def: {
    id: 'KNOB-01',
    name: 'waltid.sdjwt.x5c',
    values: ['absent', 'present'],
    defaultValue: 'absent',
    appliesAt: 'peer-runtime-option',
    formats: ['dc+sd-jwt'],
  },
  adapters: ['issuer.waltid'],
  targets: ['FP-01'],
  status: { 'dc+sd-jwt': 'proven' },
  provenBy: ['S-077', 'S-120'],
  label: 'changed walt.id issuance option',
};

export const FP01: FingerprintMatchedPayload = {
  fingerprintId: 'FP-01',
  gapIds: ['G-55'],
  confidence: 'exact',
  role: 'cause',
  deviatingSide: 'verifier',
  specClause:
    'IETF SD-JWT VC (draft-ietf-oauth-sd-jwt-vc-19) §2.5 Issuer Verification Key Discovery and Validation',
  evidenceSIds: ['S-077', 'S-120'],
  matchedExchangeIds: [],
  matchedEventSeqs: [],
  fingerprintVersion: 1,
  title: 'Inji Verify cannot verify an SD-JWT VC whose issuer key is not given as an x5c chain',
  component: { vendor: 'inji', name: 'inji-verify (vc-verifier)', versions: '1.0-alpha.1' },
};

export const OFFER01: CounterfactualOfferedPayload = {
  fingerprintId: 'FP-01',
  knobId: 'KNOB-01',
  from: 'absent',
  to: 'present',
  knobStatus: 'proven',
  applyKind: 'peer-runtime-option',
  provenBy: ['S-077', 'S-120'],
};

/** S-077: walt.id dc+sd-jwt without x5c to Inji Verify, FP-01 exact, KNOB-01 offered */
export const EXACT_DIAGNOSIS: DiagnosisResponse = {
  matches: [FP01],
  offers: [OFFER01],
  noFixReason: null,
  coverageBanner: [],
};

/** S-120 shape with the failing step outside full capture: the server omits the match */
export const UNCLASSIFIED_DIAGNOSIS: DiagnosisResponse = {
  matches: [],
  offers: [],
  noFixReason: 'unclassified',
  coverageBanner: [],
};

const second = {
  ...FP01,
  fingerprintId: 'FP-05',
  gapIds: ['G-60'],
  confidence: 'possible',
  deviatingSide: 'issuer+verifier',
  title: 'Issuer and verifier disagree on the SD-JWT VC type metadata',
  component: { vendor: 'waltid', name: 'waltid-issuer-api', versions: '0.18.2' },
} as FingerprintMatchedPayload;

export const POSSIBLE_DIAGNOSIS: DiagnosisResponse = {
  matches: [{ ...FP01, confidence: 'possible' }, second],
  offers: [],
  noFixReason: 'several-causes',
  coverageBanner: [],
};

export const OBSERVED_DIAGNOSIS: DiagnosisResponse = {
  matches: [
    { ...FP01, fingerprintId: 'FP-32', confidence: 'observed', deviatingSide: 'environment' },
  ],
  offers: [],
  noFixReason: 'observed-only',
  coverageBanner: [],
};

export const CLAIM =
  'With waltid.sdjwt.x5c = present (changed walt.id issuance option), the run that failed with FP-01 passes; nothing else changed.';

const step = (stepKey: string, outcome: 'pass' | 'fail' | 'skipped') =>
  ({ stepKey, order: 0, flowId: 'FLOW-30', state: 'done', outcome, capture: 'full' }) as never;

/** API-31 parent first; the direct-effect row is deliberately not first in `steps` */
export function childCompare(parent: unknown, child: unknown): CompareResponse {
  return {
    parent: parent as CompareResponse['parent'],
    child: child as CompareResponse['child'],
    relation: 'derived',
    knobDelta: { knobId: 'KNOB-01', from: 'absent', to: 'present' },
    classification: 'fixed',
    claimSentence: CLAIM,
    steps: [
      {
        stepKey: 'vci.token',
        parent: step('vci.token', 'pass'),
        child: step('vci.token', 'pass'),
        differences: [{ path: '$.body.c_nonce', parent: 'a', child: 'b', volatile: true }],
        directEffect: false,
      },
      {
        stepKey: 'vp.verdict.evaluate',
        parent: step('vp.verdict.evaluate', 'fail'),
        child: step('vp.verdict.evaluate', 'pass'),
        differences: [{ path: '$.verdict', parent: 'invalid', child: 'valid', volatile: false }],
        directEffect: false,
      },
      {
        stepKey: 'vci.credential',
        parent: step('vci.credential', 'pass'),
        child: step('vci.credential', 'pass'),
        differences: [
          { path: '$.credential.header.x5c', parent: null, child: ['MII…'], volatile: false },
        ],
        directEffect: true,
      },
    ],
  };
}

export const PARENT_LINEAGE: LineageResponse = {
  chain: [{ runId: PARENT_ID, knobDelta: null, result: null, state: 'completed' }],
};

export const CHILD_LINEAGE: LineageResponse = {
  chain: [
    { runId: PARENT_ID, knobDelta: null, result: null, state: 'completed' },
    {
      runId: CHILD_ID,
      knobDelta: { knobId: 'KNOB-01', from: 'absent', to: 'present' },
      result: 'fixed',
      state: 'completed',
    },
  ],
};
