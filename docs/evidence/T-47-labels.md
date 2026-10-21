# T-47 live: REQ-23 labels at the real Inji Verify (FLOW-14 + FLOW-40)

Date: 2026-10-20. Stack: `interop-playground` bundle (`verify-service` = `injistack/inji-verify-service:1.0.0-alpha.1@sha256:064fcfa12773`), bff rebuilt from `d67ab28` plus the uncommitted working-tree changes of that day. Combination: `issuer.fixture` × `wallet.playground-ts` × `verifier.inji-verify-local`, `presentationMode: null` (credential level, ADR-94), format `dc+sd-jwt`.

Request (API-20), one per case:

```
curl -s -X POST http://127.0.0.1:3100/api/v1/runs -H 'host: 127.0.0.1:3100' -H 'origin: http://127.0.0.1:3100' \
  -H 'content-type: application/json' \
  -d '{"issuer":"issuer.fixture","wallet":"wallet.playground-ts","verifier":"verifier.inji-verify-local","grant":"pre-authorized_code","presentationMode":null,"format":"dc+sd-jwt","configurationId":"<case>"}'
```

| configurationId          | run ID                       | flows             | outcome / verification     | UI result card (e2e)                                                                                            |
| ------------------------ | ---------------------------- | ----------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `PlaygroundSdJwt`        | `01M5CBEB3M9ANDEDPFBQD5D0NX` | FLOW-14 → FLOW-40 | pass / `valid`             | "Pass", "The verifier accepted the credential: Valid."                                                          |
| `PlaygroundSdJwtInvalid` | `01M5CBEB4BW718XJ7VW09CB7EF` | FLOW-14 → FLOW-40 | fail / `invalid`           | "Fail", "Invalid. The verifier rejected the credential: ERR_SIGNATURE_VERIFICATION_FAILED Verification Failed." |
| `PlaygroundSdJwtExpired` | `01M5CBEB5F7W1Z8G14VNN0PK3Q` | FLOW-14 → FLOW-40 | pass / `valid-but-expired` | "Pass", "Valid but expired. The signature checks out and the credential is past its expiry date."               |

Observed `POST http://verify-service:8080/v1/verify/v2/vc-verification` answers (HTTP 200 each), verbatim from the run store:

```
valid:   {"allChecksSuccessful":true,"schemaAndSignatureCheck":{"valid":true,"error":null},"expiryCheck":{"valid":true},"statusCheck":[],"claims":{}}
invalid: {"allChecksSuccessful":false,"schemaAndSignatureCheck":{"valid":false,"error":{"errorCode":"ERR_SIGNATURE_VERIFICATION_FAILED","errorMessage":"Verification Failed"}},"expiryCheck":null,"statusCheck":[],"claims":{}}
expired: {"allChecksSuccessful":false,"schemaAndSignatureCheck":{"valid":true,"error":null},"expiryCheck":{"valid":false},"statusCheck":[],"claims":{}}
```

The real shape matches the recorded one: `packages/adapters/src/verifiers/inji-verify-result.ts` needed no change. One fixture defect was found and fixed live: the minted SD-JWTs carried `_sd_alg: "sha256"`, which Verify rejects with `ERR_INVALID_SD_ALG`; the IANA name is `sha-256` (`issuers/fixture-mint.ts`, committed `fixtures/credentials/sdjwt-*.txt` re-minted; asserted in `issuers/fixture.test.ts`).

UI e2e: `e2e/live/labels.live.spec.ts` (selector "Credential only (no OID4VP)" + "Fixture case", three runs, three verdict stamps Valid / Invalid / Expired side by side, then the Expired one alone), take `deliverables/takes/s09-labels.webm`. Command: `LIVE_TAKE=deliverables/takes/s09-take.webm npx playwright test -c e2e/playwright.live.config.ts labels`, then `scripts/cut-takes.sh deliverables/takes/s09-take.webm`.
