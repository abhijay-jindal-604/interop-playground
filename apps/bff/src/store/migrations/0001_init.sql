-- 0001_init: schema of plan/05 §3 and §3.1, copied verbatim (T-05). Forward-only; never edit an applied file.
CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  checksum    TEXT NOT NULL,                 -- sha256 of the .sql file text
  app_version TEXT NOT NULL,
  applied_at  TEXT NOT NULL
) STRICT;

CREATE TABLE suites (
  suite_id   TEXT PRIMARY KEY,               -- ULID; every run belongs to one (interactive single runs get an implicit suite)
  name       TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('interactive','nightly','ci','manual-suite')),
  env_class  TEXT NOT NULL CHECK (env_class IN ('local','collab','mixed')),
  git_sha    TEXT,
  app_version TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('running','completed','aborted')),
  started_at TEXT NOT NULL,
  ended_at   TEXT
) STRICT;
CREATE INDEX ix_suites_started ON suites (started_at DESC);

CREATE TABLE runs (
  run_id       TEXT PRIMARY KEY,
  suite_id     TEXT NOT NULL REFERENCES suites(suite_id),
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('interactive','nightly','ci','derive')),
  origin       TEXT NOT NULL DEFAULT 'local' CHECK (origin IN ('local','imported')),
  flow_id      TEXT NOT NULL,                -- 'FLOW-30' etc. (03)
  -- immutable block -------------------------------------------------------
  spec_version INTEGER NOT NULL,             -- RunSpec schema version (P8); readers upcast
  spec_json    TEXT NOT NULL CHECK (json_valid(spec_json)),   -- the RunSpec, canonical JSON, knobs fully explicit
  spec_hash    TEXT NOT NULL,                -- sha256(spec_json)
  control_key  TEXT NOT NULL,                -- sha256(spec with tamperCase=null, parentRunId=null, knobDelta=null); a tamper run's control has the same control_key
  versions_key TEXT NOT NULL,                -- sha256 of the sorted (role,component,version_label,fingerprint) tuples
  parent_run_id  TEXT REFERENCES runs(run_id) ON DELETE RESTRICT,
  control_run_id TEXT REFERENCES runs(run_id) ON DELETE RESTRICT,  -- tamper runs only
  knob_delta_json TEXT CHECK (knob_delta_json IS NULL OR json_valid(knob_delta_json)),  -- {knobId,from,to,causeFingerprintId} (02 §7: the child's run.created carries the parent's cause)
  knobs_all_default INTEGER NOT NULL CHECK (knobs_all_default IN (0,1)),
  target_step_key TEXT NOT NULL,             -- the step that answers the cell's question (flow definition's targetStepKey)
  evidence_tier TEXT NOT NULL CHECK (evidence_tier IN ('automated','best-effort','manual')),  -- lowest tier among the 3 adapters
  started_at   TEXT NOT NULL,
  app_version  TEXT NOT NULL,
  -- generated from the RunSpec (never written, never stale) ---------------
  issuer   TEXT GENERATED ALWAYS AS (json_extract(spec_json,'$.issuer'))   VIRTUAL,
  wallet   TEXT GENERATED ALWAYS AS (json_extract(spec_json,'$.wallet'))   VIRTUAL,
  verifier TEXT GENERATED ALWAYS AS (json_extract(spec_json,'$.verifier')) VIRTUAL,
  format   TEXT GENERATED ALWAYS AS (json_extract(spec_json,'$.format'))   VIRTUAL,
  grant_type TEXT GENERATED ALWAYS AS (json_extract(spec_json,'$.grant'))  VIRTUAL,
  presentation_mode TEXT GENERATED ALWAYS AS (json_extract(spec_json,'$.presentationMode')) VIRTUAL,
  tamper_case TEXT GENERATED ALWAYS AS (json_extract(spec_json,'$.tamperCase')) VIRTUAL,
  cell_key TEXT GENERATED ALWAYS AS (
      json_extract(spec_json,'$.format') || '|' || COALESCE(json_extract(spec_json,'$.grant'),'-') || '|' ||
      COALESCE(json_extract(spec_json,'$.presentationMode'),'-') || '|' ||
      json_extract(spec_json,'$.issuer')   || '@' || json_extract(spec_json,'$.env.issuer')   || '|' ||
      json_extract(spec_json,'$.wallet')   || '@' || json_extract(spec_json,'$.env.wallet')   || '|' ||
      json_extract(spec_json,'$.verifier') || '@' || json_extract(spec_json,'$.env.verifier')) VIRTUAL,
  -- lifecycle: set by the event sink in the terminal event's transaction ---
  state   TEXT NOT NULL DEFAULT 'created' CHECK (state IN ('created','running','completed','failed','cancelled')),
  outcome TEXT CHECK (outcome IN ('pass','fail','lenient','blocked','inconclusive','no-submission')),
  outcome_reason TEXT,                       -- 'control_failed', 'environment', 'bff_restart', an FP id, ...
  failed_step_key TEXT,
  capture_limited INTEGER NOT NULL DEFAULT 0 CHECK (capture_limited IN (0,1)),   -- a size cap was hit (§5)
  last_seq     INTEGER NOT NULL DEFAULT 0,
  ended_at     TEXT,
  duration_ms  INTEGER,
  cause_fingerprint_id TEXT,                 -- this run's own exact cause FP (A5.1), set once at close
  counterfactual_result TEXT CHECK (counterfactual_result IN ('fixed','moved','not-fixed','inconclusive')),  -- set once on a derived child (A5.3)
  -- retention / curation (mutable) -----------------------------------------
  pinned  INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  note    TEXT CHECK (note IS NULL OR length(note) <= 2000),
  retention_class TEXT NOT NULL DEFAULT 'keep14' CHECK (retention_class IN ('keep14','keep90','pinned')),
  heavy_expires_at TEXT,                     -- NULL while running; NULL while pinned
  light_expires_at TEXT,
  heavy_pruned_at  TEXT
) STRICT;
CREATE INDEX ix_runs_started   ON runs (started_at DESC, run_id DESC);
CREATE INDEX ix_runs_filter    ON runs (format, outcome, started_at DESC);
CREATE INDEX ix_runs_triple    ON runs (issuer, wallet, verifier, format);
CREATE INDEX ix_runs_cell      ON runs (cell_key, ended_at DESC) WHERE tamper_case IS NULL AND parent_run_id IS NULL AND knobs_all_default = 1;
CREATE INDEX ix_runs_versions  ON runs (versions_key);
CREATE INDEX ix_runs_parent    ON runs (parent_run_id) WHERE parent_run_id IS NOT NULL;
CREATE INDEX ix_runs_control   ON runs (control_key, ended_at DESC);
CREATE INDEX ix_runs_control_of ON runs (control_run_id) WHERE control_run_id IS NOT NULL;
CREATE INDEX ix_runs_suite     ON runs (suite_id);
CREATE INDEX ix_runs_tamper    ON runs (tamper_case, ended_at DESC) WHERE tamper_case IS NOT NULL;
CREATE INDEX ix_runs_heavy_exp ON runs (heavy_expires_at) WHERE heavy_pruned_at IS NULL AND heavy_expires_at IS NOT NULL;
CREATE INDEX ix_runs_light_exp ON runs (light_expires_at) WHERE light_expires_at IS NOT NULL;

