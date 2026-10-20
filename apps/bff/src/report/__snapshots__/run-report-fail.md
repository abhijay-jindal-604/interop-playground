# Run 01JA0000000000000000000002: FAIL

Generated 2026-10-19T12:00:00.000Z (report version 1).

| Field | Value |
| --- | --- |
| Issuer | issuer.waltid |
| Wallet | wallet.playground-ts |
| Verifier | verifier.inji-verify-collab |
| Format | dc+sd-jwt |
| Proof type | jwt |
| Grant | pre-authorized_code |
| Mode | cross-device |
| Environment | issuer local, wallet local, verifier collab |
| Version (issuer) | waltid@7ac0710e |
| Version (wallet) | 0.0.0 |
| Version (verifier) | collab |
| Knobs | KNOB-01=absent |
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
| FP-01 v1 | Inji Verify cannot verify an SD-JWT VC whose issuer key is not given as an x5c chain | G-55 | exact | verifier | inji-verify (vc-verifier) 1.0-alpha.1 | IETF SD-JWT VC (draft-ietf-oauth-sd-jwt-vc-19) §2.5 Issuer Verification Key Discovery and Validation | fingerprints/FP-01.json | 01JA0000000000000000000002:4, 01JA0000000000000000000002:1 |

## Fix-it

- KNOB-01 `waltid.sdjwt.x5c`: absent → present (changed walt.id issuance option); proven by an earlier re-run.

## Coverage

Every performed step was captured in full.

## Steps

| Step | Outcome | Capture |
| --- | --- | --- |
| vci.setup.variant | pending | — |
| vci.setup.config-read | pending | — |
| vci.offer.mint | pending | — |
| vci.offer.fetch | pending | — |
| vci.metadata.issuer | pending | — |
| vci.metadata.as | pending | — |
| vci.token | pending | — |
| vci.nonce | pending | — |
| vci.proof.sign | pending | — |
| vci.credential | pass | full |
| vci.credential.inspect | pending | — |
| vp.request.create | pass | full |
| vp.request.deliver | pending | — |
| vp.request.fetch | pending | — |
| vp.request.validate | pending | — |
| vp.credential.match | pending | — |
| vp.token.build | pending | — |
| vp.response.post | pass | full |
| vp.error.dispatch | pending | — |
| vp.response.redirect | pending | — |
| vp.result.poll | pass | full |
| vp.result.fetch | pending | — |
| vp.vc.verify | pending | — |
| vp.verdict.evaluate | fail | full |
| vp.wallet.observe | pending | — |
| vp.dcapi.probe | pending | — |
| vp.dcapi.request.create | pending | — |
| vp.dcapi.request.fetch | pending | — |
| vp.dcapi.invoke | pending | — |
| vp.dcapi.response.post | pending | — |
| vp.dcapi.holder | pending | — |
