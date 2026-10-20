/**
 * BFF API contract: plan/04-api-contracts.md §3 (schemas), §6 (errors), §7 (events), §10 (flow files).
 * Names are final. JSON Schemas (`api.schema.json`), `openapi.yaml` and `client.gen.ts` are generated
 * from this file by `npm run contracts:generate`; never edit the generated files by hand.
 */
import type {
  AdapterDescriptor,
  AdapterId,
  Availability,
  CheckResult,
  ClientIdScheme,
  Coverage,
  CredentialFormat,
  Delivery,
  DisclosureSelection,
  EngineId,
  EnvClass,
  FingerprintId,
  FlowId,
  Grant,
  KnobDef,
  KnobId,
  KnobValues,
  ManualObservation,
  PresentationMode,
  Role,
  RunSpec,
  TamperVerdict,
  Tier,
  TmpId,
  Ulid,
} from '@interop-playground/adapters';

// Types imported unchanged from 02 §5.2 (04 §3 preamble), re-exported for API consumers.
export type {
  AdapterDescriptor,
  AdapterId,
  Availability,
  CheckResult,
  ClientIdScheme,
  Coverage,
  CredentialFormat,
  Delivery,
  DisclosureSelection,
  EngineId,
  EnvClass,
  FingerprintId,
  FlowId,
  Grant,
  KnobDef,
  KnobId,
  KnobValues,
  ManualObservation,
  PresentationMode,
  Role,
  RunSpec,
  TamperVerdict,
  Tier,
  TmpId,
  Ulid,
};

// ---------- 3.1 Shared types ----------
/** RFC 3339 UTC with milliseconds. */
export type Iso = string;
/** A run ULID | 'env' | 'unattributed'. */
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- 04 §3.1 spells out the named streams
export type StreamId = Ulid | 'env' | 'unattributed';
export type RunState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
/** step outcome (02 §4.2) */
export type Outcome = 'pass' | 'fail' | 'skipped';
export type Page<T> = { items: T[]; nextCursor: string | null };

// ---------- 3.2 Run ----------
export interface RunVerdict {
  /** 'probe' = DC API (ADR-16) */
  kind: 'interop' | 'tamper' | 'probe';
  /** 'blocked' (05 §4.1): the target step was skipped after an earlier step failed */
  outcome: 'pass' | 'fail' | 'blocked' | 'no-submission' | 'lenient' | 'inconclusive';
  /** IssuanceOutcome.ok; null for fixture runs and credential-level-only runs */
  issuanceOk: boolean | null;
  /** VerificationOutcome.verdict */
  verification: 'valid' | 'invalid' | 'valid-but-expired' | 'no-submission' | null;
  /** kind = 'tamper': equals outcome */
  tamperVerdict: TamperVerdict | null;
  failedStepKey: string | null;
  /** true only for kind 'interop' with outcome 'pass' | 'fail' | 'blocked' and evidence tier not 'manual' */
  countsTowardPassRate: boolean;
}
/** derived from the last engine.call{op:"await-observation"} */
export interface AwaitingInput {
  stepKey: string;
  expects: ('issuance' | 'presentation' | 'card-status' | 'dcapi-holder' | 'sdk-request-uri')[];
  /** the wait ends then: step fails with 'timeout', verdict 'no-submission' for presentation */
  deadline: Iso;
}
export interface Run {
  runId: Ulid;
  spec: RunSpec;
  /** ≤ 80 chars */
  label: string | null;
  state: RunState;
  createdAt: Iso;
  startedAt: Iso | null;
  finishedAt: Iso | null;
  /** null until terminal */
  verdict: RunVerdict | null;
  /** run.failed: 'env_not_ready' | 'engine_exception' | ... (never a protocol verdict) */
  errorCode: string | null;
  /** set on derived runs (09 A5.3) */
  counterfactualResult: 'fixed' | 'moved' | 'not-fixed' | 'inconclusive' | null;
  awaiting: AwaitingInput | null;
  /** true for verifier.inji-verify-sdk (steps arrive through API-55) */
  uiDriven: boolean;
  /** reference only (02 §6.2) */
  holderKeyId: string | null;
  /** API-36; the only mutable fields after the terminal event */
  pinned: boolean;
  note: string | null;
  /** `runs.heavy_pruned_at` (05 §3, §8.2): when retention deleted the bodies and heavy artifacts */
  heavyPrunedAt: Iso | null;
  /** 'imported' runs (API-37) cannot be derived (`key_unavailable`) */
  origin: 'local' | 'imported';
  /** last seq of the run stream */
  eventCount: number;
  stepSummary: {
    total: number;
    pass: number;
    fail: number;
    skipped: number;
    partialOrNone: number;
  };
  links: { parentRunId: Ulid | null; controlRunId: Ulid | null; childRunIds: Ulid[] };
}
export interface Step {
  stepKey: string;
  /** index in the flow definition */
  order: number;
  flowId: FlowId;
  state: 'pending' | 'running' | 'done';
  outcome: Outcome | null;
  capture: Coverage | null;
  skipReason: string | null;
  startedAt: Iso | null;
  finishedAt: Iso | null;
  durationMs: number | null;
  exchangeIds: string[];
  /** artifacts of this step in `seq` order; ids stay listed after a heavy prune (API-28 then answers `gone`) */
  artifactIds: string[];
  checks: CheckResult[];
  fingerprintIds: FingerprintId[];
}
export interface BodyRef {
  encoding: 'utf8' | 'base64';
  /** inline up to 64 KiB in events; up to 256 KiB (the stored cap) in API-27 (ADR-37) */
  text: string;
  /** original byte length */
  size: number;
  truncated: boolean;
  /** hex of the original bytes */
  sha256: string;
}
/** 'none': no body; 'stored': `body` present; 'pruned': deleted by retention; 'dropped_run_cap': per-run budget exhausted (05 §4.3, §5) */
export type BodyState = 'none' | 'stored' | 'pruned' | 'dropped_run_cap';
/** order and duplicates preserved; each entry is [name, value] */
export type Headers = [name: string, value: string][];
/** one HTTP exchange (request + response, request + error) */
export interface CapturedMessage {
  /** `<runId>:<n>` */
  exchangeId: string;
  runId: Ulid;
  /** null only in the 'unattributed' stream */
  stepKey: string | null;
  direction: 'outbound' | 'inbound';
  /** like 'wallet.playground-ts', 'mimoto→certify-authcode' */
  actor: string;
  counterpart: string;
  request: {
    method: string;
    url: string;
    headers: Headers;
    body: BodyRef | null;
    bodyState: BodyState;
    at: Iso;
  };
  response: {
    status: number;
    statusText: string | null;
    headers: Headers;
    body: BodyRef | null;
    bodyState: BodyState;
    at: Iso;
    durationMs: number;
  } | null;
  /** exactly one of response / error is set */
  error: { errorClass: string; message: string; durationMs: number } | null;
  /** 04 §8.3 */
  poll: PollInfo | null;
  capture: Coverage;
}
export interface Artifact {
  /** `<runId>:<n>` */
  artifactId: string;
  runId: Ulid;
  stepKey: string;
  kind:
    | 'credential-raw'
    | 'credential-decoded'
    | 'request-object'
    | 'vp-token'
    | 'proof-jwt'
    | 'tamper-before'
    | 'tamper-after'
    | 'verifier-result'
    | 'did-document'
    | 'mdoc-envelope';
  /** 'application/json' | 'application/jwt' | 'application/cbor' | 'text/plain' */
  mediaType: string;
  body: BodyRef;
  derivedFromExchangeId: string | null;
}

