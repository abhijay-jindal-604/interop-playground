# Interop Playground: test data

_v1, 2026-10-21. Team Bhrinjal (Abhijay Jindal)._

This page lists every piece of sample data you need to test the playground: identities, credential configurations, test keys, recorded runs and the settings each flow uses. **All of it is test data.** Nothing here is a real person, a real credential or a production key.

You do not have to create accounts or type credentials anywhere. `scripts/up.sh` seeds every identity and configuration, and the BFF fills in claims and keys for each run.

## Contents

- [Secrets: generated, never committed](#secrets-generated-never-committed)
- [Identities and personas](#identities-and-personas)
- [Credential configurations](#credential-configurations)
- [Claims used per run](#claims-used-per-run)
- [Fixture issuer and test keys](#fixture-issuer-and-test-keys)
- [walt.id peer configuration](#waltid-peer-configuration)
- [Recorded runs and traces](#recorded-runs-and-traces)
- [Which flow uses what](#which-flow-uses-what)

## Secrets: generated, never committed

`scripts/up.sh` generates every secret and every key on the host the first time it runs. They are listed in `.gitignore`, and `npm run check:secrets` (part of `npm run lint`) fails if one is committed.

| File (generated)                           | What it is                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `.env.local` (mode 0600)                   | `ESIGNET_KEYSTORE_PASSWORD`: random password of Mimoto's OIDC keystore                         |
| `.env`                                     | non-secret settings copied from [`.env.example`](../.env.example), with `PUBLIC_HOST` detected |
| `certs/playground-ca.{key,pem}`            | the local certificate authority for in-machine https                                           |
| `certs/gateway.{key,pem}`                  | the gateway's TLS certificate for `PUBLIC_HOST`, `localhost` and `127.0.0.1`                   |
| `certs/bff-admin.token`                    | the `X-Admin-Token` of `POST /api/v1/internal/tunnel`                                          |
| `certs/peers/waltid-issuer.{key,pem}`      | the P-256 key and self-signed certificate KNOB-01 hands to walt.id                             |
| `certs/peers/waltid-verifier-ed25519.json` | a walt.id verifier key (peers profile; no v1 flow uses it)                                     |
| `certs/jvm-truststore.p12`                 | the playground CA for the Java services                                                        |

`scripts/up.sh --rotate-ca` regenerates all of `certs/`. The store sink redacts these values before anything is written to the run database, and `npm run store:scan` checks the database for leaks.

## Identities and personas

**eSignet mock identity system.** `scripts/up.sh` runs `playground esignet-onboard`, which creates two personas in the mock identity system ([`PERSONAS` in `apps/bff/src/config/bringup.ts`](../apps/bff/src/config/bringup.ts)):

| Individual ID | Name             | Used by                                                               |
| ------------- | ---------------- | --------------------------------------------------------------------- |
| `2154189532`  | Gorge Cooper     | the bring-up smoke test (eSignet login, then a Mimoto guest download) |
| `8267411578`  | James Rodrigious | seeded; not used by an automated step                                 |

The login uses the mock plugin's fixed OTP `111111`. The PIN, password and other profile fields of the personas are fixed test values in `personaRequest()` in the same file. No v1 run logs in through eSignet; this path only proves the bundle came up.

**Farmer registry (Inji Certify mock data provider).** [`docker/config/certify-common/farmer_identity_data.csv`](../docker/config/certify-common/farmer_identity_data.csv) holds three farmer records (`2154189532` Gorge Cooper, `8267411578` James Rodrigious, `5860356276` Jane Thompson). Certify's CSV data provider looks the logged-in subject up by its `id`, which is why the personas use the same IDs. The `iae` profile has its own copy in `docker/config/certify-iae/`.

**Holder (wallet) keys.** The Playground reference wallet creates one fresh ES256 key per root run and reuses it for that run's fix-it children. The private key stays in the `holder_keys` table of the run database and is never exported or put into an event (test: "the holder private key never appears in an event or an exchange" in [`packages/adapters/src/wallets/playground-ts.test.ts`](../packages/adapters/src/wallets/playground-ts.test.ts)).

## Credential configurations

The configurations each issuer offers, as served by `GET /api/v1/configurations` ([`CREDENTIAL_CONFIGURATIONS` in `packages/adapters/src/catalog.ts`](../packages/adapters/src/catalog.ts)). Rows marked v1 are the ones the shipped flows use.

| Issuer                        | Format      | Configuration ID           | Default | Type / `vct`            | In v1                                                       |
| ----------------------------- | ----------- | -------------------------- | ------- | ----------------------- | ----------------------------------------------------------- |
| Inji Certify (pre-authorized) | `dc+sd-jwt` | `PlaygroundSdJwt`          | yes     | `PlaygroundSdJwt`       | yes (FLOW-04, FLOW-30)                                      |
| Inji Certify (pre-authorized) | `ldp_vc`    | `FarmerCredential`         | yes     | `FarmerCredential`      | yes (FLOW-03, FLOW-31)                                      |
| Inji Certify (pre-authorized) | `mso_mdoc`  | `DrivingLicenseCredential` | yes     | `org.iso.18013.5.1.mDL` | no (mDoc is not in v1)                                      |
| walt.id issuer-api2           | `dc+sd-jwt` | `identityCredentialSdJwt`  | yes     | `identity_credential`   | yes (FLOW-08, `--with peers`)                               |
| Fixture issuer                | `dc+sd-jwt` | `PlaygroundSdJwt`          | yes     | `PlaygroundSdJwt`       | yes: signs a **valid** credential                           |
| Fixture issuer                | `dc+sd-jwt` | `PlaygroundSdJwtInvalid`   | no      | `PlaygroundSdJwt`       | yes: signature broken (one bit flipped)                     |
| Fixture issuer                | `dc+sd-jwt` | `PlaygroundSdJwtExpired`   | no      | `PlaygroundSdJwt`       | yes: `iat` two days ago, `exp` one day ago, signature valid |

The Certify configuration files that `scripts/up.sh` loads are in [`docker/config/certify-preauth/credential-configs/`](../docker/config/certify-preauth/credential-configs/):

- `PlaygroundSdJwt.json`: SD-JWT VC, ES256 (P-256), scope `playground_sdjwt`, selectively disclosable `fullName`, `dateOfBirth`, `gender`, `email`.
- `FarmerCredential.json.tmpl`: W3C VC (JSON-LD), `Ed25519Signature2020`, scope `mock_identity_vc_ldp`, issuer `did:web:<PUBLIC_HOST>` (filled in at bring-up).
- `DrivingLicenseCredential.json`: mDL; seeded but not used in v1.
- `*.knobNN-<value>.json`: the issuer-side knob variants (for example `PlaygroundSdJwt.knob04-plain.json`, the plain `sdClaim` syntax). Certify creates a variant only when a run sets that knob.

## Claims used per run

Pre-authorized issuance needs no login: the BFF sends the subject's claims when it mints the offer. With no claims in the request it uses these values ([`DEFAULT_CLAIMS` in `packages/adapters/src/issuers/certify-preauth.ts`](../packages/adapters/src/issuers/certify-preauth.ts)):

| Configuration      | Claims                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `PlaygroundSdJwt`  | `fullName` "Asha Rao", `dateOfBirth` "1994-03-12", `gender` "Female", `email` "asha@example.org"    |
| `FarmerCredential` | `fullName` "Playground Farmer", `phone` "9999999999", `dateOfBirth` "1990-01-01", `gender` "Female" |

The fixture issuer signs `fullName` "Priya Sharma", `dateOfBirth` "1995-04-12", `gender` "Female" ([`packages/adapters/src/issuers/fixture-mint.ts`](../packages/adapters/src/issuers/fixture-mint.ts)). The verifier's DCQL query asks for `fullName` by default; for the walt.id credential it asks for `birthdate`.

## Fixture issuer and test keys

The fixture issuer (`issuer.fixture`) signs an SD-JWT VC at run time without any issuance traffic. It lets you test the three verifier labels (Valid, Invalid, Valid-but-Expired) on demand, and it needs no external service except Inji Verify.

| File                                                                                      | Content                                            | Note                                                         |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------ |
| [`fixtures/credentials/fixture-issuer.json`](../fixtures/credentials/fixture-issuer.json) | ES256 issuer key and its `x5c` certificate         | **TEST-ONLY** throwaway key (the file says so in `_comment`) |
| [`fixtures/credentials/fixture-holder.json`](../fixtures/credentials/fixture-holder.json) | ES256 holder key with its public JWK               | **TEST-ONLY** throwaway key                                  |
| [`fixtures/credentials/sdjwt-valid.txt`](../fixtures/credentials/sdjwt-valid.txt)         | an `x5c`-signed, key-bound SD-JWT VC without `exp` | used by unit tests                                           |
| [`fixtures/credentials/sdjwt-expired.txt`](../fixtures/credentials/sdjwt-expired.txt)     | the same with an `exp` before 2021-01-01           | used by unit tests                                           |

These are the only committed private keys, and `scripts/check-secrets.allow` allows exactly this directory. Do not reuse them anywhere else. The issuer is `https://fixture-issuer.interop-playground.test`, a name that cannot resolve.

walt.id's own public sample keys appear in its service configuration templates under [`docker/config/waltid-issuer/`](../docker/config/waltid-issuer/) and [`docker/config/waltid-verifier/`](../docker/config/waltid-verifier/), copied verbatim from upstream. The EUDI verifier keystore in `docker/config/eudi/` is upstream test material for a verifier that is not in v1.

## walt.id peer configuration

`scripts/up.sh --with peers` adds walt.id issuer-api2 and verifier-api2 `1.1.0` (digests in [`versions.lock`](../versions.lock)). Configuration: [`docker/config/waltid-issuer/`](../docker/config/waltid-issuer/) (issuer metadata, issuer service, profiles). Only the issuer is wired into v1 runs.

- Offer: pre-authorized code, offer by value, profile `identityCredentialSdJwt`.
- **KNOB-01 `waltid.sdjwt.x5c`**: `absent` (default, walt.id's shipped behaviour: the issuer key is a bare `did:jwk`, no `x5c`) or `present` (the BFF sends the key and certificate from `certs/peers/waltid-issuer.{key,pem}` as `runtimeOverrides`, so the credential header carries `x5c`). Inji Verify rejects the first and accepts the second; that is the fix-it example (G-55).

## Recorded runs and traces

Recorded data lets the unit, contract and UI tests run without Docker.

| Location                                                                                                                                                                                                                                                             | What it holds                                                                                                                                                                                                | Used by                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| [`fixtures/events/`](../fixtures/events/)                                                                                                                                                                                                                            | four complete event logs: `FLOW-01-pass` (JSON-LD issuance), `FLOW-04-pass` (SD-JWT issuance), `FLOW-30-pass` (issuance and presentation, Valid) and `FLOW-30-fail` (presentation rejected at `direct_post`) | stream and store tests, UI run-screen tests (live and replay reach the same state), the fixture Playwright suite                   |
| [`fixtures/golden/fixit/`](../fixtures/golden/fixit/)                                                                                                                                                                                                                | the event logs of the live fix-it pair `01M5B6KNNY7DC3YK3CR0ETNBN9` → `01M5B6M723AQ7T818D36816PRV`                                                                                                           | `apps/bff/src/diagnosis/fixit.golden.test.ts`                                                                                      |
| [`fixtures/golden/diagnosis/`](../fixtures/golden/diagnosis/)                                                                                                                                                                                                        | recorded walt.id → Inji Verify traces without and with `x5c`                                                                                                                                                 | `apps/bff/src/diagnosis/diagnosis.golden.test.ts`, derive contract tests                                                           |
| [`fixtures/golden/traces/`](../fixtures/golden/traces/)                                                                                                                                                                                                              | recorded HTTP traces of issuance (Certify pre-auth, eSignet auth code) and presentation (valid, bad nonce, bad audience, wrong `vct`, replay, tampered disclosure, missing or expired key binding)           | the Inji Verify adapter tests, the builder of `fixtures/events/` (`packages/testkit/src/events/build.ts`), the opt-in bundle tests |
| [`fixtures/golden/peers/`](../fixtures/golden/peers/), [`sessions/`](../fixtures/golden/sessions/), [`sidecar/`](../fixtures/golden/sidecar/), [`s060/`](../fixtures/golden/s060/), [`collab/`](../fixtures/golden/collab/), [`tamper/`](../fixtures/golden/tamper/) | recorded walt.id and EUDI requests, OID4VP session logs, sidecar runs, the sidecar smoke credential, public Collab well-known documents, tamper baselines                                                    | adapter tests, the CI sidecar smoke, future features                                                                               |
| [`fixtures/ldp/`](../fixtures/ldp/)                                                                                                                                                                                                                                  | a recorded JSON-LD credential, VP and Inji Verify results                                                                                                                                                    | `packages/adapters/src/wallets/ldp.test.ts`, `playground-ts.ldp.test.ts`                                                           |
| [`fixtures/golden/manifest.json`](../fixtures/golden/manifest.json)                                                                                                                                                                                                  | the SHA-256 of every golden file                                                                                                                                                                             | `packages/testkit/src/golden/runner.test.ts` fails on a changed, missing or unlisted file                                          |
| [`packages/adapters/src/issuers/waltid.recorded.json`](../packages/adapters/src/issuers/waltid.recorded.json)                                                                                                                                                        | recorded walt.id mint answers                                                                                                                                                                                | `waltid.test.ts`                                                                                                                   |
| [`docs/reports/`](reports/)                                                                                                                                                                                                                                          | the reports of the live runs cited in the README (JSON and Markdown)                                                                                                                                         | reference results                                                                                                                  |

The golden files come from throwaway local stacks and public well-known documents; the manifest notes that they contain no private keys.

## Which flow uses what

| Flow              | Combination                                              | Data it uses                                                                                             |
| ----------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| FLOW-04 → FLOW-30 | Inji Certify → reference wallet → Inji Verify, SD-JWT VC | `PlaygroundSdJwt`, the Asha Rao claims, a fresh holder key                                               |
| FLOW-03 → FLOW-31 | the same, JSON-LD                                        | `FarmerCredential`, the Playground Farmer claims, Certify's Ed25519 key, the issuer's `did:web` document |
| FLOW-08 → FLOW-30 | walt.id → reference wallet → Inji Verify                 | `identityCredentialSdJwt`, KNOB-01, `certs/peers/waltid-issuer.{key,pem}`                                |
| FLOW-14 → FLOW-40 | fixture issuer → Inji Verify, credential only            | `PlaygroundSdJwt`, `PlaygroundSdJwtInvalid` or `PlaygroundSdJwtExpired`, the fixture issuer key          |
| FLOW-14 → FLOW-30 | fixture issuer → reference wallet → Inji Verify          | the expired fixture credential presented over OID4VP                                                     |
| bring-up only     | eSignet → Mimoto guest download                          | persona `2154189532`, OTP `111111`, the farmer CSV                                                       |

Run them from the UI (see the README "Your first run") or with the API examples in [`docs/api.md`](api.md#end-to-end-use-cases).
