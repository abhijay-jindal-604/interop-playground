/**
 * Orchestrator (plan/12 T-20; 02 §1.3, 04 §4, §5.1–§5.3, ADR-21): resolves requests to RunSpecs,
 * stores them (`run.created` first), schedules runs (at most 4 running, at most 1 touching a Collab
 * column, FIFO within those limits, queue cap 50) and executes them through RunExecution.
 * On start it closes runs a previous process left open: `run.failed{bff_restarted}` (04 §5.1).
 */
import { ulid } from 'ulid';
import type { CorrelationKey } from '@interop-playground/adapters';
import type { CreateRunRequest, PreviewResponse, RunSpec } from '@interop-playground/api';
import { ApiError, issueDetails } from '../errors/index.js';
import type { Store } from '../store/index.js';
import { RunExecution, evidenceTierOf } from './engine.js';
import type { AdapterSet, CaptureHooks, KeyService } from './engine.js';
import type { FlowTable } from './flows.js';
import { targetOf } from './flows.js';
import { DEFAULT_RESOLVE_ENV, resolveRunSpec, validateCreateRunRequest } from './resolve.js';
import type { ResolveEnv } from './resolve.js';

export { RunExecution, RunFault, evidenceTierOf } from './engine.js';
export type { AdapterSet, CaptureHooks, KeyService } from './engine.js';
export { loadFlowTable, mergedSteps, planRun, stepApplies, targetOf } from './flows.js';
export type { FlowTable, PlannedStep } from './flows.js';
export { COMPAT_RULES } from './rules.js';
export { resolveRunSpec, validateCreateRunRequest, DEFAULT_RESOLVE_ENV } from './resolve.js';
export type { ResolveEnv } from './resolve.js';

export const LIMITS = { maxRunning: 4, maxCollab: 1, queueCap: 50, retryAfterS: 30 } as const;

export interface OrchestratorOptions {
  store: Store;
  flows: FlowTable;
  adapters: AdapterSet;
  capture: CaptureHooks;
  env?: ResolveEnv;
  keys?: KeyService | null;
  limits?: Partial<{ maxRunning: number; maxCollab: number; queueCap: number }>;
  appVersion?: string;
  now?: () => number;
  resultTimeoutMs?: number;
}

interface Active {
  controller: AbortController;
  spec: RunSpec;
  done: Promise<void>;
}

const touchesCollab = (spec: RunSpec): boolean => Object.values(spec.env).includes('collab');

export class Orchestrator {
  private readonly queue: { runId: string; spec: RunSpec }[] = [];
  private readonly active = new Map<string, Active>();
  private readonly correlations = new Map<string, string>();
  private readonly limits: { maxRunning: number; maxCollab: number; queueCap: number };
  private readonly env: ResolveEnv;
  private readonly now: () => number;

  constructor(private readonly opts: OrchestratorOptions) {
    this.limits = { ...LIMITS, ...opts.limits };
    this.env = opts.env ?? DEFAULT_RESOLVE_ENV;
    this.now = opts.now ?? (() => performance.now());
  }

  get flows(): FlowTable {
    return this.opts.flows;
  }

  /** 04 §5.1 shutdown rule: runs left `created`/`running` by an earlier process end `failed` */
  recover(): string[] {
    const rows = this.opts.store.driver.all<{ run_id: string }>(
      "SELECT run_id FROM runs WHERE state IN ('created','running') ORDER BY run_id",
    );
    const ids: string[] = [];
    for (const r of rows) {
      if (this.active.has(r.run_id) || this.queue.some((q) => q.runId === r.run_id)) continue;
      this.opts.store.sink.append(r.run_id, {
        type: 'run.failed',
        payload: {
          errorCode: 'bff_restarted',
          message: 'The BFF restarted while this run was active.',
          stepKey: null,
        },
      });
      ids.push(r.run_id);
    }
    return ids;
  }

  /** API-03: resolution without side effects */
  preview(body: unknown): PreviewResponse {
    const req = validateCreateRunRequest(body);
    const r = resolveRunSpec(req, this.opts.flows, this.env, {
      stateful: true,
      checkAvailability: false,
    });
    if (!r.ok) return { ok: false, hit: r.hit };
    return {
      ok: true,
      spec: r.spec,
      warnings: r.warnings,
      tamperApplicable: [],
      controlRequired: false,
    };
  }

