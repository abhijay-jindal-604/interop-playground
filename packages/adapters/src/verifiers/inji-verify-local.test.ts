/**
 * T-25 unit: `verifier.inji-verify-local` against recorded Verify answers (S-022
 * `trace-localverify-*.json`, S-200 `S-200-run2.txt`, S-202 premature result): request create
 * (clientId, 32-char nonce, DCQL), the `openid4vp://` URI, the status long-poll + result poll, and
 * the 08 §5 mapping Valid / Invalid / Valid-but-Expired / no-submission.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CheckResult } from '../contracts.js';
import type { Handler } from '../testing/fake-context.js';
import { fakeRun, stepTrail } from '../testing/fake-context.js';
import { verifyNonce } from '../support.js';
import { InjiVerifyLocalVerifier, buildRequestUri, dcqlFor } from './inji-verify-local.js';
import { mapVerifyResult } from './inji-verify-result.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const golden = path.join(here, '..', '..', '..', '..', 'fixtures', 'golden');
type TraceEx = { method: string; url: string; status: number; resBody: unknown; reqBody?: string };
const trace = (f: string): TraceEx[] =>
  JSON.parse(readFileSync(path.join(golden, 'traces', f), 'utf8')) as TraceEx[];
const vpOk = trace('trace-localverify-vp-ok.json');
const created = vpOk[5] as TraceEx;
const resultOk = (vpOk[7] as TraceEx).resBody as Record<string, unknown>;
const noSubmission = (trace('trace-localverify-vp-bad-nonce.json')[7] as TraceEx).resBody;
/** S-200 run 2: a recorded `vp-results` answer with a failed signature check */
const resultBadSig = JSON.parse(
  (
    readFileSync(path.join(golden, 'sessions', 'S-200-run2.txt'), 'utf8').split('\n')[24] ?? ''
  ).trim(),
) as Record<string, unknown>;
/** the vp-ok answer with the expiry check failed (08 §5 rule; no recorded VP-path expiry exists, RISK-31) */
const resultExpired = {
  ...resultOk,
  allChecksSuccessful: false,
  credentialResults: (resultOk.credentialResults as Record<string, unknown>[]).map((r) => ({
    ...r,
    allChecksSuccessful: false,
    expiryCheck: { valid: false },
  })),
};

const BASE = 'http://verify-service:8080/v1/verify';
const NONCE = 'EfEgO3ScUIh-xkrqeh4iN9BZUmzM24SY';
const RESPONSE_URI = 'https://192.0.2.10:8443/v1/verify/v2/vp-submission/direct-post';

function createdBody(nonce: string): unknown {
  const b = structuredClone(created.resBody) as {
    authorizationDetails: Record<string, unknown>;
  };
  b.authorizationDetails.clientId = 'interop-playground';
  b.authorizationDetails.nonce = nonce;
  b.authorizationDetails.responseUri = RESPONSE_URI;
  return b;
}

function verify(
  results: unknown[],
  statuses: string[] = ['VP_SUBMITTED'],
): Handler & { calls: string[] } {
  const calls: string[] = [];
  let r = 0;
  let s = 0;
  const h = (({ method, url, body }) => {
    calls.push(`${method} ${url.pathname}`);
    if (method === 'POST' && url.pathname === '/v1/verify/v2/vp-request') {
      const sent = JSON.parse(body ?? '{}') as { nonce: string };
      return { status: 201, body: createdBody(sent.nonce) };
    }
    if (method === 'GET' && url.pathname.endsWith('/status'))
      return { status: 200, body: { status: statuses[Math.min(s++, statuses.length - 1)] } };
    if (method === 'POST' && url.pathname.startsWith('/v1/verify/v2/vp-results/')) {
      const next = results[Math.min(r++, results.length - 1)];
      return next === noSubmission ? { status: 404, body: next } : { status: 200, body: next };
    }
    return { status: 404 };
  }) as Handler & { calls: string[] };
  h.calls = calls;
  return h;
}

const QUERY = {
  format: 'dc+sd-jwt' as const,
  configurationId: 'PlaygroundSdJwt',
  vctOrDoctypeOrType: 'PlaygroundSdJwt',
  claimPaths: [['fullName']],
  mode: 'cross-device' as const,
};

const noSleep = (): Promise<void> => Promise.resolve();

