/**
 * Adapter contracts of the Interop Playground: plan/02-architecture.md §5.2 (names are final).
 * `RunSpec` lives in this file (02 §5.2 closing paragraph); its normative shape is 04 §3.1.
 * The REST/SSE JSON Schemas are generated from these types (scripts/contracts-generate.mjs).
 */
import type { JsonWebKey } from 'node:crypto';

// ---------- shared ----------
export type Role = 'issuer' | 'wallet' | 'verifier';
export type EnvClass = 'local' | 'collab';
export type CredentialFormat = 'ldp_vc' | 'dc+sd-jwt' | 'mso_mdoc' | 'jwt_vc_json';
export type Grant = 'pre-authorized_code' | 'authorization_code';
export type PresentationMode = 'cross-device' | 'same-device' | 'dc-api';
export type ClientIdScheme = 'plain' | 'decentralized_identifier' | 'x509_san_dns' | 'redirect_uri';
export type Tier = 'automated' | 'best-effort' | 'manual'; // ADR-13, ADR-15
export type Coverage = 'full' | 'partial' | 'none'; // 02 §3.3
export type Vendor = 'inji' | 'waltid' | 'eudi' | 'credo' | 'playground';

/** The 18 adapter ids of 02 §5.3, in table order. */
export const ADAPTER_IDS = [
  'issuer.certify-preauth',
  'issuer.certify-authcode',
  'issuer.certify-mdoc',
  'issuer.certify-collab',
  'issuer.waltid',
  'issuer.fixture',
  'wallet.playground-ts',
  'wallet.inji-jvm',
  'wallet.inji-web',
  'wallet.inji-mobile',
  'wallet.credo',
  'verifier.inji-verify-local',
  'verifier.inji-verify-collab',
  'verifier.inji-verify-sdk',
  'verifier.vcverifier-offline',
  'verifier.waltid',
  'verifier.eudi',
  'verifier.credo',
] as const;

export type AdapterId =
  | 'issuer.certify-preauth'
  | 'issuer.certify-authcode'
  | 'issuer.certify-mdoc'
  | 'issuer.certify-collab'
  | 'issuer.waltid'
  | 'issuer.fixture'
  | 'wallet.playground-ts'
  | 'wallet.inji-jvm'
  | 'wallet.inji-web'
  | 'wallet.inji-mobile'
  | 'wallet.credo'
  | 'verifier.inji-verify-local'
  | 'verifier.inji-verify-collab'
  | 'verifier.inji-verify-sdk'
  | 'verifier.vcverifier-offline'
  | 'verifier.waltid'
  | 'verifier.eudi'
  | 'verifier.credo';

/**
 * Catalogue: plan/09 §Spec.
 * @pattern ^KNOB-[0-9]{2}$
 */
export type KnobId = `KNOB-${string}`;
/** Every knob of every chosen adapter, explicit. */
export type KnobValues = Readonly<Record<KnobId, string>>;

export interface KnobDef {
  id: KnobId;
  /** like 'waltid.sdjwt.x5c' */
  name: string;
  /** closed enum, in display order */
  values: readonly string[];
  defaultValue: string;
  appliesAt:
    | 'issuer-variant-config'
    | 'issuer-target-switch'
    | 'peer-runtime-option'
    | 'wallet-runtime'
    | 'verifier-request'
    | 'adapter-setting';
  /** the knob is offered only for these formats */
  formats: readonly CredentialFormat[];
}

export interface CaptureContext {
  runId: string;
  stepKey: string;
  actor: string;
  counterpart: string;
  /** marks a repeated read of one resource ('vp-result', 'vp-status'); coalescing rules in 04 §8.3 */
  poll?: { group: string };
  /** use and update the run's cookie jar (FLOW-35, API-55) */
  cookieJar?: boolean;
}

export interface CapturingHttp {
  fetch(ctx: CaptureContext, url: string | URL, init?: RequestInit): Promise<Response>;
  /** flushes the last unpersisted poll (04 §8.3) */
  closePoll(ctx: CaptureContext, group: string): Promise<void>;
}

export type CorrelationKey =
  | {
      kind:
        | 'pre-authorized-code'
        | 'offer-id'
        | 'request-id'
        | 'state'
        | 'transaction-id'
        | 'esignet-state'
        | 'peer-session-id';
      value: string;
    }
  /** SHA-256 hex, never the raw token */
  | { kind: 'access-token-sha256'; value: string };

