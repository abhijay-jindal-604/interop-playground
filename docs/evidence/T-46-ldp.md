# T-46 live: W3C VC (JSON-LD, ldp_vc) issued by Inji Certify and verified by Inji Verify (FLOW-03 + FLOW-31)

Date: 2026-10-20. Stack: `interop-playground` bundle, local profile (`scripts/up.sh`, no `--with`), bff image rebuilt from `50c52ab` (with `jsonld@9.0.0`). `certify-preauth` = `injistack/inji-certify-with-plugins:1.0.0-alpha.1@sha256:1579b2449f1a`, `verify-service` = `injistack/inji-verify-service:1.0.0-alpha.1@sha256:064fcfa12773`. Combination: `issuer.certify-preauth` × `wallet.playground-ts` × `verifier.inji-verify-local`, grant `pre-authorized_code`, `cross-device`, format `ldp_vc`, configuration `FarmerCredential`.

Request (API-20):

```
curl -s -X POST http://127.0.0.1:3100/api/v1/runs -H 'host: 127.0.0.1:3100' -H 'origin: http://127.0.0.1:3100' \
  -H 'content-type: application/json' \
  -d '{"issuer":"issuer.certify-preauth","wallet":"wallet.playground-ts","verifier":"verifier.inji-verify-local","grant":"pre-authorized_code","presentationMode":"cross-device","format":"ldp_vc"}'
```

| run ID | how | flows | outcome / verification | steps |
|---|---|---|---|---|
| `01M5CDWNQDX53HC3YF288AFFFG` | API-20 (curl above) | FLOW-03 → FLOW-31 | pass / `valid` | 32 total: 20 pass, 0 fail, 12 skipped (DC API, same-device, error and by-value request steps not in this mode) |
| `01M5CE5ZNPP9Z28SS1BWV3F5B8` | UI e2e `e2e/live/ldp.live.spec.ts` (selector "JSON-LD", Cross-device) | FLOW-03 → FLOW-31 | pass / `valid` | same; spec asserts tier 1, tier 2 and the label |

What the wallet sent (exchange `:13`, `POST …/v1/verify/v2/vp-submission/direct-post`, form `vp_token` + `state`): `vp_token={"pg":[VP]}`, VP proof `JsonWebSignature2020` (ES256, detached JWS), `verificationMethod` = the issuance holder `did:jwk:…#0`, `proofPurpose: authentication`, `challenge` = the request nonce, **`domain: "interop-playground"`** (the plain client ID). The credential inside keeps Certify's `Ed25519Signature2020` proof (`did:web:<PUBLIC_HOST>#…`). The open risk from build wave 8 (Verify might reject a plain-string `domain`; the research reproduction had only proven a `redirect_uri:` client ID) did not happen: the submission was accepted.

Verify's answers, verbatim from the run store (the `verifiableCredential` string inside `credentialResults` is left out here):

```
:13 POST /v1/verify/v2/vp-submission/direct-post   200 {}
:14 GET  /v1/verify/vp-request/<req>/status          200 {"status":"VP_SUBMITTED"}
:15 POST /v1/verify/v2/vp-results/<txn>             200 {"transactionId":"txn_82b6fcd4-b8dd-487c-b66e-1c89c4c44c7c","allChecksSuccessful":true,"credentialResults":[{"allChecksSuccessful":true,"schemaAndSignatureCheck":{"valid":true,"error":null},"expiryCheck":{"valid":true},"statusCheck":[],"claims":{},"holderProofCheck":{"valid":true,"error":null}}]}
:16 POST /v1/verify/v2/vc-verification              200 {"allChecksSuccessful":true,"schemaAndSignatureCheck":{"valid":true,"error":null},"expiryCheck":{"valid":true},"statusCheck":[],"claims":{}}
```

Judged result (ADR-96/97):
- Tier 1 (`vp.vc.verify`, Verify's `/v2/vc-verification` on the held credential): pass (`vc.signature` pass, `vc.expiry` pass).
- Tier 2 (`vp.result.poll`, the VP Verify received): pass (`vc.signature`, `vc.expiry`, `vp.holder-proof` pass; `allChecksSuccessful:true`, `holderProofCheck.valid:true`).
- Issuance (FLOW-03): every step pass incl. `vci.issuer.did` (did:web document resolved); the `vc.ldp.*` lints are `info` (Certify's `FarmerCredential` template keeps unfilled `${…}` placeholders for claims the mock identity does not have; reported, not judged).
- Verdict `pass`, verification `valid`; the UI run screen shows the format label "W3C VC (JSON-LD, ldp_vc)".

No adapter change was needed. **T-46 passes live.**

Reproduce: `scripts/up.sh`, then `npx playwright test -c e2e/playwright.live.config.ts ldp` (needs `npm ci` + `npx playwright install chromium`). Run reports: `docs/reports/01M5CDWNQDX53HC3YF288AFFFG.{json,md}`.
