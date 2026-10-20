# Interop Playground: overview (v1 outline, 2026-10-20)

> Outline for the 1–2 page overview. Each block has its key sentence and the facts it will draw on. The final prose comes with the wave 8 package. Anything still pending is marked _pending_. It allows at most one screenshot: the run screen.

## 1. What it is

Interop Playground is a local web application that runs Inji Certify, Inji Verify, Mimoto and external OpenID implementations against each other and records every protocol exchange.

- One command (`scripts/up.sh`) brings up the pinned Inji stack in Docker. The UI is served at `http://127.0.0.1:3100`.

## 2. Problem

Interop failures between issuers, wallets and verifiers surface as a single error at the last hop. The cause is usually in an earlier message.

- Example: Inji Verify rejects a walt.id SD-JWT at presentation time. The cause is in the issued credential's header: there is no `x5c` (G-55).

## 3. How it works

The backend drives every role, captures each HTTP exchange, labels how complete the capture is, and stores an immutable run that the UI replays exactly.

- Outbound calls are captured by the BFF. Inbound wallet legs go through an allowlisting edge gateway, and each hop is labelled `full`, `partial` or `none`.
- Events are persisted before they are published (SSE). The run screen shows the selector, a sequence diagram, the step rail, the inspector (decoded SD-JWT, disclosures, JOSE headers) and a per-run report (JSON and Markdown).

## 4. The original angle

When a failure matches a known fingerprint with a proven fix, the playground re-runs the same run with exactly one setting changed and reports whether that change fixed it.

- The button appears only for an exact match with a proven knob. Several causes, or evidence from a partial hop, give "possible causes" and no button.
- The child result is `fixed`, `moved`, `not-fixed` or `inconclusive`, with a claim sentence and a compare strip that shows the knob's direct effect first.
- Worked example, proven live (T-44): FP-01 + KNOB-01 (walt.id adds `x5Chain`). Parent run `01M5B6KNNY7DC3YK3CR0ETNBN9` fails, child run `01M5B6M723AQ7T818D36816PRV` passes and is classified `fixed` (reports in `docs/reports/`).

## 5. Coverage on the package date

Unsupported combinations are greyed out with the reason and the gap ID.

- Built and passing live: Inji Certify pre-auth `dc+sd-jwt` → Playground reference wallet → Inji Verify (local), cross-device (T-36, green 3×, and after a clean `scripts/up.sh`); walt.id → Playground reference wallet → Inji Verify as the fix-it pair (T-43, T-44). Combinations and evidence: `docs/interop-report.md`.
- _Pending:_ the live Valid / Invalid / Valid-but-Expired runs of the fixture issuer (T-47, wave 8); `ldp_vc` (T-46, wave 8 on recorded upstreams, live in wave 9).
- Not in the package: mDoc, the Inji JVM / Web / phone wallets, Collab Verify, the walt.id and EUDI verifiers, Credo, tamper mode, suites and the matrix (see `docs/decisions.md`).

## 6. Findings

We found and documented Inji defects with reproduction steps. They are drafted as issues and filed by hand.

- Two examples: D-01 (Certify returns 500 where the spec needs 400, G-109) and D-04 (Inji Verify requires `x5c` on SD-JWTs, G-55). The full list is in `docs/gaps.md` (16 drafts in group (a)).

## 7. Run it

`scripts/up.sh`, then `http://127.0.0.1:3100`.

- Credits: TODO(user): names.
