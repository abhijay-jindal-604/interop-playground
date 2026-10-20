# Run 01M5CBEB5F7W1Z8G14VNN0PK3Q: PASS

Generated 2026-10-20T10:40:43.002Z (report version 1).

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
| Verdict | PASS |
| Failed step | — |
| Error detail | — |

## Failing checks

| Check | Source | Status / code | Spec clause | Message |
| --- | --- | --- | --- | --- |
| vc.expiry | verifier-response | fail | — | — |

## Diagnosis

No cause to diagnose (the run passed).

## Fix-it

Not applicable.

## Coverage

- vci.fixture.load: none
- vp.verdict.evaluate: none

## Steps

| Step | Outcome | Capture |
| --- | --- | --- |
| vci.fixture.load | pass | none |
| vp.vc.verify | pass | full |
| vp.verdict.evaluate | pass | none |