CREATE TRIGGER runs_immutable BEFORE UPDATE OF run_id, suite_id, trigger_kind, origin, flow_id, spec_version, spec_json, spec_hash,
  control_key, versions_key, parent_run_id, control_run_id, knob_delta_json, knobs_all_default, target_step_key, evidence_tier,
  started_at, app_version ON runs
BEGIN SELECT RAISE(ABORT, 'runs: immutable column'); END;
CREATE TRIGGER runs_terminal_final BEFORE UPDATE OF state, outcome, ended_at ON runs
WHEN OLD.state IN ('completed','failed','cancelled')
BEGIN SELECT RAISE(ABORT, 'runs: terminal state is final'); END;
CREATE TRIGGER runs_cause_once BEFORE UPDATE OF cause_fingerprint_id ON runs
WHEN OLD.cause_fingerprint_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'runs: cause is set once'); END;
CREATE TRIGGER runs_cf_result_once BEFORE UPDATE OF counterfactual_result ON runs
WHEN OLD.counterfactual_result IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'runs: counterfactual result is set once'); END;
CREATE TABLE run_versions (
  run_id        TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('issuer','wallet','verifier')),
  component     TEXT NOT NULL,               -- 'inji-verify', 'inji-certify', 'vcverifier-jar', 'waltid-verifier', 'eudi-verifier', 'credo', 'inji-wallet', 'playground-ts', 'collab:injiverify'
  version_label TEXT NOT NULL,               -- human label: 'alpha.1', 'develop@sha256:ab12', 'v30', 'collab:2026-10-05'
  fingerprint   TEXT NOT NULL,               -- machine fingerprint (image digest, jar version, Collab host fingerprint, S-007)
  PRIMARY KEY (run_id, role)
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_run_versions ON run_versions (role, component, version_label);

