/**
 * T-47 unit: credential-level verification at `verifier.inji-verify-local` (`POST
 * /v2/vc-verification`, 03 FLOW-40) and the REQ-23 labels, on recorded Verify answers: the
 * `credentialResults[0]` of the S-060 local VP result (`vp-results-1.json`, valid), the S-200 run 2
 * answer with a failed signature check, and the S-014 shape with `expiryCheck.valid:false`
 * (sample-2). The VP-level check `chk.vp.sdjwt.expired-credential` is tested on the 08 §5 table.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { HeldCredential, VerificationOutcome } from '../contracts.js';
import { generateHolderKey } from '../wallets/keys.js';
import { fakeRun, stepTrail } from '../testing/fake-context.js';
import {
  EXPIRED_CREDENTIAL_CHECK_ID,
  judgeExpiredCredential,
  mapVerifyResult,
} from './inji-verify-result.js';
import { InjiVerifyLocalVerifier } from './inji-verify-local.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const golden = path.join(here, '..', '..', '..', '..', 'fixtures', 'golden');
type Rec = Record<string, unknown>;
const okCred = (
  JSON.parse(readFileSync(path.join(golden, 's060', 'vp-results-1.json'), 'utf8')) as {
    credentialResults: Rec[];
  }
).credentialResults[0] as Rec;
const badSigCred = (
  JSON.parse(
    (
      readFileSync(path.join(golden, 'sessions', 'S-200-run2.txt'), 'utf8').split('\n')[24] ?? ''
    ).trim(),
  ) as { credentialResults: Rec[] }
).credentialResults[0] as Rec;

/** `/v2/vc-verification` answers one credential at the top level (S-014 shape) */
const strip = (r: Rec): Rec => {
  const { verifiableCredential: _v, holderProofCheck: _h, claims: _c, ...rest } = r;
  return rest;
};
const VALID = strip(okCred);
const EXPIRED = { ...VALID, allChecksSuccessful: false, expiryCheck: { valid: false } };
const INVALID = strip(badSigCred);

const BASE = 'http://verify-service:8080/v1/verify';
const held = (): HeldCredential => ({
  format: 'dc+sd-jwt',
  raw: 'aaa.bbb.ccc~',
  holderKey: generateHolderKey('ES256').ref,
  issuerAdapter: 'issuer.fixture',
  configurationId: 'PlaygroundSdJwt',
});

async function verifyWith(status: number, body: unknown) {
  const run = fakeRun(() => ({ status, body }));
  const outcome = await new InjiVerifyLocalVerifier({ internalBase: BASE }).verifyCredential(
    run.ctx,
    held(),
  );
  return { run, outcome };
}

describe('verifier.inji-verify-local verifyCredential (T-47, REQ-23)', () => {
  it('recorded shapes carry what the mapping reads', () => {
    expect(VALID).toMatchObject({ allChecksSuccessful: true, expiryCheck: { valid: true } });
    expect(INVALID.schemaAndSignatureCheck).toMatchObject({ valid: false });
  });

  it('Valid: posts the VC as a string to /v2/vc-verification', async () => {
    const { run, outcome } = await verifyWith(200, VALID);
    expect(outcome.verdict).toBe('valid');
    const ex = run.exchanges[0];
    expect(ex?.url).toBe(`${BASE}/v2/vc-verification`);
    expect(JSON.parse(ex?.body ?? '')).toEqual({ verifiableCredential: 'aaa.bbb.ccc~' });
    expect(stepTrail(run.events)).toEqual([
      'vp.vc.verify:start',
      'vp.vc.verify:pass:full',
      'vp.verdict.evaluate:start',
      'vp.verdict.evaluate:pass:none',
    ]);
    const ids = run.events.flatMap((e) => (e.type === 'verdict.check' ? [e.check.checkId] : []));
    expect(ids).toEqual(['vc.signature', 'vc.expiry']);
  });

  it('Invalid: signature check failed, upstream code verbatim', async () => {
    const { outcome } = await verifyWith(200, INVALID);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.checks.find((c) => c.checkId === 'vc.signature')).toMatchObject({
      outcome: 'fail',
    });
  });

  it('Valid-but-Expired: signature valid and expiryCheck.valid:false', async () => {
    const { outcome } = await verifyWith(200, EXPIRED);
    expect(outcome.verdict).toBe('valid-but-expired');
    expect(outcome.checks.map((c) => `${c.checkId}:${c.outcome}`)).toEqual([
      'vc.signature:pass',
      'vc.expiry:fail',
    ]);
  });

  it('skipStatusChecks is sent only when configured', async () => {
    const run = fakeRun(() => ({ status: 200, body: VALID }));
    await new InjiVerifyLocalVerifier({
      internalBase: BASE,
      skipStatusChecks: true,
    }).verifyCredential(run.ctx, held());
    expect(JSON.parse(run.exchanges[0]?.body ?? '')).toMatchObject({ skipStatusChecks: true });
  });

  it('a 400 is an invalid verdict and a failed step, code and message verbatim', async () => {
    const { run, outcome } = await verifyWith(400, {
      errorCode: 'ERR_GENERIC',
      errorMessage: 'bad credential',
    });
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.checks[0]).toMatchObject({ outcome: 'fail', code: 'ERR_GENERIC' });
    expect(stepTrail(run.events)).toContain('vp.vc.verify:fail:full');
  });
});

describe('chk.vp.sdjwt.expired-credential (08 §5, TMP-39 at VP level)', () => {
  const out = (
    verdict: VerificationOutcome['verdict'],
    body: unknown,
    code?: string,
    message?: string,
  ): VerificationOutcome => {
    const mapped = mapVerifyResult(body);
    return {
      verdict,
      checks: code
        ? [
            {
              checkId: 'vc.signature',
              outcome: 'fail',
              source: 'verifier-response',
              code,
              ...(message ? { message } : {}),
              exchangeIds: [],
            },
          ]
        : mapped.checks,
      rawResult: body,
      exchangeIds: [],
    };
  };

  it('valid-but-expired → pass', () => {
    const o = out('valid-but-expired', EXPIRED);
    expect(mapVerifyResult(EXPIRED).verdict).toBe('valid-but-expired');
    expect(judgeExpiredCredential(o)).toMatchObject({
      check: { checkId: EXPIRED_CREDENTIAL_CHECK_ID, outcome: 'pass' },
      finding: null,
    });
  });

  it('invalid with an expiry-specific code → pass plus finding vp-collapses-expiry', () => {
    const r = judgeExpiredCredential(out('invalid', {}, 'ERR_VC_EXPIRED', 'credential expired'));
    expect(r.check.outcome).toBe('pass');
    expect(r.check.code).toBe('ERR_VC_EXPIRED');
    expect(r.finding).toBe('vp-collapses-expiry');
  });

  it('acceptance (expiryCheck.valid:true) → fail', () => {
    const r = judgeExpiredCredential(out('valid', VALID));
    expect(r.check.outcome).toBe('fail');
  });

  it('signature error → fail', () => {
    const r = judgeExpiredCredential(out('invalid', {}, 'ERR_SIGNATURE_VERIFICATION_FAILED'));
    expect(r.check.outcome).toBe('fail');
    expect(r.finding).toBeNull();
  });

  it('no submission → not-run', () => {
    expect(judgeExpiredCredential(out('no-submission', {})).check.outcome).toBe('not-run');
  });
});
