/**
 * One run's execution (02 §1.3, 04 §5.1–§5.3, ADR-27, ADR-29): walks the step plan of the run's
 * flow files, calls the chosen adapters through the 02 §5.2 contracts, and writes every event
 * through the sink (which publishes after commit). Rules kept here:
 *  - steps are emitted in plan order; a step that does not apply (or that the adapter did not
 *    perform) is emitted `step.started` + `step.completed{skipped}`, never omitted;
 *  - `CaptureHttp.flushStep` runs before each `step.completed`, `endRun` before the terminal event;
 *  - the first failed step blocks the rest (`skipped`, "blocked at <stepKey>");
 *  - an adapter throw is an engine fault: `run.failed{engine_exception}`; an abort is a cancel.
 */
import { createHash } from 'node:crypto';
import { catalogEntry } from '@interop-playground/adapters';
import type {
  AdapterContext,
  AdapterEvent,
  CapturingHttp,
  CorrelationKey,
  HeldCredential,
  HolderKeyRef,
  IssuerAdapter,
  PresentationRequestRef,
  VerificationOutcome,
  VerifierAdapter,
  WalletAdapter,
} from '@interop-playground/adapters';
import type { Coverage, EngineOp, Outcome, RunSpec, RunVerdict } from '@interop-playground/api';
import type { EventSink, SinkEvent } from '../store/index.js';
import type { FlowTable, PlannedStep } from './flows.js';
import { planRun, targetOf } from './flows.js';
import { issuerVariantKnobsChanged } from '../catalog/knobs.js';

export interface AdapterSet {
  issuer(id: string): IssuerAdapter | undefined;
  wallet(id: string): WalletAdapter | undefined;
  verifier(id: string): VerifierAdapter | undefined;
}

export interface CaptureHooks {
  http: CapturingHttp;
  flushStep(runId: string, stepKey: string): Promise<void>;
  endRun(runId: string): Promise<void>;
}

export interface KeyService {
  holderKey(runId: string, spec: RunSpec): Promise<HolderKeyRef>;
  sign(key: HolderKeyRef, alg: 'ES256' | 'EdDSA', data: Uint8Array): Promise<Uint8Array>;
}

export interface EngineDeps {
  sink: EventSink;
  flows: FlowTable;
  adapters: AdapterSet;
  capture: CaptureHooks;
  keys: KeyService | null;
  correlate(runId: string, key: CorrelationKey): void;
  now(): number;
  /** presentation result wait (03 §2.0: request expiry 300 s) */
  resultTimeoutMs: number;
}

/** an error that carries a `Run.errorCode` (04 §6.2 closing paragraph) */
export class RunFault extends Error {
  constructor(
    readonly runErrorCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'RunFault';
  }
}

class Cancelled extends Error {}

const TIER_RANK = { manual: 0, 'best-effort': 1, automated: 2 } as const;

export function evidenceTierOf(spec: RunSpec): 'automated' | 'best-effort' | 'manual' {
  const tiers = [spec.issuer, spec.wallet, spec.verifier].map((id) => catalogEntry(id).tier);
  return tiers.reduce((lo, t) => (TIER_RANK[t] < TIER_RANK[lo] ? t : lo), 'automated');
}

function safeMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.slice(0, 500);
}

export class RunExecution {
  private readonly plan: PlannedStep[];
  private readonly byKey = new Map<string, PlannedStep>();
  private readonly emitted = new Map<string, 'open' | 'done'>();
  private readonly startedAt = new Map<string, number>();
  private readonly outcomes = new Map<string, Outcome>();
  private next = 0;
  private openStep: string | null = null;
  private firstFail: string | null = null;
  private issuanceOk: boolean | null = null;
  private verification: VerificationOutcome['verdict'] | null = null;
  private readonly target: string;

  constructor(
    private readonly deps: EngineDeps,
    readonly runId: string,
    readonly spec: RunSpec,
    private readonly signal: AbortSignal,
  ) {
    this.plan = planRun(deps.flows, spec);
    for (const s of this.plan) this.byKey.set(s.stepKey, s);
    this.target = targetOf(deps.flows, spec).stepKey;
  }

  private append(ev: SinkEvent): void {
    this.deps.sink.append(this.runId, ev);
  }

  // ---------- step bookkeeping ----------
  private emitSkipped(s: PlannedStep, reason: string): void {
    this.append({
      type: 'step.started',
      stepKey: s.stepKey,
      payload: { flowId: s.flowId, order: s.order, kind: s.kind, label: s.label },
    });
    this.append({
      type: 'step.completed',
      stepKey: s.stepKey,
      payload: {
        outcome: 'skipped',
        capture: 'none',
        skipReason: reason,
        coverageNote: null,
        durationMs: 0,
      },
    });
    this.emitted.set(s.stepKey, 'done');
    this.outcomes.set(s.stepKey, 'skipped');
  }

