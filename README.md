# Interop Playground

Interop Playground lets you run Inji issuer → wallet → verifier combinations, inspect every protocol message, and prove the fix for a failure with a re-run that changes one knob.

> **v1 draft (2026-10-20).** This README describes only what is built and tested on that date. Results that are still pending are marked _pending_. Screenshot: TODO(wave 8): run screen (UI-09) with the diagram and inspector visible, taken from the T-36 recording ([`deliverables/takes/m1-slice.webm`](deliverables/takes/m1-slice.webm)).

## What it does

- **Combination selector.** Pick an issuer, a wallet and a verifier. Combinations that cannot work are greyed out, with the reason and a gap ID.
- **Live issue and present flows.** OID4VCI 1.0 pre-authorized-code issuance and OID4VP 1.0 cross-device presentation, run against real Inji services in Docker.
- **Protocol inspector.** Every HTTP exchange of a run, with decoded SD-JWT disclosures, JOSE headers and a key-payload bar. Each hop is labelled with how complete its capture is (`full`, `partial` or `none`).
- **Per-run report.** JSON and Markdown (API-45): fields, checks, diagnosis, fix-it result, coverage and steps.
- **Fix-it re-runs (the original angle).** When a failure matches a known fingerprint and a proven knob exists, one click re-runs the same run with exactly that knob changed and reports whether it fixed the failure.

## Quickstart

Host prerequisites: Docker 29 with the compose plugin, bash, openssl, `ss` and curl. Port 443 must be free on the host. With rootless Docker, allow binding port 443 first (`scripts/up.sh` prints the sysctl command if it is needed).

```bash
git clone TODO(user): repository URL
cd interop-playground
scripts/up.sh            # idempotent; a second run on a healthy bundle changes nothing
# open http://127.0.0.1:3100
```

`scripts/up.sh --help` lists the flags (`--mode local|collab`, `--with peers|mdoc-spec|iae|debug`, `--reset`, `--no-build`, …). `scripts/down.sh` stops the bundle and keeps the volumes.

**What has been verified so far.**

- `scripts/up.sh --reset` from no containers exits 0 in about 2.5 minutes. It onboards eSignet, re-asserts the Certify `didUrl` and runs the guest-smoke download (build waves 2 and 3).
- The slice e2e (below) passed 3 times on a service subset, chosen because of host RAM:

  ```bash
  docker compose -p interop-playground --env-file .env --env-file .env.local up -d --wait \
    bff certify-preauth certify-preauth-db certify-preauth-nginx verify-service verify-db
  ```

- _Pending (wave 7/8):_ a clean full `scripts/up.sh` run, followed by the slice, and the "fresh clone to a FLOW-30 Pass in ≤ 30 min" timing.

## Your first run

1. On `/`, pick **Inji Certify (pre-authorized)**, then **Playground reference wallet**, then **Inji Verify (local)**.
2. Pick the format **SD-JWT VC** and the mode **Cross-device (QR)**, then press **Run**.
3. The run screen shows the sequence diagram as messages move. The result card reads **Pass**.
4. Open a step in the inspector. The key-payload bar shows the credential offer, the token, the proof JWT, the SD-JWT with its disclosures, the KB-JWT and the verifier result.
5. **Report** opens the per-run report (Markdown and JSON tabs, downloads).

The same path runs automatically against the live bundle: `npm run e2e:live` (`e2e/live/slice.live.spec.ts`).

## Architecture

```
 browser ──REST + SSE──▶  BFF (Node 22, Fastify)  ◀── wallet / verifier callbacks
  React 18 UI             ├─ orchestrator + scheduler (immutable RunSpecs)
  (served by the BFF)     ├─ adapters (issuers, wallets, verifiers)
                          ├─ capture layer (outbound HTTP) + edge gateway (inbound legs)
                          ├─ event sink → SQLite event log → SSE stream
                          ├─ diagnosis engine (fingerprints) + derive (one-knob re-runs)
                          └─ JVM sidecar (Inji Kotlin libraries), Docker network
                                   │
          Inji Certify · Inji Verify · Mimoto · eSignet · walt.id (peers profile) …
```

- **Capture is orchestration.** The BFF makes every outbound call itself. Inbound legs (wallet to issuer, wallet to verifier) pass through an allowlisting edge gateway. Each hop says whether its capture is `full`, `partial` or `none` (ADR-19).
- **Events.** Each step is persisted, then published. The UI follows a run over Server-Sent Events and replays it exactly from the stored log (ADR-20, ADR-36).
- **Immutable runs.** A run is a `RunSpec`. A fix-it re-run is a derived `RunSpec` with exactly one knob changed and a link to its parent (ADR-21).
- **Store.** SQLite (`better-sqlite3`) through a single sink that redacts secrets before anything is written. Holder private keys stay in one table and are never exported.
- **Network.** Inji services publish no ports. The BFF gateway is the only listener, behind a local CA for in-machine https (ADR-22).
- **Collab.** The public Collab sandbox is never written to (ADR-13). Collab mode is not part of v1 (see Known limitations).

