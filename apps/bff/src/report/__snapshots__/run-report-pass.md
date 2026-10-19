# Run 01JA0000000000000000000001: PASS

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
| Knobs | KNOB-01=present* (* = non-default) |
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
| vp.verdict.evaluate | pass | full |
| vp.wallet.observe | pending | — |
| vp.dcapi.probe | pending | — |
| vp.dcapi.request.create | pending | — |
| vp.dcapi.request.fetch | pending | — |
| vp.dcapi.invoke | pending | — |
| vp.dcapi.response.post | pending | — |
| vp.dcapi.holder | pending | — |