  /** emits every not yet emitted step before plan index `upTo` (exclusive) as skipped */
  private skipBefore(upTo: number, reasonForApplicable: string): void {
    while (this.next < upTo) {
      const s = this.plan[this.next] as PlannedStep;
      this.next += 1;
      if (this.emitted.has(s.stepKey)) continue;
      this.emitSkipped(s, s.applies ? reasonForApplicable : s.skipReason);
    }
  }

  private async closeOpen(outcome: Outcome, note: string | null): Promise<void> {
    if (this.openStep !== null) await this.completeStep(this.openStep, outcome, 'full', note);
  }

  startStep(stepKey: string): void {
    const s = this.byKey.get(stepKey);
    if (!s) throw new RunFault('engine_exception', `step ${stepKey} is not in the run's flows`);
    if (!s.applies)
      throw new RunFault('engine_exception', `step ${stepKey} does not apply to this run`);
    if (this.emitted.has(stepKey))
      throw new RunFault('engine_exception', `step ${stepKey} emitted twice`);
    if (this.openStep !== null)
      throw new RunFault(
        'engine_exception',
        `step ${stepKey} started while ${this.openStep} is open`,
      );
    this.skipBefore(s.index - 1, 'not performed by the adapter');
    this.next = Math.max(this.next, s.index);
    this.append({
      type: 'step.started',
      stepKey,
      payload: { flowId: s.flowId, order: s.order, kind: s.kind, label: s.label },
    });
    this.emitted.set(stepKey, 'open');
    this.startedAt.set(stepKey, this.deps.now());
    this.openStep = stepKey;
  }

  async completeStep(
    stepKey: string,
    outcome: Outcome,
    capture: Coverage,
    coverageNote: string | null = null,
  ): Promise<void> {
    if (this.emitted.get(stepKey) !== 'open')
      throw new RunFault('engine_exception', `step ${stepKey} completed without being started`);
    await this.deps.capture.flushStep(this.runId, stepKey);
    const s = this.byKey.get(stepKey) as PlannedStep;
    this.append({
      type: 'step.completed',
      stepKey,
      payload: {
        outcome,
        capture,
        skipReason: outcome === 'skipped' ? s.skipReason : null,
        coverageNote,
        durationMs: Math.max(0, Math.round(this.deps.now() - (this.startedAt.get(stepKey) ?? 0))),
      },
    });
    this.emitted.set(stepKey, 'done');
    this.outcomes.set(stepKey, outcome);
    if (this.openStep === stepKey) this.openStep = null;
    if (outcome === 'fail' && this.firstFail === null) this.firstFail = stepKey;
  }

  private stepsOf(prefixes: string[]): PlannedStep[] {
    return this.plan.filter((s) => prefixes.some((p) => s.stepKey.startsWith(p)));
  }

  private applies(stepKey: string): boolean {
    return this.byKey.get(stepKey)?.applies === true;
  }

  private checkAbort(): void {
    if (this.signal.aborted) throw new Cancelled();
  }

  // ---------- adapter context ----------
  private context(): AdapterContext {
    const keys = this.deps.keys;
    return {
      runId: this.runId,
      spec: this.spec,
      knobs: this.spec.knobs,
      http: this.deps.capture.http,
      signal: this.signal,
      emit: async (ev: AdapterEvent) => this.onAdapterEvent(ev),
      correlate: (key) => this.deps.correlate(this.runId, key),
      holderKey: () =>
        keys
          ? keys.holderKey(this.runId, this.spec)
          : Promise.reject(new RunFault('engine_exception', 'no key service configured')),
      sign: (key, alg, data) =>
        keys
          ? keys.sign(key, alg, data)
          : Promise.reject(new RunFault('engine_exception', 'no key service configured')),
    };
  }

  private async onAdapterEvent(ev: AdapterEvent): Promise<void> {
    this.checkAbort();
    switch (ev.type) {
      case 'step.started':
        this.startStep(ev.stepKey);
        return;
      case 'step.completed':
        await this.completeStep(ev.stepKey, ev.outcome, ev.capture);
        return;
      case 'engine.call':
        this.append({
          type: 'engine.call',
          stepKey: ev.stepKey,
          payload: {
            engine: ev.engine,
            op: ev.op as EngineOp,
            inputSummary: ev.inputSummary,
            outputSummary: ev.outputSummary,
            durationMs: 0,
          },
        });
        return;
      case 'engine.exception':
        this.append({
          type: 'engine.exception',
          stepKey: ev.stepKey,
          payload: {
            engine: ev.engine,
            exceptionClass: ev.exceptionClass,
            message: ev.message,
            endedStep: false,
          },
        });
        return;
      case 'verdict.check':
        this.append({ type: 'verdict.check', stepKey: ev.stepKey, payload: { check: ev.check } });
        return;
    }
  }

