import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ERROR_CODES, ERROR_STATUS } from '@interop-playground/api';
import type { ErrorCode, ErrorEnvelope } from '@interop-playground/api';
import { REPO_ROOT } from './config/index.js';
import { ApiError } from './errors/index.js';
import { createServer, startServer } from './server.js';
import { StartupValidationError } from './validate/index.js';

const H = { host: '127.0.0.1:3100' };
const POST_OK = { ...H, origin: 'http://127.0.0.1:3100', 'content-type': 'application/json' };
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const tmp = mkdtempSync(path.join(tmpdir(), 'bff-server-'));
const uiDist = path.join(tmp, 'dist');
const noUi = path.join(tmp, 'no-ui');
const flowsDir = path.join(REPO_ROOT, 'flows');
const fpDir = path.join(tmp, 'fingerprints-absent');
const probeSidecar = () => Promise.resolve({ reachable: true, version: 'test' });

function expectEnvelope(body: string, code: ErrorCode, headers: Record<string, unknown>): void {
  const env = JSON.parse(body) as ErrorEnvelope;
  expect(env.error.code).toBe(code);
  expect(env.error.status).toBe(ERROR_STATUS[code]);
  expect(env.error.requestId).toMatch(ULID);
  expect(headers['x-request-id']).toBe(env.error.requestId);
  expect(env.error.retryable).toBe(ERROR_STATUS[code] === 429 || ERROR_STATUS[code] === 503);
  expect(String(headers['content-type'])).toMatch(/^application\/json/);
}

let app: FastifyInstance;
let bare: FastifyInstance;

beforeAll(async () => {
  mkdirSync(path.join(uiDist, 'assets'), { recursive: true });
  writeFileSync(path.join(uiDist, 'index.html'), '<!doctype html><title>ui</title>');
  writeFileSync(path.join(uiDist, 'assets', 'app.js'), 'console.log(1)');
  app = await createServer({
    config: { flowsDir, fingerprintsDir: fpDir, uiDistDir: uiDist },
    probeSidecar,
  });
  // test-only route that throws every error code (04 §6.2: the HTTP status per code is fixed)
  app.post<{ Params: { code: string } }>('/api/v1/__test/error/:code', (req) => {
    throw new ApiError(req.params.code as ErrorCode, undefined, { probe: true });
  });
  app.get('/api/v1/__test/crash', () => {
    throw new Error('secret stack detail');
  });
  bare = await createServer({
    config: { flowsDir, fingerprintsDir: fpDir, uiDistDir: noUi },
    probeSidecar,
  });
});
afterAll(async () => {
  await app.close();
  await bare.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('bff.server.listen', () => {
  it('listens only on 127.0.0.1:3100 by default', async () => {
    const s = await startServer({
      FLOWS_DIR: flowsDir,
      FINGERPRINTS_DIR: fpDir,
      UI_DIST_DIR: noUi,
      DATA_DIR: tmp,
      BFF_LOG_LEVEL: 'silent',
    });
    try {
      const addrs = s.addresses();
      expect(addrs).toEqual([expect.objectContaining({ address: '127.0.0.1', port: 3100 })]);
      const res = await fetch('http://127.0.0.1:3100/api/v1/health');
      expect(res.status).toBe(200);
    } finally {
      await s.close();
    }
  });
});

describe('bff.guard', () => {
  it.each([
    ['missing-host-match', { host: 'evil.example:3100' }],
    ['rebinding-host', { host: 'attacker.test' }],
    ['public-host', { host: '192.168.1.10:3100' }],
    ['wrong-port', { host: '127.0.0.1:8443' }],
  ])('GET with a bad Host (%s) is 403 request_guard_failed/host', async (_n, headers) => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health', headers });
    expect(res.statusCode).toBe(403);
    expectEnvelope(res.body, 'request_guard_failed', res.headers);
    expect((JSON.parse(res.body) as ErrorEnvelope).error.details).toEqual({ reason: 'host' });
  });

  it('accepts both loopback Host spellings on GET', async () => {
    for (const host of ['127.0.0.1:3100', 'localhost:3100']) {
      const res = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { host } });
      expect(res.statusCode).toBe(200);
    }
  });

  it.each([
    ['no Origin', { ...H, 'content-type': 'application/json' }],
    ['foreign Origin', { ...H, origin: 'http://evil.example', 'content-type': 'application/json' }],
    [
      'other loopback Origin',
      { ...H, origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' },
    ],
    [
      'https Origin',
      { ...H, origin: 'https://127.0.0.1:3100', 'content-type': 'application/json' },
    ],
    ['null Origin', { ...H, origin: 'null', 'content-type': 'application/json' }],
  ])('non-GET with %s is 403 request_guard_failed/origin', async (_n, headers) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs', headers, payload: '{}' });
    expect(res.statusCode).toBe(403);
    expectEnvelope(res.body, 'request_guard_failed', res.headers);
    expect((JSON.parse(res.body) as ErrorEnvelope).error.details).toEqual({ reason: 'origin' });
  });

  it('checks Host before Origin on non-GET', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/runs/x',
      headers: { host: 'evil:3100', origin: 'http://evil:3100' },
    });
    expect(res.statusCode).toBe(403);
    expect((JSON.parse(res.body) as ErrorEnvelope).error.details).toEqual({ reason: 'host' });
  });

  it('non-GET without JSON content type is 415 unsupported_media_type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      headers: { ...H, origin: 'http://127.0.0.1:3100', 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(res.statusCode).toBe(415);
    expectEnvelope(res.body, 'unsupported_media_type', res.headers);
  });

  it('a body above 1 MiB is 413 payload_too_large', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/__test/error/conflict',
      headers: POST_OK,
      payload: JSON.stringify({ x: 'a'.repeat(1024 * 1024 + 10) }),
    });
    expect(res.statusCode).toBe(413);
    expectEnvelope(res.body, 'payload_too_large', res.headers);
  });

  it('malformed JSON is 400 validation_failed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/__test/error/conflict',
      headers: POST_OK,
      payload: '{nope',
    });
    expect(res.statusCode).toBe(400);
    expectEnvelope(res.body, 'validation_failed', res.headers);
  });
});