// ---------- 3.3 Catalog, environment ----------
export interface Health {
  status: 'ok' | 'degraded';
  bff: { version: string; uptimeS: number };
  sidecar: { reachable: boolean; version: string | null };
  adapters: { id: AdapterId; available: boolean; reason: string | null }[];
}
export interface AdapterEntry {
  descriptor: AdapterDescriptor;
  availability: Availability;
  probedAt: Iso | null;
}
export interface AdapterListResponse {
  issuers: AdapterEntry[];
  wallets: AdapterEntry[];
  verifiers: AdapterEntry[];
}

export interface CreateRunRequest {
  issuer: AdapterId;
  wallet: AdapterId;
  verifier: AdapterId;
  grant: Grant;
  /**
   * null = credential-level verification without OID4VP (FLOW-40 / FLOW-41, 04 §4.2 row 2; ADR-94):
   * the held credential goes to the verifier's `verifyCredential`, no wallet presentation
   */
  presentationMode: PresentationMode | null;
  format: CredentialFormat;
  /** default: API-08 default for (issuer, format) */
  configurationId?: string;
  /** default 'full' */
  scope?: 'issuance' | 'full';
  /** default: 04 §4.2 table */
  delivery?: Delivery;
  /** default false */
  withTxCode?: boolean;
  withIae?: boolean;
  /** default: 03 §2.0 DCQL claim of the format */
  disclosure?: DisclosureSelection;
  /** omitted knobs take defaults; keys not belonging to a chosen adapter: knob_invalid */
  knobs?: Partial<KnobValues>;
  /** preset ID of API-07; applied before explicit knobs */
  preset?: string;
  tamperCase?: TmpId | null;
  suiteId?: Ulid | null;
  /** @maxLength 80 */
  label?: string;
}
export type IncompatibilityHit = { ruleId: string; reason: string; gapId: string | null };
export type PreviewResponse =
  | {
      ok: true;
      spec: RunSpec;
      warnings: string[];
      tamperApplicable: TmpId[];
      controlRequired: boolean;
    }
  | { ok: false; hit: IncompatibilityHit | { ruleId: 'validation'; reason: string; gapId: null } };

