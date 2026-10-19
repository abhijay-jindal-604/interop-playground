/**
 * Helpers shared by the adapters (02 §5.1): step bracketing per the ADR-65 (5) step contract,
 * tolerant JSON reading of captured responses, the Verify nonce generator (04 §8.7) and the
 * gateway correlation hook. No raw HTTP here: every call goes through `CapturingHttp`.
 */
import { randomBytes } from 'node:crypto';
import type { AdapterContext, Coverage, CorrelationKey } from './contracts.js';

/** request timeout of every BFF-internal call that may long-poll (04 §8.5, ADR-66 (5)) */
export const UPSTREAM_TIMEOUT_MS = 65_000;

/**
 * The gateway's correlation index as the adapters see it (02 §3.3; structural copy of
 * `apps/bff/src/gateway/correlation.ts` so this package stays free of BFF imports).
 */
export interface GatewayCorrelation {
  register(runId: string, key: string, stepKey: string, actor?: string | null): void;
  /** maps inbound `{method, path}` of the run to a stepKey (merged per run by the caller) */
  addRoutes?(
    runId: string,
    routes: readonly { method: string; pattern: RegExp; stepKey: string }[],
  ): void;
}

/** registers a key with the orchestrator (`ctx.correlate`) and, when wired, with the gateway */
export function correlate(
  ctx: AdapterContext,
  gateway: GatewayCorrelation | undefined,
  key: CorrelationKey,
  stepKey: string,
  actor: string | null = null,
): void {
  ctx.correlate(key);
  if (gateway && key.value.length >= 8) {
    const raw = key.kind === 'access-token-sha256' ? `sha256:${key.value}` : key.value;
    gateway.register(ctx.runId, raw, stepKey, actor);
  }
}

export interface StepResult<T> {
  outcome: 'pass' | 'fail' | 'skipped';
  value: T;
  capture?: Coverage;
}

/**
 * Brackets one step: `step.started`, the body, `step.completed`. A throw leaves the step open,
 * which the orchestrator closes as a failed step with partial capture (environment fault).
 */
export async function inStep<T>(
  ctx: AdapterContext,
  stepKey: string,
  body: () => Promise<StepResult<T>>,
): Promise<T> {
  await ctx.emit({ type: 'step.started', stepKey });
  const r = await body();
  await ctx.emit({
    type: 'step.completed',
    stepKey,
    outcome: r.outcome,
    capture: r.capture ?? (r.outcome === 'skipped' ? 'none' : 'full'),
  });
  return r.value;
}

/** body text parsed as JSON when it is JSON, else `null` (the raw bytes are in the capture) */
export async function jsonBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** 04 §8.7: base64url (no padding) of 24 random bytes = 32 chars inside `A-Za-z0-9-_` */
export function verifyNonce(): string {
  return randomBytes(24).toString('base64url');
}

/** combines the run's abort signal with a per-call timeout */
export function callSignal(ctx: { signal: AbortSignal }, timeoutMs: number): AbortSignal {
  return AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
}

export function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
}
