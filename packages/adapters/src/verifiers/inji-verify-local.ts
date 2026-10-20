/**
 * `verifier.inji-verify-local` cross-device (plan/12 T-25; 02 §5.3, 03 FLOW-30 and §2.0,
 * 04 §8.5/§8.7): Inji Verify `verify-service` 1.0.0-alpha.1.
 *
 * `vp.request.create`: BFF-internal `POST /v2/vp-request` to the service name with clientId
 * `interop-playground` (KNOB-07 `plain`) and a 32-char nonce (G-118); the `openid4vp://` URI is
 * built here in the SDK's parameter order (ADR-29). The orchestrator emits
 * `engine.call{deliver-request}` with that URI at `vp.request.deliver`.
 * `vp.result.poll`: the status long-poll `GET vp-request/{requestId}/status` (Verify holds it up
 * to 55 s; client timeout 65 000 ms) until the request leaves `ACTIVE`, then
 * `POST /v2/vp-results/{transactionId}`; 404 `NO_VP_SUBMISSION` is retried every 1500 ms (at most
 * 80 polls) until the run's deadline. Both are coalesced poll groups (04 §8.3).
 */
import { catalogEntry } from '../catalog.js';
import type {
  AdapterContext,
  AdapterDescriptor,
  Availability,
  CheckResult,
  GatewayCorrelation,
  HeldCredential,
  PresentationQuery,
  PresentationRequestRef,
  VerificationOutcome,
  VerifierAdapter,
} from '../contracts.js';
import {
  UPSTREAM_TIMEOUT_MS,
  callSignal,
  correlate,
  inStep,
  isRecord,
  jsonBody,
  str,
  trimSlash,
  verifyNonce,
} from '../support.js';
import { isNoSubmission, mapVerifyResult } from './inji-verify-result.js';

export const INJI_VERIFY_VERSION = 'inji-verify-service:1.0.0-alpha.1';
export const DEFAULT_CLIENT_ID = 'interop-playground';
/** 03 §2.0 poll rule (local) */
export const POLL_INTERVAL_MS = 1500;
export const MAX_RESULT_POLLS = 80;

export interface InjiVerifyLocalOptions {
  /** `http://verify-service:8080/v1/verify` (service name; BFF-internal) */
  internalBase: string;
  gateway?: GatewayCorrelation;
  /** send `skipStatusChecks:true` to `/v2/vc-verification` (S-014; default off) */
  skipStatusChecks?: boolean;
  nonce?: () => string;
  /** injectable clock and sleep for tests */
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pollIntervalMs?: number;
}

/** 03 §2.0 "Common request parameters": DCQL query per format, credential query id `pg` */
export function dcqlFor(q: PresentationQuery): unknown {
  const claimPaths = q.claimPaths.length > 0 ? q.claimPaths : [['fullName']];
  const claims = claimPaths.map((p) => ({ path: [...p] }));
  if (q.format === 'dc+sd-jwt')
    return {
      credentials: [
        { id: 'pg', format: 'dc+sd-jwt', meta: { vct_values: [q.vctOrDoctypeOrType] }, claims },
      ],
    };
  if (q.format === 'ldp_vc')
    return {
      credentials: [
        {
          id: 'pg',
          format: 'ldp_vc',
          meta: { type_values: [['VerifiableCredential', q.vctOrDoctypeOrType]] },
          claims,
        },
      ],
    };
  // G-09 / ADR-30: no mso_mdoc OID4VP query at Inji Verify (the selector greys it out)
  throw new Error(`verifier.inji-verify-local: no OID4VP query for format ${q.format} (G-09)`);
}

/**
 * The QR / deep-link content (03 FLOW-30 message 2): the SDK's parameter order
 * (`OpenID4VPVerification.tsx:56-77,234`@607c5ae1); no `client_metadata` for plain ids.
 */