export interface KnobEntry {
  def: KnobDef;
  adapters: AdapterId[];
  targets: FingerprintId[];
  /** key = CredentialFormat | `${CredentialFormat}@${AdapterId}` */
  status: { [key: string]: 'proven' | 'unproven' | 'no-value-passes' };
  provenBy: string[];
  /** A4 report label */
  label: string;
}
export interface KnobCatalogResponse {
  knobs: KnobEntry[];
}
export interface FlowIndexEntry {
  flowId: FlowId;
  kind: 'issuance' | 'presentation';
  title: string;
  adapters: AdapterId[];
  formats: CredentialFormat[];
  stepKeys: string[];
}
export interface FlowIndexResponse {
  flows: FlowIndexEntry[];
}
export interface Preset {
  presetId: string;
  title: string;
  description: string;
  knobs: Partial<KnobValues>;
}
export interface PresetListResponse {
  presets: Preset[];
}
export interface ConfigurationEntry {
  issuer: AdapterId;
  format: CredentialFormat;
  configurationId: string;
  default: boolean;
  vctOrDoctypeOrType: string;
}
export interface ConfigurationListResponse {
  configurations: ConfigurationEntry[];
}
export interface Incompatibility {
  ruleId: string;
  when: string;
  reason: string;
  gapId: string | null;
  evidence: string[];
}
export interface IncompatibilityListResponse {
  rules: Incompatibility[];
}

export interface UpstreamProbe {
  upstream: string;
  ok: boolean;
  checkedAt: Iso;
  detail: string | null;
  versionFingerprint: string | null;
}
export interface EnvSnapshot {
  mode: 'full-local' | 'collab';
  ready: boolean;
  upstreams: UpstreamProbe[];
  tunnel: { state: 'down' } | { state: 'up'; host: string; since: Iso; expiresAt: Iso };
  collabBudget: { windowS: 60; limit: 20; used: number };
  /** the PUBLIC_HOST in effect */
  publicHost: string;
}
/** host required when 'up' */
export interface TunnelRegistration {
  state: 'up' | 'down';
  host?: string;
  ttlSeconds?: number;
}

// ---------- 3.4 Runs ----------
export interface RunListQuery {
  limit?: number;
  cursor?: string;
  issuer?: AdapterId;
  wallet?: AdapterId;
  verifier?: AdapterId;
  format?: CredentialFormat;
  grant?: Grant;
  mode?: PresentationMode;
  env?: EnvClass;
  state?: RunState;
  outcome?: RunVerdict['outcome'];
  kind?: RunVerdict['kind'];
  /** a version label; with `versionRole` only that role, else any role (05 `run_versions`) */
  version?: string;
  versionRole?: Role;
  trigger?: 'manual' | 'nightly' | 'ci';
  hasCauseFingerprint?: boolean;
  pinned?: boolean;
  tamperCase?: TmpId;
  hasTamper?: boolean;
  suiteId?: Ulid;
  parentRunId?: Ulid;
  derived?: boolean;
  /** createdAt range */
  from?: Iso;
  to?: Iso;
}
export type RunListResponse = Page<Run>;
/** API-80 */
export interface VersionListQuery {
  role?: Role;
}
/** one row per (role, component, version_label) of 05 `run_versions` */
export interface VersionItem {
  role: Role;
  component: string;
  versionLabel: string;
  runCount: number;
  lastUsedAt: Iso;
}
/** not paged; ordered by `lastUsedAt` descending; cap 200 rows */
export interface VersionListResponse {
  items: VersionItem[];
}
/** API-36; at least one field; note ≤ 2,000 chars */
export interface RunPatch {
  pinned?: boolean;
  /** @maxLength 2000 */
  note?: string | null;
}
/** API-37 */
export interface ImportResponse {
  imported: Ulid[];
  skipped: { runId: Ulid; reason: string }[];
}
/** parent is the path parameter */
export interface DeriveRequest {
  knobId: KnobId;
  value: string;
}
export interface StepListResponse {
  steps: Step[];
}
export type ObservationRequest =
  | ManualObservation
  /** FLOW-44 holder attribution (ADR-16) */
  | { step: 'dcapi-holder'; holder: 'none' | 'google-wallet' | `other:${string}` }
  /** the URI the SDK built in the browser (FLOW-37), uiDriven runs only */
  | { step: 'sdk-request-uri'; uri: string };
export interface ObservationAck {
  accepted: true;
  seq: number;
}
export interface DiagnosisResponse {
  /** 04 §7.2 */
  matches: FingerprintMatchedPayload[];
  offers: CounterfactualOfferedPayload[];
  /** 09 A9.3 wording key: 'no-proven-knob' | 'several-causes' | 'unclassified' | 'tamper-run' | 'observed-only' | 'version-drift' | 'environment-changed' */
  noFixReason: string | null;
  /** every partial/none hop by name (RISK-22) */
  coverageBanner: { stepKey: string; capture: Coverage; reason: string | null }[];
}
export interface CompareResponse {
  parent: Run;
  child: Run;
  /** 'derived' = child.parentRunId = parent; 'control-tamper' = tamper run vs its control */
  relation: 'derived' | 'unrelated' | 'control-tamper';
  knobDelta: RunSpec['knobDelta'];
  classification: Run['counterfactualResult'];
  /** only for 'fixed' (09 A5.4) */
  claimSentence: string | null;
  steps: {
    stepKey: string;
    parent: Step | null;
    child: Step | null;
    differences: { path: string; parent: unknown; child: unknown; volatile: boolean }[];
    directEffect: boolean;
  }[];
}
export interface RunExport {
  exportVersion: 1;
  run: Run;
  events: EventEnvelope[];
  exchanges: CapturedMessage[];
  artifacts: Artifact[];
  diagnosis: DiagnosisResponse;
}
export interface LineageResponse {
  chain: {
    runId: Ulid;
    knobDelta: RunSpec['knobDelta'];
    result: Run['counterfactualResult'];
    state: RunState;
  }[];
}
export interface ReturnVpRequest {
  /**
   * @minLength 1
   * @maxLength 128
   */
  responseCode: string;
}
/** redirectTo = '/runs/<runId>' (UI route) */
export interface ReturnVpAck {
  runId: Ulid;
  redirectTo: string;
}
/** json: limit 1–1000, default 500; type = comma list */
export interface StreamQuery {
  format?: 'sse' | 'json';
  after?: number;
  limit?: number;
  type?: string;
}
export interface EventPage {
  streamId: StreamId;
  events: EventEnvelope[];
  nextAfter: number | null;
  closed: boolean;
}

