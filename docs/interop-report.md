# Interop report (v1, 2026-10-20)

This report lists every issuer → wallet → verifier combination that Interop Playground ran on the local bundle up to 2026-10-20, with its outcome and the evidence behind it. v1 is an index of per-run reports (API-45). The generated suite and matrix report (API-46) is not part of this release.

- **Environment.** Local Docker bundle (`scripts/up.sh`), no tunnel, no Collab calls. Every image is digest-pinned in [`versions.lock`](../versions.lock).
- **Evidence.** Each cell names a run ID with its committed report, or the live test that reproduces it and its recording. Results that another build task has not shown yet are marked _pending_. Nothing here is claimed from research alone.
- **How the run reports were produced.** The two committed run reports come from the live T-44 run pair. Their recorded events ([`fixtures/golden/fixit/`](../fixtures/golden/fixit/)) were replayed through the product's own store, diagnosis engine and report generator, the same replay as `apps/bff/src/diagnosis/fixit.golden.test.ts`. The slice runs' IDs were not kept, so those cells cite the live e2e spec, which creates a new run and checks its report every time it runs.

## Versions

| Role                | Component                                            | Version label      | Digest (from `versions.lock`) |
| ------------------- | ---------------------------------------------------- | ------------------ | ----------------------------- |
| Issuer              | Inji Certify (`inji-certify-with-plugins`)           | `1.0.0-alpha.1`    | `sha256:1579b2449f1a`         |
| Issuer (peer)       | walt.id `issuer-api2`                                | `1.1.0`            | `sha256:e7f8a9ff6b22`         |
| Issuer (no traffic) | `issuer.fixture` (signs at run time)                 | playground `0.0.0` | n/a                           |
| Wallet              | Playground reference wallet (`wallet.playground-ts`) | playground `0.0.0` | n/a                           |
| Verifier            | Inji Verify service                                  | `1.0.0-alpha.1`    | `sha256:064fcfa12773`         |
| Authorization       | eSignet (`esignet-with-plugins`)                     | `1.8.0`            | `sha256:47fffdb5a451`         |

The run reports print the same version labels and short digests per role.

## Summary

Pass rate = (pass + lenient) / (pass + lenient + fail + blocked), counted per cell (08 §2). The FP-01 parent and its fixed child form one annotated cell (09 A9).

| Format                     | pass | lenient | fail | blocked | rate             | inconclusive / no-submission / not-run / n/a |
| -------------------------- | ---- | ------- | ---- | ------- | ---------------- | -------------------------------------------- |
| SD-JWT VC (`dc+sd-jwt`)    | 1    | 0       | 1    | 0       | 50.0 % (1/2)     | 0 / 0 / 2 / 0                                |
| W3C VC (JSON-LD, `ldp_vc`) | 0    | 0       | 0    | 0       | no denominator   | 0 / 0 / 1 / 0                                |
| mDoc (`mso_mdoc`)          | 0    | 0       | 0    | 0       | no denominator   | 0 / 0 / 0 / 1                                |
| **Overall**                | 1    | 0       | 1    | 0       | **50.0 % (1/2)** | 0 / 0 / 3 / 1                                |

The one `fail` is the walt.id cell without `x5c`. Changing only KNOB-01 makes it pass, and the cell is shown as fixed below. Issuance-only rows are listed separately and are not counted in the rate.

## Interop matrix: SD-JWT VC (`dc+sd-jwt`)

Rows are issuer and grant; the column is the wallet → verifier pair. Cross-device (QR) presentation.

| Issuer @ env, grant                              | Playground reference wallet → Inji Verify (local) |
| ------------------------------------------------ | ------------------------------------------------- |
| Inji Certify @ local, pre-authorized code        | PASS                                              |
| walt.id issuer-api2 @ local, pre-authorized code | FAIL FP-01 \* fixed by KNOB-01=present            |
| `issuer.fixture` @ local, no issuance traffic    | _pending wave 8 A_ (not-run)                      |
| `issuer.fixture` (expired credential) @ local    | _pending wave 8 A_ (not-run; VP-level expiry)     |

### Evidence per cell