export function buildRequestUri(p: {
  clientId: string;
  state: string;
  nonce: string;
  responseUri: string;
  dcqlQuery: unknown;
}): string {
  const params: [string, string][] = [
    ['client_id', p.clientId],
    ['state', p.state],
    ['response_mode', 'direct_post'],
    ['response_type', 'vp_token'],
    ['nonce', p.nonce],
    ['response_uri', p.responseUri],
    ['dcql_query', JSON.stringify(p.dcqlQuery)],
  ];
  return `openid4vp://authorize?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason as Error);
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

export class InjiVerifyLocalVerifier implements VerifierAdapter {
  readonly descriptor: AdapterDescriptor;
  private readonly base: string;
  /** transactionId per run (needed by the result call, not part of the request ref) */
  private readonly txns = new Map<string, { transactionId: string; requestId: string }>();

  constructor(private readonly opts: InjiVerifyLocalOptions) {
    this.descriptor = { ...catalogEntry('verifier.inji-verify-local'), knobs: [] };
    this.base = trimSlash(opts.internalBase);
  }

  private cap(ctx: { runId: string }, stepKey: string, group?: string) {
    return {
      runId: ctx.runId,
      stepKey,
      actor: 'playground(verifier-ui)',
      counterpart: 'verifier.inji-verify-local',
      ...(group ? { poll: { group } } : {}),
    };
  }

  async probe(
    ctx: Omit<AdapterContext, 'spec' | 'knobs' | 'holderKey' | 'sign'>,
  ): Promise<Availability> {
    const res = await ctx.http.fetch(
      {
        runId: ctx.runId,
        stepKey: 'env.probe',
        actor: 'playground(env)',
        counterpart: this.descriptor.id,
      },
      `${this.base}/actuator/health`,
      { signal: ctx.signal },
    );
    const body = await jsonBody(res);
    const up = res.status === 200 && isRecord(body) && body.status === 'UP';
    return up
      ? { available: true, versionFingerprint: INJI_VERIFY_VERSION }
      : {
          available: false,
          reason: `health answered ${res.status}`,
          versionFingerprint: INJI_VERIFY_VERSION,
        };
  }

  async createRequest(ctx: AdapterContext, q: PresentationQuery): Promise<PresentationRequestRef> {
    const scheme = ctx.knobs['KNOB-07'] ?? 'plain';
    if (scheme !== 'plain')
      throw new Error(`KNOB-07 ${scheme}: signed request objects (FLOW-34) are not built yet`);
    const clientId = DEFAULT_CLIENT_ID;
    const nonce = (this.opts.nonce ?? verifyNonce)();
    const dcqlQuery = dcqlFor(q);
    return inStep(ctx, 'vp.request.create', async () => {
      const res = await ctx.http.fetch(
        this.cap(ctx, 'vp.request.create'),
        `${this.base}/v2/vp-request`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientId, nonce, dcqlQuery }),
          signal: callSignal(ctx, UPSTREAM_TIMEOUT_MS),
        },
      );
      const body = await jsonBody(res);
      const details =
        isRecord(body) && isRecord(body.authorizationDetails) ? body.authorizationDetails : {};
      const transactionId = isRecord(body) ? str(body.transactionId) : null;
      const requestId = isRecord(body) ? str(body.requestId) : null;
      const responseUri = str(details.responseUri);
      const ref: PresentationRequestRef = {
        verifierAdapter: 'verifier.inji-verify-local',
        requestUri: '',
        clientId: str(details.clientId) ?? clientId,
        clientIdScheme: 'plain',
        responseUri: responseUri ?? '',
        nonce: str(details.nonce) ?? nonce,
        state: requestId ?? '',
        dcqlQuery: details.dcqlQuery ?? dcqlQuery,
        mode: 'cross-device',
      };
      if (res.status !== 201 || !transactionId || !requestId || !responseUri)
        return { outcome: 'fail', value: ref };
      ref.requestUri = buildRequestUri(ref);
      this.txns.set(ctx.runId, { transactionId, requestId });
      // the wallet posts `state=<requestId>` to the gateway's 8443 listener (form body key)
      correlate(
        ctx,
        this.opts.gateway,
        { kind: 'request-id', value: requestId },
        'vp.response.post',
      );
      correlate(
        ctx,
        this.opts.gateway,
        { kind: 'transaction-id', value: transactionId },
        'vp.result.poll',
      );
      this.opts.gateway?.addRoutes?.(ctx.runId, [
        {
          method: 'POST',
          pattern: /\/v2\/vp-submission\/direct-post$/,
          stepKey: 'vp.response.post',
        },
      ]);
      return { outcome: 'pass', value: ref };
    });
  }

  async awaitResult(
    ctx: AdapterContext,
    _req: PresentationRequestRef,
    timeoutMs: number,
  ): Promise<VerificationOutcome> {
    const ids = this.txns.get(ctx.runId);
    if (!ids) throw new Error('awaitResult before a successful createRequest');
    const now = this.opts.now ?? (() => Date.now());
    const sleep = this.opts.sleep ?? defaultSleep;
    const interval = this.opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    const deadline = now() + timeoutMs;
    return inStep(ctx, 'vp.result.poll', async () => {
      // 1. status long-poll until the request leaves ACTIVE (or the deadline)
      const statusCap = this.cap(ctx, 'vp.result.poll', 'vp-status');
      let status: string | null = null;
      while (now() < deadline) {
        const left = Math.max(1, Math.min(UPSTREAM_TIMEOUT_MS, deadline - now()));
        try {
          const res = await ctx.http.fetch(
            statusCap,
            `${this.base}/vp-request/${encodeURIComponent(ids.requestId)}/status`,
            { signal: callSignal(ctx, left) },
          );
          const body = await jsonBody(res);
          status = isRecord(body) ? str(body.status) : null;
          if (res.status !== 200 || status !== 'ACTIVE') break;
          // Verify answers ACTIVE after its 55 s hold; never spin on a fast answer
          if (now() + interval >= deadline) break;
          await sleep(interval, ctx.signal);
        } catch (e) {
          if (ctx.signal.aborted || !isTimeout(e)) throw e;
          break; // our deadline cut the long poll: go read the result once
        }
      }
      await ctx.http.closePoll(statusCap, 'vp-status');
      // 2. the result, polled while Verify says NO_VP_SUBMISSION
      const resultCap = this.cap(ctx, 'vp.result.poll', 'vp-result');
      let polls = 0;
      let last: { status: number; body: unknown };
      for (;;) {
        polls += 1;
        const res = await ctx.http.fetch(
          resultCap,
          `${this.base}/v2/vp-results/${encodeURIComponent(ids.transactionId)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
            signal: callSignal(ctx, UPSTREAM_TIMEOUT_MS),
          },
        );
        last = { status: res.status, body: await jsonBody(res) };
        if (!isNoSubmission(last.status, last.body)) break;
        if (polls >= MAX_RESULT_POLLS || now() + interval >= deadline || status === 'EXPIRED')
          break;
        await sleep(interval, ctx.signal);
      }
      await ctx.http.closePoll(resultCap, 'vp-result');
      let outcome: VerificationOutcome;
      if (isNoSubmission(last.status, last.body)) {
        outcome = { verdict: 'no-submission', checks: [], rawResult: last.body, exchangeIds: [] };
      } else if (last.status === 200) {
        const mapped = mapVerifyResult(last.body);
        outcome = { ...mapped, rawResult: last.body, exchangeIds: [] };
        for (const check of mapped.checks)
          await ctx.emit({ type: 'verdict.check', stepKey: 'vp.result.poll', check });
      } else {
        // an unexpected answer is a failed step (data, not an exception, 02 §5.1)
        outcome = { verdict: 'invalid', checks: [], rawResult: last.body, exchangeIds: [] };
        this.txns.delete(ctx.runId);
        return { outcome: 'fail', value: outcome };
      }
      this.txns.delete(ctx.runId);
      return { outcome: 'pass', value: outcome };
    });
  }

  /**
   * Credential-level verification (03 FLOW-40, REQ-23): `POST /v2/vc-verification` with the VC as
   * a string (G-10), then `vp.verdict.evaluate`. Valid / Invalid / Valid-but-Expired comes from
   * `mapVerifyResult` (signature valid ∧ `expiryCheck.valid:false` = Valid-but-Expired, S-014).
   */
  async verifyCredential(
    ctx: AdapterContext,
    held: HeldCredential,
    opts: { evaluate?: boolean } = {},
  ): Promise<VerificationOutcome> {
    // FLOW-31 tier 1 (ADR-30, ADR-97): the checks stay at vp.vc.verify, never the run's verdict
    const tier1Checks = async (o: VerificationOutcome): Promise<void> => {
      if (opts.evaluate !== false) return;
      for (const check of o.checks)
        await ctx.emit({ type: 'verdict.check', stepKey: 'vp.vc.verify', check });
    };
    const outcome = await inStep(ctx, 'vp.vc.verify', async () => {
      const res = await ctx.http.fetch(
        this.cap(ctx, 'vp.vc.verify'),
        `${this.base}/v2/vc-verification`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            verifiableCredential: held.raw,
            ...(this.opts.skipStatusChecks ? { skipStatusChecks: true } : {}),
          }),
          signal: callSignal(ctx, UPSTREAM_TIMEOUT_MS),
        },
      );
      const body = await jsonBody(res);
      if (res.status === 200 && isRecord(body)) {
        const mapped = mapVerifyResult(body);
        const value: VerificationOutcome = { ...mapped, rawResult: body, exchangeIds: [] };
        await tier1Checks(value);
        return { outcome: 'pass' as const, value };
      }
      // a non-200 is data: the upstream code and message are copied verbatim (02 §5.1)
      const e = isRecord(body) ? body : {};
      const code = str(e.errorCode);
      const message = str(e.errorMessage);
      const check: CheckResult = {
        checkId: 'vc.signature',
        outcome: 'fail',
        source: 'verifier-response',
        ...(code ? { code } : {}),
        ...(message ? { message } : {}),
        exchangeIds: [],
      };
      const value: VerificationOutcome = {
        verdict: 'invalid',
        checks: [check],
        rawResult: body,
        exchangeIds: [],
      };
      await tier1Checks(value);
      return { outcome: 'fail' as const, value };
    });
    if (opts.evaluate === false) return outcome;
    await inStep(ctx, 'vp.verdict.evaluate', async () => {
      for (const check of outcome.checks)
        await ctx.emit({ type: 'verdict.check', stepKey: 'vp.verdict.evaluate', check });
      return { outcome: 'pass' as const, capture: 'none' as const, value: null };
    });
    return outcome;
  }
}
