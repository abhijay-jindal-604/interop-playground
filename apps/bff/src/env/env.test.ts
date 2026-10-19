/**
 * T-12 acceptance (plan/12), fake probes, no Docker:
 *  - every adapter of 02 §5.3 gets an availability once probed (API-02 view; API-10 lists upstreams)
 *  - a failing `verify-service` probe flips its adapters within one probe interval and emits `env`
 *    events; recovery emits `env.ready` and calls `onReady` (the gateway's `refresh()`)
 *  - component versions recorded for `run_versions` (`RunSpec.versions`)
 *  - API-11 1 per 5 s; API-12 loopback + `X-Admin-Token`
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import { ADAPTER_IDS } from '@interop-playground/adapters';
import type { CapturingHttp } from '@interop-playground/adapters';
import type {
  AdapterListResponse,
  EnvSnapshot,
  ErrorEnvelope,
  PayloadMap,
  PreviewResponse,
} from '@interop-playground/api';
import { REPO_ROOT } from '../config/index.js';
import { createServer } from '../server.js';
import { openStore } from '../store/index.js';
import { ADAPTER_UPSTREAMS, EnvManager, UPSTREAMS } from './index.js';
import type { EnvManagerOptions } from './index.js';

const H = { host: '127.0.0.1:3100' };
const POST = { ...H, origin: 'http://127.0.0.1:3100', 'content-type': 'application/json' };
const DIGEST = 'sha256:0123456789abcdef0123456789abcdef';
const schema = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'packages', 'api', 'api.schema.json'), 'utf8'),
) as Record<string, unknown>;
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema({ $id: 'api', ...schema });

type Ev = { type: string; payload: unknown };

/** answers every upstream with 200 `{}` unless listed in `down` */
function fakeHttp(down: Set<string>, calls: string[] = []): CapturingHttp {
  return {
    fetch: (_ctx, url) => {
      const u = String(url);
      calls.push(u);
      const def = UPSTREAMS.find((d) => d.url === u);
      if (def !== undefined && down.has(def.name))
        return Promise.resolve(new Response('down', { status: 503 }));
      const status = def?.expect === 404 ? 404 : 200;
      const body = def?.name === 'sidecar' ? '{"version":"0.3.1"}' : '{}';
      return Promise.resolve(new Response(body, { status }));
    },
    closePoll: () => Promise.resolve(),
  };
}