| Cell                                  | Flows             | Evidence                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inji Certify → playground → Verify    | FLOW-04 + FLOW-30 | Live e2e [`e2e/live/slice.live.spec.ts`](../e2e/live/slice.live.spec.ts): selector → Start → **Pass**, diagram, key payloads, run report. Green 3× on a service subset (T-36, 2026-10-20), then after a clean `scripts/up.sh` (`npm run e2e:live -- slice`, 2026-10-20). Recording: [`deliverables/takes/m1-slice.webm`](../deliverables/takes/m1-slice.webm). Run IDs not kept. |
| walt.id → playground → Verify, parent | FLOW-08 + FLOW-30 | Run `01M5B6KNNY7DC3YK3CR0ETNBN9`: **FAIL** at `vp.verdict.evaluate`, `vc.signature` = `ERR_SIGNATURE_VERIFICATION_FAILED` ("getX509CertChain(...) must not be null"). FP-01 matches exactly (G-55) and offers KNOB-01. Report: [JSON](reports/01M5B6KNNY7DC3YK3CR0ETNBN9.json), [Markdown](reports/01M5B6KNNY7DC3YK3CR0ETNBN9.md).                                               |
| walt.id → playground → Verify, child  | FLOW-08 + FLOW-30 | Run `01M5B6M723AQ7T818D36816PRV`, derived from the parent with only KNOB-01 `absent` → `present`: **PASS**, classified `fixed`. Report: [JSON](reports/01M5B6M723AQ7T818D36816PRV.json), [Markdown](reports/01M5B6M723AQ7T818D36816PRV.md).                                                                                                                                      |
| walt.id pair (both runs)              | as above          | Golden replay `npx vitest run apps/bff/src/diagnosis/fixit.golden.test.ts` (2/2); live e2e [`e2e/live/fixit.live.spec.ts`](../e2e/live/fixit.live.spec.ts) green 4× on a subset and 3× on `scripts/up.sh --with peers` (T-44, 2026-10-20). Recording: [`deliverables/takes/m2-fixit.webm`](../deliverables/takes/m2-fixit.webm).                                                 |
| `issuer.fixture` cells                | FLOW-14 + FLOW-30 | Unit tests on recorded Inji Verify answers only. Live run pending (T-47, wave 8 A; `docs/evidence/T-47-vp-expired.md` once written).                                                                                                                                                                                                                                             |

The claim sentence of the fixed cell, verbatim from the child report: "issuer.waltid → wallet.playground-ts → verifier.inji-verify-local (dc+sd-jwt) fails because Inji Verify cannot verify an SD-JWT VC whose issuer key is not given as an x5c chain [FP-01, G-55]. Changing only waltid.sdjwt.x5c from absent to present makes it pass."

## Issuance only

| Issuer @ env, grant                              | Wallet                      | Flow    | Result | Evidence                                                                                                                                                                 |
| ------------------------------------------------ | --------------------------- | ------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Inji Certify @ local, pre-authorized code        | Playground reference wallet | FLOW-04 | PASS   | Issuance half of every slice run above (`vci.*` steps, `capture: full`).                                                                                                 |
| walt.id issuer-api2 @ local, pre-authorized code | Playground reference wallet | FLOW-08 | PASS   | Both T-44 runs (issuance passed in each); `BUNDLE_IT=1 npx vitest run apps/bff/src/main.waltid.bundle.int.test.ts` 2/2 with x5c absent and present (T-43, build wave 6). |

## Credential-level verification (Valid / Invalid / Valid-but-Expired)

| Credential (`issuer.fixture`) | Verifier          | Flow    | Expected label    | Result                                   |
| ----------------------------- | ----------------- | ------- | ----------------- | ---------------------------------------- |
| `PlaygroundSdJwt`             | Inji Verify local | FLOW-40 | Valid             | _pending wave 8 A_ (unit-tested mapping) |
| `PlaygroundSdJwtInvalid`      | Inji Verify local | FLOW-40 | Invalid           | _pending wave 8 A_ (unit-tested mapping) |
| `PlaygroundSdJwtExpired`      | Inji Verify local | FLOW-40 | Valid-but-Expired | _pending wave 8 A_ (unit-tested mapping) |

