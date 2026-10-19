# T-47 live acceptance (deferred to wave 8, Docker owner)

Built in wave 7 on recorded upstreams (no Docker): `issuer.fixture`, `verifier.inji-verify-local.verifyCredential`, `judgeExpiredCredential` (`chk.vp.sdjwt.expired-credential`), `flows/FLOW-14.json`, `flows/FLOW-40.json`. Not yet run against the real Verify.

## Stack

`scripts/up.sh` (or the smallest subset with `verify-service` + `bff`); check `free -g` first.

## 1. Three credential-level runs (REQ-23 labels)

Against `http://verify-service:8080/v1/verify/v2/vc-verification` (the BFF registers `issuer.fixture` through `bundleAdapters()`; `main.ts` may need no change). Expected labels, exactly:

| configurationId | expected verdict | expected checks |
|---|---|---|
| `PlaygroundSdJwt` | valid | `vc.signature` pass, `vc.expiry` pass |
| `PlaygroundSdJwtInvalid` | invalid | `vc.signature` fail (`ERR_SIGNATURE_VERIFICATION_FAILED`) |
| `PlaygroundSdJwtExpired` | valid-but-expired | `vc.signature` pass, `vc.expiry` fail |

Quick form without the UI (from the repo root, `bff` container or host with the verify port published):

```
sg docker -c "docker compose -p interop-playground exec -T bff node -e \"...\""
```

or a one-off `npx tsx` script that builds `new FixtureIssuer()`, calls `fixture(ctx, 'dc+sd-jwt')` per configuration id and `new InjiVerifyLocalVerifier({internalBase}).verifyCredential(ctx, held)`. If the real answer differs from the recorded shape (field names, an expiry error code), fix `packages/adapters/src/verifiers/inji-verify-result.ts` and record the upstream shape in the evidence file.

## 2. VP-level run of `chk.vp.sdjwt.expired-credential` (RISK-31)

Run `PlaygroundSdJwtExpired` through FLOW-30 (`issuer.fixture` -> `wallet.playground-ts` -> `verifier.inji-verify-local`), then `judgeExpiredCredential(outcome)`.
Write the observed Verify answer (HTTP status, `expiryCheck`, error code) and the judged result (`pass` / `pass + vp-collapses-expiry` / `fail`) to `docs/evidence/T-47-vp-expired.md`; T-70 (decision day 2026-10-26) reads it. Note: Verify may reject at `vp-submission` instead of `vp-results`; record where.

## Needs from other owners

- `scripts/check-secrets.allow`: `fixtures/credentials/**` (TEST-ONLY keys; they pass today because keys are stored as base64 PKCS8, not PEM/JWK `d`).
- `packages/adapters/src/catalog.ts` `CREDENTIAL_CONFIGURATIONS`: add `issuer.fixture` / `dc+sd-jwt` configurations `PlaygroundSdJwtExpired` and `PlaygroundSdJwtInvalid` (vct `PlaygroundSdJwt`).
- Orchestrator: a FLOW-40 run must call `verifier.verifyCredential(ctx, held)` after `issuer.fixture(ctx, format)`.
