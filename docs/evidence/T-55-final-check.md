# T-55: final fresh-clone check at HEAD `2f162cd`

Date: 2026-10-20. Result: **about 3 min 10 s** from `git clone` to a FLOW-30 Pass (criterion <= 30 min: met), no overlay, no script or README change. FLOW-03 -> FLOW-31 (`ldp_vc`) also passed on the same clone. G-166 two-checkout repro: fixed.

Host: Linux, Docker 29.8.1 + compose, 23 GiB RAM (about 10 GiB available; `up.sh` warned that 12 GiB free is recommended). **All images were already pulled/cached** (no `Pulling` line); bff, sidecar and oauth2-mock were rebuilt from the clone on a warm layer cache. The bundle was down first (`docker compose -p interop-playground --profile '*' down`, volumes kept, so the old Inji volumes and the `state-stamp` volume of the main checkout were still there).

## Steps (README Quickstart, literally)

| # | Step | Time |
|---|---|---|
| 1 | `git clone` of the local repo (HEAD `2f162cd`) | 1 s |
| 2 | `scripts/up.sh` (no flags), exit 0, `ready` | 2 min 40 s |
| 3 | `npm ci` 4 s, `npx playwright install chromium` under 1 s (cached), `npx playwright test -c e2e/playwright.live.config.ts slice` 7.4 s | 12 s |

FLOW-30 run `01M5CF9XH79FFEVS3N2JBG8MYV`: `pass`, `issuanceOk: true`, verification `valid`.

## FLOW-03 -> FLOW-31 (`ldp_vc`) on the clone

`npx playwright test -c e2e/playwright.live.config.ts ldp`: 1 passed (10.3 s). Run `01M5CFAMQHWHJQ3BF5XATSG176`: `pass`, verification `valid`, `FarmerCredential`, plain client ID. T-46 holds at HEAD from a fresh checkout.

## G-166 two-checkout repro

1. Clone first start. The clone has no `.generated/state/chain.done` marker and its own CA, so the "marker mismatch" path ran (same wording as wave 8), not the stamp path:

```
[up] WARNING: Inji state was created for another PUBLIC_HOST/CA (or the chain never finished): wiping it (10 §7.6)
[up] removing Inji state volumes: esignet-pg esignet-keys mock-identity-keys certify-authcode-pg certify-preauth-keys certify-preauth-pg certify-iae-pg certify-iae-keys
```

Mimoto: `Up (healthy)` 41 s after `ready`. The clone's volumes now carry the clone's stamp.

2. Clone down, then `scripts/up.sh` from the **main** checkout (marker and CA match its own, the stamp is the clone's): the stamp path ran, exit 0 in 2 min 38 s:

```
[up] WARNING: Inji state was built by another checkout on this host (one checkout per host): rebuilding it for this one (same as scripts/up.sh --reset)
[up] removing Inji state volumes: esignet-pg esignet-keys mock-identity-keys certify-authcode-pg certify-preauth-keys certify-preauth-pg certify-iae-pg certify-iae-keys
```

`docker ps`: `interop-playground-mimoto-1 Up 37 seconds (healthy)`, `RestartCount 0`, state `running`: **no crash loop**. On the main checkout `slice` and `ldp` live specs both passed (2 passed, 13.2 s). Stack brought down again.

Finding: the main-to-clone direction never shows the "one checkout per host" text (a fresh clone has no marker, so it reports the PUBLIC_HOST/CA wipe); the stamp text shows when switching back to a checkout that has a marker. Both end in an automatic rebuild. The two checkouts detected different `PUBLIC_HOST` values (clone `192.168.1.120`, main `192.168.1.84`; the host's LAN address changed between the two runs).

## README

No step was wrong; no script change. Wording for the docs owner: the README already says the live specs need `npm ci` and `npx playwright install chromium`. The "One checkout per host" bullet can say "a second checkout gets a warning and an automatic rebuild" (G-166 fixed, ADR-101).

## Main checkout

`npm run lint`, `npm run typecheck` and `npm test` (682 passed / 8 skipped) were green. Stack left down; clone deleted.