// ---------- 3.5 CheckResult with the tamper sub-object ----------
// `CheckResult.tamper` is part of the 02 §5.2 type in @interop-playground/adapters (re-exported above).

// ---------- 3.6 Tamper ----------
export interface TamperApplicabilityRow {
  issuers: AdapterId[];
  wallets: AdapterId[];
  verifiers: AdapterId[];
  formats: CredentialFormat[];
}
export interface TamperCase {
  tmpId: TmpId;
  checkId: string;
  block: '4.1' | '4.2' | '4.3' | '4.4' | '4.5' | '4.6' | '4.7' | '4.8';
  target:
    | 'issuance-token'
    | 'issuance-proof'
    | 'issued-credential'
    | 'mdoc'
    | 'vp-token'
    | 'kb-jwt'
    | 'request-object';
  title: string;
  /** the exact mutation sentence of 07 §4 */
  mutation: string;
  injectionPoint: 'IP-1' | 'IP-2';
  /** where the mutation applies (FLOW-46, 07 §1.2) */
  stepKey: string;
  /** 07 §2.3 wording */
  judgedStepKey: string;
  judgedExchange: string;
  expected: 'reject' | 'accept' | 'accept-permitted';
  expectedCode: string | null;
  codeKind: 'spec' | 'baseline' | null;
  specClause: string;
  /** † marker of 07 §3 (RISK-27) */
  daggerUnverified: boolean;
  /** TMP-02, TMP-20 (65 s wait) */
  slow: boolean;
  observed: 'observed' | 'untested';
  applicability: TamperApplicabilityRow[];
}
export interface TamperCaseQuery {
  block?: string;
  target?: string;
  format?: CredentialFormat;
  issuer?: AdapterId;
  wallet?: AdapterId;
  verifier?: AdapterId;
  observed?: 'observed' | 'untested';
}
export interface TamperCaseListResponse {
  cases: TamperCase[];
}
export interface TamperBaseline {
  tmpId: TmpId;
  adapterId: AdapterId;
  version: string;
  code: string | null;
  status: number | null;
  /** S-ID */
  recordedFrom: string;
  source: 'seed' | 'observed';
  confirmed: boolean;
  confirmedAt: Iso | null;
}
/** identifies the candidate row (05 key: tmp_id, adapter_id, version_label, code) */
export interface TamperBaselineConfirm {
  tmpId: TmpId;
  adapterId: AdapterId;
  version: string;
  code: string | null;
}
export interface TamperBaselineListResponse {
  baselines: TamperBaseline[];
}

// ---------- 3.7 Suites, reports, stats, drafts ----------
export interface CreateSuiteRequest {
  /** @maxLength 80 */
  name: string;
  trigger: 'manual' | 'nightly' | 'ci';
  /** exactly one of runs / matrix */
  runs?: CreateRunRequest[];
  matrix?: {
    issuers: AdapterId[];
    wallets: AdapterId[];
    verifiers: AdapterId[];
    formats: CredentialFormat[];
    grants?: Grant[];
    modes?: PresentationMode[];
    /** null = the control/baseline run */
    tamperCases?: (TmpId | null)[];
    /** true: drop incompatible cells and list them in `skipped`; false: reject the request */
    skipIncompatible: boolean;
  };
}
export interface Suite {
  suiteId: Ulid;
  name: string;
  trigger: 'manual' | 'nightly' | 'ci';
  state: 'queued' | 'running' | 'completed' | 'cancelled';
  createdAt: Iso;
  finishedAt: Iso | null;
  runs: {
    runId: Ulid;
    state: RunState;
    verdict: RunVerdict | null;
    spec: Pick<
      RunSpec,
      'issuer' | 'wallet' | 'verifier' | 'format' | 'grant' | 'presentationMode' | 'tamperCase'
    >;
  }[];
  skipped: {
    cell: Pick<RunSpec, 'issuer' | 'wallet' | 'verifier' | 'format'>;
    hit: IncompatibilityHit;
  }[];
}
export type SuiteListResponse = Page<Omit<Suite, 'runs' | 'skipped'> & { runCount: number }>;
export interface MatrixQuery {
  issuer?: AdapterId[];
  wallet?: AdapterId[];
  verifier?: AdapterId[];
  format?: CredentialFormat[];
  env?: EnvClass;
  version?: string;
  versionRole?: Role;
  kind?: 'interop' | 'tamper';
}
/** identical to 05 §7.3 (that section is normative) */
export interface MatrixCell {
  /** runs.cell_key; tamper cells: `tamper|<tmpId>|<targetAdapter>|<versionLabel>` */
  cellKey: string;
  block: 'plain' | 'tamper';
  state:
    'pass' | 'fail' | 'blocked' | 'lenient' | 'inconclusive' | 'no-submission' | 'n/a' | 'not-run';
  runId?: Ulid;
  endedAt?: Iso;
  versionsKey?: string;
  versions?: Record<Role, string>;
  tier: Tier;
  failedStepKey?: string;
  causeFingerprintId?: FingerprintId;
  fixedBy?: { knobId: KnobId; to: string; childRunId: Ulid };
  naReason?: { reason: string; gapId?: string };
  flaky: boolean;
  history: { runId: Ulid; state: string; endedAt: Iso }[];
  /** snapshots only: the referenced run was pruned, deleted ("run pruned" in the UI) */
  runDeleted?: true;
}
export interface SnapshotCreateRequest {
  name?: string;
  scope?: MatrixQuery;
  suiteId?: Ulid;
}
export interface MatrixSnapshot {
  snapshotId: Ulid;
  createdAt: Iso;
  name: string | null;
  suiteId: Ulid | null;
  trigger: 'manual' | 'nightly' | 'ci';
  cells: MatrixCell[];
}
export type MatrixSnapshotListResponse = Page<
  Omit<MatrixSnapshot, 'cells'> & { cellCount: number }