Repository layout: `apps/bff` (BFF and `playground` CLI), `apps/ui` (web UI), `packages/adapters`, `packages/api` (contracts, OpenAPI, generated client), `packages/testkit` (fakes, fixtures, golden runner), `sidecar/` (Gradle, Inji JVM libraries), `compose.yaml` + `docker/`, `flows/`, `fingerprints/`, `fixtures/`, `scripts/`.

## Shipped flows

| Flow    | Picks                                                              | Format      | Grant / mode               | Tier      | Expected                                                                             |
| ------- | ------------------------------------------------------------------ | ----------- | -------------------------- | --------- | ------------------------------------------------------------------------------------ |
| FLOW-01 | Inji Certify (pre-authorized) → Playground reference wallet        | (skeleton)  | pre-authorized, no tx_code | automated | issuance reference skeleton, which FLOW-04 extends                                   |
| FLOW-04 | Inji Certify (pre-authorized) → Playground reference wallet        | `dc+sd-jwt` | pre-authorized             | automated | credential issued, `capture: full`                                                   |
| FLOW-30 | … → Inji Verify (local)                                            | `dc+sd-jwt` | cross-device QR            | automated | **Pass**, Valid (live e2e green 3×)                                                  |
| FLOW-08 | walt.id issuer-api2 → Playground reference wallet (`--with peers`) | `dc+sd-jwt` | pre-authorized (by value)  | automated | issued; KNOB-01 switches the issuer key form (x5c absent/present), verified live 2/2 |
| FLOW-14 | Fixture credential                                                 | `dc+sd-jwt` | no traffic                 | automated | _pending (T-47, wave 7)_                                                             |
| FLOW-40 | Fixture credential → credential-level verification                 | `dc+sd-jwt` | no OID4VP                  | automated | _pending (T-47)_: Valid / Invalid / Valid-but-Expired                                |

The selector greys out combinations that the build rules out, each with its gap ID: no `mso_mdoc` at Inji Verify (G-09), pre-auth on Collab (G-06), no credential-offer support in Inji Web (G-08), the VCIClient https rule (G-103), and EdDSA-only request objects in the openid4vp library (G-112).

## Fix-it re-runs (the original angle)

A **fingerprint** describes a known failure: the step and exchange where it shows, the evidence it needs, the spec clause, and the component that deviates. After a failed run, the diagnosis engine reads only the persisted events and artifacts.

- **Exact match plus a proven knob:** the diagnosis card offers **one** button. It has no confirm dialog and re-runs the parent with that single knob changed.
- **Several possible causes, or evidence from a `partial` hop:** the card lists them. No button is offered.
- **No match:** "unclassified". No button is offered.

The child run is classified as `fixed`, `moved`, `not-fixed` or `inconclusive`. The compare strip shows the knob's direct effect first, and the claim sentence comes verbatim from API-31.

**Worked example: FP-01 + KNOB-01 (G-55).** Inji Verify alpha.1 requires an `x5c` header on SD-JWT credentials and rejects an issuer key given only as `did:jwk` or a JWK. A walt.id-issued credential without `x5c` fails at Inji Verify, and FP-01 matches exactly. The knob KNOB-01 ("changed walt.id issuance option") adds the `x5Chain`, and the child run passes. The golden fixtures (recorded research traces) and the fixture e2e (`e2e/angle.spec.ts`) cover this. _Pending (T-44, wave 7):_ the live parent and child run on the bundle, with links to both run reports.

## Formats and labels

| Label in the UI            | Status in v1                                             |
| -------------------------- | -------------------------------------------------------- |
| SD-JWT VC (`dc+sd-jwt`)    | issuance and cross-device presentation, live             |
| W3C VC (JSON-LD, `ldp_vc`) | _pending_: attempted in wave 8 only if T-47 lands (T-46) |
| mDoc (`mso_mdoc`)          | not in v1 (cut 2026-10-20, see `docs/decisions.md`)      |

Verifier results use the labels **Valid**, **Invalid** and **Valid-but-Expired** (REQ-23). The mapping is unit-tested on recorded Inji Verify responses. _Pending:_ the three fixture runs (T-47).

## Reports

Each terminal run has a report: `GET /api/v1/reports/runs/{runId}?format=json|markdown`, plus the `/runs/:id/report` view. It is generated from the stored events, so the redaction rules apply. _Pending (wave 8):_ `docs/interop-report.md` v1, an index of run reports for the shipped combinations.

## Spec targets and versions

