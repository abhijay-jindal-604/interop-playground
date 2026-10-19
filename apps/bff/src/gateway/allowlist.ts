/**
 * Gateway allowlists (02 §2.3 M1..M4, §6.3 hard deny, 04 §8.2 API-71 rule labels; ADR-66).
 *
 * Order of a decision: path normalisation (a path that cannot be normalised is denied by default)
 * → hard deny (wins over any allow) → exact path routes (443) → relay (8443) → allow rules.
 * M1 listeners derive their allow rules from the endpoints the upstream advertises in its
 * well-known documents, loaded at start, again on `refresh()` (after `env.ready`) and lazily
 * while a listener has never loaded (the upstream may start after the BFF).
 */
import { GLOBAL_HARD_DENY } from './listeners.js';
import type { ListenerSpec, PathRoute, StaticRule } from './listeners.js';

export type Decision =
  | { kind: 'forward'; upstream: string; counterpart: string }
  | { kind: 'relay'; runId: string }
  | { kind: 'deny'; rule: string };

/** metadata fetcher: GET `<upstream><path>` → parsed JSON, or null when not 200/JSON */
export type MetadataFetch = (upstream: string, path: string) => Promise<unknown>;

/** advertised endpoint keys and the method a wallet / client uses on them */
const ENDPOINT_METHODS: Record<string, readonly string[]> = {
  token_endpoint: ['POST'],
  credential_endpoint: ['POST'],
  nonce_endpoint: ['POST'],
  deferred_credential_endpoint: ['POST'],
  notification_endpoint: ['POST'],
  batch_credential_endpoint: ['POST'],
  pushed_authorization_request_endpoint: ['POST'],
  interactive_authorization_endpoint: ['POST'],
  authorization_endpoint: ['GET'],
  jwks_uri: ['GET'],
  status_list_endpoint: ['GET'],
  status_list_aggregation_endpoint: ['GET'],
};
const WELL_KNOWN_GET =
  /(^|\/)\.well-known\/(openid-credential-issuer|oauth-authorization-server|openid-configuration|jwks\.json|did\.json)(\/[A-Za-z0-9_.-]+)?$/;
/** reload a listener that has never loaded at most this often (ms) */
const LAZY_RETRY_MS = 5000;

/**
 * Decodes percent-escapes and collapses repeated slashes so `/v1/certify//%61ctuator` cannot
 * slip past a hard-deny pattern. Returns null for dot segments, NUL, encoded slashes or bad
 * escapes: those are never forwarded (default deny).
 */
export function normalisePath(rawPath: string): string | null {
  const q = rawPath.indexOf('?');
  const p = q >= 0 ? rawPath.slice(0, q) : rawPath;
  if (!p.startsWith('/')) return null;
  if (/%2f|%5c|%00/i.test(p)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    return null;
  }
  if (decoded.includes('\\') || decoded.includes('\u0000')) return null;
  const collapsed = decoded.replace(/\/{2,}/g, '/');
  if (collapsed.split('/').some((s) => s === '.' || s === '..')) return null;
  return collapsed;
}

function prefixPattern(p: string): RegExp {
  const esc = p
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^]*');
  return new RegExp(`^${esc}${p.endsWith('*') ? '' : '(/|$)'}`, 'i');
}

/** the 02 §6.3 hard-deny rule that matches, as `hard-deny:<pattern>` */
export function hardDenyRule(l: ListenerSpec, path: string): string | null {
  for (const g of GLOBAL_HARD_DENY) if (g.re.test(path)) return `hard-deny:${g.label}`;
  for (const p of l.hardDeny ?? []) if (prefixPattern(p).test(path)) return `hard-deny:${p}`;
  return null;
}

function methodOk(rule: StaticRule, method: string): boolean {
  return rule.methods === '*' || rule.methods.includes(method);
}

