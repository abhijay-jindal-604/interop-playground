# Gaps write-up (v1, 2026-10-20)

This is the list of interoperability gaps we found while researching and building Interop Playground. It covers the Inji stack (MOSIP Inji Certify, Inji Verify, Mimoto, Inji Web and the Inji libraries) and the peers we ran it against.

- **Versions.** Inji components are `1.0.0-alpha.1` unless a commit is named, eSignet is `1.8.0`, and walt.id is `1.1.0` (all pinned in `versions.lock`).
- **Evidence.** Each gap carries the research evidence ID (S-nnn) from our spike log. The public issue drafts will cite run IDs and a trimmed transcript instead, and they will be filed upstream by hand only.
- **Status** says what the build itself did with the gap:
  - **reproduced in build**: seen again on the bundle while building (build wave named).
  - **relied on**: the build encodes a rule, a workaround or a test fixture for it (a greyed-out selector cell with the gap ID, a fingerprint, a fake). The gap is not re-run as a finding.
  - **research only**: documented and reproduced in research. The submission build does not exercise it.
  - **pending**: the build exercises it in a task that has not finished yet.

v1 is written on 2026-10-20 from the research log and the merged build (waves 1 to 6). The issue drafts and the URLs of filed issues come in the final version.

## Group (a): Inji defects, drafted

| Draft | Gap(s)                       | Component                            | One-line statement                                                                                                                                                 | Evidence                              | Status                                                                                                       |
| ----- | ---------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| D-01  | G-109                        | inji-certify (224bef4)               | Returns 500 instead of 400 for a token request without `pre-authorized_code` (RFC 6749 §5.2) and for a proof with `alg=EdDSA` on an EC key (OID4VCI 1.0 §8.3.1.2). | S-189 (TMP-04, TMP-12)                | relied on: modelled in the Certify fake; listed in `ci/known-fails.json`; tamper mode not in v1              |
| D-02  | G-19                         | inji-verify (Collab and local)       | A tampered SD-JWT disclosure is reported as a missing claim and the credential is labelled `ldp_vc`.                                                               | S-020, S-022 (TMP-55)                 | research only                                                                                                |
| D-03  | G-18                         | inji-verify                          | An SD-JWT with a self-signed `x5c` is accepted with no trust anchor configured. Framed as a configuration question ("no trust framework configured").              | S-020 (predicted TMP-49)              | research only                                                                                                |
| D-04  | G-55                         | inji-verify                          | SD-JWT verification requires an `x5c` header and cannot resolve a `did:jwk` or JWK issuer key.                                                                     | S-077; walt.id `x5Chain` retest S-120 | relied on: FP-01 + KNOB-01, golden fixtures from S-077/S-120; **pending:** live fix-it re-run (T-44, wave 7) |
| D-05  | G-73, G-92, G-97             | vc-verifier (c46dd44, 1.9.0 lineage) | The KB-JWT `aud` rule rejects every client_id prefix that contains `_` (`x509_san_dns:`, `x509_hash:`, …).                                                         | S-116, S-160, S-161, S-170            | research only                                                                                                |
| D-06  | G-93                         | inji-verify on Collab                | Returns an unsigned request object for `x509_san_dns:` client_ids, where OID4VP 1.0 §5.9.3 requires a signed JAR.                                                  | S-162                                 | research only                                                                                                |
| D-07  | G-85                         | inji-verify on Collab                | A `decentralized_identifier:` JAR is signed with Verify's own did:web key while `iss` echoes the caller's DID.                                                     | S-140                                 | research only                                                                                                |
| D-08  | G-112                        | inji-openid4vp (cd98a07)             | Accepts only EdDSA request-object signatures, so it fails against EUDI (ES512) and signed walt.id (ES256) requests.                                                | S-195                                 | relied on: selector rule greys out the cell with G-112                                                       |
| D-09  | G-98, G-50                   | inji-openid4vp                       | Has no `x509_*` member in `ClientIdPrefix` and does not check the `client_id` prefix on unsigned requests.                                                         | S-071, S-170                          | research only                                                                                                |
| D-10  | G-41                         | inji-openid4vp                       | Sends no error to the verifier when validation fails before `response_uri` is parsed (for example, a malformed `response_mode`).                                   | S-051, S-070                          | research only                                                                                                |
| D-11  | G-14, G-15                   | inji-certify                         | Signs credentials that still contain unfilled Velocity placeholders; the metadata claims differ from the template fields.                                          | S-018                                 | relied on: a "quickstart sample" Certify configuration (KNOB-05 values) exists; the fingerprint is not in v1 |
| D-12  | G-88                         | inji-certify                         | The DID document lists the bare DID in `assertionMethod`/`authentication`, where DID Core 1.0 §5.3 wants the verification method's DID URL.                        | S-151                                 | research only                                                                                                |
| D-13  | G-23, G-24, G-26, G-28, G-95 | inji-certify (224bef4), `mso_mdoc`   | A `did:jwk:…#0` kid breaks the mDoc credential request; the output uses the legacy mDoc shape; element typing is wrong (three drafts).                             | S-026, S-029, S-166                   | relied on: selector rule for G-23; mDoc is not in v1 (T-48 cut)                                              |
| D-14  | G-104                        | inji-vci-client                      | A null proof callback surfaces as a wrapped NullPointerException instead of a typed argument error.                                                                | S-181                                 | research only                                                                                                |
| D-15  | G-29                         | vc-verifier 1.9.0 (cd5a1d7)          | Cannot parse the spec-shaped mDoc that Certify develop emits; the fix exists on develop but is in no release.                                                      | S-029                                 | research only                                                                                                |
| D-16  | G-115                        | inji-certify (224bef4)               | A wrong `tx_code` answers `invalid_request` instead of `invalid_grant` (OID4VCI 1.0 §6.3), and any failed attempt burns the pre-authorized code.                   | S-197 (TMP-06)                        | relied on: modelled in the Certify fake; listed in `ci/known-fails.json`; `tx_code` flow not in v1           |

