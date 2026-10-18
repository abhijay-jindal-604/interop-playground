import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import type { CliIo } from './cli.js';
import { GUEST_SMOKE_GATEWAY_MISSING } from './config/bringup.js';

const tmp = mkdtempSync(path.join(tmpdir(), 'cli-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type Handler = (url: string, init: RequestInit | undefined) => Response | undefined;
interface Call {
  method: string;
  url: string;
  body: string | undefined;
}

function fake(handlers: Handler[]): { io: CliIo; calls: Call[]; out: string[]; err: string[] } {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: {
      PUBLIC_HOST: '192.0.2.7',
      ESIGNET_CLIENT_KEY: path.join(tmp, `k-${Math.random()}.pem`),
    },
    http: (url, init) => {
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body as string | undefined });
      for (const h of handlers) {
        const r = h(url, init);
        if (r !== undefined) return Promise.resolve(r);
      }
      return Promise.resolve(new Response('nope', { status: 599 }));
    },
  };
  return { io, calls, out, err };
}

const ok = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers });
const csrf: Handler = (u) =>
  u.endsWith('/v1/esignet/csrf/token')
    ? ok({ token: 'T' }, { 'set-cookie': 'XSRF-TOKEN=T; Path=/' })
    : undefined;
const personas: Handler = (u) =>
  u.endsWith('/v1/mock-identity-system/identity')
    ? ok({ response: { status: 'ok' }, errors: [] })
    : undefined;