>;
export interface MatrixResponse {
  generatedAt: Iso;
  cells: MatrixCell[];
}
export interface RunReport {
  reportVersion: 1;
  runId: Ulid;
  generatedAt: Iso;
  /** REQ-26 */
  fields: {
    issuer: AdapterId;
    wallet: AdapterId;
    verifier: AdapterId;
    format: CredentialFormat;
    proofType: string;
    /** null when the run has no such step (as `RunSpec.grant`; ADR-81) */
    grant: Grant | null;
    /** null for issuance-only and credential-level runs (as `RunSpec.presentationMode`; ADR-81) */
    mode: PresentationMode | null;
    env: RunSpec['env'];
    versions: RunSpec['versions'];
    knobs: KnobValues;
    nonDefaultKnobs: KnobId[];
    verdict: RunVerdict;
    failedStepKey: string | null;
    failingChecks: CheckResult[];
    errorDetail: string | null;
  };
  diagnosis: DiagnosisResponse;
  claimSentence: string | null;
  tamper: CheckResult['tamper'] | null;
  steps: Pick<Step, 'stepKey' | 'outcome' | 'capture' | 'skipReason'>[];
}
export interface SuiteReport {
  reportVersion: 1;
  suite: Suite;
  matrix: MatrixCell[];
  failures: RunReport[];
  generatedAt: Iso;
}
export interface StatsQuery {
  groupBy: 'adapter' | 'format' | 'flow' | 'version' | 'day';
  from?: Iso;
  to?: Iso;
  kind?: 'interop' | 'tamper';
}
export interface StatsResponse {
  groupBy: StatsQuery['groupBy'];
  rows: {
    key: string;
    runs: number;
    pass: number;
    fail: number;
    other: number;
    passRate: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
  }[];
}
export interface IssueDraft {
  draftId: Ulid;
  fingerprintId: FingerprintId;
  gapIds: string[];
  /** like 'inji/inji-verify' */
  repo: string;
  title: string;
  /** markdown, prefilled per 09 A9.6 */
  body: string;
  runIds: Ulid[];
  createdAt: Iso;
  reviewStatus: 'pending' | 'approved' | 'rejected' | 'filed-by-human';
  /** 08 §4.2 additive fields (migration 0002, 05 `issue_drafts`); always present (RISK-33) */
  occurrences: number;
  versionsSeen: string[];
  firstSeenAt: Iso;
  lastSeenAt: Iso;
  resolvedInVersion: string | null;
  note: string | null;
  filedUrl: string | null;
  checklist: IssueDraftChecklist | null;
  /** drafts for private-disclosure gaps are never created (09 A9.6) */
  privateDisclosure: false;
}
export type IssueDraftListResponse = Page<IssueDraft>;
/** 08: the five human checks (the fifth matters for tamper-derived drafts, RISK-27) */
export interface IssueDraftChecklist {
  readExchange: boolean;
  searchedDuplicates: boolean;
  noSecrets: boolean;
  wordingNeutral: boolean;
  specClauseRead: boolean;
}
/**
 * 'pending' cannot be set again; 'approved' needs `checklist` with all five true (else 422
 * `validation_failed`); 'filed-by-human' needs `filedUrl` (https URL the user pasted after filing by hand)
 */
export interface IssueDraftPatch {
  reviewStatus: IssueDraft['reviewStatus'];
  note?: string;
  filedUrl?: string;
  checklist?: IssueDraftChecklist;
}