## Group (b): documentation and configuration gaps

These are the gaps the v1 build reproduced or relies on:

| Gap   | One-line statement                                                                                        | Evidence     | Status                                                                                                                     |
| ----- | --------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| G-06  | Certify accepts tokens from one token issuer only, so pre-authorized issuance cannot work on Collab.      | S-008        | relied on: selector rule                                                                                                   |
| G-08  | Inji Web has no credential-offer (pre-authorized) support.                                                | S-011        | relied on: selector rule                                                                                                   |
| G-09  | Inji Verify has no `mso_mdoc` support.                                                                    | S-013        | relied on: selector rule; the Verify adapter has no mDoc query                                                             |
| G-10  | `vc-verification` takes the credential as a string; the docs also allow a JSON object, which is rejected. | S-014        | relied on: the Verify adapter sends a string                                                                               |
| G-13  | Presentation during issuance is broken on Collab.                                                         | S-198, S-207 | relied on: selector rule                                                                                                   |
| G-17  | A non-JSONPath `sdClaim` silently produces an SD-JWT with no disclosures.                                 | S-019        | relied on: the wallet's inspect step flags "no selectively disclosable claim"                                              |
| G-20  | The seeded `did_url` differs from the issuer DID in the quickstart.                                       | S-021, S-025 | reproduced in build: `up.sh` renders the per-config `didUrl` and `playground certify-didurl` re-asserts it (waves 1 and 2) |
| G-36  | The Collab guest Farmer download fails with a "technical error" (cause unknown).                          | S-025, S-106 | relied on: selector rule                                                                                                   |
| G-37  | Inji Wallet has no Credential Manager holder code, so it cannot answer the DC API.                        | S-041        | relied on: probe copy and selector rule; DC API probe not in v1                                                            |
| G-103 | The VCIClient offer flow refuses a non-https `credential_issuer` (spec-aligned, documentation note).      | S-179, S-181 | relied on: selector rule                                                                                                   |
| G-117 | Verify clears the `transaction_id` cookie on every results call, failures included.                       | S-202        | relied on: the capture cookie jar ignores a clearing cookie                                                                |
| G-118 | Verify rejects, at create time, a creator `nonce` shorter than 16 characters or outside `A-Za-z0-9-._~`.  | S-202        | relied on: the Verify adapter sends a 32-character nonce                                                                   |

Research only (documented, not exercised by v1): G-01, G-02, G-03, G-04, G-05, G-12/G-12b, G-16, G-21/G-22, G-25, G-27, G-38, G-39, G-51, G-68, G-99/G-100 (observed only, never drafted), G-106, G-107 (avoided by portless did:web, ADR-24), G-113, G-116, G-119, G-121, G-122.

## Group (c): external components, upstream image facts, our own gaps, not a gap

| Gap        | One-line statement                                                                                                                 | Evidence            | Status                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------- |
| G-59       | The EUDI verifier requires `cnf.jwk` and does not resolve Certify's `cnf.kid` (`did:jwk`). Closing it needs a Certify code change. | S-086, S-152, S-195 | relied on: decided diagnosis-only on 2026-10-13 (`docs/decisions.md`); EUDI not in v1 |
| G-53, G-54 | walt.id's default config crashes issuer-api2 (relative logo URIs) and disables anonymous pre-auth.                                 | S-075, S-076        | research only (the peers profile ships its own walt.id config)                        |
| G-125      | `postgres:bookworm` at the locked digest is PostgreSQL 18 and rejects the classic data-directory mount.                            | build wave 1        | reproduced in build; compose mounts the volume one level up                           |
| G-126      | `mosipid/oidc-ui:1.8.0` cannot be restarted in place (restart loop).                                                               | build wave 1        | reproduced in build; `up.sh` recreates it                                             |
| G-127      | vcverifier-jar 1.9.0 cannot verify an `ldp_vc` offline (it needs network access for JSON-LD contexts).                             | build wave 1        | reproduced in build (sidecar smoke); `ldp_vc` pending (T-46)                          |
| G-141      | `mosipid/mock-identity-system:0.13.0` crash-loops after a container restart (an `unzip` prompt with no TTY).                       | build wave 4        | reproduced in build; fixed in the compose entrypoint (wave 5)                         |
| G-153      | walt.id issuer-api2 1.1.0 serves its well-knowns only in the RFC 8414 inserted form; the suffix form answers 404.                  | build wave 6        | reproduced in build; the wallet uses the inserted form (wallet-compatibility fact)    |
| G-110      | Certify's `c_nonce` is not single-use, and access tokens survive a pre-auth-code replay. Spec-permitted: not a gap.                | S-189               | research only (shown as `lenient` in tamper mode, not in v1)                          |

Also in this group, research only:

- **External peers:** G-58, G-60, G-101 (EUDI); G-64, G-65 (Sphereon); G-84, G-86 (Credo); G-108 (verifiers split on the mDoc envelope); G-120 (EUDI `typeMetadata.policy`); G-63 (the Certify SD-JWT leaf certificate has no AKI).
- **Not a gap:** G-45 (did not reproduce), G-114 (our own DCQL path was wrong).
- **Our own errors:** G-32, G-40, G-105.
- **Plan and contract gaps found while building, all fixed or decided in the build:** G-123, G-124, G-128 (same as G-103), G-129 to G-137, G-139, G-140, G-143, G-144, G-147, G-151.

## Filed issues

TODO(user): the URL of each filed draft, added after filing by hand.