describe('bff.cli', () => {
  it('prints usage and exits 2 for unknown commands', async () => {
    const f = fake([]);
    expect(await runCli(['nope'], f.io)).toBe(2);
    expect(await runCli([], f.io)).toBe(2);
  });

  it('esignet-onboard creates the client with the key on disk and both personas', async () => {
    const f = fake([
      csrf,
      personas,
      (u, i) =>
        u.endsWith('/client-mgmt/client') && i?.method === 'POST'
          ? ok({ response: {}, errors: [] })
          : undefined,
    ]);
    expect(await runCli(['esignet-onboard'], f.io)).toBe(0);
    const keyPath = f.io.env.ESIGNET_CLIENT_KEY ?? '';
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    const create = f.calls.find((c) => c.url.endsWith('/client-mgmt/client'));
    const req = (JSON.parse(create?.body ?? '{}') as { request: Record<string, unknown> }).request;
    expect(req.clientId).toBe('playground-mimoto');
    expect(req.redirectUris).toContain('http://192.0.2.7:3004/redirect');
    expect((req.publicKey as { kty: string }).kty).toBe('RSA');
    expect(f.calls.filter((c) => c.url.endsWith('/identity'))).toHaveLength(2);
    // second run: duplicate -> update, same key file (never a new key, S-150)
    const before = statSync(keyPath).mtimeMs;
    const g = fake([
      csrf,
      personas,
      (u, i) =>
        u.endsWith('/client-mgmt/client') && i?.method === 'POST'
          ? ok({ errors: [{ errorCode: 'duplicate_client_id', message: 'exists' }] })
          : undefined,
      (u, i) =>
        u.endsWith('/client-mgmt/client/playground-mimoto') && i?.method === 'PUT'
          ? ok({ errors: [] })
          : undefined,
    ]);
    g.io.env.ESIGNET_CLIENT_KEY = keyPath;
    expect(await runCli(['esignet-onboard'], g.io)).toBe(0);
    expect(statSync(keyPath).mtimeMs).toBe(before);
    expect(g.out.join('\n')).toMatch(/existed, updated/);
  });

  it('esignet-onboard fails on an eSignet error', async () => {
    const f = fake([
      csrf,
      (u) =>
        u.endsWith('/client-mgmt/client')
          ? ok({ errors: [{ errorCode: 'invalid_public_key' }] })
          : undefined,
    ]);
    expect(await runCli(['esignet-onboard'], f.io)).toBe(1);
  });

  it('certify-didurl re-applies a wrong didUrl and leaves a right one', async () => {
    const f = fake([
      (u, i) =>
        u.includes('certify-preauth') && (i?.method ?? 'GET') === 'GET'
          ? ok({ credentialConfigKeyId: 'FarmerCredential', didUrl: 'did:web:192.0.2.7' })
          : undefined,
      (u, i) =>
        u.includes('certify-authcode') && (i?.method ?? 'GET') === 'GET'
          ? ok({ credentialConfigKeyId: 'FarmerCredential', didUrl: 'did:web:dead.ngrok.app' })
          : undefined,
      (u, i) => (i?.method === 'PUT' ? ok({}) : undefined),
    ]);
    expect(await runCli(['certify-didurl'], f.io)).toBe(0);
    const puts = f.calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0]?.url).toContain('certify-authcode');
    expect(JSON.parse(puts[0]?.body ?? '{}')).toMatchObject({
      didUrl: 'did:web:192.0.2.7:authcode',
    });
  });

  const esignetFlow: Handler[] = [
    csrf,
    (u) =>
      u === 'http://192.0.2.7:8093/.well-known/openid-credential-issuer' ? ok({}) : undefined,
    (u) =>
      u.includes('/issuers/PlaygroundFarmer/configuration')
        ? ok({ authorization_endpoint: 'x' })
        : undefined,
    (u) =>
      u.endsWith('/v3/oauth-details')
        ? ok({ response: { transactionId: 'TX' }, errors: [] })
        : undefined,
    (u) =>
      u.endsWith('/send-otp') || u.endsWith('/v3/authenticate')
        ? ok({ response: {}, errors: [] })
        : undefined,
    (u) => (u.endsWith('/auth-code') ? ok({ response: { code: 'C' }, errors: [] }) : undefined),
  ];

  it('guest-smoke passes on a PDF', async () => {
    const f = fake([
      ...esignetFlow,
      (u) =>
        u.endsWith('/credentials/download')
          ? new Response('%PDF-1.7 ...', { status: 200 })
          : undefined,
    ]);
    expect(await runCli(['guest-smoke'], f.io)).toBe(0);
    const dl = f.calls.find((c) => c.url.endsWith('/credentials/download'));
    const form = new URLSearchParams(dl?.body ?? '');
    expect(form.get('code')).toBe('C');
    expect(form.get('credential')).toBe('FarmerCredential');
    const od = f.calls.find((c) => c.url.endsWith('/v3/oauth-details'));
    expect(JSON.parse(od?.body ?? '{}')).toMatchObject({
      request: { clientId: 'playground-mimoto' },
    });
  });

  it('guest-smoke exits 3 when the gateway issuer URL does not answer', async () => {
    const f = fake([]);
    f.io.http = () => Promise.reject(new Error('ECONNRESET'));
    expect(await runCli(['guest-smoke'], f.io)).toBe(GUEST_SMOKE_GATEWAY_MISSING);
  });

  it('guest-smoke exits 3 when only the did:web host is missing', async () => {
    const f = fake([
      ...esignetFlow,
      (u) =>
        u.endsWith('/credentials/download')
          ? new Response('{"errors":[{"errorCode":"signature_verification_failed"}]}', {
              status: 400,
            })
          : undefined,
    ]);
    expect(await runCli(['guest-smoke'], f.io)).toBe(GUEST_SMOKE_GATEWAY_MISSING);
  });

  it('wait-ready reports each service and fails on a wrong status', async () => {
    const f = fake([
      (u) => (u.startsWith('http://sidecar:7070') ? ok({ status: 'ok' }) : undefined),
      (u) =>
        u.startsWith('http://datashare-service') ? new Response('', { status: 404 }) : undefined,
      (u) => (u.startsWith('http://mimoto') ? new Response('', { status: 503 }) : undefined),
    ]);
    expect(
      await runCli(
        ['wait-ready', '--timeout', '0', 'sidecar', 'datashare-service', 'unknown-svc'],
        f.io,
      ),
    ).toBe(0);
    expect(await runCli(['wait-ready', '--timeout', '0', 'mimoto'], f.io)).toBe(1);
    expect(f.out.join('\n')).toMatch(/mimoto\s+FAIL \(503\)/);
  });

  it('render-config writes the tree', async () => {
    const f = fake([]);
    f.io.env.WALTID_VERIFIER_DID = 'did:key:z6MkX';
    f.io.env.WALTID_VERIFIER_KEY_JWK = '{"kty":"OKP"}';
    const out = path.join(tmp, 'render');
    expect(await runCli(['render-config', '--out', out], f.io)).toBe(0);
    expect(f.out.join('')).toMatch(/rendered \d+ files/);
    delete f.io.env.PUBLIC_HOST;
    expect(await runCli(['render-config', '--out', out], f.io)).toBe(1);
  });
});
