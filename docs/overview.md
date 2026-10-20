# Interop Playground: overview

_v1, 2026-10-20. Every fact below is backed by a run ID, a test or an evidence file in this repository._

![The combination selector: issuer, wallet and verifier columns, with unavailable combinations greyed out](screenshots/selector.png)

## What it is

Interop Playground is a local web application that runs Inji Certify, Inji Verify, Mimoto and external OpenID implementations against each other and records every protocol exchange. One command, `scripts/up.sh`, brings up the digest-pinned Inji stack in Docker, and the UI is served at `http://127.0.0.1:3100`. From a fresh clone on a host with the images already pulled, the first passing presentation took 3 min 1 s ([fresh-clone timing](evidence/T-55-fresh-clone.md)).

## The problem

Interop failures between issuers, wallets and verifiers surface as a single error at the last hop, while the cause is usually in an earlier message. When Inji Verify rejects an SD-JWT credential issued by walt.id, it answers `ERR_SIGNATURE_VERIFICATION_FAILED`. The reason is two hops back: the credential's header carries the issuer key without an `x5c` certificate chain, which Inji Verify requires (G-55). Nothing at the verifier points there.

## How it works

The backend drives every role, captures each HTTP exchange, labels how complete the capture is, and stores an immutable run that the UI replays exactly. The backend makes every outbound call itself; inbound wallet legs pass through an allowlisting edge gateway, and each hop is labelled `full`, `partial` or `none`. Each event is persisted before it is published over Server-Sent Events, so a finished run replays from its stored log. The run screen shows a sequence diagram, a step rail and an inspector that decodes SD-JWT disclosures, JOSE headers and key payloads. Every finished run has a report in JSON and Markdown.

## The original angle: fix-it re-runs

When a failure matches a known fingerprint with a proven fix, the playground re-runs the same run with exactly one setting changed and reports whether that change fixed it. The button appears only for an exact match with a proven knob; several possible causes, or evidence from a partially captured hop, give a list of causes and no button. The child run is classified `fixed`, `moved`, `not-fixed` or `inconclusive`, with a one-sentence claim and a comparison that shows the knob's direct effect first.

This was proven live on 2026-10-20. Run `01M5B6KNNY7DC3YK3CR0ETNBN9` (walt.id issuer → Playground reference wallet → Inji Verify) fails; fingerprint FP-01 matches and offers knob KNOB-01. One click derives run `01M5B6M723AQ7T818D36816PRV`, in which walt.id adds the `x5c` chain: it passes and is classified `fixed`. The claim reads: "Changing only waltid.sdjwt.x5c from absent to present makes it pass." Both run reports are in [`reports/`](reports/).

## Coverage on the package date

Unsupported combinations are greyed out with the reason and the gap ID, and adapters outside this release are shown as "Not in this release". Shown live on the bundle:

- **SD-JWT VC (`dc+sd-jwt`):** Inji Certify (pre-authorized code) → Playground reference wallet → Inji Verify (local), cross-device QR: Pass (live end-to-end test green three times, then again after a clean `scripts/up.sh`; run `01M5CCC4FZRMCCWMVQF5038EYS` from a fresh clone). walt.id issuer → the same wallet and verifier: the fix-it pair above.
- **Valid / Invalid / Valid-but-Expired:** a fixture issuer signs a valid credential, one with a bad signature and an expired one at run time, and Inji Verify labels them exactly Valid, Invalid and Valid-but-Expired (runs `01M5CBEB3M9ANDEDPFBQD5D0NX`, `01M5CBEB4BW718XJ7VW09CB7EF`, `01M5CBEB5F7W1Z8G14VNN0PK3Q`; [evidence](evidence/T-47-labels.md)). Presented over OpenID4VP, the expired credential is also reported as Valid-but-Expired (run `01M5CBC7EQY4ZKHPE50C1PC9CJ`).
- **W3C VC (JSON-LD, `ldp_vc`):** Inji Certify (pre-authorized code) → Playground reference wallet → Inji Verify (local), cross-device QR: Pass; Inji Verify validated both the credential and the presented VP, including the holder proof (run `01M5CDWNQDX53HC3YF288AFFFG`, [evidence](evidence/T-46-ldp.md)).
- **Pass rate** of the presentation cells: 75 % (3 of 4: SD-JWT 2 of 3, JSON-LD 1 of 1); the one failure is the walt.id cell, fixed by one knob ([interop report](interop-report.md)).
- **Not in this package:** mDoc, the Inji JVM, Inji Web and phone wallets, Collab Verify, the walt.id and EUDI verifiers, Credo, tamper mode, suites and the nightly matrix ([`decisions.md`](decisions.md)).

## Findings

We found and documented Inji defects with reproduction steps. They are drafted as issues and filed by hand. The gaps write-up holds 16 drafts in group (a). Two examples: Inji Certify answers 500 where the specification requires 400 (D-01, G-109), and Inji Verify requires `x5c` on SD-JWT credentials and cannot resolve a `did:jwk` or JWK issuer key (D-04, G-55), which the fix-it pair above reproduces live. Building the playground also showed that Inji Verify checks the SD-JWT `_sd_alg` value strictly. The full list is in [`gaps.md`](gaps.md).

## Run it

Run `scripts/up.sh`, then open `http://127.0.0.1:3100`. The quickstart, the shipped flows and the tests are in the [README](../README.md); the demo video is [`deliverables/video/demo-v1.mp4`](../deliverables/video/demo-v1.mp4).

Built by TODO(user): names.
