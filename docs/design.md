# Design: screens, wireframes and user flows

_v1, 2026-10-21. Screenshots of the main screens, low-fidelity wireframes of the two core layouts, and three user flows, each with a short design rationale._

## How the screenshots were made

Every screenshot below was captured with Playwright at 1440 × 900 px in the light theme. It shows the production UI build (`apps/ui`, served by `vite preview`) answering from the same fixture API that `npm run e2e` uses ([`e2e/support.ts`](../e2e/support.ts)): the recorded event logs in [`fixtures/events/`](../fixtures/events/) and the UI test fixtures in `apps/ui/src/test/`. No Docker bundle runs behind them. The public host is the documentation address `192.0.2.10`, and no secrets are shown.

The look is called "Quiet": a white page (black in the dark theme) with a light, frosted top bar and a plain side rail, one link blue for links, selection and focus, and ink (near-black) pill buttons for the main action. Type does the work: system sans-serif, large page titles, sentence-case labels, and monospace only for real data such as payloads, digests and run IDs. Cards are flat, either a light grey fill or a hairline border. The outcome colours (pass green, fail red, warning amber, running slate blue, skipped grey) appear only on small icons and their words, never as large fills, and every outcome also has an icon and a word. Every colour pair is checked by `npm run contrast`, in light and dark themes.

Motion is quiet and physical: pages and lists fade in with a short rise (staggered by 40 ms), buttons respond with a slight press, selections cross-fade, and nothing bounces, glows or loops except a real progress indicator. With "reduce motion" set in the operating system, all of it is off.

The ten `design-*.png` files are recaptured with [`scripts/capture-design.mts`](../scripts/capture-design.mts). Build the UI, start the preview on port 4391, then run the script:

```
npm run build -w @interop-playground/ui
npm run preview -w @interop-playground/ui -- --port 4391 &
npx tsx scripts/capture-design.mts docs/screenshots http://127.0.0.1:4391
```

Fixture data differs from the live runs in a few places. The fix-it screens reuse the Inji Certify fixture log, while the live pair used the walt.id issuer. The Valid-but-Expired card is the pass log with its verdict set to `valid-but-expired`. For the live results, see the evidence linked under each screen. The live selector is [`screenshots/selector.png`](screenshots/selector.png).

## Screens

### Selector (`/`)

![Selector inside the dark app frame: format, mode and scope controls, then three numbered columns (Issuer, Wallet, Verifier) of radio cards with environment, tier and format chips, a greyed-out verifier card with its reason, and the start bar with the Run button](screenshots/design-selector.png)

Three radio-group columns let you pick exactly one issuer, one wallet and one verifier. Format, mode and scope sit above them; the grant is derived from the issuer, not picked. Combinations that cannot work stay in place, greyed out, with the reason as visible text and the gap ID. The compatibility rules are checked by the backend for every card, so the UI never keeps its own copy of them. The start bar repeats the whole choice in one line before **Run**.

### Run screen while running (`/runs/:runId`)

![Run screen mid-run: header with the picks, a Running banner "Step 18 of 31" with the elapsed time, and the full-width sequence diagram stage with lanes, numbered step markers and completed steps in green](screenshots/design-run-midrun.png)

The run screen is one page for a live run, a finished run and a replay. All three come from one reducer over the run's event log. While the run is going, the banner names the step ("Running. Step n of N: …"), and the diagram animates as messages arrive. The diagram is a full-width stage at the top of the workspace. Below it sit the step rail (a numbered list of steps with outcome and capture badge) and a sticky inspector that follows the running step. The step rail is the accessible twin of the diagram, which is `aria-hidden`.

### Inspector, Decoded tab

![Step rail on the left and the sticky inspector on the right, on the POST /issuance/credential step, Decoded tab: the proof JWT with its alg, typ, kid and x5c chips and payload, and the issued SD-JWT with its disclosed claims in a table](screenshots/design-inspector-decoded.png)

The inspector shows the raw payloads of each step. The key-payload bar (Offer, Token, Credential, Request link, Request object, vp_token, Presentation query, Verification result) jumps straight to the message that matters. A chip is muted when the run has no such message. The Decoded tab splits JOSE headers into chips (`alg`, `typ`, `kid`, `x5c`) and lists SD-JWT disclosures. It also says that decoding here does not check the signature; the verifier's own result is on the Checks tab. Each step carries its capture badge (`Full capture`, `Partial capture` or `No capture`).

### Result cards: Valid, Invalid, Valid-but-Expired