describe('verifier.inji-verify-local createRequest (T-25)', () => {
  it('posts clientId interop-playground, a 32-char nonce and the 03 §2.0 DCQL to the service name', async () => {
    const h = verify([resultOk]);
    const run = fakeRun(h);
    const registered: string[] = [];
    const v = new InjiVerifyLocalVerifier({
      internalBase: BASE,
      gateway: { register: (_r, key, step) => registered.push(`${key}|${step}`) },
    });
    const ref = await v.createRequest(run.ctx, QUERY);
    expect(stepTrail(run.events)).toEqual([
      'vp.request.create:start',
      'vp.request.create:pass:full',
    ]);
    const ex = run.exchanges[0];
    expect(ex?.url).toBe(`${BASE}/v2/vp-request`);
    const sent = JSON.parse(ex?.body ?? '') as {
      clientId: string;
      nonce: string;
      dcqlQuery: unknown;
    };
    expect(sent.clientId).toBe('interop-playground');
    expect(sent.nonce).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // the recorded request's DCQL (trace-localverify-vp-ok.json[5])
    expect(sent.dcqlQuery).toEqual(
      (JSON.parse(created.reqBody as string) as { dcqlQuery: unknown }).dcqlQuery,
    );
    expect(ref).toMatchObject({
      clientId: 'interop-playground',
      clientIdScheme: 'plain',
      nonce: sent.nonce,
      state: 'req_0c4e6e1c-8af3-46c0-ab90-c7b1a8965e8b',
      responseUri: RESPONSE_URI,
      mode: 'cross-device',
    });
    expect(run.correlations).toEqual([
      { kind: 'request-id', value: 'req_0c4e6e1c-8af3-46c0-ab90-c7b1a8965e8b' },
      { kind: 'transaction-id', value: 'txn_8178ec0c-6cd4-4a02-af30-ac0911f2db3f' },
    ]);
    expect(registered[0]).toBe('req_0c4e6e1c-8af3-46c0-ab90-c7b1a8965e8b|vp.response.post');
    // the URI: SDK parameter order, values percent-encoded, decodes back to the request
    expect(
      ref.requestUri.startsWith('openid4vp://authorize?client_id=interop-playground&state=req_'),
    ).toBe(true);
    const u = new URL(ref.requestUri);
    expect([...u.searchParams.keys()]).toEqual([
      'client_id',
      'state',
      'response_mode',
      'response_type',
      'nonce',
      'response_uri',
      'dcql_query',
    ]);
    expect(u.searchParams.get('response_uri')).toBe(RESPONSE_URI);
    expect(u.searchParams.get('nonce')).toBe(sent.nonce);
    expect(JSON.parse(u.searchParams.get('dcql_query') ?? '')).toEqual(sent.dcqlQuery);
  });

  it('nonce generator: 24 random bytes, base64url, 32 chars inside Verify’s set (G-118)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const n = verifyNonce();
      expect(n).toMatch(/^[A-Za-z0-9\-._~]{32}$/);
      expect(Buffer.from(n, 'base64url')).toHaveLength(24);
      seen.add(n);
    }
    expect(seen.size).toBe(200);
  });

  it('a 400 at create is a failed step with no URI', async () => {
    const run = fakeRun(() => ({
      status: 400,
      body: {
        errorCode: 'invalid_request',
        errorMessage: 'Nonce must contain only ASCII URL-safe characters',
      },
    }));
    const ref = await new InjiVerifyLocalVerifier({ internalBase: BASE }).createRequest(
      run.ctx,
      QUERY,
    );
    expect(stepTrail(run.events).at(-1)).toBe('vp.request.create:fail:full');
    expect(ref.requestUri).toBe('');
  });

  it('DCQL per format; mso_mdoc has no OID4VP query at Inji Verify (G-09)', () => {
    expect(dcqlFor({ ...QUERY, format: 'ldp_vc', vctOrDoctypeOrType: 'FarmerCredential' })).toEqual(
      {
        credentials: [
          {
            id: 'pg',
            format: 'ldp_vc',
            meta: { type_values: [['VerifiableCredential', 'FarmerCredential']] },
            claims: [{ path: ['fullName'] }],
          },
        ],
      },
    );
    expect(() => dcqlFor({ ...QUERY, format: 'mso_mdoc' })).toThrow(/G-09/);
    expect(
      buildRequestUri({
        clientId: 'a b',
        state: 's',
        nonce: 'n',
        responseUri: 'https://x/y?z',
        dcqlQuery: {},
      }),
    ).toBe(
      'openid4vp://authorize?client_id=a%20b&state=s&response_mode=direct_post&response_type=vp_token&nonce=n&response_uri=https%3A%2F%2Fx%2Fy%3Fz&dcql_query=%7B%7D',
    );
  });
});

