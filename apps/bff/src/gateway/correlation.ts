/**
 * Correlation of inbound gateway traffic to runs (02 §3.3, ADR-27 b).
 *
 * A step that creates a key (pre-authorized code, offer id, access-token hash, Verify
 * `requestId`/`state`, `transactionId`, eSignet `state`, peer session ids) registers it with
 * its run. The gateway looks keys up in the request path segments, the query values, the form
 * or JSON body values and the `Authorization` header; tokens are only ever keys as SHA-256
 * (`sha256:<hex>`), never raw. A run's route table maps `{method, path}` to the stepKey; without
 * a matching route the key's own stepKey is used.
 */
import { createHash } from 'node:crypto';

export interface RouteEntry {
  method: string;
  pattern: RegExp;
  stepKey: string;
}

export interface Attribution {
  runId: string;
  stepKey: string;
  actor: string | null;
}

interface KeyEntry {
  runId: string;
  stepKey: string;
  actor: string | null;
}

export interface InboundProbe {
  method: string;
  /** raw request target (path + query) */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer | null;
}

export function tokenKey(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

const MIN_KEY = 8;

function bodyValues(body: Buffer | null, contentType: string): string[] {
  if (!body || body.length === 0 || body.length > 256 * 1024) return [];
  const text = body.toString('utf8');
  if (/application\/x-www-form-urlencoded/i.test(contentType)) {
    return [...new URLSearchParams(text).values()];
  }
  if (/json/i.test(contentType)) {
    try {
      const v = JSON.parse(text) as unknown;
      const out: string[] = [];
      const walk = (x: unknown, depth: number): void => {
        if (depth > 3) return;
        if (typeof x === 'string') out.push(x);
        else if (Array.isArray(x)) x.forEach((y) => walk(y, depth + 1));
        else if (x && typeof x === 'object') Object.values(x).forEach((y) => walk(y, depth + 1));
      };
      walk(v, 0);
      return out;
    } catch {
      return [];
    }
  }
  return [];
}

export class CorrelationIndex {
  private readonly keys = new Map<string, KeyEntry>();
  private readonly byRun = new Map<string, Set<string>>();
  private readonly routes = new Map<string, RouteEntry[]>();

  /** registers a raw key (ids, codes, state); use `tokenKey()` for bearer tokens */
  register(runId: string, key: string, stepKey: string, actor: string | null = null): void {
    if (key.length < MIN_KEY) throw new Error('correlation keys must have at least 8 characters');
    this.keys.set(key, { runId, stepKey, actor });
    let s = this.byRun.get(runId);
    if (!s) this.byRun.set(runId, (s = new Set()));
    s.add(key);
  }

  registerToken(runId: string, token: string, stepKey: string, actor: string | null = null): void {
    this.register(runId, tokenKey(token), stepKey, actor);
  }

  setRoutes(runId: string, table: RouteEntry[]): void {
    this.routes.set(runId, table);
  }

  /** at the run's terminal event */
  dropRun(runId: string): void {
    for (const k of this.byRun.get(runId) ?? []) this.keys.delete(k);
    this.byRun.delete(runId);
    this.routes.delete(runId);
  }

  get size(): number {
    return this.keys.size;
  }

  resolve(p: InboundProbe): Attribution | null {
    if (this.keys.size === 0) return null;
    const u = new URL(p.url, 'http://gateway.invalid');
    const candidates: string[] = [];
    for (const seg of u.pathname.split('/')) {
      if (seg.length >= MIN_KEY) candidates.push(safeDecode(seg));
    }
    for (const v of u.searchParams.values()) candidates.push(v);
    const ct = headerValue(p.headers['content-type']);
    candidates.push(...bodyValues(p.body, ct));
    const auth = headerValue(p.headers.authorization);
    const m = /^(?:Bearer|DPoP)\s+(.+)$/i.exec(auth.trim());
    if (m?.[1]) candidates.unshift(tokenKey(m[1]));
    for (const c of candidates) {
      const hit = this.keys.get(c);
      if (!hit) continue;
      const table = this.routes.get(hit.runId) ?? [];
      const method = p.method.toUpperCase();
      const route = table.find((r) => r.method === method && r.pattern.test(u.pathname));
      return { runId: hit.runId, stepKey: route?.stepKey ?? hit.stepKey, actor: hit.actor };
    }
    return null;
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function headerValue(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}
