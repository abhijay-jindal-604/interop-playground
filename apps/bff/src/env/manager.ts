/**
 * Environment manager (02 §1.1 C8; ADR-05, RISK-09; 04 §2.2, §3.3 `EnvSnapshot`, §7.2 env events;
 * ADR-73). A probe loop over the upstream well-knowns through the injected `CapturingHttp`, adapter
 * availability per 02 §5.3, version fingerprints (`RunSpec.versions` → `run_versions`), tunnel
 * state (API-12) and the Collab rate budget. It is the orchestrator's `ResolveEnv`.
 */
import { createHash } from 'node:crypto';
import { ADAPTER_IDS, catalogEntry } from '@interop-playground/adapters';
import type { CapturingHttp } from '@interop-playground/adapters';
import type {
  AdapterId,
  Availability,
  EnvSnapshot,
  Iso,
  PayloadMap,
  TunnelRegistration,
  UpstreamProbe,
} from '@interop-playground/api';
import { ApiError, issueDetails } from '../errors/index.js';
import type { ResolveEnv } from '../orchestrator/resolve.js';
import { ADAPTER_UPSTREAMS, UPSTREAMS, inProcessFingerprint } from './upstreams.js';
import type { UpstreamDef } from './upstreams.js';

type EnvType = 'env.probe' | 'env.ready' | 'env.degraded' | 'env.fingerprint' | 'env.tunnel';
export interface EnvEventSink {
  appendEnv<T extends EnvType>(type: T, payload: PayloadMap[T]): unknown;
}

export interface EnvTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface EnvManagerOptions {
  /** every probe goes through this client (02 §3.2) */
  http: CapturingHttp;
  /** the `env` stream (sink.appendEnv); null = no events (tests of the pure view) */
  sink: EnvEventSink | null;
  mode: 'local' | 'collab';
  publicHost: string;
  bffVersion: string;
  /** versions.lock `images` (image → digest) */
  imageDigests?: Readonly<Record<string, string>>;
  /** probe loop period (default 30 s) */
  intervalMs?: number;
  /** per-probe timeout (default 5 s) */
  timeoutMs?: number;
  /** wall clock, ms since epoch */
  now?: () => number;
  timers?: EnvTimers;
  upstreams?: readonly UpstreamDef[];
  /** called after every transition to ready (main.ts: the gateway's `refresh()`) */
  onReady?: () => void | Promise<void>;
}

interface ProbeState extends UpstreamProbe {
  checkedAtMs: number;
}

/** API-11: 1 call per 5 s */
export const PROBE_RATE_LIMIT_MS = 5000;
/** 04 §8.6: `ttlSeconds` default 1800, max 7200 */
const DEFAULT_TTL_S = 1800;
const MAX_TTL_S = 7200;
const HOST_RE =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const sha12 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12);

function statusOk(def: UpstreamDef, status: number): boolean {
  if (def.expect === 'any') return status < 500;
  if (typeof def.expect === 'number') return status === def.expect;
  return def.expect.includes(status);
}

/** S-007: the shape of a Collab answer (status + top-level keys + advertised endpoints) */
function collabShape(status: number, body: unknown): string {
  const keys =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? Object.keys(body).sort()
      : Array.isArray(body)
        ? ['[array]']
        : [];
  return `collab:${sha12(JSON.stringify({ status, keys }))}`;
}

export class EnvManager implements ResolveEnv {
  private readonly o: EnvManagerOptions;
  private readonly defs: readonly UpstreamDef[];
  private readonly now: () => number;
  private readonly timers: EnvTimers;
  private readonly probes = new Map<string, ProbeState>();
  private readonly lastFp = new Map<string, string>();
  private readyState: boolean | null = null;
  private tunnelState: EnvSnapshot['tunnel'] = { state: 'down' };
  private handle: unknown = null;
  private running: Promise<EnvSnapshot> | null = null;
  private lastManual = -Infinity;
  private readonly collabCalls: number[] = [];