describe('verifier.inji-verify-local awaitResult (T-25)', () => {
  async function await_(results: unknown[], statuses?: string[], timeoutMs = 300_000) {
    const h = verify(results, statuses);
    const run = fakeRun(h);
    let t = 0;
    const v = new InjiVerifyLocalVerifier({
      internalBase: BASE,
      nonce: () => NONCE,
      now: () => t,
      sleep: (ms) => {
        t += ms;
        return noSleep();
      },
    });
    const ref = await v.createRequest(run.ctx, QUERY);
    run.events.length = 0;
    const out = await v.awaitResult(run.ctx, ref, timeoutMs);
    return { out, run, calls: h.calls };
  }

  it('status long-poll then vp-results; valid; checks emitted on vp.result.poll', async () => {
    const { out, run, calls } = await await_([resultOk]);
    expect(out.verdict).toBe('valid');
    expect(out.rawResult).toEqual(resultOk);
    expect(calls.slice(1)).toEqual([
      'GET /v1/verify/vp-request/req_0c4e6e1c-8af3-46c0-ab90-c7b1a8965e8b/status',
      'POST /v1/verify/v2/vp-results/txn_8178ec0c-6cd4-4a02-af30-ac0911f2db3f',
    ]);
    const polls = run.exchanges.slice(1).map((x) => x.ctx.poll?.group);
    expect(polls).toEqual(['vp-status', 'vp-result']);
    expect(run.closed).toEqual(['vp-status', 'vp-result']);
    expect(stepTrail(run.events)).toEqual(['vp.result.poll:start', 'vp.result.poll:pass:full']);
    const checks = run.events.flatMap((e) => (e.type === 'verdict.check' ? [e.check] : []));
    expect(checks.map((c) => `${c.checkId}:${c.outcome}`)).toEqual([
      'vc.signature:pass',
      'vc.expiry:pass',
      'vp.holder-proof:pass',
    ]);
  });

  it('ACTIVE keeps long-polling; NO_VP_SUBMISSION is retried every 1500 ms', async () => {
    const { out, calls } = await await_(
      [noSubmission, noSubmission, resultOk],
      ['ACTIVE', 'ACTIVE', 'VP_SUBMITTED'],
    );
    expect(out.verdict).toBe('valid');
    expect(calls.filter((c) => c.endsWith('/status'))).toHaveLength(3);
    expect(calls.filter((c) => c.includes('vp-results'))).toHaveLength(3);
  });

  it('premature: nothing submitted until the deadline → no-submission (S-202 point 5 answer)', async () => {
    const { out, run } = await await_([noSubmission], ['ACTIVE'], 4000);
    expect(out.verdict).toBe('no-submission');
    expect(out.rawResult).toEqual(noSubmission);
    expect(stepTrail(run.events).at(-1)).toBe('vp.result.poll:pass:full');
  });

  it('recorded signature failure → invalid, upstream code verbatim', async () => {
    const { out } = await await_([resultBadSig]);
    expect(out.verdict).toBe('invalid');
    const sig = out.checks.find((c) => c.checkId === 'vc.signature') as CheckResult;
    expect(sig).toMatchObject({
      outcome: 'fail',
      code: 'ERR_SIGNATURE_VERIFICATION_FAILED',
      message: 'Verification Failed',
    });
  });

  it('a 5xx result is a failed step', async () => {
    const run = fakeRun(({ method, url, body }) =>
      url.pathname.includes('vp-results')
        ? { status: 500, body: { error: 'boom' } }
        : verify([resultOk])({ method, url, body, headers: new Headers() }),
    );
    const v = new InjiVerifyLocalVerifier({ internalBase: BASE });
    const ref = await v.createRequest(run.ctx, QUERY);
    await v.awaitResult(run.ctx, ref, 10_000);
    expect(stepTrail(run.events).at(-1)).toBe('vp.result.poll:fail:full');
  });
});

describe('08 §5 result mapping (REQ-23)', () => {
  it('Valid / Invalid / Valid-but-Expired from recorded responses', () => {
    expect(mapVerifyResult(resultOk).verdict).toBe('valid');
    expect(mapVerifyResult(resultBadSig).verdict).toBe('invalid');
    const exp = mapVerifyResult(resultExpired);
    expect(exp.verdict).toBe('valid-but-expired');
    expect(exp.checks.map((c) => `${c.checkId}:${c.outcome}`)).toEqual([
      'vc.signature:pass',
      'vc.expiry:fail',
      'vp.holder-proof:pass',
    ]);
  });

  it('signature invalid wins over expiry; holder proof and status failures are invalid', () => {
    const both = {
      allChecksSuccessful: false,
      credentialResults: [
        { schemaAndSignatureCheck: { valid: false, error: null }, expiryCheck: { valid: false } },
      ],
    };
    expect(mapVerifyResult(both).verdict).toBe('invalid');
    const holder = {
      allChecksSuccessful: false,
      credentialResults: [
        {
          schemaAndSignatureCheck: { valid: true },
          expiryCheck: { valid: true },
          holderProofCheck: { valid: false },
        },
      ],
    };
    expect(mapVerifyResult(holder).verdict).toBe('invalid');
    expect(mapVerifyResult({ allChecksSuccessful: true, credentialResults: [] }).verdict).toBe(
      'invalid',
    );
    expect(mapVerifyResult('nope').verdict).toBe('invalid');
  });

  it('credential path (/v2/vc-verification answers one credential at the top level)', () => {
    expect(
      mapVerifyResult({
        allChecksSuccessful: false,
        schemaAndSignatureCheck: { valid: true },
        expiryCheck: { valid: false },
      }).verdict,
    ).toBe('valid-but-expired');
  });
});