CREATE TABLE run_events (
  run_id     TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,               -- 1.., no gaps (02 §4.1)
  envelope_v INTEGER NOT NULL DEFAULT 1,
  ts         TEXT NOT NULL,
  type       TEXT NOT NULL,                  -- 02 §4.2
  step_key   TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),   -- bodies replaced by {"$blob":sha256,"size":n,"truncated":b,"enc":"utf8|base64"}
  PRIMARY KEY (run_id, seq)
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_events_type ON run_events (run_id, type, seq);
CREATE TRIGGER run_events_append_only BEFORE UPDATE ON run_events
BEGIN SELECT RAISE(ABORT, 'run_events: append-only'); END;

CREATE TABLE blobs (
  sha256   TEXT PRIMARY KEY,                 -- of the REDACTED, UNCOMPRESSED bytes
  raw_size INTEGER NOT NULL,
  enc      TEXT NOT NULL CHECK (enc IN ('identity','gzip')),
  data     BLOB NOT NULL,
  created_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE exchanges (
  run_id      TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  exchange_id TEXT NOT NULL,
  step_key    TEXT NOT NULL,
  direction   TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
  actor       TEXT NOT NULL,
  counterpart TEXT NOT NULL,
  method      TEXT NOT NULL,
  url         TEXT NOT NULL CHECK (length(url) <= 8192),          -- redacted
  status      INTEGER,                                            -- NULL for exchange.error
  error_class TEXT,
  req_headers_json  TEXT NOT NULL CHECK (json_valid(req_headers_json)),
  resp_headers_json TEXT CHECK (resp_headers_json IS NULL OR json_valid(resp_headers_json)),
  req_blob_sha  TEXT, req_size  INTEGER, req_truncated  INTEGER NOT NULL DEFAULT 0, req_body_state  TEXT NOT NULL DEFAULT 'none',
  resp_blob_sha TEXT, resp_size INTEGER, resp_truncated INTEGER NOT NULL DEFAULT 0, resp_body_state TEXT NOT NULL DEFAULT 'none',
  content_type TEXT,
  req_seq INTEGER NOT NULL, resp_seq INTEGER,
  started_at TEXT NOT NULL, duration_ms INTEGER,
  coalesced_count INTEGER NOT NULL DEFAULT 1,       -- identical polls folded into one row (ADR-29)
  PRIMARY KEY (run_id, exchange_id),
  CHECK (req_body_state  IN ('none','stored','truncated','dropped_run_cap','pruned')),
  CHECK (resp_body_state IN ('none','stored','truncated','dropped_run_cap','pruned'))
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_exchanges_step ON exchanges (run_id, step_key, req_seq);
CREATE INDEX ix_exchanges_cp   ON exchanges (counterpart, status, started_at DESC);
CREATE INDEX ix_exchanges_blob ON exchanges (resp_blob_sha) WHERE resp_blob_sha IS NOT NULL;

CREATE TABLE steps (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,                    -- vci.* / vp.* (03 §1.15, §2.0)
  ordinal  INTEGER NOT NULL,                 -- order of step.started (skipped steps get the next ordinals at close)
  outcome  TEXT CHECK (outcome IN ('pass','fail','skipped')),     -- NULL while running
  capture  TEXT CHECK (capture IN ('full','partial','none')),
  reason   TEXT,                             -- skipped reason ("blocked at vp.request.validate")
  started_at TEXT, completed_at TEXT,
  exchange_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, step_key)
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_steps_fail ON steps (step_key, outcome) WHERE outcome = 'fail';

CREATE TABLE checks (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  seq    INTEGER NOT NULL,                   -- seq of the verdict.check event
  step_key TEXT NOT NULL,
  check_id TEXT NOT NULL,                    -- 'vc.signature', 'chk.vci.token.code-missing', ...
  outcome  TEXT NOT NULL CHECK (outcome IN ('pass','fail','not-run','info')),   -- 'info': informational (04 §8.8), excluded from every outcome function and count
  source   TEXT NOT NULL CHECK (source IN ('verifier-response','engine','playground-lint')),
  code     TEXT, message TEXT CHECK (message IS NULL OR length(message) <= 4096),   -- verbatim upstream, truncated at 4 KiB with "…"
  spec_clause TEXT,
  exchange_ids_json TEXT NOT NULL CHECK (json_valid(exchange_ids_json)),
  tamper_json TEXT CHECK (tamper_json IS NULL OR json_valid(tamper_json)),        -- CheckResult.tamper (07 §6)
  PRIMARY KEY (run_id, seq)
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_checks_id ON checks (check_id, outcome);

CREATE TABLE fingerprint_matches (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  seq    INTEGER NOT NULL,
  fingerprint_id TEXT NOT NULL,              -- 'FP-35'
  fingerprint_version INTEGER NOT NULL,
  title TEXT NOT NULL,                       -- 09 A2 `title`, copied from the event payload (06 OI-2)
  component_json TEXT NOT NULL CHECK (json_valid(component_json)),   -- 09 A2 `component` `{vendor, name, versions}` (06 OI-2)
  gap_ids_json TEXT NOT NULL CHECK (json_valid(gap_ids_json)),
  confidence TEXT NOT NULL CHECK (confidence IN ('exact','possible','observed')),
  role       TEXT NOT NULL CHECK (role IN ('cause','finding')),
  deviating_side TEXT NOT NULL,
  spec_clause TEXT,
  evidence_sids_json TEXT NOT NULL CHECK (json_valid(evidence_sids_json)),
  matched_exchange_ids_json TEXT NOT NULL CHECK (json_valid(matched_exchange_ids_json)),
  matched_event_seqs_json   TEXT NOT NULL CHECK (json_valid(matched_event_seqs_json)),
  offer_json TEXT CHECK (offer_json IS NULL OR json_valid(offer_json)),           -- the counterfactual.offered payload for this match, if any
  PRIMARY KEY (run_id, seq)
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_fpm_fp ON fingerprint_matches (fingerprint_id, role, run_id);

CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id   TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('credential','credential-header','mdoc-cbor','x509-leaf','did-document','request-object','token',
                                         'issuer-metadata','vp-token','tamper-before','tamper-after')),
  source_exchange_id TEXT,                   -- the full exchange it was extracted from (09 A2: artifact predicates read full exchanges only)
  tmp_id   TEXT,                             -- tamper-before/after only
  content_type TEXT NOT NULL,
  blob_sha TEXT NOT NULL,
  size     INTEGER NOT NULL CHECK (size <= 1048576),
  tier     TEXT NOT NULL CHECK (tier IN ('heavy','light')),   -- tamper-before/after are 'light'
  seq      INTEGER NOT NULL,                 -- event seq of the artifact's creation
  pruned_at TEXT
) STRICT;
CREATE INDEX ix_artifacts_run ON artifacts (run_id, step_key, kind);

CREATE TABLE tamper_results (
  run_id   TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  tmp_id   TEXT NOT NULL,                    -- 'TMP-04'
  check_id TEXT NOT NULL,                    -- 'chk.vci.token.code-missing'
  control_run_id TEXT REFERENCES runs(run_id) ON DELETE RESTRICT,   -- mirror of runs.control_run_id, NULL only if no control could start (verdict inconclusive)
  target_role TEXT NOT NULL CHECK (target_role IN ('issuer','wallet','verifier')),
  target_adapter TEXT NOT NULL,              -- the adapter whose behaviour is judged (07 §4.9)
  judged_step_key TEXT NOT NULL,
  judged_exchange_id TEXT,
  expected TEXT NOT NULL CHECK (expected IN ('reject','accept','accept-permitted')),
  observed TEXT NOT NULL CHECK (observed IN ('accepted','rejected','crashed','no-response')),
  verdict  TEXT NOT NULL CHECK (verdict IN ('pass','fail','lenient','inconclusive')),
  reason   TEXT,
  findings_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(findings_json)),     -- ["code-drift"]
  observed_status INTEGER, observed_code TEXT,        -- what was judged (07 §2.3), also the baseline comparison input
  before_artifact_id TEXT REFERENCES artifacts(artifact_id) ON DELETE SET NULL,
  after_artifact_id  TEXT REFERENCES artifacts(artifact_id) ON DELETE SET NULL,
  mutation TEXT NOT NULL                     -- the fixed mutation sentence from 07 §4 plus any recorded random UUID (07 §1.3)
) STRICT;
CREATE INDEX ix_tamper_cell ON tamper_results (tmp_id, target_adapter, verdict);

CREATE TABLE tamper_baselines (
  tmp_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  version_label TEXT NOT NULL,
  expected_status INTEGER,
  code TEXT NOT NULL,                        -- '' = rejection with no error code (a WWW-Authenticate-only rejection stores its error= value)
  source TEXT NOT NULL CHECK (source IN ('seed','observed')),
  confirmed INTEGER NOT NULL CHECK (confirmed IN (0,1)),
  evidence TEXT NOT NULL,                    -- 'S-189'; for observed: the run id
  first_seen_run_id TEXT,                    -- no FK: survives run deletion
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  PRIMARY KEY (tmp_id, adapter_id, version_label, code)
) STRICT, WITHOUT ROWID;

CREATE TABLE holder_keys (
  key_id   TEXT PRIMARY KEY,                 -- HolderKeyRef.keyId
  kind     TEXT NOT NULL CHECK (kind IN ('holder','tamper')),
  alg      TEXT NOT NULL CHECK (alg IN ('ES256','EdDSA')),
  public_jwk_json TEXT NOT NULL CHECK (json_valid(public_jwk_json)),
  did_jwk  TEXT,
  private_jwk_json TEXT NOT NULL,            -- never selected by any export query, never by any report query (§6)
  root_run_id TEXT REFERENCES runs(run_id) ON DELETE SET NULL,  -- the run that created it; tamper keys have NULL
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE run_keys (                      -- which runs use which key (derived runs reuse the parent's, 02 §1.3 item 4)
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  key_id TEXT NOT NULL REFERENCES holder_keys(key_id) ON DELETE RESTRICT,
  PRIMARY KEY (run_id, key_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE env_events (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,   -- the `env` stream's SSE id (02 §4.3)
  ts      TEXT NOT NULL,
  type    TEXT NOT NULL,                       -- env.probe | env.ready | env.degraded | env.fingerprint | env.tunnel | gateway.denied
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;
CREATE INDEX ix_env_ts ON env_events (ts);

CREATE TABLE unattributed_exchanges (          -- 02 §3.3: unmatched gateway traffic, 24 h
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  port INTEGER NOT NULL, actor TEXT NOT NULL, counterpart TEXT NOT NULL,
  method TEXT NOT NULL, url TEXT NOT NULL, status INTEGER,
  req_headers_json TEXT NOT NULL, resp_headers_json TEXT,
  req_blob_sha TEXT, resp_blob_sha TEXT, duration_ms INTEGER
) STRICT;
CREATE INDEX ix_unattr_ts ON unattributed_exchanges (received_at);

CREATE TABLE reports (
  report_id TEXT PRIMARY KEY,
  kind      TEXT NOT NULL CHECK (kind IN ('run','matrix','gaps')),
  format    TEXT NOT NULL CHECK (format IN ('json','markdown')),
  run_id    TEXT REFERENCES runs(run_id) ON DELETE CASCADE,          -- kind 'run'
  snapshot_id TEXT REFERENCES matrix_snapshots(snapshot_id) ON DELETE CASCADE,   -- kind 'matrix'
  schema_version INTEGER NOT NULL,
  generator_version TEXT NOT NULL,
  blob_sha TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE matrix_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  suite_id    TEXT REFERENCES suites(suite_id) ON DELETE SET NULL,
  scope_json  TEXT NOT NULL CHECK (json_valid(scope_json)),          -- filters used: env, versionsKey, formats, date bound
  cells_json  TEXT NOT NULL CHECK (json_valid(cells_json)),          -- array of Cell (§7.3)
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),       -- counts per state, pass rate
  created_at  TEXT NOT NULL
) STRICT;
CREATE INDEX ix_snap_created ON matrix_snapshots (created_at DESC);
CREATE TRIGGER snap_immutable BEFORE UPDATE ON matrix_snapshots BEGIN SELECT RAISE(ABORT,'matrix_snapshots: immutable'); END;

CREATE TABLE issue_drafts (                    -- storage only; P12 owns field semantics, dedup and review flow
  draft_id TEXT PRIMARY KEY,
  fingerprint_id TEXT, tmp_id TEXT,
  gap_ids_json TEXT NOT NULL CHECK (json_valid(gap_ids_json)),
  repo TEXT NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE,            -- sha256(repo | fingerprint_id) (08: the version label is dropped, so a still-failing defect on a new release is the same draft; migration 0002 refines this table)
  status TEXT NOT NULL CHECK (status IN ('draft','reviewed','filed','dismissed')),
  title TEXT NOT NULL,
  body_blob_sha TEXT NOT NULL,
  evidence_run_ids_json TEXT NOT NULL CHECK (json_valid(evidence_run_ids_json)),
  filed_url TEXT,
  created_at TEXT NOT NULL, reviewed_at TEXT
) STRICT;
-- Latest closed, default-knob root run per cell (all time). The BFF builds the same query with the user's filters
-- (env, versions_key, format, date bound) added to the INNER WHERE, so ROW_NUMBER sees only the filtered runs.
CREATE VIEW v_cell_latest AS
SELECT cell_key, run_id, outcome, versions_key, evidence_tier, ended_at, cause_fingerprint_id
FROM (SELECT r.*, ROW_NUMBER() OVER (PARTITION BY r.cell_key ORDER BY r.ended_at DESC, r.run_id DESC) AS rn
      FROM runs r
      WHERE r.state = 'completed' AND r.tamper_case IS NULL AND r.parent_run_id IS NULL
        AND r.knobs_all_default = 1 AND r.outcome IS NOT NULL)
WHERE rn = 1;

CREATE VIEW v_tamper_cell_latest AS
SELECT tmp_id, target_adapter, version_label, run_id, verdict, observed_status, observed_code, findings_json, ended_at
FROM (SELECT t.tmp_id, t.target_adapter, rv.version_label, t.run_id, t.verdict, t.observed_status, t.observed_code, t.findings_json, r.ended_at,
             ROW_NUMBER() OVER (PARTITION BY t.tmp_id, t.target_adapter, rv.version_label ORDER BY r.ended_at DESC, r.run_id DESC) AS rn
      FROM tamper_results t
      JOIN runs r ON r.run_id = t.run_id AND r.state = 'completed'
      JOIN run_versions rv ON rv.run_id = t.run_id AND rv.role = t.target_role)
WHERE rn = 1;

-- Telemetry (REQ-35): success rate and latency per flow, last 30 days by default (a WHERE the BFF appends).
CREATE VIEW v_flow_stats AS
SELECT flow_id, format, COUNT(*) AS runs,
       SUM(outcome IN ('pass','lenient')) AS ok, SUM(outcome IN ('fail','blocked')) AS bad,
       AVG(duration_ms) AS avg_ms, MAX(duration_ms) AS max_ms
FROM runs WHERE state = 'completed' AND tamper_case IS NULL AND evidence_tier <> 'manual' GROUP BY flow_id, format;