function harness(over: Partial<EnvManagerOptions> = {}) {
  const down = new Set<string>();
  const events: Ev[] = [];
  const pending: { fn: () => void; ms: number }[] = [];
  let clock = Date.parse('2026-10-19T10:00:00.000Z');
  let readyCalls = 0;
  const env = new EnvManager({
    http: fakeHttp(down),
    sink: {
      appendEnv: <T extends keyof PayloadMap>(type: T, payload: PayloadMap[T]) =>
        events.push({ type, payload }),
    },
    mode: 'local',
    publicHost: 'playground.local',
    bffVersion: '0.0.0',
    imageDigests: { 'injistack/inji-verify-service:1.0.0-alpha.1': DIGEST },
    intervalMs: 30_000,
    now: () => clock,
    timers: {
      set: (fn, ms) => {
        const h = { fn, ms };
        pending.push(h);
        return h;
      },
      clear: (h) => {
        const i = pending.indexOf(h as (typeof pending)[number]);
        if (i >= 0) pending.splice(i, 1);
      },
    },
    onReady: () => {
      readyCalls += 1;
    },
    ...over,
  });
  /** fires the next scheduled tick and waits for its round */
  const tick = async (): Promise<number> => {
    const h = pending.shift();
    if (h === undefined) throw new Error('nothing scheduled');
    clock += h.ms;
    h.fn();
    await env.probeRound(false);
    await new Promise((r) => setImmediate(r));
    return h.ms;
  };
  return {
    env,
    down,
    events,
    pending,
    tick,
    advance: (ms: number) => {
      clock += ms;
    },
    readyCalls: () => readyCalls,
  };
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

async function server(env: EnvManager, adminToken: string | null = 'secret-admin-token') {
  const store = openStore(':memory:');
  const app = await createServer({
    config: {
      flowsDir: path.join(REPO_ROOT, 'flows'),
      fingerprintsDir: path.join(REPO_ROOT, 'no-fingerprints-here'),
      uiDistDir: path.join(REPO_ROOT, 'no-ui'),
    },
    probeSidecar: () => Promise.resolve({ reachable: true, version: 't' }),
    store,
    env,
    adminToken: () => adminToken,
  });
  cleanup.push(async () => {
    await app.close();
    store.close();
  });
  return app;
}

describe('env.manager (T-12)', () => {
  it('every 02 §5.3 adapter has an upstream mapping; every mapped upstream is probed', () => {
    expect(Object.keys(ADAPTER_UPSTREAMS).sort()).toEqual([...ADAPTER_IDS].sort());
    const names = new Set(UPSTREAMS.map((u) => u.name));
    for (const ups of Object.values(ADAPTER_UPSTREAMS))
      for (const u of ups) expect(names).toContain(u);
  });

  it('a probe round gives every adapter an availability and emits env.ready once', async () => {
    const h = harness();
    expect(h.env.availability('verifier.inji-verify-local')).toBeNull();
    h.env.start();
    expect(await h.tick()).toBe(0);
    for (const id of ADAPTER_IDS) expect(h.env.availability(id), id).not.toBeNull();
    expect(h.env.availability('verifier.inji-verify-local')).toEqual({
      available: true,
      versionFingerprint: `injistack/inji-verify-service:1.0.0-alpha.1@${DIGEST.slice(0, 19)}`,
    });
    expect(h.env.availability('issuer.certify-collab')).toMatchObject({
      available: false,
    });
    expect(h.env.availability('issuer.certify-collab')?.reason).toMatch(/Collab mode is off/);
    expect(h.env.availability('wallet.inji-jvm')?.versionFingerprint).toBe('sidecar@0.3.1');
    expect(h.env.ready()).toBe(true);
    expect(h.events.filter((e) => e.type === 'env.ready')).toHaveLength(1);
    expect(h.readyCalls()).toBe(1);
    // the loop is rescheduled at the probe interval
    expect(h.pending.map((p) => p.ms)).toEqual([30_000]);
    h.env.stop();
    expect(h.pending).toHaveLength(0);
  });

  it('a failing verify-service flips its adapters within one interval and emits env events', async () => {
    const h = harness();
    h.env.start();
    await h.tick();
    h.events.length = 0;
    h.down.add('verify-service');
    expect(await h.tick()).toBe(30_000);
    for (const id of ['verifier.inji-verify-local', 'verifier.inji-verify-sdk'] as const)
      expect(h.env.availability(id)).toMatchObject({
        available: false,
        reason: 'verify-service: HTTP 503',
      });
    expect(h.env.availability('issuer.certify-preauth')?.available).toBe(true);
    expect(h.events.map((e) => e.type)).toEqual(['env.probe', 'env.degraded']);
    expect(h.events[0]?.payload).toMatchObject({ upstream: 'verify-service', ok: false });
    expect(h.events[1]?.payload).toEqual({
      upstreams: ['verify-service'],
      reasons: { 'verify-service': 'HTTP 503' },
    });
    for (const e of h.events)
      expect(
        ajv.getSchema(`api#/definitions/Event.${e.type}`)?.({
          v: 1,
          runId: 'env',
          seq: 1,
          ts: '2026-10-19T10:00:00.000Z',
          type: e.type,
          payload: e.payload,
        }),
        e.type,
      ).toBe(true);
    // recovery: env.ready again and the gateway refresh callback
    h.down.delete('verify-service');
    await h.tick();
    expect(h.env.availability('verifier.inji-verify-local')?.available).toBe(true);
    expect(h.events.at(-1)?.type).toBe('env.ready');
    expect(h.readyCalls()).toBe(2);
  });

  it('a network error marks the upstream down with its cause', async () => {
    const h = harness({
      http: {
        fetch: () =>
          Promise.reject(
            Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
          ),
        closePoll: () => Promise.resolve(),
      },
    });
    await h.env.probeRound(false);
    expect(h.env.availability('issuer.certify-preauth')).toMatchObject({
      available: false,
      reason: 'certify-preauth: ECONNREFUSED',
    });
    expect(h.env.snapshot().ready).toBe(false);
  });

  it('fingerprint changes are reported with the previous value', async () => {
    let version = '0.3.1';
    const base = fakeHttp(new Set());
    const h = harness({
      http: {
        fetch: (ctx, url, init) =>
          String(url).includes('sidecar')
            ? Promise.resolve(new Response(JSON.stringify({ version }), { status: 200 }))
            : base.fetch(ctx, url, init),
        closePoll: () => Promise.resolve(),
      },
    });
    await h.env.probeRound(false);
    version = '0.3.2';
    h.events.length = 0;
    await h.env.probeRound(false);
    expect(h.events.find((e) => e.type === 'env.fingerprint')?.payload).toEqual({
      upstream: 'sidecar',
      fingerprint: 'sidecar@0.3.2',
      previous: 'sidecar@0.3.1',
      changed: true,
    });
  });
});

describe('env.routes (API-10..12) and run_versions', () => {
  it('API-10 serves a schema-valid snapshot; API-02 shows the probed availability', async () => {
    const h = harness();
    await h.env.probeRound(false);
    const app = await server(h.env);
    const snap = await app.inject({ method: 'GET', url: '/api/v1/env', headers: H });
    expect(snap.statusCode).toBe(200);
    const body = snap.json<EnvSnapshot>();
    expect(ajv.getSchema('api#/definitions/EnvSnapshot')?.(body)).toBe(true);
    expect(body).toMatchObject({ mode: 'full-local', ready: true, tunnel: { state: 'down' } });
    expect(body.upstreams.map((u) => u.upstream)).toContain('verify-service');
    const list = (
      await app.inject({ method: 'GET', url: '/api/v1/adapters', headers: H })
    ).json<AdapterListResponse>();
    const entries = [...list.issuers, ...list.wallets, ...list.verifiers];
    expect(entries).toHaveLength(ADAPTER_IDS.length);
    const verify = entries.find((e) => e.descriptor.id === 'verifier.inji-verify-local');
    expect(verify?.availability.available).toBe(true);
    expect(verify?.probedAt).toBe('2026-10-19T10:00:00.000Z');
  });

  it('component versions land in RunSpec.versions (run_versions)', async () => {
    const h = harness();
    await h.env.probeRound(false);
    const app = await server(h.env);
    const p = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/runs/preview',
        headers: POST,
        payload: {
          issuer: 'issuer.certify-preauth',
          wallet: 'wallet.playground-ts',
          verifier: 'verifier.inji-verify-local',
          grant: 'pre-authorized_code',
          presentationMode: 'cross-device',
          format: 'dc+sd-jwt',
        },
      })
    ).json<PreviewResponse>();
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.spec.versions).toEqual({
      issuer: 'injistack/inji-certify-with-plugins:1.0.0-alpha.1 + nginx:stable',
      wallet: 'playground-ts@0.0.0',
      verifier: `injistack/inji-verify-service:1.0.0-alpha.1@${DIGEST.slice(0, 19)}`,
    });
  });

  it('API-11 re-probes now and is limited to 1 per 5 s', async () => {
    const h = harness();
    const app = await server(h.env);
    const probe = () =>
      app.inject({ method: 'POST', url: '/api/v1/env/probe', headers: POST, payload: {} });
    const first = await probe();
    expect(first.statusCode).toBe(200);
    expect(first.json<EnvSnapshot>().upstreams.length).toBeGreaterThan(0);
    // verbose: one env.probe per upstream, then env.ready, then env.fingerprint
    const types = h.events.map((e) => e.type);
    expect(types.filter((t) => t === 'env.probe')).toHaveLength(
      first.json<EnvSnapshot>().upstreams.length,
    );
    expect(types.indexOf('env.ready')).toBeGreaterThan(types.lastIndexOf('env.probe'));
    expect(types.indexOf('env.fingerprint')).toBeGreaterThan(types.indexOf('env.ready'));
    h.advance(3000);
    const limited = await probe();
    expect(limited.statusCode).toBe(429);
    expect(limited.json<ErrorEnvelope>().error.code).toBe('rate_limited');
    expect(limited.headers['retry-after']).toBe('2');
    h.advance(2000);
    expect((await probe()).statusCode).toBe(200);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/env/probe',
      headers: POST,
      payload: { x: 1 },
    });
    expect(bad.json<ErrorEnvelope>().error.code).toBe('validation_failed');
  });

  it('API-12 needs a loopback peer and the admin token; registers, conflicts and clears', async () => {
    const h = harness();
    const app = await server(h.env);
    const reg = (payload: object, headers: Record<string, string> = {}, remoteAddress?: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/internal/tunnel',
        headers: { ...POST, ...headers },
        payload,
        ...(remoteAddress ? { remoteAddress } : {}),
      });
    const up = { state: 'up', host: 'abc.trycloudflare.com' };
    expect((await reg(up)).statusCode).toBe(401);
    expect((await reg(up, { 'x-admin-token': 'wrong' })).statusCode).toBe(401);
    expect(
      (await reg(up, { 'x-admin-token': 'secret-admin-token' }, '192.168.1.84')).statusCode,
    ).toBe(401);
    const ok = await reg(up, { 'x-admin-token': 'secret-admin-token' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<EnvSnapshot>().tunnel).toEqual({
      state: 'up',
      host: 'abc.trycloudflare.com',
      since: '2026-10-19T10:00:00.000Z',
      expiresAt: '2026-10-19T10:30:00.000Z',
    });
    expect(h.env.tunnel()).toEqual({ up: true, host: 'abc.trycloudflare.com' });
    expect(h.events.at(-1)).toEqual({
      type: 'env.tunnel',
      payload: {
        state: 'up',
        host: 'abc.trycloudflare.com',
        expiresAt: '2026-10-19T10:30:00.000Z',
      },
    });
    const other = await reg(
      { state: 'up', host: 'other.example.org' },
      { 'x-admin-token': 'secret-admin-token' },
    );
    expect(other.json<ErrorEnvelope>().error.code).toBe('conflict');
    const invalid = await reg(
      { state: 'up', host: 'https://x' },
      { 'x-admin-token': 'secret-admin-token' },
    );
    expect(invalid.json<ErrorEnvelope>().error.code).toBe('validation_failed');
    const ttl = await reg({ ...up, ttlSeconds: 7201 }, { 'x-admin-token': 'secret-admin-token' });
    expect(ttl.json<ErrorEnvelope>().error.code).toBe('validation_failed');
    const downRes = await reg({ state: 'down' }, { 'x-admin-token': 'secret-admin-token' });
    expect(downRes.json<EnvSnapshot>().tunnel).toEqual({ state: 'down' });
    // expiry: a registration lapses after its TTL
    await reg({ ...up, ttlSeconds: 60 }, { 'x-admin-token': 'secret-admin-token' });
    h.advance(61_000);
    expect(h.env.tunnel()).toEqual({ up: false, host: null });
  });

  it('API-12 is unauthorized when no admin token file exists', async () => {
    const app = await server(harness().env, null);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/internal/tunnel',
      headers: { ...POST, 'x-admin-token': '' },
      payload: { state: 'down' },
    });
    expect(res.statusCode).toBe(401);
  });
});