/**
 * The gateway's correlation index as the adapters see it (02 §3.3, ADR-70; structural copy of
 * `apps/bff/src/gateway/correlation.ts` so this package stays free of BFF imports).
 */
export interface GatewayCorrelation {
  register(runId: string, key: string, stepKey: string, actor?: string | null): void;
  /** maps inbound `{method, path}` of the run to a stepKey (merged per run by the caller) */
  addRoutes?(
    runId: string,
    routes: readonly { method: string; pattern: RegExp; stepKey: string }[],
  ): void;
}

export interface AdapterContext {
  readonly runId: string;
  readonly spec: RunSpec;
  readonly knobs: KnobValues;
  readonly http: CapturingHttp;
  readonly signal: AbortSignal;
  /** persisted before publish (02 §4.1) */
  emit(event: AdapterEvent): Promise<void>;
  /** gateway lookup table (02 §3.3) */
  correlate(key: CorrelationKey): void;
  /** parent's key on derived runs (02 §1.3 item 4) */
  holderKey(): Promise<HolderKeyRef>;
  /** P1363 for ES256 */
  sign(key: HolderKeyRef, alg: 'ES256' | 'EdDSA', data: Uint8Array): Promise<Uint8Array>;
}

export type AdapterEvent =
  | { type: 'step.started'; stepKey: string }
  | {
      type: 'step.completed';
      stepKey: string;
      outcome: 'pass' | 'fail' | 'skipped';
      capture: Coverage;
    }
  | {
      type: 'engine.call';
      stepKey: string;
      engine: EngineId;
      op: string;
      inputSummary: unknown;
      outputSummary: unknown;
    }
  | {
      type: 'engine.exception';
      stepKey: string;
      engine: EngineId;
      exceptionClass: string;
      message: string;
    }
  | { type: 'verdict.check'; stepKey: string; check: CheckResult };

export type EngineId =
  | 'sidecar.openid4vp'
  | 'sidecar.vci-client'
  | 'sidecar.vcverifier'
  | 'credo'
  | 'playground-ts'
  | 'mdoc-normaliser';

export interface HolderKeyRef {
  keyId: string;
  alg: 'ES256' | 'EdDSA';
  publicJwk: JsonWebKey;
  didJwk: string;
}

/** Tamper verdict of 07 §2.2 (04 §3.1 `TamperVerdict`). */
export type TamperVerdict = 'pass' | 'fail' | 'lenient' | 'inconclusive';

export interface CheckResult {
  /** stable, like 'vp.kb-jwt.aud', 'vc.signature', 'mdoc.decode' */
  checkId: string;
  /**
   * 'info' = informational, never a pass criterion, never a fail criterion, never counted in
   * `stepSummary`, never counted in a verdict (first user: `vp.wallet.verifier-badges`, 03 FLOW-60, S-203)
   */
  outcome: 'pass' | 'fail' | 'not-run' | 'info';
  source: 'verifier-response' | 'engine' | 'playground-lint';
  /** verbatim upstream code, like 'ERR_INVALID_AUD', 'IsMissingHolderPublicKey' */
  code?: string;
  /** verbatim upstream message */
  message?: string;
  /** spec name + section title (P7 owns tamper clauses) */
  specClause?: string;
  /** the captured exchanges the check rests on */
  exchangeIds: readonly string[];
  /** present only on the single verdict.check of a tamper run (07 §6; 04 §3.5) */
  tamper?: {
    tmpId: TmpId;
    expected: 'reject' | 'accept' | 'accept-permitted';
    observed: 'accepted' | 'rejected' | 'crashed' | 'no-response';
    verdict: TamperVerdict;
    /** for 'inconclusive' and 'fail' (for example 'control run failed', '5xx where 4xx required') */
    reason?: string;
    /** 'code-drift' is the only value defined today */
    findings: string[];
  };
}

/** ADR-05, S-007 */
export interface Availability {
  available: boolean;
  reason?: string;
  versionFingerprint: string;
}

export interface AdapterDescriptor {
  id: AdapterId;
  role: Role;
  vendor: Vendor;
  displayName: string;
  envClass: EnvClass;
  tier: Tier;
  formats: readonly CredentialFormat[];
  knobs: readonly KnobDef[];
  coverage: CoverageDecl;
}
export interface CoverageDecl {
  default: Coverage;
  partialHops: readonly { stepKey: string; reason: string; evidence: string }[];
}

