# Interop Playground: API documentation

_v1, 2026-10-21. Team Bhrinjal (Abhijay Jindal)._

The backend for frontend (BFF) serves the web UI and a REST + Server-Sent Events (SSE) API. The UI uses only this API, so anything the UI does can be scripted with `curl`.

- **Machine-readable source:** [`packages/api/openapi.yaml`](../packages/api/openapi.yaml) (OpenAPI 3.1). It is generated from [`packages/api/src/api.ts`](../packages/api/src/api.ts) by `npm run contracts:generate`, and `tests/repo/contracts-generated.test.ts` fails when the committed file drifts. A typed client is generated next to it (`packages/api/src/client.gen.ts`).
- **Route code:** [`apps/bff/src/routes/`](../apps/bff/src/routes/), wired in [`apps/bff/src/server.ts`](../apps/bff/src/server.ts).
- **This page** documents the endpoints the v1 BFF actually serves. The OpenAPI file also specifies endpoints for features that are not in v1 (see [Specified but not served in v1](#specified-but-not-served-in-v1)); those answer `404 not_found`.

## Contents

- [Base URL and transport](#base-url-and-transport)
- [Authentication and the request guard](#authentication-and-the-request-guard)
- [Error format](#error-format)
- [Catalog endpoints](#catalog-endpoints)
- [Environment endpoints](#environment-endpoints)
- [Run endpoints](#run-endpoints)
- [Event stream (SSE)](#event-stream-sse)
- [Diagnosis, fix-it derive and compare](#diagnosis-fix-it-derive-and-compare)
- [Run report](#run-report)
- [End-to-end use cases](#end-to-end-use-cases)
- [Specified but not served in v1](#specified-but-not-served-in-v1)
- [External APIs the playground calls](#external-apis-the-playground-calls)

## Base URL and transport

| Item             | Value                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base URL         | `http://127.0.0.1:3100/api/v1` (also reachable as `http://localhost:3100/api/v1`)                                                                                   |
| Listener         | `scripts/up.sh` publishes the BFF on `127.0.0.1:3100` only ([`compose.yaml`](../compose.yaml)); outside Docker it binds `127.0.0.1` by default                      |
| Content type     | JSON (`application/json; charset=utf-8`) for every request and response body, except the SSE stream (`text/event-stream`) and the Markdown report (`text/markdown`) |
| Max request body | 1 MiB (`413 payload_too_large` above)                                                                                                                               |
| Request ID       | every response carries `X-Request-Id` (a ULID); error bodies repeat it                                                                                              |
| IDs              | run IDs are ULIDs (26 characters, Crockford base32), for example `01M5CCC4FZRMCCWMVQF5038EYS`                                                                       |
| Times            | RFC 3339 UTC with milliseconds                                                                                                                                      |
| Unknown fields   | request bodies and query strings with unknown keys are rejected (`400 validation_failed`)                                                                           |

## Authentication and the request guard

The playground is a local, single-user developer tool. **There is no user authentication: no login, no API keys, no bearer tokens on `/api/v1`.** Protection comes from where the API listens and from a request guard ([`apps/bff/src/guard/index.ts`](../apps/bff/src/guard/index.ts)):

1. **Local-only listener.** The API port 3100 is published on the loopback address only, so other machines cannot reach it.
2. **Host check (every request).** The `Host` header must be `127.0.0.1:3100` or `localhost:3100`. Anything else is `403 request_guard_failed` with `details.reason: "host"`. This blocks DNS-rebinding attacks.
3. **Origin check (every non-GET request).** `Origin` must equal `http://<Host>`, for example `http://127.0.0.1:3100`. A missing, foreign, `null` or https origin is `403 request_guard_failed` with `details.reason: "origin"`. This blocks cross-site request forgery from other web pages.
4. **Content type (every non-GET request).** `Content-Type: application/json` is required (`415 unsupported_media_type` otherwise).

`curl` sets `Host` itself, so a scripted POST only needs the two extra headers:

```bash
curl -s -X POST http://127.0.0.1:3100/api/v1/env/probe \
  -H 'Origin: http://127.0.0.1:3100' -H 'Content-Type: application/json' -d '{}'
```

The one endpoint with a secret is `POST /api/v1/internal/tunnel`: it accepts only a loopback peer **and** an `X-Admin-Token` header equal to the token `scripts/up.sh` generates into `certs/bff-admin.token` (never committed). Otherwise it answers `401 unauthorized`.

**The edge gateway is a separate listener, not part of this API.** It forwards the wallet's inbound calls (wallet → issuer, wallet → verifier) to the Inji containers through an allowlist ([`apps/bff/src/gateway/`](../apps/bff/src/gateway/)): only the endpoints an upstream advertises in its well-known metadata, or a fixed list per service, are forwarded. Admin paths (`/actuator/*`, `/swagger*`, `/v3/api-docs*`, Certify's `credential-configurations` and `pre-authorized-data`, eSignet `client-mgmt`, walt.id `/issuer2/*`) are always denied. A denied request gets `403 gateway_denied` and a `gateway.denied` event. The Inji admin APIs have no authentication of their own, so they are never exposed.

## Error format

Every non-2xx answer on `/api/v1/*` has one envelope ([`apps/bff/src/errors/index.ts`](../apps/bff/src/errors/index.ts)):

```json
{
  "error": {
    "code": "validation_failed",
    "message": "The request does not match its schema.",
    "status": 400,
    "requestId": "<the X-Request-Id of this request>",
    "retryable": false,
    "details": { "issues": [{ "path": "$.query.colour", "message": "unknown parameter" }] }
  }
}
```

- `code` is one of 40 fixed codes, each with a fixed HTTP status (`ERROR_STATUS` in [`packages/api/src/api.ts`](../packages/api/src/api.ts)). A client can switch on `code` alone.
- `retryable` is `true` only for 429 and 503. `rate_limited`, `queue_full` and `env_not_ready` also send `Retry-After` (seconds).
- `validation_failed` lists `details.issues[]` with a JSON path and a message.
- `internal_error` (500) never contains exception text; the BFF log has it under the same `requestId`.

Codes you will meet with the v1 endpoints:

| Status | Codes                                                                                                                                                                                                             |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `validation_failed`                                                                                                                                                                                               |
| 401    | `unauthorized` (tunnel endpoint only)                                                                                                                                                                             |
| 403    | `request_guard_failed`                                                                                                                                                                                            |
| 404    | `not_found`                                                                                                                                                                                                       |
| 409    | `idempotency_conflict`, `run_not_cancellable`, `run_not_terminal`, `key_unavailable`, `parent_not_failed`, `tamper_run_not_derivable`, `knob_reverted`, `version_drift`, `environment_changed`, `tunnel_required` |
| 413    | `payload_too_large`                                                                                                                                                                                               |
| 415    | `unsupported_media_type`                                                                                                                                                                                          |
| 422    | `incompatible_selection`, `knob_invalid`, `knob_not_applicable`, `derive_not_one_knob`, `fix_not_offered`, `compare_not_comparable`                                                                               |
| 429    | `queue_full`, `rate_limited`                                                                                                                                                                                      |
| 500    | `internal_error`                                                                                                                                                                                                  |
| 503    | `adapter_unavailable`, `env_not_ready`                                                                                                                                                                            |

## Catalog endpoints

Read-only lists that drive the combination selector ([`apps/bff/src/routes/catalog.ts`](../apps/bff/src/routes/catalog.ts), [`flows.ts`](../apps/bff/src/routes/flows.ts), [`health.ts`](../apps/bff/src/routes/health.ts)).

| Method and path          | Purpose                                                 | Query                         | Response                                                                             |
| ------------------------ | ------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------ |
| `GET /health`            | liveness of the BFF, the JVM sidecar and each adapter   | none                          | `Health`: `status` `ok` or `degraded` (always HTTP 200 while the BFF serves)         |
| `GET /adapters`          | the 18 adapters by role, with live availability         | none                          | `{issuers[], wallets[], verifiers[]}` of `{descriptor, availability, probedAt}`      |
| `GET /knobs`             | the one-setting changes (knobs) a run can set           | `adapter`, `format`           | `{knobs: [{def, adapters, targets, status, provenBy, label}]}`                       |
| `GET /presets`           | named knob presets                                      | none                          | `{presets: [{presetId, title, description, knobs}]}`                                 |
| `GET /configurations`    | credential configurations per issuer and format         | `issuer`, `format`            | `{configurations: [{issuer, format, configurationId, default, vctOrDoctypeOrType}]}` |
| `GET /incompatibilities` | the rules that grey out combinations, with gap IDs      | none                          | `{rules: [{ruleId, when, reason, gapId, evidence}]}`                                 |
| `GET /flows`             | the shipped flow definitions                            | `kind=issuance\|presentation` | `{flows: [{flowId, kind, title, adapters, formats, stepKeys}]}`                      |
| `GET /flows/{flowId}`    | one flow definition (the file in [`flows/`](../flows/)) | none                          | `FlowDefinition`; `404 not_found` for an unknown ID                                  |

Unknown query keys or values are `400 validation_failed`. `format` is one of `ldp_vc`, `dc+sd-jwt`, `mso_mdoc`, `jwt_vc_json`.

Example:

```bash
curl -s 'http://127.0.0.1:3100/api/v1/configurations?issuer=issuer.fixture&format=dc%2Bsd-jwt'
```

```json
{
  "configurations": [
    {
      "issuer": "issuer.fixture",
      "format": "dc+sd-jwt",
      "configurationId": "PlaygroundSdJwt",
      "default": true,
      "vctOrDoctypeOrType": "PlaygroundSdJwt"
    },
    {
      "issuer": "issuer.fixture",
      "format": "dc+sd-jwt",
      "configurationId": "PlaygroundSdJwtExpired",
      "default": false,
      "vctOrDoctypeOrType": "PlaygroundSdJwt"
    },
    {
      "issuer": "issuer.fixture",
      "format": "dc+sd-jwt",
      "configurationId": "PlaygroundSdJwtInvalid",
      "default": false,
      "vctOrDoctypeOrType": "PlaygroundSdJwt"
    }
  ]
}
```

(Values from `CREDENTIAL_CONFIGURATIONS` in [`packages/adapters/src/catalog.ts`](../packages/adapters/src/catalog.ts).)

## Environment endpoints

[`apps/bff/src/routes/env.ts`](../apps/bff/src/routes/env.ts). The environment manager probes every upstream service on a fixed interval and publishes the results on the `env` event stream.

| Method and path         | Purpose                                | Body                                        | Response                                                                                                                                   |
| ----------------------- | -------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /env`              | environment snapshot                   | none                                        | `EnvSnapshot`: `mode`, `ready`, `upstreams[{upstream, ok, checkedAt, detail, versionFingerprint}]`, `tunnel`, `collabBudget`, `publicHost` |
| `POST /env/probe`       | probe every upstream now               | `{}` or empty                               | `EnvSnapshot`; at most one call per 5 s (`429 rate_limited` with `Retry-After`)                                                            |
| `POST /internal/tunnel` | register or clear a public tunnel host | `{state: "up"\|"down", host?, ttlSeconds?}` | loopback peer + `X-Admin-Token` only (see above); no tunnel is started in v1                                                               |

## Run endpoints

[`apps/bff/src/routes/runs.ts`](../apps/bff/src/routes/runs.ts). A run is an immutable `RunSpec`: once created, its selection, knobs and parent link never change. The orchestrator runs at most 4 runs at a time and queues up to 50 more (`429 queue_full` beyond).

| Method and path             | Purpose                                                          | Response                                                                                                               |
| --------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `POST /runs/preview`        | resolve a selection to the full `RunSpec` without creating a run | `200 {ok: true, spec, warnings, tamperApplicable, controlRequired}` or `200 {ok: false, hit: {ruleId, reason, gapId}}` |
| `POST /runs`                | create and queue a run                                           | `201 Run` (new), `200 Run` with `Idempotent-Replay: true` (same `Idempotency-Key` and body)                            |
| `GET /runs`                 | list runs, newest first                                          | `{items: Run[], nextCursor}`                                                                                           |
| `GET /runs/{runId}`         | one run                                                          | `Run`; a finished run is sent with `Cache-Control: immutable`                                                          |
| `GET /runs/{runId}/steps`   | the run's steps in flow order                                    | `{steps: Step[]}`                                                                                                      |
| `POST /runs/{runId}/cancel` | cancel a queued or running run                                   | `Run`; `409 run_not_cancellable` if it already completed or failed                                                     |

### Create a run: request body (`CreateRunRequest`)

| Field                                                | Required | Values                                                                                                                             |
| ---------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `issuer`                                             | yes      | `issuer.certify-preauth`, `issuer.waltid` (needs `scripts/up.sh --with peers`), `issuer.fixture`                                   |
| `wallet`                                             | yes      | `wallet.playground-ts`                                                                                                             |
| `verifier`                                           | yes      | `verifier.inji-verify-local`                                                                                                       |
| `grant`                                              | yes      | `pre-authorized_code`                                                                                                              |
| `presentationMode`                                   | yes      | `cross-device`, or `null` for credential-level verification without OID4VP (FLOW-40)                                               |
| `format`                                             | yes      | `dc+sd-jwt` or `ldp_vc`                                                                                                            |
| `configurationId`                                    | no       | default from `GET /configurations`; for the fixture issuer `PlaygroundSdJwt`, `PlaygroundSdJwtInvalid` or `PlaygroundSdJwtExpired` |
| `knobs`                                              | no       | `{ "KNOB-01": "present" }`; omitted knobs take their defaults                                                                      |
| `preset`, `scope`, `delivery`, `disclosure`, `label` | no       | see the OpenAPI schema                                                                                                             |

The adapter IDs above are the ones built in v1. The other IDs in the schema (Inji JVM wallet, Inji Web, the phone wallet, Credo, Collab Verify, the walt.id and EUDI verifiers) are refused with the reason "Not in this release". A combination that cannot work is refused with `422 incompatible_selection` and the rule's gap ID, for example `mso_mdoc` at Inji Verify (G-09).

Optional header `Idempotency-Key` (1 to 64 characters): the same key with the same body within 10 minutes returns the first run instead of creating a second one; the same key with another body is `409 idempotency_conflict`. The UI sends one key per click.

### `GET /runs` query

`limit` (1 to 200, default 50), `cursor` (the previous page's `nextCursor`), and filters `issuer`, `wallet`, `verifier`, `format`, `grant`, `mode`, `state`, `outcome`, `kind`, `parentRunId`, `derived`, `from`, `to` and others listed in the OpenAPI file.

### The `Run` object

Fields from the `Run` type in [`packages/api/src/api.ts`](../packages/api/src/api.ts); values from the committed fix-it child run [`01M5B6M723AQ7T818D36816PRV`](reports/01M5B6M723AQ7T818D36816PRV.json) and its recorded events ([`fixtures/golden/fixit/`](../fixtures/golden/fixit/)), trimmed:

```json
{
  "runId": "01M5B6M723AQ7T818D36816PRV",
  "spec": {
    "issuer": "issuer.waltid",
    "wallet": "wallet.playground-ts",
    "verifier": "verifier.inji-verify-local",
    "grant": "pre-authorized_code",
    "presentationMode": "cross-device",
    "format": "dc+sd-jwt",
    "configurationId": "identityCredentialSdJwt",
    "knobs": { "KNOB-01": "present", "KNOB-07": "plain" },
    "parentRunId": "01M5B6KNNY7DC3YK3CR0ETNBN9",
    "knobDelta": { "knobId": "KNOB-01", "from": "absent", "to": "present" },
    "causeFingerprintId": "FP-01",
    "issuanceFlowId": "FLOW-08",
    "presentationFlowId": "FLOW-30",
    "…": "…"
  },
  "label": null,
  "state": "completed",
  "verdict": {
    "kind": "interop",
    "outcome": "pass",
    "issuanceOk": true,
    "verification": "valid",
    "tamperVerdict": null,
    "failedStepKey": null,
    "countsTowardPassRate": true
  },
  "errorCode": null,
  "counterfactualResult": "fixed",
  "links": { "parentRunId": "01M5B6KNNY7DC3YK3CR0ETNBN9", "controlRunId": null, "childRunIds": [] },
  "…": "createdAt, startedAt, finishedAt, awaiting, eventCount, stepSummary, …"
}
```

- `state`: `queued`, `running`, `completed`, `failed` (the run could not finish, for example `errorCode: "env_not_ready"`) or `cancelled`.
- `verdict.outcome`: `pass`, `fail`, `blocked`, `no-submission`, `lenient` or `inconclusive`.
- `verdict.verification`: `valid`, `invalid`, `valid-but-expired`, `no-submission` or `null`. The UI shows these as **Valid**, **Invalid** and **Valid-but-Expired**.
- `counterfactualResult` is set on fix-it children only: `fixed`, `moved`, `not-fixed` or `inconclusive`.

A `Step` (from `GET /runs/{runId}/steps`) has `stepKey`, `order`, `flowId`, `state`, `outcome` (`pass`, `fail`, `skipped`), `capture` (`full`, `partial`, `none`), `skipReason`, timings, `exchangeIds`, `artifactIds`, `checks` and `fingerprintIds`.

## Event stream (SSE)

`GET /streams/{streamId}/events` ([`apps/bff/src/routes/stream.ts`](../apps/bff/src/routes/stream.ts)). `streamId` is a run ID, `env` (environment probes) or `unattributed` (gateway traffic that matched no run).

Every event is written to the SQLite event log **before** it is published, so a client that reconnects, or opens a finished run later, gets exactly the same sequence.

**SSE mode (default).**

- The stream starts with `retry: 3000`, replays the stored events, then follows live.
- Each frame is `id: <seq>`, `event: <type>`, `data: <EventEnvelope JSON>`. `seq` starts at 1 per stream and has no gaps.
- Resume with the `Last-Event-ID` header or `?after=<seq>`: delivery starts strictly after that seq.
- An idle stream sends a `: hb` comment every 15 s.
- After a run's terminal event the server sends one `event: stream.end` frame without an `id`, with `data: {"reason":"terminal","lastSeq":<n>}`, and closes. `reason` can also be `server-shutdown`.

**JSON mode.** `?format=json` returns one page: `{streamId, events[], nextAfter, closed}`. Page on with `?after=<nextAfter>`; `limit` is 1 to 1000 (default 500). `?type=a,b` filters by event type in both modes.

**Event envelope.** `{v: 1, runId, seq, ts, type, stepKey?, payload}`. The 22 event types:

| Group         | Types                                                                                     | Payload highlights                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Run lifecycle | `run.created`, `run.started`, `run.completed`, `run.failed`, `run.cancelled`              | `run.created`: the full `spec`; `run.completed`: `verdict`, `counterfactualResult`                                                   |
| Steps         | `step.started`, `step.completed`                                                          | `flowId`, `order`, `label`; then `outcome`, `capture`, `skipReason`, `durationMs`                                                    |
| HTTP capture  | `exchange.request`, `exchange.response`, `exchange.error`                                 | `exchangeId`, `direction`, `actor`, `counterpart`, `method`, `url`, `headers`, `body`, `bodyState`; then `status`, `headers`, `body` |
| Gateway       | `gateway.denied`                                                                          | the denied method, path and rule                                                                                                     |
| Wallet engine | `engine.call`, `engine.exception`                                                         | `engine`, `op` (for example `sign-proof`), `inputSummary`, `outputSummary`                                                           |
| Verdict       | `verdict.check`                                                                           | `check: {checkId, outcome, source, exchangeIds, code?, message?}`                                                                    |
| Diagnosis     | `fingerprint.matched`, `counterfactual.offered`                                           | the matched fingerprint; the offered knob change                                                                                     |
| Environment   | `env.probe`, `env.ready`, `env.degraded`, `env.fingerprint`, `env.tunnel`, `env.run-list` | probe results on the `env` stream                                                                                                    |

Recorded frames from the FLOW-30 pass fixture ([`fixtures/events/FLOW-30-pass.json`](../fixtures/events/FLOW-30-pass.json)), trimmed:

```text
retry: 3000

id: 3
event: step.started
data: {"v":1,"runId":"01K7X0F1XA0000000000000030","seq":3,"ts":"2026-10-19T10:00:00.013Z","type":"step.started","stepKey":"vci.setup.variant","payload":{"flowId":"FLOW-04","order":1,"kind":"http","label":"ensure variant (sdClaim syntax)"}}

id: 39
event: verdict.check
data: {"v":1,"runId":"01K7X0F1XA0000000000000030","seq":39,"ts":"2026-10-19T10:00:00.215Z","type":"verdict.check","stepKey":"vci.credential","payload":{"check":{"checkId":"vci.credential.issued","outcome":"pass","source":"verifier-response","exchangeIds":["01K7X0F1XA0000000000000030:8"]}}}

id: 97
event: run.completed
data: {"v":1,"runId":"01K7X0F1XA0000000000000030","seq":97,"ts":"2026-10-19T10:00:00.404Z","type":"run.completed","payload":{"verdict":{"kind":"interop","outcome":"pass","issuanceOk":true,"verification":"valid","tamperVerdict":null,"failedStepKey":null,"countsTowardPassRate":true},"counterfactualResult":null}}

event: stream.end
data: {"reason":"terminal","lastSeq":97}
```

Secrets are redacted by the store sink before an event is written, so they never appear in the stream, the API or a report.

## Diagnosis, fix-it derive and compare

### `GET /runs/{runId}/diagnosis`

[`apps/bff/src/routes/diagnosis.ts`](../apps/bff/src/routes/diagnosis.ts). What the diagnosis engine found in the stored events of a finished run.

Response `DiagnosisResponse`: `matches[]` (fingerprint ID, gap IDs, `confidence` `exact` or `possible`, `role`, `deviatingSide`, `specClause`, the matched exchanges and events, the deviating component), `offers[]` (the proven knob change for an exact cause), `noFixReason` (why no fix-it button is shown: `no-proven-knob`, `several-causes`, `unclassified`, `tamper-run`, `observed-only`, `version-drift` or `environment-changed`; `null` when an offer stands) and `coverageBanner[]` (every step whose capture was `partial` or `none`).

From the committed parent run [`01M5B6KNNY7DC3YK3CR0ETNBN9`](reports/01M5B6KNNY7DC3YK3CR0ETNBN9.json), trimmed:

```json
{
  "matches": [
    {
      "fingerprintId": "FP-01",
      "gapIds": ["G-55"],
      "confidence": "exact",
      "role": "cause",
      "deviatingSide": "verifier",
      "specClause": "IETF SD-JWT VC (draft-ietf-oauth-sd-jwt-vc-19) §2.5 Issuer Verification Key Discovery and Validation",
      "matchedExchangeIds": ["01M5B6KNNY7DC3YK3CR0ETNBN9:6"],
      "title": "Inji Verify cannot verify an SD-JWT VC whose issuer key is not given as an x5c chain",
      "component": {
        "vendor": "inji",
        "name": "inji-verify (vc-verifier)",
        "versions": "1.0-alpha.1"
      }
    }
  ],
  "offers": [
    {
      "fingerprintId": "FP-01",
      "knobId": "KNOB-01",
      "from": "absent",
      "to": "present",
      "knobStatus": "proven",
      "applyKind": "peer-runtime-option"
    }
  ],
  "noFixReason": null,
  "coverageBanner": [{ "stepKey": "vci.proof.sign", "capture": "none", "reason": null }]
}
```

### `POST /runs/{runId}/derive` (fix-it re-run)

[`apps/bff/src/routes/derive.ts`](../apps/bff/src/routes/derive.ts), checks in [`apps/bff/src/orchestrator/derive.ts`](../apps/bff/src/orchestrator/derive.ts). Creates a child run: a copy of the parent's `RunSpec` with exactly one knob changed, linked to the parent.

- Body (`DeriveRequest`): `{"knobId": "KNOB-01", "value": "present"}`.
- Optional `Idempotency-Key`, as for `POST /runs`.
- `201 Run`: the queued child, with `spec.parentRunId`, `spec.knobDelta` and `spec.causeFingerprintId` set. When it finishes, `counterfactualResult` says whether the change fixed the failure.

The checks, each with its own error code: the parent exists (`404 not_found`) and is finished (`409 run_not_terminal`), failed (`409 parent_not_failed`), is not a tamper run (`409 tamper_run_not_derivable`) and was not imported (`409 key_unavailable`); the knob and value exist (`422 knob_invalid`) and apply to this run (`422 knob_not_applicable`); the value differs from the current one (`422 derive_not_one_knob`); the diagnosis offered this change (`422 fix_not_offered`); no ancestor already changed this knob (`409 knob_reverted`); the component versions and environment still match the parent (`409 version_drift`, `409 environment_changed`); the adapters are available (`503 adapter_unavailable`) and the queue has room (`429 queue_full`). Each case has a test in [`apps/bff/src/routes/derive.contract.test.ts`](../apps/bff/src/routes/derive.contract.test.ts).

### `GET /runs/{runId}/compare/{otherRunId}`

[`apps/bff/src/routes/compare.ts`](../apps/bff/src/routes/compare.ts). Compares a parent and its child (the BFF swaps a child-first URL to parent first). Query `includeVolatile=true` adds differences in values that change on every run (timestamps, nonces).

Response `CompareResponse`: `parent`, `child` (two `Run`s), `relation` (`derived`, `unrelated` or `control-tamper`), `knobDelta`, `classification`, `claimSentence` (only for `fixed`) and `steps[]` with per-step `differences[{path, parent, child, volatile}]` and `directEffect` (the knob's direct effect is listed first). `422 compare_not_comparable` when the two runs have different scopes.

For the fix-it pair, `claimSentence` is (from [`docs/reports/01M5B6M723AQ7T818D36816PRV.json`](reports/01M5B6M723AQ7T818D36816PRV.json)):

> issuer.waltid → wallet.playground-ts → verifier.inji-verify-local (dc+sd-jwt) fails because Inji Verify cannot verify an SD-JWT VC whose issuer key is not given as an x5c chain [FP-01, G-55]. Changing only waltid.sdjwt.x5c from absent to present makes it pass. Evidence: run 01M5B6KNNY7DC3YK3CR0ETNBN9 vs run 01M5B6M723AQ7T818D36816PRV; fingerprint fingerprints/FP-01.json. (changed walt.id issuance option)

## Run report

`GET /reports/runs/{runId}?format=json|markdown` ([`apps/bff/src/routes/reports.ts`](../apps/bff/src/routes/reports.ts), built in [`apps/bff/src/report/index.ts`](../apps/bff/src/report/index.ts)).

- `format=json` (default): `RunReport` with `reportVersion`, `runId`, `generatedAt`, `fields` (issuer, wallet, verifier, format, proof type, grant, mode, environment, component versions, knobs, non-default knobs, verdict, failed step, failing checks, error detail), `diagnosis`, `claimSentence`, `tamper` and `steps[{stepKey, outcome, capture, skipReason}]`.
- `format=markdown`: the same report as `text/markdown`, with `Content-Disposition: inline; filename="run-<runId>.md"`.
- Errors: `404 not_found` (unknown run), `409 run_not_terminal` (the run is still going), `400 validation_failed` (unknown parameter or format).

The report is built from the stored events, so the redaction rules apply. Committed examples: every file in [`docs/reports/`](reports/) (each run has a `.json` and a `.md`).

`fields` of the failing parent run [`01M5B6KNNY7DC3YK3CR0ETNBN9`](reports/01M5B6KNNY7DC3YK3CR0ETNBN9.json), trimmed:

```json
{
  "issuer": "issuer.waltid",
  "wallet": "wallet.playground-ts",
  "verifier": "verifier.inji-verify-local",
  "format": "dc+sd-jwt",
  "proofType": "jwt (ES256)",
  "grant": "pre-authorized_code",
  "mode": "cross-device",
  "versions": {
    "issuer": "waltid/issuer-api2:1.1.0@sha256:e7f8a9ff6b22",
    "verifier": "injistack/inji-verify-service:1.0.0-alpha.1@sha256:064fcfa12773",
    "wallet": "playground-ts@0.0.0"
  },
  "knobs": { "KNOB-01": "absent", "KNOB-07": "plain" },
  "verdict": {
    "kind": "interop",
    "outcome": "fail",
    "issuanceOk": true,
    "verification": "invalid",
    "failedStepKey": "vp.verdict.evaluate",
    "…": "…"
  },
  "failedStepKey": "vp.verdict.evaluate",
  "failingChecks": [
    {
      "checkId": "vc.signature",
      "outcome": "fail",
      "source": "verifier-response",
      "code": "ERR_SIGNATURE_VERIFICATION_FAILED",
      "message": "Exception during Verification: getX509CertChain(...) must not be null"
    }
  ],
  "errorDetail": "ERR_SIGNATURE_VERIFICATION_FAILED: Exception during Verification: getX509CertChain(...) must not be null"
}
```

## End-to-end use cases

All three need the bundle running (`scripts/up.sh`). Set the two guard headers once:

```bash
API=http://127.0.0.1:3100/api/v1
H=(-H 'Origin: http://127.0.0.1:3100' -H 'Content-Type: application/json')
```

### 1. Start a run and follow it

Inji Certify → Playground reference wallet → Inji Verify, SD-JWT VC, cross-device. This is the request used for the fresh-clone check ([`docs/evidence/T-55-fresh-clone.md`](evidence/T-55-fresh-clone.md)).

```bash
RUN=$(curl -s -X POST "$API/runs" "${H[@]}" -H 'Idempotency-Key: demo-1' -d '{
  "issuer": "issuer.certify-preauth", "wallet": "wallet.playground-ts",
  "verifier": "verifier.inji-verify-local", "grant": "pre-authorized_code",
  "presentationMode": "cross-device", "format": "dc+sd-jwt"}' | jq -r .runId)

# follow it live; the stream ends with "event: stream.end"
curl -sN "$API/streams/$RUN/events"

# or read the result when it is done
curl -s "$API/runs/$RUN" | jq '{state, verdict: .verdict.outcome, verification: .verdict.verification}'
```

On 2026-10-20 this combination gave run `01M5CCC4FZRMCCWMVQF5038EYS`: `completed`, outcome `pass`, verification `valid`. For JSON-LD send `"format": "ldp_vc"` (run `01M5CDWNQDX53HC3YF288AFFFG`, [`docs/evidence/T-46-ldp.md`](evidence/T-46-ldp.md)). For the three result labels without OID4VP, send `"issuer": "issuer.fixture", "presentationMode": null` and a `configurationId` from the fixture list ([`docs/evidence/T-47-labels.md`](evidence/T-47-labels.md)).

### 2. Get a report

```bash
curl -s "$API/reports/runs/01M5CCC4FZRMCCWMVQF5038EYS?format=markdown" -o run.md
curl -s "$API/reports/runs/01M5CCC4FZRMCCWMVQF5038EYS" | jq '.fields.verdict'
```

A run that has not finished yet answers `409 run_not_terminal`. The same report opens in the UI at `/runs/<runId>/report`.

### 3. Trigger a fix-it re-run

Needs `scripts/up.sh --with peers` (walt.id issuer). The parent fails at Inji Verify because the walt.id credential has no `x5c` header (G-55).

```bash
PARENT=$(curl -s -X POST "$API/runs" "${H[@]}" -d '{
  "issuer": "issuer.waltid", "wallet": "wallet.playground-ts",
  "verifier": "verifier.inji-verify-local", "grant": "pre-authorized_code",
  "presentationMode": "cross-device", "format": "dc+sd-jwt"}' | jq -r .runId)

# when it has failed: read the offer
curl -s "$API/runs/$PARENT/diagnosis" | jq '.offers, .noFixReason'

# derive the child with exactly that knob changed
CHILD=$(curl -s -X POST "$API/runs/$PARENT/derive" "${H[@]}" -H 'Idempotency-Key: fix-1' \
  -d '{"knobId": "KNOB-01", "value": "present"}' | jq -r .runId)

# when the child is done: classification and claim sentence
curl -s "$API/runs/$PARENT/compare/$CHILD" | jq '{classification, claimSentence}'
```

The recorded live pair is `01M5B6KNNY7DC3YK3CR0ETNBN9` (fail) → `01M5B6M723AQ7T818D36816PRV` (pass, `fixed`). The UI does the same with one click on the diagnosis card; [`e2e/live/fixit.live.spec.ts`](../e2e/live/fixit.live.spec.ts) checks that the click sends exactly `{"knobId":"KNOB-01","value":"present"}`.

## Specified but not served in v1

The OpenAPI file is the full contract of the plan. These endpoints are specified there but the v1 BFF does not register them, so they answer `404 not_found`. They belong to features listed under "Known limitations" in the [README](../README.md#known-limitations).

| Area                    | Endpoints                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Run extras              | `PATCH`/`DELETE /runs/{runId}`, `POST /runs/import`, `GET /runs/{runId}/exchanges/{exchangeId}`, `/artifacts/{artifactId}`, `/export`, `/lineage`, `POST /runs/{runId}/observations` |
| Same-device return      | `POST /api/v1/return/vp`, `GET /return/vp`                                                                                                                                           |
| Suites and matrix       | `/suites*`, `/matrix*`, `/reports/suites/{suiteId}`, `/stats`, `/versions`                                                                                                           |
| Issue drafts            | `/issue-drafts*`                                                                                                                                                                     |
| Tamper mode             | `/tamper/*`, `/tamper/request/{runId}`                                                                                                                                               |
| Verify SDK pass-through | `/proxy/verify/{runId}/{path}`                                                                                                                                                       |

The `/health`, `/vci/*`, `/vp/*` and `/vc/verify` paths at the end of the file belong to the JVM sidecar (Inji Kotlin libraries), which listens only on the internal Docker network. The sidecar is built and its contract is tested against a fake ([`packages/testkit/src/fakes/sidecar.contract.test.ts`](../packages/testkit/src/fakes/sidecar.contract.test.ts)), but no v1 flow uses it.

## External APIs the playground calls

The BFF drives every role itself. Calls marked "internal" go straight to the container on the Docker network; "wallet" calls go through the edge gateway at the address the issuer or verifier advertises, which is how they are captured. Versions are pinned by digest in [`versions.lock`](../versions.lock).

### OpenID for Verifiable Credential Issuance (OID4VCI 1.0 final)

**Inji Certify `1.0.0-alpha.1`** (adapter [`packages/adapters/src/issuers/certify-preauth.ts`](../packages/adapters/src/issuers/certify-preauth.ts), wallet side in [`packages/adapters/src/wallets/playground-ts.ts`](../packages/adapters/src/wallets/playground-ts.ts)):

| Who      | Call                                                                                           | Purpose                                                                        |
| -------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| internal | `GET /v1/certify/credential-configurations/{id}`, `POST /v1/certify/credential-configurations` | read the configuration; create a knob variant when an issuer-side knob differs |
| internal | `POST /v1/certify/pre-authorized-data`                                                         | mint a pre-authorized credential offer with the claims                         |
| wallet   | `GET /v1/certify/credential-offer-data/{id}`                                                   | fetch the credential offer                                                     |
| wallet   | `GET /.well-known/openid-credential-issuer`, `GET /.well-known/oauth-authorization-server`     | issuer and authorization-server metadata                                       |
| wallet   | `POST /v1/certify/oauth/token` (form body)                                                     | exchange the pre-authorized code for an access token                           |
| wallet   | `POST /v1/certify/nonce`                                                                       | get the `c_nonce` for the proof                                                |
| wallet   | `POST /v1/certify/issuance/credential`                                                         | request the credential with a `jwt` proof (ES256)                              |
| wallet   | `GET /.well-known/did.json`                                                                    | issuer DID document (`did:web`)                                                |

The wallet takes the token, nonce and credential URLs from the metadata; the paths above are what Certify advertises.

**walt.id issuer-api2 `1.1.0`** (with `--with peers`; [`packages/adapters/src/issuers/waltid.ts`](../packages/adapters/src/issuers/waltid.ts)):

| Who      | Call                                                                                          | Purpose                                                                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| internal | `POST /issuer2/credential-offers`                                                             | mint a pre-authorized offer by value (`identityCredentialSdJwt`); with KNOB-01 `present` the body adds `runtimeOverrides` with the issuer key and an `x5Chain` |
| wallet   | metadata, token, nonce and credential endpoints under `http://<PUBLIC_HOST>:18103/openid4vci` | the same OID4VCI steps as above                                                                                                                                |

### OpenID for Verifiable Presentations (OID4VP 1.0 final, DCQL)

**Inji Verify `verify-service 1.0.0-alpha.1`** (adapter [`packages/adapters/src/verifiers/inji-verify-local.ts`](../packages/adapters/src/verifiers/inji-verify-local.ts)), base path `/v1/verify`:

| Who      | Call                                  | Purpose                                                                                                                                     |
| -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| internal | `POST /v2/vp-request`                 | create the presentation request (client ID `interop-playground`, a 32-character nonce, a DCQL query); the BFF builds the `openid4vp://` URI |
| wallet   | `GET /v2/vp-request/{requestId}`      | fetch the request (cross-device QR)                                                                                                         |
| wallet   | `POST /v2/vp-submission/direct-post`  | submit `vp_token` and `state` (`direct_post`)                                                                                               |
| internal | `GET /vp-request/{requestId}/status`  | long-poll until the request leaves `ACTIVE` (Verify holds up to 55 s)                                                                       |
| internal | `POST /v2/vp-results/{transactionId}` | read the verification result                                                                                                                |
| internal | `POST /v2/vc-verification`            | credential-level verification without OID4VP (FLOW-40)                                                                                      |

The verifier result maps to the labels: `allChecksSuccessful` and `schemaAndSignatureCheck.valid` give Valid or Invalid, and `expiryCheck.valid: false` with a valid signature gives Valid-but-Expired ([`docs/evidence/T-47-labels.md`](evidence/T-47-labels.md), [`docs/evidence/T-47-vp-expired.md`](evidence/T-47-vp-expired.md)).

### eSignet `1.8.0` and the mock identity system (bring-up only)

No v1 run calls eSignet. `scripts/up.sh` calls it once through the `playground` CLI ([`apps/bff/src/config/bringup.ts`](../apps/bff/src/config/bringup.ts)) to prepare the Mimoto path:

| Call                                                                                           | Purpose                                                                     |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `POST /v1/esignet/client-mgmt/client`, `PUT /v1/esignet/client-mgmt/client/{clientId}`         | create or update the Mimoto OIDC client                                     |
| `POST /v1/mock-identity-system/identity`                                                       | create the two test personas (see [`docs/test-data.md`](test-data.md))      |
| `POST /v1/esignet/authorization/v3/oauth-details`, then the OTP authentication calls           | the authorization-code login of the bring-up smoke test (mock OTP `111111`) |
| Mimoto `GET /v1/mimoto/issuers/{issuer}/configuration`, `POST /v1/mimoto/credentials/download` | the guest download smoke test                                               |
