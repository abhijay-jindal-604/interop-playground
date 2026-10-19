/**
 * `sidecar.contract` (plan/11 §4.5, DoD-SIDECAR-OP 1): FakeSidecar answers API-60..69 with the
 * schemas of 04 §3.8 (validated against the generated api.schema.json), long-poll semantics,
 * `answers/{cbId}` and the sidecar error codes.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import { API_SCHEMA_PATH } from '../paths.js';
import { startFakeSidecar, type FakeSidecar, type FakeSidecarScript } from './sidecar.js';

const schema = JSON.parse(readFileSync(API_SCHEMA_PATH, 'utf8')) as Record<string, unknown>;
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema({ $id: 'api', ...schema });
function expectShape(name: string, value: unknown): void {
  const v = ajv.getSchema(`api#/definitions/${name}`);
  expect(v, name).toBeDefined();
  expect(v?.(value), `${name}: ${JSON.stringify(v?.errors?.slice(0, 3))}`).toBe(true);
}

let fake: FakeSidecar | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

async function start(script: FakeSidecarScript = {}): Promise<FakeSidecar> {
  fake = await startFakeSidecar({ holdMs: 0, ...script });
  return fake;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  if (!fake) throw new Error('not started');
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const res = await fetch(`${fake.url}${path}`, init);
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as unknown) : null };
}

describe('sidecar.contract', () => {
  it('API-60 health', async () => {
    await start();
    const r = await call('GET', '/health');
    expect(r.status).toBe(200);
    expectShape('SidecarHealth', r.json);
  });

  it('API-61..65 a VCIClient session: create, pending, answer, result, delete', async () => {
    await start();
    const created = await call('POST', '/vci/sessions', {
      offerUri: 'openid-credential-offer://?credential_offer_uri=x',
    });
    expect(created.status).toBe(201);
    expectShape('VciSessionCreated', created.json);
    const id = (created.json as { sessionId: string }).sessionId;

    const pending = await call('GET', `/vci/sessions/${id}/pending?after=0`);
    expectShape('VciPendingResponse', pending.json);
    const p = pending.json as { callbacks: { id: string; type: string }[]; next: number };
    expect(p.callbacks.map((c) => c.type)).toEqual(['proof']);
    expect(p.next).toBe(1);

    const running = await call('GET', `/vci/sessions/${id}/result`);
    expect(running.status).toBe(202);
    expectShape('VciResult', running.json);

    const cb = p.callbacks[0]?.id ?? '';
    expect(
      (await call('POST', `/vci/sessions/${id}/answers/${cb}`, { jws: 'eyJ.a.b' })).status,
    ).toBe(204);
    const again = await call('POST', `/vci/sessions/${id}/answers/${cb}`, { jws: 'eyJ.a.b' });
    expect(again.status).toBe(409);
    expectShape('ErrorEnvelope', again.json);
    expect((again.json as { error: { code: string } }).error.code).toBe('callback_not_pending');

    const empty = await call('GET', `/vci/sessions/${id}/pending?after=1`);
    expect(empty.json).toEqual({ callbacks: [], next: 1 });

    const done = await call('GET', `/vci/sessions/${id}/result`);
    expect(done.status).toBe(200);
    expectShape('VciResult', done.json);
    expect((done.json as { state: string }).state).toBe('done');

    expect((await call('DELETE', `/vci/sessions/${id}`)).status).toBe(204);
    expect((await call('GET', `/vci/sessions/${id}/result`)).status).toBe(404);
  });

  it('API-62 long-polls until the hold expires when nothing is pending', async () => {
    await start({ holdMs: 30, callbacks: [] });
    const created = await call('POST', '/vci/sessions', {
      offerUri: 'openid-credential-offer://?x',
    });
    const id = (created.json as { sessionId: string }).sessionId;
    const t0 = Date.now();
    const r = await call('GET', `/vci/sessions/${id}/pending?after=0`);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(r.json).toEqual({ callbacks: [], next: 0 });
  });

  it('API-64 failed session and the scripted outcome', async () => {
    await start({
      callbacks: [],
      vciOutcome: {
        state: 'failed',
        exceptionClass: 'InvalidProofException',
        message: 'invalid_proof',
      },
    });
    const created = await call('POST', '/vci/sessions', {
      offerUri: 'openid-credential-offer://?x',
    });
    const id = (created.json as { sessionId: string }).sessionId;
    const r = await call('GET', `/vci/sessions/${id}/result`);
    expectShape('VciResult', r.json);
    expect(r.json).toMatchObject({ state: 'failed', exceptionClass: 'InvalidProofException' });
  });

  it('API-66..68 the OID4VP ops in order', async () => {
    await start();
    const auth = await call('POST', '/vp/authenticate', {
      urlEncodedRequest: 'client_id=x',
      trustedVerifiers: [],
    });
    expectShape('VpAuthenticateResponse', auth.json);
    const sessionId = (auth.json as { sessionId: string }).sessionId;
    const unsigned = await call('POST', '/vp/unsigned-token', {
      sessionId,
      credential: { format: 'dc+sd-jwt', raw: 'eyJ~' },
      disclosure: { claimPaths: [] },
      holderDid: 'did:jwk:x',
    });
    expectShape('VpUnsignedTokenResponse', unsigned.json);
    const resp = await call('POST', '/vp/response', { sessionId, signature: 'c2ln' });
    expectShape('VpResponseResponse', resp.json);
    expect((await call('POST', '/vp/response', { sessionId: 'nope', signature: 'x' })).status).toBe(
      404,
    );
  });

  it('API-69 verify, and engine_exception (422) with exceptionClass in details', async () => {
    await start();
    const ok = await call('POST', '/vc/verify', { format: 'ldp_vc', raw: '{}' });
    expectShape('VcVerifyResponse', ok.json);
    await fake?.close();
    await start({
      vpException: { exceptionClass: 'SignatureVerificationException', message: 'bad' },
    });
    const r = await call('POST', '/vc/verify', { format: 'ldp_vc', raw: '{}' });
    expect(r.status).toBe(422);
    // G-139: the generated ErrorEnvelope.details points at KnobValues, so validate without details
    const { details: _details, ...envelope } = (r.json as { error: Record<string, unknown> }).error;
    expectShape('ErrorEnvelope', { error: envelope });
    expect(r.json).toMatchObject({
      error: {
        code: 'engine_exception',
        details: { exceptionClass: 'SignatureVerificationException' },
      },
    });
  });

  it('validation_failed for bad input, never accepts a private key', async () => {
    await start();
    const bad = await call('POST', '/vci/sessions', { offerUri: 'https://x' });
    expect(bad.status).toBe(400);
    expectShape('ErrorEnvelope', bad.json);
    const created = await call('POST', '/vci/sessions', {
      offerUri: 'openid-credential-offer://?x',
    });
    const id = (created.json as { sessionId: string }).sessionId;
    const key = await call('POST', `/vci/sessions/${id}/answers/cb-1`, {
      jws: 'x',
      privateKey: {},
    });
    expect(key.status).toBe(400);
    expect(fake?.calls.map((c) => c.method)).toEqual(['POST', 'POST', 'POST']);
  });
});