/** advertised endpoints of one metadata document whose URL points at this listener's port */
export function advertisedRules(doc: unknown, listenerPort: number): StaticRule[] {
  const out: StaticRule[] = [];
  const visit = (v: unknown): void => {
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const methods = ENDPOINT_METHODS[k];
      if (methods && typeof val === 'string') {
        let u: URL;
        try {
          u = new URL(val);
        } catch {
          continue;
        }
        const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
        if (port !== listenerPort) continue;
        const path = normalisePath(u.pathname);
        if (path === null) continue;
        out.push({
          methods,
          pattern: new RegExp(`^${path.replace(/[.+?^${}()|[\]\\]/g, '\\$&')}$`),
        });
      } else if (typeof val === 'object') {
        visit(val);
      }
    }
  };
  visit(doc);
  return out;
}

interface Loaded {
  rules: StaticRule[];
  loadedAt: number | null;
  lastTry: number;
}

export class Allowlists {
  private readonly loaded = new Map<number, Loaded>();
  private readonly activeRoutes: (r: PathRoute) => boolean;

  constructor(
    private readonly listeners: readonly ListenerSpec[],
    private readonly fetchMeta: MetadataFetch,
    private readonly now: () => number = Date.now,
    opts: { routeActive?: (r: PathRoute) => boolean } = {},
  ) {
    this.activeRoutes = opts.routeActive ?? (() => true);
  }

  /** (re)loads every M1 listener's advertised endpoints; a failed load keeps the previous list */
  async refresh(ports?: readonly number[]): Promise<void> {
    const targets = this.listeners.filter(
      (l) => l.allow === 'M1' && (!ports || ports.includes(l.port)),
    );
    await Promise.all(targets.map((l) => this.load(l)));
  }

  /** true once the listener's metadata answered at least once */
  isLoaded(port: number): boolean {
    return (this.loaded.get(port)?.loadedAt ?? null) !== null;
  }

  private async load(l: ListenerSpec): Promise<void> {
    const prev = this.loaded.get(l.port);
    const entry: Loaded = prev ?? { rules: [], loadedAt: null, lastTry: 0 };
    entry.lastTry = this.now();
    this.loaded.set(l.port, entry);
    const docs = await Promise.all(
      (l.metadata ?? []).map((p) => this.fetchMeta(l.upstream, p).catch(() => null)),
    );
    const got = docs.filter((d) => d !== null && typeof d === 'object');
    if (got.length === 0) return;
    entry.rules = got.flatMap((d) => advertisedRules(d, l.port));
    entry.loadedAt = this.now();
  }

  private async m1Rules(l: ListenerSpec): Promise<StaticRule[]> {
    const e = this.loaded.get(l.port);
    if (!e || (e.loadedAt === null && this.now() - e.lastTry >= LAZY_RETRY_MS)) await this.load(l);
    return this.loaded.get(l.port)?.rules ?? [];
  }

  async decide(l: ListenerSpec, method: string, rawPath: string): Promise<Decision> {
    const m = method.toUpperCase();
    const defaultDeny: Decision = { kind: 'deny', rule: `allowlist:${l.allow}` };
    const path = normalisePath(rawPath);
    if (path === null) return defaultDeny;
    const hard = hardDenyRule(l, path);
    if (hard) return { kind: 'deny', rule: hard };
    for (const r of l.routes ?? []) {
      if (r.path === path && r.method === m && this.activeRoutes(r)) {
        return { kind: 'forward', upstream: r.upstream, counterpart: r.counterpart };
      }
    }
    if (l.relay) {
      const hit = l.relay.exec(path);
      if (hit?.[1] && (m === 'GET' || m === 'POST')) return { kind: 'relay', runId: hit[1] };
    }
    const forward: Decision = { kind: 'forward', upstream: l.upstream, counterpart: l.counterpart };
    if ((l.rules ?? []).some((r) => methodOk(r, m) && r.pattern.test(path))) return forward;
    if (l.allow === 'M1') {
      if ((m === 'GET' || m === 'HEAD') && WELL_KNOWN_GET.test(path)) return forward;
      const dyn = await this.m1Rules(l);
      if (dyn.some((r) => methodOk(r, m) && r.pattern.test(path))) return forward;
    }
    return defaultDeny;
  }
}