// ---------- 3.8 Sidecar schemas (API-60..69) ----------
export interface SidecarHealth {
  status: 'ok';
  version: string;
  jars: { vciClient: string; openid4vp: string; vcverifier: string };
}
/** offerUri = 'openid-credential-offer://…' */
export interface VciSessionCreate {
  offerUri: string;
  clientMetadata?: { [key: string]: unknown };
}
export interface VciSessionCreated {
  sessionId: Ulid;
}
export type VciCallback =
  | {
      id: string;
      type: 'proof';
      aud: string;
      nonce: string | null;
      alg: ('RS256' | 'PS256' | 'ES256' | 'EdDSA')[];
    }
  /** not used in FLOW-06; defined for FLOW-02-like future use */
  | {
      id: string;
      type: 'txcode';
      inputMode: 'numeric' | 'text';
      length: number | null;
      description: string | null;
    };
/** pass `next` as the next `after`; empty list after 25 s */
export interface VciPendingResponse {
  callbacks: VciCallback[];
  next: number;
}
/** proof → jws; txcode → txCode */
export interface VciAnswer {
  jws?: string;
  txCode?: string;
}
export type VciResult =
  | { state: 'running' }
  | { state: 'done'; credential: unknown; configId: string; format: CredentialFormat }
  | { state: 'failed'; exceptionClass: string; message: string };
export interface VpAuthenticateRequest {
  urlEncodedRequest: string;
  trustedVerifiers: { clientId: string; responseUris: string[] }[];
  walletMetadata?: { [key: string]: unknown };
}
export interface VpAuthenticateResponse {
  authorizationRequest: {
    clientId: string;
    responseUri: string;
    nonce: string;
    state: string;
    responseMode: string;
    dcqlQuery: unknown;
  };
  sessionId: Ulid;
}
export interface VpUnsignedTokenRequest {
  sessionId: Ulid;
  credential: { format: CredentialFormat; raw: string };
  disclosure: DisclosureSelection;
  holderDid: string;
}
/** the BFF signs it (AdapterContext.sign) */
export interface VpUnsignedTokenResponse {
  toSign: string;
  alg: 'ES256' | 'EdDSA';
}
/** base64url, P1363 for ES256 */
export interface VpResponseRequest {
  sessionId: Ulid;
  signature: string;
}
/** the BFF posts it through CapturingHttp (S-182) */
export interface VpResponseResponse {
  vpToken: string;
  state: string;
  responseUri: string;
}
export interface VcVerifyRequest {
  format: CredentialFormat;
  raw: string;
}
export interface VcVerifyResponse {
  verificationStatus: boolean;
  code: string | null;
  message: string | null;
  rawResult: unknown;
}

// ---------- 6 Error model ----------
/** The 40 codes of 04 §6.2 with their fixed HTTP status (a client may switch on `code` alone). */
export const ERROR_STATUS = {
  validation_failed: 400,
  request_guard_failed: 403,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  gone: 410,
  idempotency_conflict: 409,
  incompatible_selection: 422,
  knob_invalid: 422,
  knob_not_applicable: 422,
  tamper_not_applicable: 422,
  tunnel_required: 409,
  adapter_unavailable: 503,
  env_not_ready: 503,
  queue_full: 429,
  rate_limited: 429,
  run_not_cancellable: 409,
  run_not_terminal: 409,
  run_in_use: 409,
  key_unavailable: 409,
  parent_not_failed: 409,
  tamper_run_not_derivable: 409,
  derive_not_one_knob: 422,
  fix_not_offered: 422,
  knob_reverted: 409,
  version_drift: 409,
  environment_changed: 409,
  observation_not_expected: 409,
  compare_not_comparable: 422,
  draft_not_editable: 409,
  proxy_path_denied: 403,
  proxy_run_not_active: 409,
  upstream_unreachable: 502,
  gateway_denied: 403,
  sidecar_unavailable: 503,
  engine_exception: 422,
  callback_not_pending: 409,
  internal_error: 500,
} as const satisfies Record<string, number>;

export type ErrorCode =
  | 'validation_failed'
  | 'request_guard_failed'
  | 'unauthorized'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'gone'
  | 'idempotency_conflict'
  | 'incompatible_selection'
  | 'knob_invalid'
  | 'knob_not_applicable'
  | 'tamper_not_applicable'
  | 'tunnel_required'
  | 'adapter_unavailable'
  | 'env_not_ready'
  | 'queue_full'
  | 'rate_limited'
  | 'run_not_cancellable'
  | 'run_not_terminal'
  | 'run_in_use'
  | 'key_unavailable'
  | 'parent_not_failed'
  | 'tamper_run_not_derivable'
  | 'derive_not_one_knob'
  | 'fix_not_offered'
  | 'knob_reverted'
  | 'version_drift'
  | 'environment_changed'
  | 'observation_not_expected'
  | 'compare_not_comparable'
  | 'draft_not_editable'
  | 'proxy_path_denied'
  | 'proxy_run_not_active'
  | 'upstream_unreachable'
  | 'gateway_denied'
  | 'sidecar_unavailable'
  | 'engine_exception'
  | 'callback_not_pending'
  | 'internal_error';

export const ERROR_CODES = Object.keys(ERROR_STATUS) as ErrorCode[];