export interface AdapterBase {
  readonly descriptor: AdapterDescriptor;
  probe(ctx: Omit<AdapterContext, 'spec' | 'knobs' | 'holderKey' | 'sign'>): Promise<Availability>;
}

// ---------- issuer ----------
export interface CredentialOffer {
  /** 'openid-credential-offer://?credential_offer_uri=…' (by reference) | offer by value */
  uri: string;
  credentialIssuer: string;
  configurationId: string;
  grant: Grant;
  txCode?: { value: string; inputMode: 'numeric' | 'text'; length: number };
}
/** auth-code issuers: what a wallet needs to start the flow */
export interface AuthCodeTarget {
  credentialIssuer: string;
  authorizationServer: string;
  scope: string;
  configurationId: string;
}
export interface IssuerAdapter extends AdapterBase {
  metadata(
    ctx: AdapterContext,
  ): Promise<{ issuer: unknown; authorizationServer: unknown; exchangeIds: string[] }>;
  /** Pre-auth issuers: mint an offer (BFF-internal admin call, never through the gateway). */
  createOffer?(
    ctx: AdapterContext,
    req: { configurationId: string; claims: Record<string, unknown>; withTxCode: boolean },
  ): Promise<CredentialOffer>;
  /** Auth-code issuers: describe the flow for the wallet adapter. */
  authCodeTarget?(ctx: AdapterContext, configurationId: string): Promise<AuthCodeTarget>;
  /** Issuer-side knobs: ensure the variant config exists (idempotent) and return its id (02 §1.3 item 5). */
  resolveVariant(ctx: AdapterContext, baselineConfigurationId: string): Promise<string>;
  /** Fixture issuer only: return a saved credential and its holder key. */
  fixture?(ctx: AdapterContext, format: CredentialFormat): Promise<HeldCredential>;
}

// ---------- wallet ----------
/** mDoc envelope shapes recognised by the normaliser (02 §5.5, ADR-25). */
export type MdocEnvelope = 'issuer-signed' | 'document' | 'device-response';

export interface HeldCredential {
  format: CredentialFormat;
  /** compact SD-JWT, JSON-LD as JSON text, mDoc as base64url (as received) */
  raw: string;
  /** 02 §5.5 */
  mdocEnvelope?: MdocEnvelope;
  holderKey: HolderKeyRef;
  issuerAdapter: AdapterId;
  configurationId: string;
}
export interface IssuanceOutcome {
  ok: boolean;
  credential?: HeldCredential;
  checks: readonly CheckResult[];
}
export interface PresentationRequestRef {
  verifierAdapter: AdapterId;
  /** 'openid4vp://authorize?…' as the wallet would receive it (QR / deep link) */
  requestUri: string;
  clientId: string;
  clientIdScheme: ClientIdScheme;
  responseUri: string;
  nonce: string;
  state: string;
  dcqlQuery: unknown;
  mode: PresentationMode;
}
export interface DisclosureSelection {
  claimPaths: readonly (readonly string[])[];
}
export interface PresentationOutcome {
  submitted: boolean;
  checks: readonly CheckResult[];
  walletError?: { dispatched: boolean; error: string };
}
export interface WalletAdapter extends AdapterBase {
  receiveOffer?(ctx: AdapterContext, offer: CredentialOffer): Promise<IssuanceOutcome>;
  receiveAuthCode?(ctx: AdapterContext, target: AuthCodeTarget): Promise<IssuanceOutcome>;
  present(
    ctx: AdapterContext,
    req: PresentationRequestRef,
    held: HeldCredential,
    sel: DisclosureSelection,
  ): Promise<PresentationOutcome>;
  /** manual tier only (inji-mobile): the user's recorded observation of the phone screen. */
  recordManualObservation?(ctx: AdapterContext, obs: ManualObservation): Promise<void>;
}
export type ManualObservation =
  | { step: 'issuance'; shown: 'card-added' | 'error'; text?: string }
  | { step: 'presentation'; shown: 'shared' | 'no-matching-credentials' | 'error'; text?: string }
  | { step: 'card-status'; shown: 'valid' | 'invalid' | 'pending'; text?: string };

