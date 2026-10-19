/**
 * Inji Verify result → `VerificationOutcome` (08 §5 REQ-23, 03 FLOW-30 message 8).
 *  - signature invalid on any credential → `invalid`
 *  - signature valid, expiry invalid → `valid-but-expired`
 *  - everything verified → `valid`; any other failed check → `invalid`
 *  - 404 `NO_VP_SUBMISSION` (or nothing posted) → `no-submission`
 * Upstream codes and messages are copied verbatim into `CheckResult.code` / `message`.
 */
import type { CheckResult, VerificationOutcome } from '../contracts.js';
import { isRecord, str } from '../support.js';

type Verdict = VerificationOutcome['verdict'];

function check(
  checkId: string,
  valid: unknown,
  error: unknown,
  exchangeIds: readonly string[],
): CheckResult {
  const outcome: CheckResult['outcome'] =
    valid === true ? 'pass' : valid === false ? 'fail' : 'not-run';
  const e = isRecord(error) ? error : null;
  const code = e ? str(e.errorCode) : null;
  const message = e ? str(e.errorMessage) : null;
  return {
    checkId,
    outcome,
    source: 'verifier-response',
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
    exchangeIds,
  };
}

/** `checks` and verdict from a `/v2/vp-results` (or `/v2/vc-verification`) 200 body */
export function mapVerifyResult(
  body: unknown,
  exchangeIds: readonly string[] = [],
): { verdict: Verdict; checks: CheckResult[] } {
  if (!isRecord(body)) return { verdict: 'invalid', checks: [] };
  const results = Array.isArray(body.credentialResults)
    ? body.credentialResults.filter(isRecord)
    : // `/v2/vc-verification` answers one credential at the top level
      [body];
  const checks: CheckResult[] = [];
  let sigInvalid = false;
  let expInvalid = false;
  let otherInvalid = false;
  for (const r of results) {
    const sig = isRecord(r.schemaAndSignatureCheck) ? r.schemaAndSignatureCheck : null;
    const exp = isRecord(r.expiryCheck) ? r.expiryCheck : null;
    checks.push(check('vc.signature', sig?.valid, sig?.error, exchangeIds));
    checks.push(check('vc.expiry', exp?.valid, exp?.error, exchangeIds));
    if (isRecord(r.holderProofCheck)) {
      checks.push(
        check('vp.holder-proof', r.holderProofCheck.valid, r.holderProofCheck.error, exchangeIds),
      );
      if (r.holderProofCheck.valid === false) otherInvalid = true;
    }
    if (Array.isArray(r.statusCheck)) {
      for (const s of r.statusCheck.filter(isRecord)) {
        const c = check('vc.status', s.valid, s.error, exchangeIds);
        checks.push(c);
        if (c.outcome === 'fail') otherInvalid = true;
      }
    }
    if (sig?.valid !== true) sigInvalid = true;
    if (exp?.valid === false) expInvalid = true;
    if (r.allChecksSuccessful === false && sig?.valid === true && exp?.valid !== false)
      otherInvalid = true;
  }
  let verdict: Verdict;
  if (results.length === 0 || sigInvalid) verdict = 'invalid';
  else if (otherInvalid) verdict = 'invalid';
  else if (expInvalid) verdict = 'valid-but-expired';
  else verdict = body.allChecksSuccessful === false ? 'invalid' : 'valid';
  return { verdict, checks };
}

/** Verify's "keep polling" answer (03 §2.0 poll rule) */
export function isNoSubmission(status: number, body: unknown): boolean {
  return status === 404 && isRecord(body) && body.errorCode === 'NO_VP_SUBMISSION';
}