/** Run-level values of `Run.errorCode` beyond the HTTP table (04 §6.2 closing paragraph). */
export type RunErrorCode =
  | 'env_not_ready'
  | 'sidecar_unavailable'
  | 'engine_exception'
  | 'ui_not_connected'
  | 'bff_restarted'
  | 'internal_error';

export interface ErrorEnvelope {
  error: {
    /** stable snake_case, 04 §6.2 */
    code: ErrorCode;
    /** English, one sentence, safe to show; never secrets, never stack traces */
    message: string;
    /** equals the HTTP status */
    status: number;
    requestId: Ulid;
    /** true for 429 and 503 only */
    retryable: boolean;
    /** free-form, per error code (04 §6.2); its own shape, not KnobValues (G-139) */
    details?: { [key: string]: unknown };
  };
}

// ---------- 7 Event schema ----------
export interface EventEnvelope<T extends EventType = EventType> {
  v: 1;
  /** run ULID | 'env' | 'unattributed' */
  runId: StreamId;
  /** per stream, from 1, no gaps; SSE `id` */
  seq: number;
  ts: Iso;
  type: T;
  /** required for step.*, engine.*, verdict.check and exchange.* on run streams; absent for run.*, env.*, gateway.denied */
  stepKey?: string;
  payload: PayloadOf<T>;
}
/** The SSE control frame that closes a stream (04 §7.1); it has no `id`. */
export interface StreamEndFrame {
  reason: 'terminal' | 'closed' | 'server-shutdown';
  lastSeq: number;
}

export type EventType = keyof PayloadMap;
export type PayloadOf<T extends EventType> = PayloadMap[T];
export interface PayloadMap {
  // run lifecycle
  'run.created': { spec: RunSpec; label: string | null; queuePosition: number };
  'run.started': { startedAt: Iso };
  'run.completed': { verdict: RunVerdict; counterfactualResult: Run['counterfactualResult'] };
  /** environment error, not a verdict (02 §4.2) */
  'run.failed': { errorCode: string; message: string; stepKey: string | null };
  'run.cancelled': { reason: 'user' | 'suite' | 'shutdown'; atStepKey: string | null };
  // steps
  'step.started': {
    flowId: FlowId;
    order: number;
    kind: 'http' | 'engine' | 'ui' | 'manual';
    label: string;
  };
  'step.completed': {
    outcome: Outcome;
    capture: Coverage;
    skipReason: string | null;
    /** names the hop outside capture when capture = 'partial' */
    coverageNote: string | null;
    durationMs: number;
  };
  // traffic
  'exchange.request': {
    exchangeId: string;
    direction: 'outbound' | 'inbound';
    actor: string;
    counterpart: string;
    method: string;
    url: string;
    headers: Headers;
    body: BodyRef | null;
    bodyState: BodyState;
    poll: PollInfo | null;
  };
  'exchange.response': {
    exchangeId: string;
    status: number;
    statusText: string | null;
    headers: Headers;
    body: BodyRef | null;
    bodyState: BodyState;
    durationMs: number;
    poll: PollInfo | null;
  };
  'exchange.error': { exchangeId: string; errorClass: string; message: string; durationMs: number };
  'gateway.denied': {
    method: string;
    path: string;
    port: number;
    rule: string;
    remote: 'loopback' | 'lan' | 'tunnel';
  };
  // engines
  'engine.call': {
    engine: EngineId;
    op: EngineOp;
    inputSummary: unknown;
    outputSummary: unknown;
    durationMs: number;
  };
  'engine.exception': {
    engine: EngineId;
    exceptionClass: string;
    message: string;
    endedStep: boolean;
  };
  // diagnosis (02 §7)
  'verdict.check': { check: CheckResult };
  'fingerprint.matched': FingerprintMatchedPayload;
  'counterfactual.offered': CounterfactualOfferedPayload;
  // environment (stream 'env')
  'env.probe': {
    upstream: string;
    ok: boolean;
    detail: string | null;
    versionFingerprint: string | null;
  };
  'env.ready': { upstreams: string[] };
  'env.degraded': { upstreams: string[]; reasons: { [upstream: string]: string } };
  'env.fingerprint': {
    upstream: string;
    fingerprint: string;
    previous: string | null;
    changed: boolean;
  };
  'env.tunnel': { state: 'up'; host: string; expiresAt: Iso } | { state: 'down' };
  /** P8 addition to 02 §4.2: run list updates (02 §4.3) */
  'env.run-list': {
    runId: Ulid;
    state: RunState;
    verdict: RunVerdict | null;
    spec: Pick<
      RunSpec,
      | 'issuer'
      | 'wallet'
      | 'verifier'
      | 'format'
      | 'grant'
      | 'presentationMode'
      | 'tamperCase'
      | 'parentRunId'
      | 'suiteId'
    >;
    at: Iso;
  };
}
/** 04 §8.3; total only on the group's last persisted response */
export interface PollInfo {
  group: string;
  index: number;
  total: number | null;
}
export type EngineOp =
  | 'sign-proof'
  | 'deliver-offer'
  | 'deliver-request'
  | 'load-fixture'
  | 'manual-observation'
  | 'await-observation'
  | 'return-route'
  | 'cancelled'
  | 'normalise-mdoc'
  | 'tamper-apply'
  | 'fetchCredentialsUsingCredentialOffer'
  | 'callback.proof'
  | 'callback.trust'
  | 'callback.txcode'
  | 'authenticateVerifier'
  | 'constructUnsignedVPToken'
  | 'constructVPResponse'
  | 'verify'
  | 'resolve-request'
  | 'dcapi-invoke'
  | 'dcapi-probe'
  | 'inspect-credential'
  | 'validate-request'
  | 'match-credential'
  | 'build-kb-jwt';
