# Run 01M5B6KNNY7DC3YK3CR0ETNBN9: FAIL

Generated 2026-10-20T10:40:43.042Z (report version 1).

| Field | Value |
| --- | --- |
| Issuer | issuer.waltid |
| Wallet | wallet.playground-ts |
| Verifier | verifier.inji-verify-local |
| Format | dc+sd-jwt |
| Proof type | jwt (ES256) |
| Grant | pre-authorized_code |
| Mode | cross-device |
| Environment | issuer local, wallet local, verifier local |
| Version (issuer) | waltid/issuer-api2:1.1.0@sha256:e7f8a9ff6b22 |
| Version (wallet) | playground-ts@0.0.0 |
| Version (verifier) | injistack/inji-verify-service:1.0.0-alpha.1@sha256:064fcfa12773 |
| Knobs | KNOB-01=absent, KNOB-07=plain |
| Verdict | FAIL |
| Failed step | vp.verdict.evaluate |
| Error detail | ERR_SIGNATURE_VERIFICATION_FAILED: Exception during Verification: getX509CertChain(...) must not be null |

## Failing checks

| Check | Source | Status / code | Spec clause | Message |
| --- | --- | --- | --- | --- |
| vc.signature | verifier-response | ERR_SIGNATURE_VERIFICATION_FAILED | — | Exception during Verification: getX509CertChain(...) must not be null |
| vp.verdict | verifier-response | fail | — | invalid |

## Diagnosis

| Fingerprint | Title | Gaps | Confidence | Deviating side | Component | Spec clause | Evidence | Exchanges |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FP-01 v1 | Inji Verify cannot verify an SD-JWT VC whose issuer key is not given as an x5c chain | G-55 | exact | verifier | inji-verify (vc-verifier) 1.0-alpha.1 | IETF SD-JWT VC (draft-ietf-oauth-sd-jwt-vc-19) §2.5 Issuer Verification Key Discovery and Validation | fingerprints/FP-01.json | 01M5B6KNNY7DC3YK3CR0ETNBN9:6 |

## Fix-it

- KNOB-01 `waltid.sdjwt.x5c`: absent → present (changed walt.id issuance option); proven by an earlier re-run.

## Coverage

- vci.proof.sign: none
- vci.credential.inspect: none
- vp.request.validate: none
- vp.credential.match: none
- vp.token.build: none

## Steps

| Step | Outcome | Capture |
| --- | --- | --- |
| vci.offer.mint | pass | full |
| vci.offer.fetch | skipped | none (offer by value) |
| vci.metadata.issuer | pass | full |
| vci.metadata.as | pass | full |
| vci.token | pass | full |
| vci.nonce | pass | full |
| vci.proof.sign | pass | none |
| vci.credential | pass | full |
| vci.credential.inspect | pass | none |
| vp.request.create | pass | full |
| vp.request.deliver | pass | full |
| vp.request.fetch | skipped | none (request carried by value) |
| vp.request.validate | pass | none |
| vp.credential.match | pass | none |
| vp.token.build | pass | none |
| vp.response.post | pass | full |
| vp.error.dispatch | skipped | none (wallet raised no error) |
| vp.response.redirect | skipped | none (not a web-wallet delivery) |
| vp.result.poll | pass | full |
| vp.result.fetch | skipped | none (cross-device flow reads the result by poll) |
| vp.vc.verify | skipped | none (credential-level verification is not part of an OID4VP flow) |
| vp.verdict.evaluate | fail | full |
| vp.wallet.observe | skipped | none (automated wallet, nothing to observe) |
| vp.dcapi.probe | skipped | none (not a DC API run) |
| vp.dcapi.request.create | skipped | none (not a DC API run) |
| vp.dcapi.request.fetch | skipped | none (not a DC API run) |
| vp.dcapi.invoke | skipped | none (not a DC API run) |
| vp.dcapi.response.post | skipped | none (not a DC API run) |
| vp.dcapi.holder | skipped | none (not a DC API run) |
