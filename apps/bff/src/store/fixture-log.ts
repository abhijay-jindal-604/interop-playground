/**
 * A small recorded-shape event log (FLOW-01-like: offer, token, credential, verify) used by the store,
 * sink, rebuild and scan-store tests. Secrets can be injected into bodies, URLs, headers and
 * messages to prove redaction (05 §6, test `redact.registry`).
 */
import type { RunSpec } from '@interop-playground/adapters';
import type { RunVerdict } from '@interop-playground/api';
import type { EventSink } from './sink.js';

/** A complete valid run spec for tests and fixtures, with any field overridable. */
export function sampleSpec(over: Partial<RunSpec> = {}): RunSpec {
  return {
    issuer: 'issuer.certify-preauth',
    wallet: 'wallet.playground-ts',
    verifier: 'verifier.inji-verify-local',
    grant: 'pre-authorized_code',
    presentationMode: 'cross-device',
    format: 'ldp_vc',
    configurationId: 'FarmerCredential',
    env: { issuer: 'local', wallet: 'local', verifier: 'local' },
    versions: { issuer: 'develop@sha256:ab12', wallet: '0.0.0', verifier: 'v0.16.0' },
    tamperCase: null,
    knobs: {},
    parentRunId: null,
    knobDelta: null,
    tunnelHost: null,
    scope: 'full',
    issuanceFlowId: 'FLOW-01',
    presentationFlowId: 'FLOW-30',
    delivery: 'in-process',
    withTxCode: false,
    withIae: false,
    disclosure: { claimPaths: [] },
    clientIdScheme: 'plain',
    suiteId: null,
    controlRunId: null,
    causeFingerprintId: null,
    ...over,
  };
}

export interface FixtureOptions {
  runId?: string;
  suiteId?: string;
  /** strings placed in a body, a URL, a header and a check message (redaction tests) */
  inject?: string[];
}

/** writes one complete failed run through the sink; returns its id */
export function recordFixtureRun(sink: EventSink, opts: FixtureOptions = {}): string {
  const runId = opts.runId ?? '01JZZZZZZZZZZZZZZZZZZZZZZ1';
  const suiteId = opts.suiteId ?? `${runId}-suite`;
  const secret = (opts.inject ?? []).join(' ');
  sink.createSuite({
    suiteId,
    name: 'fixture',
    triggerKind: 'ci',
    envClass: 'local',
    appVersion: '0.0.0',
  });
  sink.createRun({
    runId,
    suiteId,
    triggerKind: 'ci',
    flowId: 'FLOW-01',
    spec: sampleSpec({ suiteId }),
    knobsAllDefault: true,
    targetStepKey: 'vp.verdict.evaluate',
    evidenceTier: 'automated',
    appVersion: '0.0.0',
    label: 'fixture',
  });
  sink.append(runId, { type: 'run.started', payload: { startedAt: '2026-10-13T00:00:00.000Z' } });

  const exchange = (
    stepKey: string,
    url: string,
    reqBody: string | null,
    status: number,
    respBody: string,
  ): string => {
    const exchangeId = sink.nextExchangeId(runId);
    sink.append(runId, {
      type: 'exchange.request',
      stepKey,
      payload: {
        exchangeId,
        direction: 'outbound',
        actor: 'wallet.playground-ts',
        counterpart: 'certify-preauth',
        method: reqBody === null ? 'GET' : 'POST',
        url,
        headers: [
          ['Content-Type', 'application/json'],
          ['X-Trace', secret || 'none'],
        ],
        body: reqBody === null ? null : { bytes: reqBody, contentType: 'application/json' },
        poll: null,
      },
    });
    sink.append(runId, {
      type: 'exchange.response',
      stepKey,
      payload: {
        exchangeId,
        status,
        statusText: null,
        headers: [['Content-Type', 'application/json']],
        body: { bytes: respBody, contentType: 'application/json' },
        durationMs: 12,
        poll: null,
      },
    });
    return exchangeId;
  };
  const step = (stepKey: string, order: number): void => {
    sink.append(runId, {
      type: 'step.started',
      stepKey,
      payload: { flowId: 'FLOW-01', order, kind: 'http', label: stepKey },
    });
  };
  const done = (stepKey: string, outcome: 'pass' | 'fail' | 'skipped'): void => {
    sink.append(runId, {
      type: 'step.completed',
      stepKey,
      payload: {
        outcome,
        capture: outcome === 'skipped' ? 'none' : 'full',
        skipReason: outcome === 'skipped' ? 'blocked at vci.token' : null,
        coverageNote: null,
        durationMs: 5,
      },
    });
  };

  step('vci.offer', 1);
  exchange(
    'vci.offer',
    `https://192.0.2.10/.well-known/openid-credential-issuer?trace=${encodeURIComponent(secret)}`,
    null,
    200,
    JSON.stringify({
      credential_issuer: 'https://192.0.2.10',
      note: secret,
      big: 'x'.repeat(3000),
    }),
  );
  done('vci.offer', 'pass');

  step('vci.token', 2);
  const tokenEx = exchange(
    'vci.token',
    'https://192.0.2.10/v1/certify/oauth/token',
    `grant_type=urn:ietf:params:oauth:grant-type:pre-authorized_code&pre-authorized_code=abc&x=${secret}`,
    400,
    JSON.stringify({ error: 'invalid_grant', error_description: `code missing ${secret}` }),
  );
  sink.append(runId, {
    type: 'verdict.check',
    stepKey: 'vci.token',
    payload: {
      check: {
        checkId: 'chk.vci.token.code-missing',
        outcome: 'fail',
        source: 'verifier-response',
        code: 'invalid_grant',
        message: `code missing ${secret}`,
        exchangeIds: [tokenEx],
      },
    },
  });
  sink.append(runId, {
    type: 'fingerprint.matched',
    stepKey: 'vci.token',
    payload: {
      fingerprintId: 'FP-35',
      gapIds: ['G-109'],
      confidence: 'exact',
      role: 'cause',
      deviatingSide: 'issuer',
      specClause: 'OID4VCI 6.1',
      evidenceSIds: ['S-189'],
      matchedExchangeIds: [tokenEx],
      matchedEventSeqs: [8],
      fingerprintVersion: 1,
      title: 'Certify drops the code',
      component: { vendor: 'inji', name: 'inji-certify', versions: 'develop' },
    },
  });
  sink.append(runId, {
    type: 'counterfactual.offered',
    stepKey: 'vci.token',
    payload: {
      fingerprintId: 'FP-35',
      knobId: 'KNOB-01',
      from: 'a',
      to: 'b',
      knobStatus: 'proven',
      applyKind: 'wallet-runtime',
      provenBy: ['S-189'],
    },
  });
  sink.append(runId, {
    type: 'engine.exception',
    stepKey: 'vci.token',
    payload: {
      engine: 'playground-ts',
      exceptionClass: 'TokenError',
      message: `boom ${secret}`,
      endedStep: true,
    },
  });
  done('vci.token', 'fail');
  done('vp.verdict.evaluate', 'skipped');
  const verdict: RunVerdict = {
    kind: 'interop',
    outcome: 'blocked',
    issuanceOk: false,
    verification: null,
    tamperVerdict: null,
    failedStepKey: 'vci.token',
    countsTowardPassRate: true,
  };
  sink.append(runId, { type: 'run.completed', payload: { verdict, counterfactualResult: null } });
  return runId;
}
