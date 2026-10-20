# Run 01M5CCC4FZRMCCWMVQF5038EYS: PASS

Generated 2026-10-20T10:40:42.942Z (report version 1).

| Field | Value |
| --- | --- |
| Issuer | issuer.certify-preauth |
| Wallet | wallet.playground-ts |
| Verifier | verifier.inji-verify-local |
| Format | dc+sd-jwt |
| Proof type | jwt (ES256) |
| Grant | pre-authorized_code |
| Mode | cross-device |
| Environment | issuer local, wallet local, verifier local |
| Version (issuer) | injistack/inji-certify-with-plugins:1.0.0-alpha.1@sha256:1579b2449f1a + nginx:stable@sha256:0623fd2455fb |
| Version (wallet) | playground-ts@0.0.0 |
| Version (verifier) | injistack/inji-verify-service:1.0.0-alpha.1@sha256:064fcfa12773 |
| Knobs | KNOB-04=jsonpath, KNOB-07=plain |
| Verdict | PASS |
| Failed step | — |
| Error detail | — |

## Failing checks

None.

## Diagnosis

No cause to diagnose (the run passed).

## Fix-it

Not applicable.

## Coverage

- vci.proof.sign: none
- vci.credential.inspect: none
- vp.request.validate: none
- vp.credential.match: none
- vp.token.build: none

## Steps

| Step | Outcome | Capture |
| --- | --- | --- |
| vci.setup.variant | skipped | none (no issuer-side knob differs from its default) |
| vci.setup.config-read | pass | full |
| vci.offer.mint | pass | full |
| vci.offer.fetch | pass | full |
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
| vp.verdict.evaluate | pass | full |
| vp.wallet.observe | skipped | none (automated wallet, nothing to observe) |
| vp.dcapi.probe | skipped | none (not a DC API run) |
| vp.dcapi.request.create | skipped | none (not a DC API run) |
| vp.dcapi.request.fetch | skipped | none (not a DC API run) |
| vp.dcapi.invoke | skipped | none (not a DC API run) |
| vp.dcapi.response.post | skipped | none (not a DC API run) |
| vp.dcapi.holder | skipped | none (not a DC API run) |
