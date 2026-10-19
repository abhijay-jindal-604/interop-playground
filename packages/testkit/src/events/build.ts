/**
 * Builds the recorded event-log fixtures of `fixtures/events/` from the golden traces (plan/11 §3.2,
 * S-018, S-019, S-022): every `exchange.*` carries the method, status, headers and body of a recorded
 * exchange, with the loopback hosts of the spike rewritten to the bundle's gateway URLs on
 * `PUBLIC_HOST=192.0.2.10` (TEST-NET-1, plan/11 §2). Steps the recordings did not cover
 * (`vci.setup.config-read`, `vci.metadata.as`) carry bodies cut from the recorded issuer metadata.
 *
 * Deterministic: fixed run ids, timestamps from 2026-10-19T10:00:00Z advanced by the recorded `ms`.
 * Regenerate with `npx tsx packages/testkit/src/events/write.ts`; the test `events.fixtures` fails when
 * the committed JSON differs from this builder.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  BodyRef,
  CheckResult,
  EventEnvelope,
  EventType,
  FlowId,
  FlowStep,
  Headers,
  PayloadOf,
  RunSpec,
  RunVerdict,
} from '@interop-playground/api';
import { resolvedSteps } from '../flows.js';
import { GOLDEN_DIR } from '../paths.js';
import type { EventFixture, EventFixtureId } from './types.js';

export const FIXTURE_HOST = '192.0.2.10';
const CERTIFY = `https://${FIXTURE_HOST}`;
const VERIFY = `https://${FIXTURE_HOST}:8443/v1/verify`;
const START = Date.parse('2026-10-19T10:00:00.000Z');

export const FIXTURE_RUN_IDS: Record<EventFixtureId, string> = {
  'FLOW-01-pass': '01K7X0F1XA0000000000000001',
  'FLOW-04-pass': '01K7X0F1XA0000000000000004',
  'FLOW-30-pass': '01K7X0F1XA0000000000000030',
  'FLOW-30-fail': '01K7X0F1XA0000000000000031',
};

interface TraceEntry {
  method: string;
  url: string;
  reqHeaders: Record<string, string>;
  reqBody?: unknown;
  status: number;
  ms?: number;
  resHeaders: Record<string, string>;
  resBody: unknown;
}

function readTrace(file: string): TraceEntry[] {
  return JSON.parse(readFileSync(path.join(GOLDEN_DIR, 'traces', file), 'utf8')) as TraceEntry[];
}

/** spike loopback hosts → bundle gateway URLs, in plain and URL-encoded form */
export function rewriteHosts(text: string): string {
  return text
    .replaceAll('http://localhost:8090', CERTIFY)
    .replaceAll('http://localhost:8080', VERIFY)
    .replaceAll('http%3A%2F%2Flocalhost%3A8090', encodeURIComponent(CERTIFY))
    .replaceAll('http%3A%2F%2Flocalhost%3A8080', encodeURIComponent(VERIFY));
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function bodyText(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  return rewriteHosts(typeof body === 'string' ? body : JSON.stringify(body));
}

function bodyRef(text: string | null): BodyRef | null {
  if (text === null) return null;
  return {
    encoding: 'utf8',
    text,
    size: Buffer.byteLength(text, 'utf8'),
    truncated: false,
    sha256: sha256(text),
  };
}

function headers(h: Record<string, string>): Headers {
  return Object.entries(h).map(([k, v]) => [k, rewriteHosts(v)]);
}

class Log {
  readonly events: EventEnvelope[] = [];
  private t = START;
  private exchanges = 0;
  constructor(readonly runId: string) {}

  emit<T extends EventType>(type: T, payload: PayloadOf<T>, stepKey?: string, dtMs = 3): void {
    this.t += dtMs;
    const env: EventEnvelope<T> = {
      v: 1,
      runId: this.runId,
      seq: this.events.length + 1,
      ts: new Date(this.t).toISOString(),
      type,
      ...(stepKey === undefined ? {} : { stepKey }),
      payload,
    };
    this.events.push(env);
  }

  exchange(stepKey: string, x: TraceEntry, actor: string, counterpart: string): string {
    this.exchanges += 1;
    const exchangeId = `${this.runId}:${this.exchanges}`;
    const req = bodyRef(bodyText(x.reqBody));
    const res = bodyRef(bodyText(x.resBody));
    const ms = x.ms ?? 12;
    this.emit(
      'exchange.request',
      {
        exchangeId,
        direction: 'outbound',
        actor,
        counterpart,
        method: x.method,
        url: rewriteHosts(x.url),
        headers: headers(x.reqHeaders),
        body: req,
        bodyState: req ? 'stored' : 'none',
        poll: null,
      },
      stepKey,
      1,
    );
    this.emit(
      'exchange.response',
      {
        exchangeId,
        status: x.status,
        statusText: null,
        headers: headers(x.resHeaders),
        body: res,
        bodyState: res ? 'stored' : 'none',
        durationMs: ms,
        poll: null,
      },
      stepKey,
      ms,
    );
    return exchangeId;
  }
}

type StepPlan =
  | { kind: 'skip' }
  | {
      kind: 'run';
      outcome: 'pass' | 'fail';
      /** recorded exchanges of this step: [entry, actor, counterpart] */
      exchanges?: [TraceEntry, string, string][];
      engine?: { op: PayloadOf<'engine.call'>['op']; input: unknown; output: unknown };
      checks?: (ids: string[]) => CheckResult[];
    };

function runFlow(log: Log, flowId: FlowId, plans: Record<string, StepPlan>): void {
  const steps: FlowStep[] = resolvedSteps(flowId);
  for (const step of steps) {
    const plan = plans[step.stepKey] ?? { kind: 'skip' };
    log.emit(
      'step.started',
      { flowId, order: step.order, kind: step.kind, label: step.label },
      step.stepKey,
    );
    if (plan.kind === 'skip') {
      log.emit(
        'step.completed',
        {
          outcome: 'skipped',
          capture: 'none',
          skipReason: step.skipReason ?? 'not applicable',
          coverageNote: null,
          durationMs: 0,
        },
        step.stepKey,
      );
      continue;
    }
    let ms = 0;
    const ids: string[] = [];
    for (const [x, actor, counterpart] of plan.exchanges ?? []) {
      ids.push(log.exchange(step.stepKey, x, actor, counterpart));
      ms += x.ms ?? 12;
    }
    if (plan.engine) {
      log.emit(
        'engine.call',
        {
          engine: 'playground-ts',
          op: plan.engine.op,
          inputSummary: plan.engine.input,
          outputSummary: plan.engine.output,
          durationMs: 2,
        },
        step.stepKey,
        2,
      );
      ms += 2;
    }
    for (const check of plan.checks?.(ids) ?? [])
      log.emit('verdict.check', { check }, step.stepKey, 1);
    log.emit(
      'step.completed',
      {
        outcome: plan.outcome,
        capture: (plan.exchanges?.length ?? 0) > 0 ? 'full' : 'none',
        skipReason: null,
        coverageNote: null,
        durationMs: ms,
      },
      step.stepKey,
    );
  }
}

function spec(over: Partial<RunSpec>): RunSpec {
  return {
    issuer: 'issuer.certify-preauth',
    wallet: 'wallet.playground-ts',
    verifier: 'verifier.inji-verify-local',
    grant: 'pre-authorized_code',
    presentationMode: null,
    format: 'ldp_vc',
    configurationId: 'FarmerCredential',
    env: { issuer: 'local', wallet: 'local', verifier: 'local' },
    versions: {
      issuer: 'certify@0.12.0-alpha.1',
      wallet: 'playground-ts@0.0.0',
      verifier: 'inji-verify@1.0.0-alpha.1',
    },
    tamperCase: null,
    knobs: {},
    parentRunId: null,
    knobDelta: null,
    tunnelHost: null,
    scope: 'issuance',
    issuanceFlowId: 'FLOW-01',
    presentationFlowId: null,
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

const WALLET = 'wallet.playground-ts';
const VERIFIER = 'verifier.inji-verify-local';

/** the wallet-side issuance steps of FLOW-01 / FLOW-04 from one recorded pre-auth trace */
function issuancePlans(
  trace: TraceEntry[],
  metadata: TraceEntry,
  configurationId: string,
  format: string,
): Record<string, StepPlan> {
  const find = (re: RegExp): TraceEntry => {
    const x = trace.find((e) => re.test(e.url));
    if (!x) throw new Error(`trace has no ${String(re)}`);
    return x;
  };
  const meta = metadata.resBody as {
    credential_configurations_supported: Record<string, unknown>;
  };
  const configRead: TraceEntry = {
    method: 'GET',
    url: `http://localhost:8090/v1/certify/credential-configurations/${configurationId}`,
    reqHeaders: {},
    status: 200,
    ms: 9,
    resHeaders: { 'content-type': 'application/json' },
    resBody: {
      credentialConfigurationId: configurationId,
      ...(meta.credential_configurations_supported[configurationId] as object),
    },
  };
  const asMeta: TraceEntry = {
    method: 'GET',
    url: 'http://localhost:8090/v1/certify/.well-known/oauth-authorization-server',
    reqHeaders: {},
    status: 200,
    ms: 7,
    resHeaders: { 'content-type': 'application/json' },
    resBody: {
      issuer: 'http://localhost:8090',
      token_endpoint: 'http://localhost:8090/v1/certify/oauth/token',
      grant_types_supported: ['urn:ietf:params:oauth:grant-type:pre-authorized_code'],
      'pre-authorized_grant_anonymous_access_supported': true,
    },
  };
  const credential = find(/issuance\/credential$/);
  const credBody = credential.resBody as { credentials?: { credential: unknown }[] };
  const issued = JSON.stringify(credBody.credentials?.[0]?.credential ?? null);
  return {
    'vci.setup.config-read': {
      kind: 'run',
      outcome: 'pass',
      exchanges: [[configRead, 'playground', 'certify-preauth']],
    },
    'vci.offer.mint': {
      kind: 'run',
      outcome: 'pass',
      exchanges: [[find(/pre-authorized-data$/), 'playground', 'certify-preauth']],
    },
    'vci.offer.fetch': {
      kind: 'run',
      outcome: 'pass',
      exchanges: [[find(/credential-offer-data\//), WALLET, 'certify-preauth']],
    },
    'vci.metadata.issuer': {
      kind: 'run',
      outcome: 'pass',
      exchanges: [[metadata, WALLET, 'certify-preauth']],
    },
    'vci.metadata.as': {
      kind: 'run',
      outcome: 'pass',
      exchanges: [[asMeta, WALLET, 'certify-preauth']],
    },
    'vci.token': {
      kind: 'run',
      outcome: 'pass',
      exchanges: [[find(/oauth\/token$/), WALLET, 'certify-preauth']],
    },
    'vci.nonce': {
      kind: 'run',
      outcome: 'pass',
      exchanges: [[find(/\/nonce$/), WALLET, 'certify-preauth']],
    },
    'vci.proof.sign': {
      kind: 'run',
      outcome: 'pass',
      engine: {
        op: 'sign-proof',
        input: { aud: CERTIFY, typ: 'openid4vci-proof+jwt' },
        output: {
          alg: 'ES256',
          kid: 'did:jwk:fixture-holder#0',
          jwsSha256: sha256(JSON.stringify(credential.reqBody)),
        },
      },
    },
    'vci.credential': {
      kind: 'run',
      outcome: 'pass',
      exchanges: [[credential, WALLET, 'certify-preauth']],
      checks: (ids) => [
        {
          checkId: 'vci.credential.issued',
          outcome: 'pass',
          source: 'verifier-response',
          exchangeIds: ids,
        },
      ],
    },
    'vci.credential.inspect': {
      kind: 'run',
      outcome: 'pass',
      checks: () => [
        {
          checkId: `vci.credential.decode.${format}`,
          outcome: 'pass',
          source: 'engine',
          message: `decoded ${issued.length} characters of ${format}`,
          exchangeIds: [],
        },
      ],
    },
  };
}

function finish(log: Log, verdict: RunVerdict): void {
  log.emit('run.completed', { verdict, counterfactualResult: null });
}

function issuanceOnly(id: 'FLOW-01-pass' | 'FLOW-04-pass'): EventFixture {
  const flow01 = id === 'FLOW-01-pass';
  const file = flow01
    ? 'trace-FarmerCredential-1790515114311.json'
    : 'trace-PlaygroundSdJwt-1790515220806.json';
  const trace = readTrace(file);
  const configurationId = flow01 ? 'FarmerCredential' : 'PlaygroundSdJwt';
  const format = flow01 ? 'ldp_vc' : 'dc+sd-jwt';
  const flowId: FlowId = flow01 ? 'FLOW-01' : 'FLOW-04';
  const log = new Log(FIXTURE_RUN_IDS[id]);
  log.emit('run.created', {
    spec: spec({ format, configurationId, issuanceFlowId: flowId }),
    label: flow01 ? 'Farmer ldp_vc issuance' : 'SD-JWT issuance',
    queuePosition: 0,
  });
  log.emit('run.started', { startedAt: new Date(START + 10).toISOString() }, undefined, 7);
  const metadata = trace.find(
    (e) => e.status === 200 && e.url.endsWith('/v1/certify/.well-known/openid-credential-issuer'),
  );
  if (!metadata) throw new Error(`${file}: no issuer metadata`);
  runFlow(log, flowId, issuancePlans(trace, metadata, configurationId, format));
  finish(log, {
    kind: 'interop',
    outcome: 'pass',
    issuanceOk: true,
    verification: null,
    tamperVerdict: null,
    failedStepKey: null,
    countsTowardPassRate: true,
  });
  return {
    fixtureId: id,
    description: flow01
      ? 'FLOW-01: certify-preauth issues FarmerCredential (ldp_vc) to wallet.playground-ts, issuance only, pass.'
      : 'FLOW-04: certify-preauth issues PlaygroundSdJwt (dc+sd-jwt) to wallet.playground-ts, issuance only, pass.',
    sources: [{ file: `traces/${file}`, sids: flow01 ? ['S-018'] : ['S-019', 'S-060'] }],
    runId: log.runId,
    run: {
      flowId,
      targetStepKey: 'vci.credential',
      evidenceTier: 'automated',
      knobsAllDefault: true,
    },
    flows: [flowId],
    events: log.events,
    end: { reason: 'terminal', lastSeq: log.events.length },
  };
}

function presentation(id: 'FLOW-30-pass' | 'FLOW-30-fail'): EventFixture {
  const pass = id === 'FLOW-30-pass';
  const file = pass ? 'trace-localverify-vp-ok.json' : 'trace-localverify-vp-bad-aud.json';
  const trace = readTrace(file);
  const metaTrace = readTrace('trace-PlaygroundSdJwt-1790515220806.json');
  const metadata = metaTrace.find(
    (e) => e.status === 200 && e.url.endsWith('/v1/certify/.well-known/openid-credential-issuer'),
  );
  if (!metadata) throw new Error('no issuer metadata');
  const find = (re: RegExp): TraceEntry => {
    const x = trace.find((e) => re.test(e.url));
    if (!x) throw new Error(`${file} has no ${String(re)}`);
    return x;
  };
  const log = new Log(FIXTURE_RUN_IDS[id]);
  log.emit('run.created', {
    spec: spec({
      format: 'dc+sd-jwt',
      configurationId: 'PlaygroundSdJwt',
      issuanceFlowId: 'FLOW-04',
      presentationFlowId: 'FLOW-30',
      presentationMode: 'cross-device',
      scope: 'full',
      disclosure: { claimPaths: [['fullName']] },
    }),
    label: pass ? null : 'client_id domain mismatch',
    queuePosition: 0,
  });
  log.emit('run.started', { startedAt: new Date(START + 10).toISOString() }, undefined, 7);
  runFlow(log, 'FLOW-04', issuancePlans(trace, metadata, 'PlaygroundSdJwt', 'dc+sd-jwt'));

  const vpRequest = find(/\/v2\/vp-request$/);
  const created = vpRequest.resBody as {
    transactionId: string;
    requestId: string;
    authorizationDetails: { clientId: string; nonce: string; responseUri: string };
  };
  const uri = `openid4vp://authorize?client_id=${encodeURIComponent(created.authorizationDetails.clientId)}&request_uri=${encodeURIComponent(rewriteHosts(`http://localhost:8080/v2/vp-request/${created.requestId}`))}`;
  const post = find(/vp-submission\/direct-post$/);
  const result = find(/\/v2\/vp-results\//);
  const postErr = post.resBody as { errorCode?: string; errorMessage?: string };
  const resultErr = result.resBody as { errorCode?: string; errorMessage?: string };
  const fail = (ids: string[]): CheckResult[] => [
    {
      checkId: 'vp.response.accepted',
      outcome: 'fail',
      source: 'verifier-response',
      code: postErr.errorCode ?? 'invalid_request',
      message: postErr.errorMessage ?? 'rejected',
      specClause: 'OpenID4VP 1.0 §8.2 Response Mode direct_post',
      exchangeIds: ids,
    },
  ];
  let resultIds: string[] = [];
  runFlow(log, 'FLOW-30', {
    'vp.request.create': {
      kind: 'run',
      outcome: 'pass',
      exchanges: [[vpRequest, VERIFIER, 'inji-verify']],
    },
    'vp.request.deliver': {
      kind: 'run',
      outcome: 'pass',
      engine: {
        op: 'deliver-request',
        input: { channel: 'in-process' },
        output: { channel: 'in-process', uri, uriSha256: sha256(uri) },
      },
    },
    'vp.request.validate': {
      kind: 'run',
      outcome: 'pass',
      engine: {
        op: 'resolve-request',
        input: { clientIdScheme: 'plain' },
        output: {
          clientId: created.authorizationDetails.clientId,
          responseMode: 'direct_post',
          nonce: created.authorizationDetails.nonce,
        },
      },
    },
    'vp.credential.match': {
      kind: 'run',
      outcome: 'pass',
      checks: () => [
        {
          checkId: 'vp.dcql.match',
          outcome: 'pass',
          source: 'engine',
          message: 'pg: PlaygroundSdJwt, disclose fullName',
          exchangeIds: [],
        },
      ],
    },
    'vp.token.build': {
      kind: 'run',
      outcome: 'pass',
      engine: {
        op: 'sign-proof',
        input: { typ: 'kb+jwt', aud: created.authorizationDetails.clientId },
        output: {
          alg: 'ES256',
          kid: 'did:jwk:fixture-holder#0',
          jwsSha256: sha256(String(post.reqBody)),
        },
      },
    },
    'vp.response.post': pass
      ? { kind: 'run', outcome: 'pass', exchanges: [[post, WALLET, 'inji-verify']] }
      : { kind: 'run', outcome: 'fail', exchanges: [[post, WALLET, 'inji-verify']], checks: fail },
    'vp.result.poll': {
      kind: 'run',
      outcome: pass ? 'pass' : 'fail',
      exchanges: [[result, VERIFIER, 'inji-verify']],
      checks: (ids) => {
        resultIds = ids;
        return pass
          ? []
          : [
              {
                checkId: 'vp.result.submitted',
                outcome: 'fail',
                source: 'verifier-response',
                code: resultErr.errorCode ?? 'NO_VP_SUBMISSION',
                message: resultErr.errorMessage ?? 'no submission',
                exchangeIds: ids,
              },
            ];
      },
    },
    'vp.verdict.evaluate': {
      kind: 'run',
      outcome: pass ? 'pass' : 'fail',
      checks: () =>
        pass
          ? [
              {
                checkId: 'vp.result.all-checks',
                outcome: 'pass',
                source: 'verifier-response',
                message: 'allChecksSuccessful: true',
                exchangeIds: resultIds,
              },
              {
                checkId: 'vc.signature',
                outcome: 'pass',
                source: 'verifier-response',
                exchangeIds: resultIds,
              },
              {
                checkId: 'vc.expiry',
                outcome: 'pass',
                source: 'verifier-response',
                exchangeIds: resultIds,
              },
            ]
          : [
              {
                checkId: 'vp.result.all-checks',
                outcome: 'not-run',
                source: 'verifier-response',
                message: 'no result: the verifier rejected the submission',
                exchangeIds: resultIds,
              },
            ],
    },
  });
  finish(log, {
    kind: 'interop',
    outcome: pass ? 'pass' : 'fail',
    issuanceOk: true,
    verification: pass ? 'valid' : 'invalid',
    tamperVerdict: null,
    failedStepKey: pass ? null : 'vp.response.post',
    countsTowardPassRate: true,
  });
  return {
    fixtureId: id,
    description: pass
      ? 'FLOW-04 + FLOW-30: PlaygroundSdJwt issued, presented cross-device to local Inji Verify, Valid (S-022 ok).'
      : 'FLOW-04 + FLOW-30: PlaygroundSdJwt issued, presentation rejected at the direct_post (S-022 bad-aud: "Client id validation failed"), fail.',
    sources: [
      { file: `traces/${file}`, sids: ['S-022'] },
      { file: 'traces/trace-PlaygroundSdJwt-1790515220806.json', sids: ['S-019', 'S-060'] },
    ],
    runId: log.runId,
    run: {
      flowId: 'FLOW-30',
      targetStepKey: 'vp.verdict.evaluate',
      evidenceTier: 'automated',
      knobsAllDefault: true,
    },
    flows: ['FLOW-04', 'FLOW-30'],
    events: log.events,
    end: { reason: 'terminal', lastSeq: log.events.length },
  };
}

export function buildEventFixture(id: EventFixtureId): EventFixture {
  switch (id) {
    case 'FLOW-01-pass':
    case 'FLOW-04-pass':
      return issuanceOnly(id);
    case 'FLOW-30-pass':
    case 'FLOW-30-fail':
      return presentation(id);
  }
}