| Valid                                                            | Invalid                                                                                                                                          | Valid-but-Expired                                                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ![Result card: green Pass with the sentence "The verifier accepted the credential: Valid." beside a summary table of the combination](screenshots/design-result-valid.png) | ![Result card: red Fail with the verifier's error beside a summary table that names the failing step, under a diagnosis card "No known cause matched"](screenshots/design-result-invalid.png) | ![Result card: green Pass, "Valid but expired. The signature checks out and the credential is past its expiry date.", with the summary table](screenshots/design-result-expired.png) |

Every terminal run has a result card: an outcome badge with an icon and a word (colour is never the only signal), one sentence, and a summary table. The verifier label decides the sentence: Valid, Invalid with the verifier's own error code and message, or Valid-but-Expired, which is a pass with a warning and is not merged into Invalid. All three labels were shown live at the real Inji Verify ([evidence](evidence/T-47-labels.md)).

### Diagnosis and fix-it panel

![Diagnosis card "Inji Verify cannot verify an SD-JWT VC whose issuer key is not given as an x5c chain", Exact match, with deviating side, spec clause, gap G-55 and evidence; below it the Try the fix panel showing one setting changing, waltid.sdjwt.x5c "absent" struck through → "present", and the Fix it and re-run button](screenshots/design-diagnosis-fixit.png)

The diagnosis card sits above the diagram on failed runs, because it is the first thing to read. It names the matched fingerprint, the deviating side, the spec clause, the gap IDs and the evidence. The fix-it panel appears only for an exact match with a proven knob. It shows the single change as a before → after diff ("from" struck through, "to" highlighted), says what stays the same, and has one button with no confirm dialog. When more than one cause fits, the card lists them and offers no button ([`e2e/angle.spec.ts`](../e2e/angle.spec.ts)).

### Child run and compare

![Child run: banner "Re-run of PPPPPPPP: waltid.sdjwt.x5c absent → present", a Fixed card "The change fixed it." with the claim sentence and its buttons, and the compare strip listing the changed steps, the knob's direct effect first](screenshots/design-child-compare.png)

A derived run opens with a banner that links its parent and names the one knob that changed. The result card classifies the child as `fixed`, `moved`, `not-fixed` or `inconclusive`; only `fixed` carries the claim sentence. The compact compare strip lists the knob's direct effect first, then the other changed steps, and hides volatile fields such as nonces and timestamps. Live pair: [parent](reports/01M5B6KNNY7DC3YK3CR0ETNBN9.md), [child](reports/01M5B6M723AQ7T818D36816PRV.md).

### Report view (`/runs/:runId/report`)

![Report view: Run ZZZZZZZZ: FAIL, a segmented Report, Markdown and JSON switch, download buttons, and the Combination table with issuer, wallet, verifier, format, proof type, grant, mode, environment, versions, settings, outcome, failed step and error detail](screenshots/design-report.png)

The report is the shareable record of one run: the combination, the versions, the outcome, failing checks, diagnosis, fix-it result, coverage and steps. The same content is available as a rendered view, as Markdown and as JSON, with download and copy buttons. Committed examples are in [`reports/`](reports/).

### Environment page (`/environment`)

![Environment page: three cards for mode (Full local, public host, status Ready), tunnel (down) and Collab budget; the services table with status, version and last check; traffic outside a run](screenshots/design-environment.png)

The environment page answers "is my bundle healthy?" before you start a run. It shows the mode, the readiness probe of each service with its version, the tunnel state (down by default; the playground never opens one), and any traffic the gateway saw outside a run, with the rule that denied it.

## Wireframes

Low-fidelity layouts of the two core screens. They show the regions and their order, not the visual style.

![Wireframe of the selector: app shell, title, format and mode segmented controls, scope, three columns with a selected card and a greyed card with reason and gap ID, Advanced options, start bar with Run](diagrams/wireframe-selector.svg)

![Wireframe of the run screen: header with picks and actions, banners, diagnosis card with the fix-it panel, result card, then the full-width diagram stage with lifelines, and below it the step rail beside the sticky inspector with key-payload chips, tabs and decoded content](diagrams/wireframe-run.svg)

Why this order on the run screen: the header says what ran; banners say what is happening now (status, connection, capture coverage). The diagnosis goes above the result for failed runs, because it explains the result. The workspace is stacked: the diagram stage (where in the flow) spans the full width, and below it the step rail and the sticky inspector (what was on the wire) sit side by side from 1024 px up and stack on narrower screens. Every screen is checked with axe at 320 to 1440 px in light and dark themes (`npm run e2e`).

## User flows

![User flows: A, first run from scripts/up.sh to the selector, Run, a Pass and the report; B, the fix-it journey from a failed run through the diagnosis card and one click to a fixed child run and the compare strip; C, reading a report from the combination to the outcome, checks, diagnosis, coverage and download](diagrams/user-flows.svg)

- **A. First run.** The same path is automated against the live bundle by [`e2e/live/slice.live.spec.ts`](../e2e/live/slice.live.spec.ts). The steps are in the README section [Your first run](../README.md#your-first-run).
- **B. Fix-it journey.** Automated on fixtures by [`e2e/angle.spec.ts`](../e2e/angle.spec.ts) and live by [`e2e/live/fixit.live.spec.ts`](../e2e/live/fixit.live.spec.ts).
- **C. Reading a report.** From the run screen's **Report** action, or `GET /api/v1/reports/runs/{runId}?format=json|markdown`.

## Design rules that apply to every screen

- **Status is never colour alone.** Each outcome has an icon, a word and a colour token, and the tokens pass the contrast script (`npm run contrast`).
- **Plain copy.** Errors that come from a user action show inline, with the request reference. Background errors (environment) use a toast.
- **Keyboard.** Global shortcuts use `Alt+Shift` (`N` new run, `H` History, `K` the shortcut list) and never fire while you type in a field; `Esc` closes the topmost dialog, drawer or menu ([`apps/ui/src/shell/shortcuts.ts`](../apps/ui/src/shell/shortcuts.ts)).
- **Light and dark themes** come from one set of CSS tokens (`apps/ui/src/tokens.css`).

See also [`architecture.md`](architecture.md) for the system diagrams.