  /** after an adapter phase: steps of the phase it left open fail; the rest are blocked on failure */
  private async afterPhase(): Promise<boolean> {
    await this.closeOpen('fail', 'adapter returned without completing the step');
    return this.firstFail === null;
  }

  // ---------- orchestration ----------
  private adapter<T>(get: (id: string) => T | undefined, id: string): T {
    const a = get(id);
    if (!a) throw new RunFault('engine_exception', `adapter ${id} is not registered`);
    return a;
  }

  private async issuance(ctx: AdapterContext): Promise<HeldCredential | null> {
    const issuer = this.adapter((id) => this.deps.adapters.issuer(id), this.spec.issuer);
    const wallet = this.adapter((id) => this.deps.adapters.wallet(id), this.spec.wallet);
    let configurationId = this.spec.configurationId;
    // vci.setup.variant: only when an issuer-side knob differs from its default (02 §1.3 item 5)
    const issuerKnobs = issuerVariantKnobsChanged(this.spec);
    if (issuerKnobs && this.applies('vci.setup.variant')) {
      configurationId = await issuer.resolveVariant(ctx, configurationId);
      if (!(await this.afterPhase())) return null;
    } else if (this.byKey.has('vci.setup.variant')) {
      const s = this.byKey.get('vci.setup.variant') as PlannedStep;
      this.skipBefore(s.index - 1, 'not performed by the adapter');
      if (!this.emitted.has(s.stepKey)) this.emitSkipped(s, s.skipReason);
    }
    this.checkAbort();
    await issuer.metadata(ctx);
    if (!(await this.afterPhase())) return null;
    this.checkAbort();
    let outcome;
    if (this.spec.grant === 'authorization_code') {
      if (!issuer.authCodeTarget || !wallet.receiveAuthCode)
        throw new RunFault(
          'engine_exception',
          'adapters do not implement the authorization code grant',
        );
      const target = await issuer.authCodeTarget(ctx, configurationId);
      if (!(await this.afterPhase())) return null;
      outcome = await wallet.receiveAuthCode(ctx, target);
    } else {
      if (!issuer.createOffer || !wallet.receiveOffer)
        throw new RunFault(
          'engine_exception',
          'adapters do not implement the pre-authorized grant',
        );
      const offer = await issuer.createOffer(ctx, {
        configurationId,
        claims: {},
        withTxCode: this.spec.withTxCode,
      });
      if (!(await this.afterPhase())) return null;
      this.checkAbort();
      outcome = await wallet.receiveOffer(ctx, offer);
    }
    const ok = await this.afterPhase();
    this.issuanceOk = outcome.ok && ok;
    return this.issuanceOk && outcome.credential ? outcome.credential : null;
  }

  private async presentation(ctx: AdapterContext, held: HeldCredential): Promise<void> {
    const verifier = this.adapter((id) => this.deps.adapters.verifier(id), this.spec.verifier);
    const wallet = this.adapter((id) => this.deps.adapters.wallet(id), this.spec.wallet);
    let result: VerificationOutcome;
    if (verifier.createRequest && verifier.awaitResult) {
      const ref: PresentationRequestRef = await verifier.createRequest(ctx, {
        format: this.spec.format,
        configurationId: this.spec.configurationId,
        vctOrDoctypeOrType: this.spec.configurationId,
        claimPaths: this.spec.disclosure.claimPaths,
        mode: this.spec.presentationMode ?? 'cross-device',
      });
      if (!(await this.afterPhase())) return;
      this.checkAbort();
      if (this.applies('vp.request.deliver')) {
        this.startStep('vp.request.deliver');
        this.append({
          type: 'engine.call',
          stepKey: 'vp.request.deliver',
          payload: {
            engine: 'playground-ts',
            op: 'deliver-request',
            inputSummary: { wallet: this.spec.wallet },
            outputSummary: {
              channel: this.spec.delivery,
              uri: ref.requestUri,
              uriSha256: createHash('sha256').update(ref.requestUri).digest('hex'),
            },
            durationMs: 0,
          },
        });
        await this.completeStep('vp.request.deliver', 'pass', 'full');
      }
      this.checkAbort();
      const presented = await wallet.present(ctx, ref, held, this.spec.disclosure);
      if (!(await this.afterPhase())) return;
      this.checkAbort();
      result = await verifier.awaitResult(ctx, ref, this.deps.resultTimeoutMs);
      if (!presented.submitted && result.verdict !== 'no-submission')
        result = { ...result, verdict: 'no-submission' };
    } else if (verifier.verifyCredential) {
      result = await verifier.verifyCredential(ctx, held);
    } else {
      throw new RunFault('engine_exception', `${this.spec.verifier} implements no verification`);
    }
    if (!(await this.afterPhase())) return;
    this.verification = result.verdict;
    if (this.applies('vp.verdict.evaluate')) {
      this.startStep('vp.verdict.evaluate');
      const pass = result.verdict === 'valid' || result.verdict === 'valid-but-expired';
      this.append({
        type: 'verdict.check',
        stepKey: 'vp.verdict.evaluate',
        payload: {
          check: {
            checkId: 'vp.verdict',
            outcome: result.verdict === 'no-submission' ? 'not-run' : pass ? 'pass' : 'fail',
            source: 'verifier-response',
            message: result.verdict,
            exchangeIds: [...result.exchangeIds],
          },
        },
      });
      await this.completeStep('vp.verdict.evaluate', pass ? 'pass' : 'fail', 'full');
    }
  }