The label mapping (signature valid and expiry invalid gives Valid-but-Expired) is unit-tested on recorded Inji Verify responses in `packages/adapters/src/verifiers/inji-verify-local.test.ts`. A VP-level expired presentation (FLOW-30 with `PlaygroundSdJwtExpired`) is not claimed until its live run is recorded.

## W3C VC (JSON-LD, `ldp_vc`)

| Issuer @ env, grant                       | Playground reference wallet → Inji Verify (local)                                                               |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Inji Certify @ local, pre-authorized code | _pending_ (not-run): T-46, FLOW-03 + FLOW-31, being built in wave 8 B on recorded upstreams; live run in wave 9 |

## mDoc (`mso_mdoc`)

| Issuer @ env, grant | Any wallet → Inji Verify (local)                                                           |
| ------------------- | ------------------------------------------------------------------------------------------ |
| any                 | n/a: Inji Verify has no `mso_mdoc` path (G-09). mDoc issuance (T-48) is cut on 2026-10-20. |

## Greyed-out combinations

The selector shows these as unavailable instead of running them. Rule-based cells carry a gap ID (rules in [`apps/bff/src/orchestrator/rules.ts`](../apps/bff/src/orchestrator/rules.ts)).

| Combination                                                         | Reason                                                                              | Gap / decision                                 |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------- |
| any `mso_mdoc` → Inji Verify                                        | Inji Verify has no `mso_mdoc` path.                                                 | G-09                                           |
| Collab Certify, pre-authorized code                                 | Collab Certify does not offer pre-authorized issuance.                              | G-06                                           |
| Inji Web wallet × pre-authorized code                               | Inji Web has no offer entry.                                                        | G-08                                           |
| Collab Certify × any wallet other than Inji Web                     | Collab issuance runs only through Inji Web.                                         | G-36                                           |
| Inji JVM wallet × `mso_mdoc`                                        | `mso_mdoc` through VCIClient is not offered (needs a `did:jwk` proof).              | G-23                                           |
| Inji JVM wallet × Certify auth-code, Certify mDoc or walt.id issuer | VCIClient refuses http issuers.                                                     | G-103                                          |
| Inji JVM wallet × EUDI verifier                                     | the openid4vp library accepts only EdDSA request objects; EUDI signs with ES512.    | G-112                                          |
| DC API probe                                                        | runs through the Verify SDK; Inji Wallet has no DC API holder code.                 | G-37                                           |
| Presentation during issuance outside the local pre-auth issuer      | only the local pre-auth issuer with the reference wallet.                           | G-13                                           |
| Inji JVM wallet → walt.id verifier                                  | kept greyed after the RISK-38 decision (signed-request process never smoke-tested). | `docs/decisions.md` 2026-10-20, RISK-38        |
| Every adapter not built in this release                             | "not in this release (docs/decisions.md 2026-10-20)"                                | `docs/decisions.md` 2026-10-20 submission cuts |

Adapters built in this release: `issuer.certify-preauth`, `issuer.waltid`, `issuer.fixture`, `wallet.playground-ts`, `verifier.inji-verify-local`. The others in the catalog (Inji Certify auth-code, mDoc and Collab issuers; the Inji JVM, Inji Web, phone and Credo wallets; Collab Verify, the Verify SDK, the offline vc-verifier, and the walt.id, EUDI and Credo verifiers) are not in this release. _Pending wave 8 A:_ the selector and API-02/API-03 show them as unavailable with that reason; until then, Start answers `adapter_unavailable`.

## Not run, and why

- `issuer.fixture` cells and the three REQ-23 labels: the live run is wave 8 A's task (T-47).
- `ldp_vc`: T-46 is being built in wave 8 on recorded upstreams; its live run is wave 9.
- Tamper mode, suites, the nightly matrix and Collab Verify are not in this release (`docs/decisions.md` 2026-10-20). The known upstream tamper failures are listed in [`ci/known-fails.json`](../ci/known-fails.json) for when tamper mode ships.
