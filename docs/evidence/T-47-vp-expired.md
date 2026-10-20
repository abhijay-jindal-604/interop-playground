# T-47 live: VP-level `chk.vp.sdjwt.expired-credential` (RISK-31, 08 §5)

Date: 2026-10-20. Run `01M5CBC7EQY4ZKHPE50C1PC9CJ`: `issuer.fixture` (`PlaygroundSdJwtExpired`, FLOW-14) → `wallet.playground-ts` → `verifier.inji-verify-local`, FLOW-30 cross-device, DCQL vct `PlaygroundSdJwt`, disclosure `fullName`.

```
curl -s -X POST http://127.0.0.1:3100/api/v1/runs -H 'host: 127.0.0.1:3100' -H 'origin: http://127.0.0.1:3100' \
  -H 'content-type: application/json' \
  -d '{"issuer":"issuer.fixture","wallet":"wallet.playground-ts","verifier":"verifier.inji-verify-local","grant":"pre-authorized_code","presentationMode":"cross-device","format":"dc+sd-jwt","configurationId":"PlaygroundSdJwtExpired"}'
```

Where Verify answers: the wallet's `POST /v1/verify/v2/vp-submission/direct-post` (via the gateway) got **HTTP 200**: Verify does not reject at submission. The verdict is in `vp-results`.

Observed `POST http://verify-service:8080/v1/verify/v2/vp-results/<txn>`, **HTTP 200**, verbatim (the presented SD-JWT+KB elided):

```
{"transactionId":"txn_d28b53a4-5c4f-4655-9eac-75e891dbf57c","allChecksSuccessful":false,"credentialResults":[{"allChecksSuccessful":false,"schemaAndSignatureCheck":{"valid":true,"error":null},"expiryCheck":{"valid":false},"statusCheck":[],"claims":{},"verifiableCredential":"<SD-JWT~disclosure~KB-JWT elided>","holderProofCheck":{"valid":true,"error":null}}]}
```

- `expiryCheck`: `{"valid":false}`; error code: none (no `errorCode` anywhere; signature and holder proof valid).
- Mapped verdict: `valid-but-expired` (run outcome pass; checks `vc.signature` pass, `vc.expiry` fail, `vp.holder-proof` pass; `vp.verdict.evaluate` pass).
- Judged `chk.vp.sdjwt.expired-credential` (`judgeExpiredCredential`): **pass**, finding none. Verify does NOT collapse expiry into `invalid` at VP level (the `vp-collapses-expiry` branch is not taken).
- G-162 answered: there is no VP-path expiry error wording; Verify reports expiry as `expiryCheck.valid:false` exactly as on `/v2/vc-verification`. The `/expir/i` fallback in `judgeExpiredCredential` stays for other verifiers but is not exercised by Inji Verify.
