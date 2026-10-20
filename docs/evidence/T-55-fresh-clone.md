# T-55: fresh clone + README quickstart → FLOW-30 Pass

Date: 2026-10-20. Result: **3 min 1 s** from `git clone` to a FLOW-30 Pass (criterion ≤ 30 min: met).

Host: Linux, Docker 29 + compose plugin, 23 GiB RAM (10 GiB available at start; `up.sh` warned that 12 GiB free is recommended). **Every image was already pulled or cached on this host** (no `Pulling` line in the log; the bff, sidecar and oauth2-mock images were rebuilt from the clone with a warm Docker layer cache). A host without the images adds the pull time of the digests in `versions.lock`.

Tree: `git clone` of the local repository (HEAD `d67ab28`) into a scratch directory, with the wave 8 working-tree files copied over it (the tree as it will be merged; no `.env`, `.generated/`, `certs/` or `node_modules/` came along). The bundle was down first (`docker compose -p interop-playground --profile '*' down`, volumes kept); the clone uses the same compose project.

Steps, literally from `README.md` → Quickstart and "Your first run":

| # | Step | Time |
|---|---|---|
| 1 | `git clone <repo> && cd interop-playground` | 6 s (incl. the overlay) |
| 2 | `scripts/up.sh` (no flags): builds the local images, generates `.env`, the playground CA and certs, starts the local profile, runs the ADR-14 chain, prints `ready` | 2 min 40 s |
| 3 | Open `http://127.0.0.1:3100`, pick Inji Certify (pre-authorized) → Playground reference wallet → Inji Verify (local), SD-JWT VC, Cross-device (QR), Run → result card **Pass** → Report | 15 s (driven by `npx playwright test -c e2e/playwright.live.config.ts slice`, the same clicks; spec 6.9 s) |

Run: `01M5CCC4FZRMCCWMVQF5038EYS`, verdict `pass`, `issuanceOk: true`, verification `valid`.

Observations (no README step was wrong):
- The new clone has its own playground CA, so `up.sh` printed "Inji state was created for another PUBLIC_HOST/CA … wiping it (10 §7.6)" and recreated the Inji volumes: the run used freshly initialised Inji databases, not the old state.
- The README does not say that step 3 can be automated: `npm ci` + `npx playwright install chromium` are needed for `npm run e2e:live`, which is outside the quickstart (proposed README line for the docs owner).
- `git clone TODO(user): repository URL` is still a placeholder (T-56).
