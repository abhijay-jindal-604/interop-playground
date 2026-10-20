# Run 01M5CBEB4BW718XJ7VW09CB7EF: FAIL

Generated 2026-10-20T10:40:42.983Z (report version 1).

| Field | Value |
| --- | --- |
| Issuer | issuer.fixture |
| Wallet | wallet.playground-ts |
| Verifier | verifier.inji-verify-local |
| Format | dc+sd-jwt |
| Proof type | none (fixture credential) |
| Grant | pre-authorized_code |
| Mode | — |
| Environment | issuer local, wallet local, verifier local |
| Version (issuer) | fixture@r3d2 |
| Version (wallet) | playground-ts@0.0.0 |
| Version (verifier) | injistack/inji-verify-service:1.0.0-alpha.1@sha256:064fcfa12773 |
| Knobs | KNOB-07=plain |
| Verdict | FAIL |
| Failed step | — |
| Error detail | ERR_SIGNATURE_VERIFICATION_FAILED: Verification Failed |

## Failing checks

| Check | Source | Status / code | Spec clause | Message |
| --- | --- | --- | --- | --- |
| vc.signature | verifier-response | ERR_SIGNATURE_VERIFICATION_FAILED | — | Verification Failed |

## Diagnosis

Unclassified: no fingerprint matched; the raw failing checks are listed above.

## Fix-it

Diagnosis only: unclassified.

## Coverage

- vci.fixture.load: none
- vp.verdict.evaluate: none

## Steps

| Step | Outcome | Capture |
| --- | --- | --- |
| vci.fixture.load | pass | none |
| vp.vc.verify | pass | full |
| vp.verdict.evaluate | pass | none |