| Spec / component | Version                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| OID4VCI          | 1.0 final                                                                                                                    |
| OID4VP           | 1.0 final, DCQL                                                                                                              |
| SD-JWT VC        | `dc+sd-jwt` (IETF SD-JWT VC draft -19, RFC 9901)                                                                             |
| Inji             | Certify, Verify, Mimoto, Inji Web `1.0.0-alpha.1`; eSignet `1.8.0`; one digest-pinned develop-class Certify (not used in v1) |
| Peers            | walt.id issuer-api2 / verifier-api2 `1.1.0`, EUDI verifier endpoint `v0.11.0` (only walt.id issuance is wired in v1)         |

Every image is pinned in `versions.lock`. The problem statement names earlier OpenID drafts. We implement the finals, and any draft behaviour is reported only as a labelled observation.

## Security notes

- Inji admin APIs are unauthenticated, so nothing is published beyond the gateway's allowlisted listeners. The gateway hard-denies admin paths.
- Secrets live only in the generated `.env.local` (mode 0600). The store sink redacts secrets before it persists anything, and `npm run store:scan` checks the store for leaks.
- Holder private keys never leave the `holder_keys` table and are never exported.
- No tunnel is started by default.

## Known limitations

From [`docs/decisions.md`](docs/decisions.md) (decision days 2026-10-13 and 2026-10-20):

- **One wallet, one live verifier.** v1 has the Playground reference wallet and the local Inji Verify only. The Inji JVM wallet, Inji Web, the phone wallet, Credo, Collab Verify, the Verify SDK, and the walt.id and EUDI verifiers are not built. Starting a run with one of them answers "not built yet".
- **Formats.** No mDoc (T-48 cut). `ldp_vc` is pending (see above).
- **Fix-it re-runs.** One fingerprint (FP-01) and one knob (KNOB-01) only. The G-59 knob is diagnosis-only, because Certify hardcodes `cnf.kid`.
- **Not in v1:** tamper mode, suites, the interop matrix, nightly CI against Collab, issue drafts, `tx_code`, auth-code issuance, presentation during issuance, same-device presentation, the tunnel and the DC API probe. If tamper mode ships later, the 33 tamper cells with no observation carry `expectation: unverified`, and the known upstream fails are listed in [`ci/known-fails.json`](ci/known-fails.json).
- **Collab mode** (`--mode collab`) exists in `up.sh`, but no Collab adapter is built in v1.
- **Bundle size.** The full `local` profile needs several GB of RAM. The acceptance runs used the service subset shown in the Quickstart.

## Gaps we found

We reproduced or relied on known gaps in the Inji stack while building, and documented each one with evidence. Examples: Inji Verify requires `x5c` on SD-JWTs (G-55), Certify returns 500 where the spec needs 400 (G-109), and Certify's `tx_code` errors use the wrong code (G-115). The full list is in [`docs/gaps.md`](docs/gaps.md). Issues are filed upstream by hand only.

## Tech stack and the problem statement's recommended stack

| Area      | Choice                                                                    | Note                                          |
| --------- | ------------------------------------------------------------------------- | --------------------------------------------- |
| Backend   | Node 22, TypeScript, Fastify, `better-sqlite3`                            | the BFF drives every role                     |
| UI        | React 18, Vite 7, React Router, Mermaid (built-in SVG fallback), `qrcode` | no Tailwind; plain CSS tokens, light and dark |
| Live data | Server-Sent Events, REST commands                                         | no WebSocket                                  |
| Inji libs | JVM sidecar (Gradle) with the Inji Kotlin libraries                       | built; not used by v1 flows                   |
| Stack     | Docker Compose, one `scripts/up.sh`                                       | images pinned in `versions.lock`              |

## Development and tests

```bash
npm ci
npm run lint        # eslint + no-GitHub-write lint + secret scan + flow validation
npm run typecheck   # tsc -b
npm test            # vitest: unit, contract, integration, repo projects
npm run test:ui     # UI component tests
npm run e2e         # Playwright on fixture routes (axe, 320–1440 px, light + dark)
npm run e2e:live    # Playwright against the running bundle
```

At the build wave 6 merge, `npm test` reported 615 tests passing (7 skipped) and the fixture Playwright suite 54 passing. Bundle integration tests are opt-in (`BUNDLE_IT=1`).

## Documents

- [`docs/overview.md`](docs/overview.md): 1–2 page overview (v1 outline)
- [`docs/gaps.md`](docs/gaps.md): gaps write-up (v1)
- [`docs/decisions.md`](docs/decisions.md): dated decision log
- `docs/interop-report.md`: _pending (wave 8)_

## References

TODO(wave 8): the Inji documentation and repository links (REQ-42, REQ-43), one line each.

## Credits

Built by TODO(user): names.

## License

TODO(user): license, chosen at publication (T-56).