describe('bff.errors', () => {
  it('covers all 40 codes of 04 §6.2', () => {
    expect(ERROR_CODES).toHaveLength(40);
  });

  it.each(ERROR_CODES.map((c) => [c, ERROR_STATUS[c]] as const))(
    '%s answers HTTP %i with the envelope',
    async (code, status) => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/__test/error/${code}`,
        headers: POST_OK,
        payload: '{}',
      });
      expect(res.statusCode).toBe(status);
      expectEnvelope(res.body, code, res.headers);
      const env = JSON.parse(res.body) as ErrorEnvelope;
      expect(env.error.details).toEqual({ probe: true });
      if (['rate_limited', 'queue_full', 'env_not_ready'].includes(code))
        expect(res.headers['retry-after']).toMatch(/^\d+$/);
      else expect(res.headers['retry-after']).toBeUndefined();
    },
  );

  it('unknown routes are 404 not_found', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope', headers: H });
    expect(res.statusCode).toBe(404);
    expectEnvelope(res.body, 'not_found', res.headers);
  });

  it('a thrown exception is 500 internal_error without the exception text', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/__test/crash', headers: H });
    expect(res.statusCode).toBe(500);
    expectEnvelope(res.body, 'internal_error', res.headers);
    expect(res.body).not.toContain('secret stack detail');
  });

  it('every response carries X-Request-Id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health', headers: H });
    expect(res.headers['x-request-id']).toMatch(ULID);
  });
});

describe('bff.routes', () => {
  it('API-01 health reports the sidecar', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health', headers: H });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ok',
      sidecar: { reachable: true, version: 'test' },
    });
  });

  it('API-01 lists every adapter from the env manager (G-143)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health', headers: H });
    const adapters = res.json<{
      adapters: { id: string; available: boolean; reason: string | null }[];
    }>().adapters;
    expect(adapters.length).toBe(18);
    expect(adapters.find((a) => a.id === 'issuer.certify-preauth')).toEqual({
      id: 'issuer.certify-preauth',
      available: false,
      reason: 'not probed yet',
    });
  });

  it('API-01 is degraded, still 200, without the sidecar', async () => {
    const s = await createServer({
      config: { flowsDir, fingerprintsDir: fpDir, uiDistDir: noUi },
      probeSidecar: () => Promise.reject(new Error('down')),
    });
    const res = await s.inject({ method: 'GET', url: '/api/v1/health', headers: H });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'degraded', sidecar: { reachable: false } });
    await s.close();
  });

  it('API-05/06 serve the validated flows', async () => {
    const idx = await app.inject({ method: 'GET', url: '/api/v1/flows?kind=issuance', headers: H });
    const ids = idx.json<{ flows: { flowId: string }[] }>().flows.map((f) => f.flowId);
    expect(ids).toEqual(['FLOW-01', 'FLOW-04']);
    const one = await app.inject({ method: 'GET', url: '/api/v1/flows/FLOW-30', headers: H });
    expect(one.json()).toMatchObject({ flowId: 'FLOW-30', kind: 'presentation' });
    const missing = await app.inject({ method: 'GET', url: '/api/v1/flows/FLOW-99', headers: H });
    expectEnvelope(missing.body, 'not_found', missing.headers);
    const bad = await app.inject({ method: 'GET', url: '/api/v1/flows?typo=1', headers: H });
    expectEnvelope(bad.body, 'validation_failed', bad.headers);
  });
});

describe('bff.static', () => {
  it('serves the built SPA, its assets and deep links', async () => {
    const root = await app.inject({ method: 'GET', url: '/', headers: H });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('<title>ui</title>');
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js', headers: H });
    expect(asset.statusCode).toBe(200);
    const deep = await app.inject({ method: 'GET', url: '/runs/01ABC', headers: H });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('<title>ui</title>');
    const missingAsset = await app.inject({ method: 'GET', url: '/assets/nope.js', headers: H });
    expectEnvelope(missingAsset.body, 'not_found', missingAsset.headers);
  });

  it('answers a 404 envelope when no UI is built', async () => {
    const res = await bare.inject({ method: 'GET', url: '/', headers: H });
    expect(res.statusCode).toBe(404);
    expectEnvelope(res.body, 'not_found', res.headers);
  });

  it('the guard also covers static files', async () => {
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: 'evil:3100' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('bff.startup-validators', () => {
  it('refuses to start on a broken flow file', async () => {
    const dir = path.join(tmp, 'flows-broken');
    mkdirSync(dir, { recursive: true });
    copyFileSync(path.join(flowsDir, 'FLOW-01.json'), path.join(dir, 'FLOW-01.json'));
    writeFileSync(path.join(dir, 'FLOW-30.json'), JSON.stringify({ flowId: 'FLOW-30', kind: 'x' }));
    await expect(
      createServer({ config: { flowsDir: dir, fingerprintsDir: fpDir, uiDistDir: noUi } }),
    ).rejects.toBeInstanceOf(StartupValidationError);
  });

  it('refuses to start on a broken fingerprint file, accepts an empty dir', async () => {
    const dir = path.join(tmp, 'fp');
    mkdirSync(dir, { recursive: true });
    const ok = await createServer({ config: { flowsDir, fingerprintsDir: dir, uiDistDir: noUi } });
    await ok.close();
    writeFileSync(path.join(dir, 'FP-01.json'), JSON.stringify({ id: 'FP-02' }));
    await expect(
      createServer({ config: { flowsDir, fingerprintsDir: dir, uiDistDir: noUi } }),
    ).rejects.toThrow(/FP-01\.json/);
  });
});
