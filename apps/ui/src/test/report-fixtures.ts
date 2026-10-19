/**
 * API-45 `RunReport` fixtures (04 §3.7) for the UI-51 report view: a pass and a forced-fail run of
 * the slice (FLOW-04 + FLOW-30, the recorded logs of fixtures/events). Shared by unit tests and e2e
 * until session C's report generator serves the real thing.
 */
import type { RunReport, RunSpec } from '@interop-playground/api';

const versions: RunSpec['versions'] = {
  issuer: 'certify@0.12.0-alpha.1',
  wallet: 'playground-ts@0.0.0',
  verifier: 'inji-verify@1.0.0-alpha.1',
};
const env: RunSpec['env'] = { issuer: 'local', wallet: 'local', verifier: 'local' };

const steps: RunReport['steps'] = [
  {
    stepKey: 'vci.setup.variant',
    outcome: 'skipped',
    capture: 'full',
    skipReason: 'variant exists',
  },
  { stepKey: 'vci.token', outcome: 'pass', capture: 'full', skipReason: null },
  { stepKey: 'vci.proof.sign', outcome: 'pass', capture: 'none', skipReason: null },
  { stepKey: 'vci.credential', outcome: 'pass', capture: 'full', skipReason: null },
  { stepKey: 'vp.request.create', outcome: 'pass', capture: 'full', skipReason: null },
  { stepKey: 'vp.request.deliver', outcome: 'pass', capture: 'none', skipReason: null },
  {
    stepKey: 'vp.request.fetch',
    outcome: 'skipped',
    capture: 'full',
    skipReason: 'request carried by value',
  },
  { stepKey: 'vp.token.build', outcome: 'pass', capture: 'none', skipReason: null },
  { stepKey: 'vp.response.post', outcome: 'pass', capture: 'full', skipReason: null },
  { stepKey: 'vp.result.poll', outcome: 'pass', capture: 'full', skipReason: null },
  { stepKey: 'vp.verdict.evaluate', outcome: 'pass', capture: 'none', skipReason: null },
];

export const PASS_REPORT: RunReport = {
  reportVersion: 1,
  runId: '01J8PASSPASSPASSPASSPASSPA',
  generatedAt: '2026-10-19T10:00:05.000Z',
  fields: {
    issuer: 'issuer.certify-preauth',
    wallet: 'wallet.playground-ts',
    verifier: 'verifier.inji-verify-local',
    format: 'dc+sd-jwt',
    proofType: 'jwt (ES256, P1363)',
    grant: 'pre-authorized_code',
    mode: 'cross-device',
    env,
    versions,
    knobs: {},
    nonDefaultKnobs: [],
    verdict: {
      kind: 'interop',
      outcome: 'pass',
      issuanceOk: true,
      verification: 'valid',
      tamperVerdict: null,
      failedStepKey: null,
      countsTowardPassRate: true,
    },
    failedStepKey: null,
    failingChecks: [],
    errorDetail: null,
  },
  diagnosis: {
    matches: [],
    offers: [],
    noFixReason: null,
    coverageBanner: [
      { stepKey: 'vci.proof.sign', capture: 'none', reason: null },
      { stepKey: 'vp.token.build', capture: 'none', reason: null },
    ],
  },
  claimSentence: null,
  tamper: null,
  steps,
};

export const FAIL_REPORT: RunReport = {
  ...PASS_REPORT,
  runId: '01J8FAILFAILFAILFAILFAILFA',
  fields: {
    ...PASS_REPORT.fields,
    verdict: {
      kind: 'interop',
      outcome: 'fail',
      issuanceOk: true,
      verification: 'invalid',
      tamperVerdict: null,
      failedStepKey: 'vp.response.post',
      countsTowardPassRate: true,
    },
    failedStepKey: 'vp.response.post',
    failingChecks: [
      {
        checkId: 'vp.response.status',
        outcome: 'fail',
        source: 'verifier-response',
        code: 'invalid_request',
        message: 'Client id validation failed due to invalid client_id/domain.',
        specClause: 'OpenID4VP 1.0 §8.2 Response Mode "direct_post"',
        exchangeIds: ['01J8EXCHANGE0000000000000A'],
      },
    ],
    errorDetail:
      '400 invalid_request: Client id validation failed due to invalid client_id/domain.',
  },
  diagnosis: {
    matches: [
      {
        fingerprintId: 'FP-11',
        gapIds: ['G-73'],
        confidence: 'exact',
        role: 'cause',
        deviatingSide: 'verifier',
        specClause: 'OpenID4VP 1.0 §5.9 Client Identifier Prefix',
        evidenceSIds: ['S-201'],
        matchedExchangeIds: ['01J8EXCHANGE0000000000000A'],
        matchedEventSeqs: [61],
        fingerprintVersion: 1,
        title: 'Verifier rejects the client id the wallet echoed',
        component: { vendor: 'inji', name: 'inji-verify', versions: '1.0.0-alpha.1' },
      },
    ],
    offers: [],
    noFixReason: 'no-proven-knob',
    coverageBanner: PASS_REPORT.diagnosis.coverageBanner,
  },
  steps: steps.map((s) =>
    s.stepKey === 'vp.response.post'
      ? { ...s, outcome: 'fail' }
      : s.stepKey === 'vp.result.poll' || s.stepKey === 'vp.verdict.evaluate'
        ? { ...s, outcome: 'fail' }
        : s,
  ),
};

export const FAIL_MARKDOWN = `# Run 01J8FAILFAILFAILFAILFAILFA: FAIL

| Field | Value |
|---|---|
| Issuer | issuer.certify-preauth |
| Wallet | wallet.playground-ts |
| Verifier | verifier.inji-verify-local |
`;
