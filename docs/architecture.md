# Architecture

_v1, 2026-10-21. Four diagrams of how Interop Playground is built. Each one names the source files it describes. The README section [Architecture](../README.md#architecture) has the same facts in short form._

The diagrams are SVG files in [`diagrams/`](diagrams/). Each has its own white background, so it reads the same on a light or a dark page.

## 1. System and components

![Component diagram: the browser talks to one BFF process over REST and SSE; the BFF hosts the routes, orchestrator and scheduler, adapters, capture layer, edge gateway, event sink with the SQLite event log, diagnosis and derive, and the report generator; Inji Certify, Inji Verify, Mimoto with Inji Web, eSignet with mock identity, the walt.id peers and the JVM sidecar run in Docker](diagrams/architecture-components.svg)

| Component                     | What it does                                                                                                                                                                           | Code                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Web UI                        | React 18 single-page app, served by the BFF at `http://127.0.0.1:3100`. It talks only to the BFF (REST commands, Server-Sent Events).                                                  | `apps/ui/src`                                                   |
| BFF                           | One Node 22 TypeScript process (Fastify). The only component that holds secrets and calls the Inji services and peers.                                                                 | `apps/bff/src/server.ts`, `apps/bff/src/main.ts`                |
| Orchestrator + scheduler      | Turns an immutable `RunSpec` into ordered steps (from the flow files in `flows/`), calls the adapters, applies knobs, emits events.                                                    | `apps/bff/src/orchestrator`                                     |
| Adapters                      | One adapter per issuer, wallet and verifier. The Playground reference wallet runs in-process.                                                                                          | `packages/adapters/src/{issuers,wallets,verifiers}`             |
| Capture (`CapturingHttp`)     | Records every outbound call the BFF makes as `exchange.*` events (`full` capture).                                                                                                     | `apps/bff/src/capture`                                          |
| Edge gateway                  | The only listener. Carries the inbound legs (wallet to issuer, wallet to verifier, service-to-service calls) through an allowlist; admin paths are hard-denied.                        | `apps/bff/src/gateway`                                          |
| Event sink + SQLite event log | Redacts secrets, then persists each event (`better-sqlite3`); only then is the event published. Holder private keys stay in one table and are never exported.                          | `apps/bff/src/store`, `apps/bff/src/redact`                     |
| Event bus + SSE stream        | Publishes persisted events in `seq` order to `GET /api/v1/streams/{runId}/events`.                                                                                                     | `apps/bff/src/stream`, `apps/bff/src/routes/stream.ts`          |
| Diagnosis + derive            | Matches fingerprints against the persisted events only; offers a proven knob; builds a child run with exactly one knob changed.                                                        | `apps/bff/src/diagnosis`, `apps/bff/src/orchestrator/derive.ts` |
| Report generator              | Builds the per-run JSON and Markdown report from the stored events.                                                                                                                    | `apps/bff/src/report`                                           |
| Docker services               | Inji Certify, Inji Verify, Mimoto, Inji Web (`1.0.0-alpha.1`), eSignet `1.8.0` with mock identity, walt.id `1.1.0` with `--with peers`, the JVM sidecar (built, not used by v1 flows). | `compose.yaml`, `docker/`, `versions.lock`                      |

Inji services publish no host ports. The BFF gateway is the only listener, and it uses a local CA for https inside the machine (ADR-22). `scripts/up.sh` brings the bundle up with every image pinned by digest.

## 2. Data flow of one run

![Data flow: selector sends a CreateRunRequest; it is resolved into an immutable RunSpec; the orchestrator runs the steps through the adapters; capture turns exchanges into events; the sink redacts and persists them in the SQLite event log; the bus publishes them over SSE to the UI reducer; the diagnosis engine and report generator read the stored log](diagrams/run-dataflow.svg)

1. The selector posts a `CreateRunRequest` to `POST /api/v1/runs`. The BFF resolves it once into a `RunSpec` that never changes afterwards (ADR-21).
2. The scheduler starts the run. The orchestrator walks the steps of the issuance flow and the presentation flow (`flows/*.json`) and calls the adapters.
3. Every HTTP exchange is captured: outbound calls by `CapturingHttp`, inbound legs by the gateway. Each step records whether its capture is `full`, `partial` or `none` (ADR-19).
4. The event sink redacts secrets and writes the event to the `run_events` table. The bus publishes it only after the write (ADR-20).
5. The UI follows the run over Server-Sent Events. One reducer builds the diagram, the step rail, the inspector and the result card. A finished run, or a reconnecting client, is rebuilt from the same stored log (ADR-36).
6. When the run ends, the diagnosis engine reads the stored events and writes `fingerprint.matched` and `counterfactual.offered` events. The report (`GET /api/v1/reports/runs/{runId}?format=json|markdown`) is generated from the same log, so the redaction rules apply to it too.

## 3. Issuance and presentation sequence

![Sequence diagram: OID4VCI 1.0 pre-authorized code issuance from Inji Certify to the reference wallet (offer, metadata, token, nonce, proof, credential), then OID4VP 1.0 cross-device presentation to Inji Verify (vp-request, request link, request object, vp_token direct_post, vp-results, verdict)](diagrams/sequence-issue-present.svg)

This is the slice FLOW-04 + FLOW-30: Inji Certify (pre-authorized) → Playground reference wallet → Inji Verify (local), cross-device QR. Each arrow is one step of [`flows/FLOW-01.json`](../flows/FLOW-01.json) (extended by [`FLOW-04.json`](../flows/FLOW-04.json)) or [`flows/FLOW-30.json`](../flows/FLOW-30.json), and its step key is shown on the right. In the UI, the same flow files drive the animated sequence diagram. The `ldp_vc` flows (FLOW-03, FLOW-31) follow the same shape. Spec versions are in the README section [Spec targets and versions](../README.md#spec-targets-and-versions). Live evidence: run `01M5CCC4FZRMCCWMVQF5038EYS` ([report](reports/01M5CCC4FZRMCCWMVQF5038EYS.md)).

## 4. Fix-it derive flow

![Fix-it flow: a failed parent run is diagnosed from its persisted events; an exact FP-01 match with a proven knob offers one Fix it and re-run button; POST /runs/{id}/derive passes the derive gate; a child RunSpec with only KNOB-01 changed runs and is classified fixed, moved, not-fixed or inconclusive](diagrams/fixit-derive.svg)

- The diagnosis card offers one button only for an exact fingerprint match with a proven knob. With several possible causes, or with evidence from a `partial` hop, it lists the causes and offers no button.
- `POST /api/v1/runs/{runId}/derive` with `{ knobId, value }` and an `Idempotency-Key` header runs the derive gate in [`apps/bff/src/orchestrator/derive.ts`](../apps/bff/src/orchestrator/derive.ts). The first failed check answers with its error code (for example `parent_not_failed`, `fix_not_offered`, `derive_not_one_knob`).
- The child `RunSpec` is the parent's spec with one knob changed, plus `parentRunId`, `knobDelta` and `causeFingerprintId`. After it runs, [`apps/bff/src/diagnosis/classify.ts`](../apps/bff/src/diagnosis/classify.ts) classifies it as `fixed`, `moved`, `not-fixed` or `inconclusive`.
- Worked example, live on 2026-10-20: parent `01M5B6KNNY7DC3YK3CR0ETNBN9` (FAIL, FP-01, G-55) and child `01M5B6M723AQ7T818D36816PRV` (PASS, `fixed`). Reports: [parent](reports/01M5B6KNNY7DC3YK3CR0ETNBN9.md), [child](reports/01M5B6M723AQ7T818D36816PRV.md).

## See also

- [`design.md`](design.md): screens, wireframes and user flows
- [`../packages/api/openapi.yaml`](../packages/api/openapi.yaml): the machine-readable API contract
- [`interop-report.md`](interop-report.md): every combination that ran, with evidence
- [`decisions.md`](decisions.md): dated decision log