  /** API-20 steps 1–8: returns the new run id (state `running` when a slot was free) */
  create(body: unknown): string {
    const req: CreateRunRequest = validateCreateRunRequest(body);
    const r = resolveRunSpec(req, this.opts.flows, this.env, {
      stateful: true,
      checkAvailability: true,
    });
    if (!r.ok) {
      if (r.rule.stateful)
        throw new ApiError('tunnel_required', r.hit.reason, {
          ruleId: r.hit.ruleId,
          gapId: r.hit.gapId,
        });
      throw new ApiError('incompatible_selection', r.hit.reason, { ...r.hit });
    }
    const spec = r.spec;
    for (const [role, get] of [
      ['issuer', (id: string) => this.opts.adapters.issuer(id)],
      ['wallet', (id: string) => this.opts.adapters.wallet(id)],
      ['verifier', (id: string) => this.opts.adapters.verifier(id)],
    ] as const) {
      const id = spec[role];
      if (!get(id))
        throw new ApiError('adapter_unavailable', `${id} is not built yet.`, {
          adapterId: id,
          reason: 'not-implemented',
        });
    }
    if (this.queue.length >= this.limits.queueCap)
      throw new ApiError(
        'queue_full',
        'The run queue is full.',
        { queueCap: this.limits.queueCap },
        LIMITS.retryAfterS,
      );
    const store = this.opts.store;
    let suiteId = spec.suiteId;
    if (suiteId !== null) {
      if (!store.driver.get('SELECT 1 AS x FROM suites WHERE suite_id = ?', suiteId))
        throw new ApiError(
          'validation_failed',
          'Unknown suite.',
          issueDetails([{ path: '$.suiteId', message: 'no such suite' }]),
        );
    } else {
      // interactive runs get an implicit suite of one (05 §5)
      suiteId = ulid();
      const envs = new Set(Object.values(spec.env));
      store.sink.createSuite({
        suiteId,
        name: r.label ?? 'interactive run',
        triggerKind: 'interactive',
        envClass: envs.size > 1 ? 'mixed' : envs.has('collab') ? 'collab' : 'local',
        appVersion: this.opts.appVersion ?? '0.0.0',
      });
    }
    const runId = ulid();
    const target = targetOf(this.opts.flows, spec);
    store.sink.createRun({
      runId,
      suiteId,
      triggerKind: 'interactive',
      flowId: target.flowId,
      spec,
      label: r.label,
      queuePosition: this.queue.length,
      knobsAllDefault: true,
      targetStepKey: target.stepKey,
      evidenceTier: evidenceTierOf(spec),
      appVersion: this.opts.appVersion ?? '0.0.0',
    });
    this.queue.push({ runId, spec });
    this.pump();
    return runId;
  }

  /** API-23: queued → cancelled at once; running → abort, the execution closes the log */
  async cancel(runId: string): Promise<void> {
    const qi = this.queue.findIndex((q) => q.runId === runId);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      await this.opts.capture.endRun(runId);
      this.opts.store.sink.append(runId, {
        type: 'run.cancelled',
        payload: { reason: 'user', atStepKey: null },
      });
      return;
    }
    const a = this.active.get(runId);
    if (a) {
      a.controller.abort();
      await a.done;
    }
  }

  isQueued(runId: string): boolean {
    return this.queue.some((q) => q.runId === runId);
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  counts(): { running: number; queued: number } {
    return { running: this.active.size, queued: this.queue.length };
  }

  /** resolves when nothing is running or queued (tests, shutdown) */
  async idle(): Promise<void> {
    while (this.active.size > 0) await Promise.all([...this.active.values()].map((a) => a.done));
  }

  /** the run a correlation key belongs to (02 §3.3 gateway lookup table) */
  correlated(key: CorrelationKey): string | null {
    return this.correlations.get(`${key.kind}:${key.value}`) ?? null;
  }

  /** aborts every running run (shutdown) */
  async stop(): Promise<void> {
    this.queue.length = 0;
    for (const a of this.active.values()) a.controller.abort();
    await this.idle();
  }

  private pump(): void {
    for (let i = 0; i < this.queue.length && this.active.size < this.limits.maxRunning;) {
      const q = this.queue[i] as { runId: string; spec: RunSpec };
      const collabBusy =
        touchesCollab(q.spec) &&
        [...this.active.values()].filter((a) => touchesCollab(a.spec)).length >=
          this.limits.maxCollab;
      if (collabBusy) {
        i += 1;
        continue;
      }
      this.queue.splice(i, 1);
      this.start(q.runId, q.spec);
    }
  }

  private start(runId: string, spec: RunSpec): void {
    const controller = new AbortController();
    this.opts.store.sink.append(runId, {
      type: 'run.started',
      payload: { startedAt: new Date().toISOString() },
    });
    const exec = new RunExecution(
      {
        sink: this.opts.store.sink,
        flows: this.opts.flows,
        adapters: this.opts.adapters,
        capture: this.opts.capture,
        keys: this.opts.keys ?? null,
        correlate: (id, key) => this.correlations.set(`${key.kind}:${key.value}`, id),
        now: this.now,
        resultTimeoutMs: this.opts.resultTimeoutMs ?? 300_000,
      },
      runId,
      spec,
      controller.signal,
    );
    const done = (async () => {
      // yield once so `create` answers before the first adapter call
      await Promise.resolve();
      await exec.run();
    })().finally(() => {
      this.active.delete(runId);
      try {
        this.pump();
      } catch {
        // the store went away (shutdown); queued runs are failed by the next start's recover()
      }
    });
    this.active.set(runId, { controller, spec, done });
  }
}