export interface FingerprintMatchedPayload {
  fingerprintId: FingerprintId;
  gapIds: string[];
  confidence: 'exact' | 'possible' | 'observed';
  role: 'cause' | 'finding';
  /** 09 A2's six sides (G-151): a two-sided defect is 'issuer+verifier', an environment fault 'environment' */
  deviatingSide:
    'issuer' | 'wallet' | 'verifier' | 'issuer+verifier' | 'environment' | 'playground';
  specClause: string;
  evidenceSIds: string[];
  matchedExchangeIds: string[];
  matchedEventSeqs: number[];
  fingerprintVersion: number;
  /** the fingerprint's one-line title (09 A2 `title`), copied so history replay needs no library */
  title: string;
  /** the deviating component, 09 A2 `component` (like 'vcverifier-jar 1.9.0') */
  component: {
    vendor: 'inji' | 'waltid' | 'eudi' | 'credo' | 'playground';
    name: string;
    versions: string;
  };
}
export interface CounterfactualOfferedPayload {
  fingerprintId: FingerprintId;
  knobId: KnobId;
  from: string;
  to: string;
  knobStatus: 'proven';
  applyKind: KnobDef['appliesAt'];
  provenBy: string[];
  chain?: { knobId: 'env'; from: string; to: string }[];
}

/** Typed `outputSummary` of the engine ops the UI and fingerprints rely on (04 §7.2 table). */
export interface EngineOpOutputSummaries {
  'deliver-offer': { channel: Delivery; uri: string; uriSha256: string };
  'deliver-request': { channel: Delivery; uri: string; uriSha256: string };
  'await-observation': { expects: AwaitingInput['expects']; deadline: Iso };
  'manual-observation': { observation: ObservationRequest };
  'sign-proof': { alg: 'ES256' | 'EdDSA'; kid: string; jwsSha256: string };
  'dcapi-invoke': { resolved: boolean; domExceptionName: string | null; message: string | null };
  'tamper-apply': { tmpId: TmpId; artifactBefore: string; artifactAfter: string };
}

// ---------- 10 Flow definition files (API-72) ----------
export type Lifeline = 'IUI' | 'I' | 'VUI' | 'V' | 'W' | 'L';
export interface FlowDefinition {
  /** 'FLOW-01'..'FLOW-14' (issuance) | 'FLOW-30'..'FLOW-44' (presentation); equals the file name */
  flowId: FlowId;
  kind: 'issuance' | 'presentation';
  title: string;
  /** the step whose outcome is the run outcome (05 §4.1) */
  targetStepKey: string;
  /** format-delta files: start from the base steps, replace by stepKey, append after `after` */
  extends?: FlowId;
  /** issuance: IUI, I, W, L; presentation: VUI, V, W, L (03 §3.1) */
  lifelines: Lifeline[];
  steps: FlowStep[];
}
export interface FlowStep {
  /** a key of the registry (03 §1.15 `vci.*`, §2.0 `vp.*`, `vci.prereq.<suffix>`) */
  stepKey: string;
  /** 1-based, unique, ascending */
  order: number;
  /** lifeline codes */
  from: string;
  to: string;
  /** arrow text shown in the diagram */
  label: string;
  kind: 'http' | 'engine' | 'ui' | 'manual';
  /** 2 for http (request + dashed response), 1 for engine/ui/manual (03 §3.1) */
  messages: 1 | 2;
  /** closed AND-filter; omitted = always applies */
  appliesTo?: {
    adapters?: AdapterId[];
    formats?: CredentialFormat[];
    grants?: Grant[];
    modes?: PresentationMode[];
    deliveries?: Delivery[];
    envs?: EnvClass[];
    clientIdSchemes?: ClientIdScheme[];
    withTxCode?: boolean;
    withIae?: boolean;
  };
  /** text of `step.completed.skipReason` when the filter does not match; default "not applicable" */
  skipReason?: string;
  /** only in an `extends` file: stepKey to insert this step after */
  after?: string;
  /** kept one release so old runs render (03 §3.1 rule 5) */
  deprecated?: boolean;
}

/** Event types in 04 §7.2 order (the 22 keys of PayloadMap). */
export const EVENT_TYPES = [
  'run.created',
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'step.started',
  'step.completed',
  'exchange.request',
  'exchange.response',
  'exchange.error',
  'gateway.denied',
  'engine.call',
  'engine.exception',
  'verdict.check',
  'fingerprint.matched',
  'counterfactual.offered',
  'env.probe',
  'env.ready',
  'env.degraded',
  'env.fingerprint',
  'env.tunnel',
  'env.run-list',
] as const satisfies readonly EventType[];