// ---------- verifier ----------
export interface PresentationQuery {
  format: CredentialFormat;
  configurationId: string;
  vctOrDoctypeOrType: string;
  claimPaths: readonly (readonly string[])[];
  mode: PresentationMode;
}
export interface VerificationOutcome {
  verdict: 'valid' | 'invalid' | 'valid-but-expired' | 'no-submission';
  checks: readonly CheckResult[];
  /** the verifier's own result JSON, verbatim */
  rawResult: unknown;
  exchangeIds: readonly string[];
}
export interface VerifierAdapter extends AdapterBase {
  createRequest?(ctx: AdapterContext, q: PresentationQuery): Promise<PresentationRequestRef>;
  awaitResult?(
    ctx: AdapterContext,
    req: PresentationRequestRef,
    timeoutMs: number,
  ): Promise<VerificationOutcome>;
  /**
   * Credential-level verification (no OID4VP): offline and library verifiers, Inji Verify
   * /v2/vc-verification. `evaluate:false` (FLOW-31 tier 1, ADR-97): the checks stay at
   * `vp.vc.verify` and `vp.verdict.evaluate` is left to the OID4VP tier.
   */
  verifyCredential?(
    ctx: AdapterContext,
    held: HeldCredential,
    opts?: { evaluate?: boolean },
  ): Promise<VerificationOutcome>;
}

// ---------- registry ----------
export interface AdapterRegistry {
  list(): readonly AdapterDescriptor[];
  issuer(id: AdapterId): IssuerAdapter;
  wallet(id: AdapterId): WalletAdapter;
  verifier(id: AdapterId): VerifierAdapter;
  /** Static compatibility (selector greys out impossible triples, with the gap ID as reason). */
  compatible(
    issuer: AdapterId,
    wallet: AdapterId,
    verifier: AdapterId,
    format: CredentialFormat,
    grant: Grant,
  ): { ok: true } | { ok: false; reason: string; gapId?: string };
}

// ---------- run spec (02 §1.3; normative TypeScript: 04 §3.1) ----------
/**
 * 26 chars, Crockford base32, uppercase.
 * @pattern ^[0-9A-HJKMNP-TV-Z]{26}$
 */
export type Ulid = string;
/**
 * TMP-01..TMP-79
 * @pattern ^TMP-[0-9]{2}$
 */
export type TmpId = `TMP-${string}`;
/** @pattern ^FLOW-[0-9]{2}$ */
export type FlowId = `FLOW-${string}`;
/** @pattern ^FP-[0-9]{2}$ */
export type FingerprintId = `FP-${string}`;
export type Delivery = 'qr' | 'deep-link' | 'web-wallet-redirect' | 'adb-intent' | 'in-process';

/** Immutable (ADR-21); 02 §1.3 names first, P8 additions after. */
export interface RunSpec {
  issuer: AdapterId;
  wallet: AdapterId;
  verifier: AdapterId;
  /** null when the run has no such step (credential-level verification, issuance-only; 05 §3 `cell_key` writes '-') */
  grant: Grant | null;
  presentationMode: PresentationMode | null;
  format: CredentialFormat;
  configurationId: string;
  /** keyed by role; derived from the adapter descriptors */
  env: Record<Role, EnvClass>;
  /** keyed by role; Availability.versionFingerprint at creation */
  versions: Record<Role, string>;
  tamperCase: TmpId | null;
  /** every knob of every chosen adapter, explicit */
  knobs: KnobValues;
  parentRunId: Ulid | null;
  knobDelta: { knobId: KnobId; from: string; to: string } | null;
  /** set when the tunnel base URLs were switched at creation (02 §2.6) */
  tunnelHost: string | null;

  /** 'issuance' stops after the issuance flow; the verifier is still recorded */
  scope: 'issuance' | 'full';
  /** chosen by 04 §4.2 */
  issuanceFlowId: FlowId;
  /** null when scope = 'issuance' */
  presentationFlowId: FlowId | null;
  delivery: Delivery;
  /** FLOW-02; only certify-preauth + playground-ts */
  withTxCode: boolean;
  /** FLOW-13; only when the probe allows (ADR-50) */
  withIae: boolean;
  /** default per format (03 §2.0 common parameters) */
  disclosure: DisclosureSelection;
  /** effective scheme; = KNOB-07 value, except 'redirect_uri' for wallet.inji-mobile */
  clientIdScheme: ClientIdScheme;
  suiteId: Ulid | null;
  /** set on tamper runs (07 §1.1) */
  controlRunId: Ulid | null;
  /** set on derived runs (02 §7) */
  causeFingerprintId: FingerprintId | null;
}