  private verdict(): RunVerdict {
    const kind: RunVerdict['kind'] = this.spec.presentationMode === 'dc-api' ? 'probe' : 'interop';
    const targetOutcome = this.outcomes.get(this.target) ?? null;
    let outcome: RunVerdict['outcome'];
    if (this.firstFail !== null && targetOutcome === 'skipped') outcome = 'blocked';
    else if (this.verification === 'no-submission') outcome = 'no-submission';
    else if (this.firstFail !== null) outcome = 'fail';
    else if (this.spec.scope === 'issuance') outcome = this.issuanceOk ? 'pass' : 'fail';
    else
      outcome =
        this.issuanceOk !== false &&
        (this.verification === 'valid' || this.verification === 'valid-but-expired')
          ? 'pass'
          : 'fail';
    return {
      kind,
      outcome,
      issuanceOk: this.issuanceOk,
      verification: this.verification,
      tamperVerdict: null,
      failedStepKey: this.firstFail,
      countsTowardPassRate:
        kind === 'interop' &&
        ['pass', 'fail', 'blocked'].includes(outcome) &&
        evidenceTierOf(this.spec) !== 'manual',
    };
  }

  /** runs to exactly one terminal event; never throws */
  async run(): Promise<void> {
    const ctx = this.context();
    try {
      this.checkAbort();
      const held = await this.issuance(ctx);
      if (held && this.spec.scope === 'full' && this.firstFail === null) {
        this.checkAbort();
        await this.presentation(ctx, held);
      }
      this.checkAbort();
      const reason =
        this.firstFail !== null ? `blocked at ${this.firstFail}` : 'not performed by the adapter';
      this.skipBefore(this.plan.length, reason);
      await this.deps.capture.endRun(this.runId);
      this.append({
        type: 'run.completed',
        payload: { verdict: this.verdict(), counterfactualResult: null },
      });
    } catch (e) {
      await this.terminate(e);
    }
  }

  private async terminate(e: unknown): Promise<void> {
    const at = this.openStep;
    try {
      if (e instanceof Cancelled || this.signal.aborted) {
        if (at !== null) {
          this.append({
            type: 'engine.call',
            stepKey: at,
            payload: {
              engine: 'playground-ts',
              op: 'cancelled',
              inputSummary: null,
              outputSummary: null,
              durationMs: 0,
            },
          });
          await this.completeStep(at, 'fail', 'partial', 'cancelled during this step');
        }
        this.skipBefore(this.plan.length, 'cancelled');
        await this.deps.capture.endRun(this.runId);
        this.append({ type: 'run.cancelled', payload: { reason: 'user', atStepKey: at } });
        return;
      }
      if (at !== null) await this.completeStep(at, 'fail', 'partial', 'engine fault');
      this.skipBefore(this.plan.length, `blocked at ${at ?? this.firstFail ?? 'engine fault'}`);
      await this.deps.capture.endRun(this.runId);
      this.append({
        type: 'run.failed',
        payload: {
          errorCode: e instanceof RunFault ? e.runErrorCode : 'engine_exception',
          message: safeMessage(e),
          stepKey: at,
        },
      });
    } catch (inner) {
      // last resort: the log must still close
      try {
        this.append({
          type: 'run.failed',
          payload: { errorCode: 'internal_error', message: safeMessage(inner), stepKey: at },
        });
      } catch {
        /* the run is already closed */
      }
    }
  }
}