  constructor(opts: EnvManagerOptions) {
    this.o = opts;
    this.defs = (opts.upstreams ?? UPSTREAMS).filter(
      (d) => d.profile !== 'collab' || opts.mode === 'collab',
    );
    this.now = opts.now ?? (() => Date.now());
    this.timers = opts.timers ?? {
      set: (fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref();
        return t;
      },
      clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
  }

  get intervalMs(): number {
    return this.o.intervalMs ?? 30_000;
  }

  /** starts the loop: one probe round now, then one per interval */
  start(): void {
    if (this.handle !== null) return;
    const tick = (): void => {
      void this.probeRound(false).finally(() => {
        if (this.handle !== null) this.handle = this.timers.set(tick, this.intervalMs);
      });
    };
    this.handle = this.timers.set(tick, 0);
  }

  stop(): void {
    if (this.handle !== null) this.timers.clear(this.handle);
    this.handle = null;
  }

  /** API-11: re-run every probe now; 429 `rate_limited` within 5 s of the last call */
  async probeNow(): Promise<EnvSnapshot> {
    const t = this.now();
    const wait = this.lastManual + PROBE_RATE_LIMIT_MS - t;
    if (wait > 0) {
      const retryAfterS = Math.ceil(wait / 1000);
      throw new ApiError(
        'rate_limited',
        'Probes run at most once per 5 s.',
        { retryAfterS },
        retryAfterS,
      );
    }
    this.lastManual = t;
    return this.probeRound(true);
  }

  /** one round; `verbose` (API-11) emits every event, the loop only the changes */
  probeRound(verbose: boolean): Promise<EnvSnapshot> {
    if (this.running) return this.running;
    this.running = this.doRound(verbose).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doRound(verbose: boolean): Promise<EnvSnapshot> {
    const results = await Promise.all(this.defs.map((d) => this.probeOne(d)));
    for (const r of results) {
      const prev = this.probes.get(r.upstream);
      this.probes.set(r.upstream, r);
      const changed =
        prev === undefined || prev.ok !== r.ok || prev.versionFingerprint !== r.versionFingerprint;
      if (verbose || changed)
        this.emit('env.probe', {
          upstream: r.upstream,
          ok: r.ok,
          detail: r.detail,
          versionFingerprint: r.versionFingerprint,
        });
    }
    const required = this.requiredUpstreams();
    const failing = required.filter((u) => this.probes.get(u)?.ok !== true);
    const ready = failing.length === 0;
    const flipped = this.readyState !== ready;
    this.readyState = ready;
    if (verbose || flipped) {
      if (ready) this.emit('env.ready', { upstreams: required });
      else
        this.emit('env.degraded', {
          upstreams: failing,
          reasons: Object.fromEntries(
            failing.map((u) => [u, this.probes.get(u)?.detail ?? 'not probed']),
          ),
        });
    }
    for (const r of results) {
      if (r.versionFingerprint === null) continue;
      const previous = this.lastFp.get(r.upstream) ?? null;
      if (verbose || previous !== r.versionFingerprint)
        this.emit('env.fingerprint', {
          upstream: r.upstream,
          fingerprint: r.versionFingerprint,
          previous,
          changed: previous !== null && previous !== r.versionFingerprint,
        });
      this.lastFp.set(r.upstream, r.versionFingerprint);
    }
    if (ready && flipped && this.o.onReady) {
      try {
        await this.o.onReady();
      } catch {
        // a failed gateway refresh keeps its last allowlist (ADR-66); the next flip retries
      }
    }
    return this.snapshot();
  }

  private async probeOne(def: UpstreamDef): Promise<ProbeState> {
    const t = this.now();
    const checkedAt = new Date(t).toISOString();
    if (def.profile === 'collab') {
      this.collabCalls.push(t);
    }
    const base = { upstream: def.name, checkedAt, checkedAtMs: t };
    try {
      const res = await this.o.http.fetch(
        { runId: 'env', stepKey: 'env.probe', actor: 'bff', counterpart: def.name },
        def.url,
        { method: 'GET', signal: AbortSignal.timeout(this.o.timeoutMs ?? 5000) },
      );
      const text = await res.text().catch(() => '');
      let body: unknown = null;
      try {
        body = text === '' ? null : JSON.parse(text);
      } catch {
        body = null;
      }
      const ok = statusOk(def, res.status);
      return {
        ...base,
        ok,
        detail: ok ? null : `HTTP ${res.status}`,
        versionFingerprint: this.fingerprint(def, res.status, body),
      };
    } catch (e) {
      const err = e as { name?: string; message?: string; cause?: { code?: string } };
      const detail =
        err.cause?.code ?? (err.name === 'TimeoutError' ? 'timeout' : (err.message ?? 'error'));
      return { ...base, ok: false, detail, versionFingerprint: null };
    }
  }

  private fingerprint(def: UpstreamDef, status: number, body: unknown): string | null {
    if (def.fingerprintFrom === 'collab-shape') return collabShape(status, body);
    if (def.fingerprintFrom === 'json-version') {
      const v = (body as { version?: unknown } | null)?.version;
      return typeof v === 'string' ? `${def.name}@${v}` : `${def.name}@unknown`;
    }
    if (def.image !== undefined) {
      const digest = this.o.imageDigests?.[def.image];
      const name = def.image.replace(/#.*$/, '');
      return digest ? `${name}@${digest.slice(0, 19)}` : name;
    }
    return `${def.name}@local-build`;
  }

  /** upstreams that decide `ready`: the default profile of the mode (core + local, or core + Collab) */
  private requiredUpstreams(): string[] {
    const want = this.o.mode === 'collab' ? ['core', 'collab'] : ['core', 'local'];
    return this.defs.filter((d) => want.includes(d.profile)).map((d) => d.name);
  }

  // ---------- views ----------
  private probedEntry(id: AdapterId): { availability: Availability; probedAt: Iso | null } | null {
    const ups = ADAPTER_UPSTREAMS[id];
    if (catalogEntry(id).envClass === 'collab' && this.o.mode !== 'collab')
      return {
        availability: {
          available: false,
          reason: 'Collab mode is off (PLAYGROUND_MODE=local)',
          versionFingerprint: 'collab:off',
        },
        probedAt: null,
      };
    if (ups.length === 0)
      return {
        availability: {
          available: true,
          versionFingerprint: inProcessFingerprint(id, this.o.bffVersion),
        },
        probedAt: null,
      };
    const states = ups.map((u) => this.probes.get(u));
    if (states.some((s) => s === undefined)) return null;
    const list = states as ProbeState[];
    const bad = list.find((s) => !s.ok);
    const fp = list.map((s) => s.versionFingerprint ?? `${s.upstream}@unknown`).join(' + ');
    const probedAt = new Date(Math.max(...list.map((s) => s.checkedAtMs))).toISOString();
    return {
      availability: bad
        ? {
            available: false,
            reason: `${bad.upstream}: ${bad.detail ?? 'probe failed'}`,
            versionFingerprint: fp,
          }
        : { available: true, versionFingerprint: fp },
      probedAt,
    };
  }

  /** API-02 view */
  entry(id: AdapterId): { availability: Availability; probedAt: Iso | null } | null {
    return this.probedEntry(id);
  }

  /** ResolveEnv: null = never probed (resolution treats it as available) */
  availability(id: AdapterId): Availability | null {
    return this.probedEntry(id)?.availability ?? null;
  }

  tunnel(): { up: boolean; host: string | null } {
    const t = this.currentTunnel();
    return t.state === 'up' ? { up: true, host: t.host } : { up: false, host: null };
  }

  /** every adapter of 02 §5.3 (API-01 summary) */
  adapterSummary(): { id: AdapterId; available: boolean; reason: string | null }[] {
    return ADAPTER_IDS.map((id) => {
      const a = this.availability(id);
      return {
        id,
        available: a?.available ?? false,
        reason: a === null ? 'not probed yet' : (a.reason ?? null),
      };
    });
  }

  ready(): boolean {
    return this.readyState === true;
  }

  snapshot(): EnvSnapshot {
    const t = this.now();
    while (this.collabCalls.length > 0 && (this.collabCalls[0] ?? 0) <= t - 60_000)
      this.collabCalls.shift();
    return {
      mode: this.o.mode === 'collab' ? 'collab' : 'full-local',
      ready: this.readyState === true,
      upstreams: this.defs
        .map((d) => this.probes.get(d.name))
        .filter((p): p is ProbeState => p !== undefined)
        .map(({ checkedAtMs: _ms, ...p }) => p),
      tunnel: this.currentTunnel(),
      collabBudget: { windowS: 60, limit: 20, used: this.collabCalls.length },
      publicHost: this.o.publicHost,
    };
  }

  // ---------- tunnel (API-12) ----------
  private currentTunnel(): EnvSnapshot['tunnel'] {
    const t = this.tunnelState;
    if (t.state === 'up' && Date.parse(t.expiresAt) <= this.now()) {
      this.tunnelState = { state: 'down' };
      this.emit('env.tunnel', { state: 'down' });
    }
    return this.tunnelState;
  }

  registerTunnel(body: unknown): EnvSnapshot {
    const reg = validateTunnel(body);
    const current = this.currentTunnel();
    if (reg.state === 'down') {
      if (current.state === 'up') {
        this.tunnelState = { state: 'down' };
        this.emit('env.tunnel', { state: 'down' });
      }
      return this.snapshot();
    }
    const host = (reg.host as string).toLowerCase();
    if (current.state === 'up' && current.host !== host)
      throw new ApiError(
        'conflict',
        'Another tunnel host is registered; register state down first.',
        {
          host: current.host,
        },
      );
    const t = this.now();
    const expiresAt = new Date(t + (reg.ttlSeconds ?? DEFAULT_TTL_S) * 1000).toISOString();
    const since = current.state === 'up' ? current.since : new Date(t).toISOString();
    this.tunnelState = { state: 'up', host, since, expiresAt };
    this.emit('env.tunnel', { state: 'up', host, expiresAt });
    return this.snapshot();
  }

  private emit<T extends EnvType>(type: T, payload: PayloadMap[T]): void {
    this.o.sink?.appendEnv(type, payload);
  }
}

function validateTunnel(body: unknown): TunnelRegistration {
  const issues: { path: string; message: string }[] = [];
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    throw new ApiError(
      'validation_failed',
      undefined,
      issueDetails([{ path: '$', message: 'must be an object' }]),
    );
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b))
    if (!['state', 'host', 'ttlSeconds'].includes(k))
      issues.push({ path: `$.${k}`, message: 'unknown field' });
  if (b.state !== 'up' && b.state !== 'down')
    issues.push({ path: '$.state', message: 'one of up, down' });
  if (b.state === 'up' && (typeof b.host !== 'string' || !HOST_RE.test(b.host)))
    issues.push({
      path: '$.host',
      message: 'a DNS host name (no scheme, no port) is required when up',
    });
  if (
    b.ttlSeconds !== undefined &&
    (typeof b.ttlSeconds !== 'number' ||
      !Number.isInteger(b.ttlSeconds) ||
      b.ttlSeconds < 1 ||
      b.ttlSeconds > MAX_TTL_S)
  )
    issues.push({ path: '$.ttlSeconds', message: `integer 1..${MAX_TTL_S}` });
  if (issues.length > 0) throw new ApiError('validation_failed', undefined, issueDetails(issues));
  return b as unknown as TunnelRegistration;
}
