/**
 * `CreateRunRequest` → `RunSpec` (04 §4.1 steps 1–7, §4.2), shared by API-03 (preview) and API-20.
 * First failure wins. Knob, preset, tamper and configuration catalogues arrive with T-21 / T-76;
 * until then the defaults of ADR-65 apply (no knob is accepted, no tamper case applies).
 */
import { ADAPTER_IDS, catalogEntry } from '@interop-playground/adapters';
import type {
  AdapterId,
  Availability,
  CreateRunRequest,
  CredentialFormat,
  Delivery,
  DisclosureSelection,
  FlowId,
  IncompatibilityHit,
  Role,
  RunSpec,
} from '@interop-playground/api';
import { ApiError, issueDetails } from '../errors/index.js';
import type { FlowTable } from './flows.js';
import { firstHit, type CompatRule, type RuleInput } from './rules.js';

export interface ResolveEnv {
  /** last probe of an adapter; null = never probed (T-12 not running): treated as available */
  availability(id: AdapterId): Availability | null;
  tunnel(): { up: boolean; host: string | null };
}

export const DEFAULT_RESOLVE_ENV: ResolveEnv = {
  availability: () => null,
  tunnel: () => ({ up: false, host: null }),
};

export type Resolution =
  | { ok: true; spec: RunSpec; warnings: string[]; label: string | null }
  | { ok: false; hit: IncompatibilityHit; rule: CompatRule };

const REQUEST_KEYS: Record<string, true> = {
  issuer: true,
  wallet: true,
  verifier: true,
  grant: true,
  presentationMode: true,
  format: true,
  configurationId: true,
  scope: true,
  delivery: true,
  withTxCode: true,
  withIae: true,
  disclosure: true,
  knobs: true,
  preset: true,
  tamperCase: true,
  suiteId: true,
  label: true,
};
const GRANTS = ['pre-authorized_code', 'authorization_code'];
const MODES = ['cross-device', 'same-device', 'dc-api'];
const FORMATS = ['ldp_vc', 'dc+sd-jwt', 'mso_mdoc', 'jwt_vc_json'];
const DELIVERIES = ['qr', 'deep-link', 'web-wallet-redirect', 'adb-intent', 'in-process'];
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** API-08 defaults known today (03 FLOW-01/03/04/05 traces); other pairs use 'default' (ADR-65) */
const DEFAULT_CONFIG: Partial<Record<AdapterId, Partial<Record<CredentialFormat, string>>>> = {
  'issuer.certify-preauth': {
    ldp_vc: 'FarmerCredential',
    'dc+sd-jwt': 'PlaygroundSdJwt',
    mso_mdoc: 'DrivingLicenseCredential',
  },
};

const DEFAULT_DISCLOSURE: Record<CredentialFormat, DisclosureSelection> = {
  'dc+sd-jwt': { claimPaths: [['fullName']] },
  ldp_vc: { claimPaths: [['credentialSubject', 'fullName']] },
  mso_mdoc: { claimPaths: [] },
  jwt_vc_json: { claimPaths: [] },
};

const CREDENTIAL_LEVEL: AdapterId[] = ['verifier.vcverifier-offline', 'verifier.credo'];

function validationError(issues: { path: string; message: string }[]): ApiError {
  return new ApiError('validation_failed', undefined, issueDetails(issues));
}

/** 04 §4.1 step 1: the JSON Schema of `CreateRunRequest` (unknown keys rejected, 04 §1) */
export function validateCreateRunRequest(body: unknown): CreateRunRequest {
  const issues: { path: string; message: string }[] = [];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw validationError([{ path: '$', message: 'must be an object' }]);
  }
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b))
    if (!REQUEST_KEYS[k]) issues.push({ path: `$.${k}`, message: 'unknown field' });
  const role = (k: 'issuer' | 'wallet' | 'verifier'): void => {
    const v = b[k];
    if (v === undefined) issues.push({ path: `$.${k}`, message: 'required' });
    else if (
      typeof v !== 'string' ||
      !(ADAPTER_IDS as readonly string[]).includes(v) ||
      !v.startsWith(`${k}.`)
    )
      issues.push({ path: `$.${k}`, message: `not a ${k} adapter id` });
  };
  role('issuer');
  role('wallet');
  role('verifier');
  const oneOf = (k: string, allowed: string[], required: boolean): void => {
    const v = b[k];
    if (v === undefined) {
      if (required) issues.push({ path: `$.${k}`, message: 'required' });
    } else if (typeof v !== 'string' || !allowed.includes(v))
      issues.push({ path: `$.${k}`, message: `one of ${allowed.join(', ')}` });
  };
  oneOf('grant', GRANTS, true);
  oneOf('presentationMode', MODES, true);
  oneOf('format', FORMATS, true);
  oneOf('scope', ['issuance', 'full'], false);
  oneOf('delivery', DELIVERIES, false);
  for (const k of ['withTxCode', 'withIae'])
    if (b[k] !== undefined && typeof b[k] !== 'boolean')
      issues.push({ path: `$.${k}`, message: 'boolean' });
  for (const k of ['configurationId', 'preset'])
    if (b[k] !== undefined && (typeof b[k] !== 'string' || b[k] === ''))
      issues.push({ path: `$.${k}`, message: 'non-empty string' });
  if (b.label !== undefined && (typeof b.label !== 'string' || b.label.length > 80))
    issues.push({ path: '$.label', message: 'string of at most 80 characters' });
  if (
    b.knobs !== undefined &&
    (b.knobs === null || typeof b.knobs !== 'object' || Array.isArray(b.knobs))
  )
    issues.push({ path: '$.knobs', message: 'object' });
  if (
    b.tamperCase !== undefined &&
    b.tamperCase !== null &&
    (typeof b.tamperCase !== 'string' || !/^TMP-\d{2}$/.test(b.tamperCase))
  )
    issues.push({ path: '$.tamperCase', message: 'TMP-xx or null' });
  if (
    b.suiteId !== undefined &&
    b.suiteId !== null &&
    (typeof b.suiteId !== 'string' || !ULID_RE.test(b.suiteId))
  )
    issues.push({ path: '$.suiteId', message: 'ULID or null' });
  if (b.disclosure !== undefined) {
    const d = b.disclosure;
    const ok =
      d !== null &&
      typeof d === 'object' &&
      Object.keys(d).every((k) => k === 'claimPaths') &&
      Array.isArray((d as { claimPaths?: unknown }).claimPaths) &&
      (d as { claimPaths: unknown[] }).claimPaths.every(
        (p) => Array.isArray(p) && p.every((s) => typeof s === 'string'),
      );
    if (!ok) issues.push({ path: '$.disclosure', message: '{claimPaths: string[][]}' });
  }
  if (issues.length > 0) throw validationError(issues);
  return b as unknown as CreateRunRequest;
}

function defaultDelivery(wallet: AdapterId, verifier: AdapterId, mode: string): Delivery {
  if (CREDENTIAL_LEVEL.includes(verifier)) return 'in-process';
  if (wallet === 'wallet.inji-web') return 'web-wallet-redirect';
  if (wallet === 'wallet.inji-mobile') return 'qr';
  return mode === 'same-device' ? 'deep-link' : 'in-process';
}

function allowedDeliveries(wallet: AdapterId): Delivery[] {
  if (wallet === 'wallet.inji-web') return ['web-wallet-redirect'];
  if (wallet === 'wallet.inji-mobile') return ['qr', 'adb-intent'];
  return ['in-process', 'deep-link'];
}

/** 04 §4.2 issuance table */
export function issuanceFlowOf(r: CreateRunRequest): FlowId {
  if (r.issuer === 'issuer.fixture') return 'FLOW-14';
  if (r.withIae) return 'FLOW-13';
  if (r.wallet === 'wallet.inji-mobile') return 'FLOW-07';
  if (r.wallet === 'wallet.inji-jvm') return 'FLOW-06';
  if (r.wallet === 'wallet.inji-web' && r.issuer === 'issuer.certify-authcode') return 'FLOW-11';
  if (r.wallet === 'wallet.inji-web' && r.issuer === 'issuer.certify-collab') return 'FLOW-12';
  if (r.issuer === 'issuer.waltid') return 'FLOW-08';
  if (r.grant === 'authorization_code') return r.format === 'mso_mdoc' ? 'FLOW-10' : 'FLOW-09';
  if (r.withTxCode) return 'FLOW-02';
  return r.format === 'ldp_vc' ? 'FLOW-03' : r.format === 'dc+sd-jwt' ? 'FLOW-04' : 'FLOW-05';
}

/** 04 §4.2 presentation table */
export function presentationFlowOf(
  r: CreateRunRequest,
  delivery: Delivery,
  clientIdScheme: RunSpec['clientIdScheme'],
): FlowId {
  const v = r.verifier;
  if (r.presentationMode === 'dc-api') return 'FLOW-44';
  // row 2 (credential level): the credential-level verifiers, and mso_mdoc (ADR-30); Inji Verify
  // with an OID4VP wallet stays on its OID4VP flow (ADR-65)
  const credentialLevel =
    delivery === 'in-process' && (CREDENTIAL_LEVEL.includes(v) || r.format === 'mso_mdoc');
  if (credentialLevel) return r.format === 'mso_mdoc' ? 'FLOW-41' : 'FLOW-40';
  if (r.wallet === 'wallet.credo') return 'FLOW-42';
  if (r.wallet === 'wallet.inji-mobile') return 'FLOW-43';
  if (v === 'verifier.inji-verify-sdk') return 'FLOW-37';
  if (r.presentationMode === 'same-device' && delivery === 'deep-link') return 'FLOW-35';
  if (r.presentationMode === 'same-device' && delivery === 'web-wallet-redirect') return 'FLOW-36';
  if (v === 'verifier.waltid') return 'FLOW-38';
  if (v === 'verifier.eudi') return 'FLOW-39';
  if (clientIdScheme === 'decentralized_identifier' || clientIdScheme === 'x509_san_dns')
    return 'FLOW-34';
  if (v === 'verifier.inji-verify-collab') return 'FLOW-33';
  if (r.wallet === 'wallet.inji-jvm') return 'FLOW-32';
  return r.format === 'ldp_vc' ? 'FLOW-31' : 'FLOW-30';
}

/**
 * Format-delta files not shipped yet fall back to their base (ADR-65): FLOW-03/05 → FLOW-01,
 * FLOW-10 → FLOW-09, FLOW-31 → FLOW-30. Returns null when neither is loaded.
 */
const FALLBACK: Partial<Record<FlowId, FlowId>> = {
  'FLOW-03': 'FLOW-01',
  'FLOW-05': 'FLOW-01',
  'FLOW-10': 'FLOW-09',
  'FLOW-31': 'FLOW-30',
};
export function shippedFlow(flows: FlowTable, id: FlowId): FlowId | null {
  if (flows.has(id)) return id;
  const base = FALLBACK[id];
  return base !== undefined && flows.has(base) ? base : null;
}

function hitOf(rule: CompatRule, input: RuleInput): IncompatibilityHit {
  return { ruleId: rule.ruleId, reason: rule.reason(input), gapId: rule.gapId };
}

/**
 * Steps 2–7 of 04 §4.1 for an already schema-valid request. Incompatibilities (stateless and,
 * with `stateful`, the tunnel rules) are returned as `{ok:false}`; knob, tamper, availability and
 * flow problems throw their ApiError.
 */
export function resolveRunSpec(
  req: CreateRunRequest,
  flows: FlowTable,
  env: ResolveEnv,
  opts: { stateful: boolean; checkAvailability: boolean },
): Resolution {
  const warnings: string[] = [];
  // 2. normalise
  let grant = req.grant;
  if (req.issuer === 'issuer.fixture' && grant !== 'pre-authorized_code') {
    grant = 'pre-authorized_code';
    warnings.push('grant ignored for fixture');
  }
  const delivery = req.delivery ?? defaultDelivery(req.wallet, req.verifier, req.presentationMode);
  const scope = req.scope ?? 'full';
  const withTxCode = req.withTxCode ?? false;
  const withIae = req.withIae ?? false;
  const tunnel = env.tunnel();
  // 3. static compatibility (before the delivery set check: a rule names the reason better)
  const input: RuleInput = {
    issuer: req.issuer,
    wallet: req.wallet,
    verifier: req.verifier,
    grant,
    format: req.format,
    presentationMode: req.presentationMode,
    delivery,
    scope,
    withTxCode,
    withIae,
    tunnelUp: tunnel.up,
  };
  const hit = firstHit(input, { stateful: false });
  if (hit) return { ok: false, hit: hitOf(hit, input), rule: hit };
  if (
    !CREDENTIAL_LEVEL.includes(req.verifier) &&
    !allowedDeliveries(req.wallet).includes(delivery)
  ) {
    throw validationError([
      {
        path: '$.delivery',
        message: `${req.wallet} accepts ${allowedDeliveries(req.wallet).join(', ')}`,
      },
    ]);
  }
  // 4. knobs: no catalogue is loaded yet (T-21), so every given knob is unknown
  const knobIds = Object.keys(req.knobs ?? {});
  if (knobIds.length > 0) {
    throw new ApiError('knob_invalid', 'Unknown knob.', {
      knobId: knobIds[0],
      reason: 'unknown-knob',
    });
  }
  if (req.preset !== undefined) {
    throw validationError([{ path: '$.preset', message: `unknown preset ${req.preset}` }]);
  }
  // 5. tamper: no catalogue is loaded yet (T-76)
  if (req.tamperCase) {
    throw new ApiError('tamper_not_applicable', 'This tamper case does not apply.', {
      tmpId: req.tamperCase,
      reason: 'tamper catalogue not loaded',
    });
  }
  // 6. stateful checks
  if (opts.stateful) {
    const s = firstHit(input, { stateful: true });
    if (s) return { ok: false, hit: hitOf(s, input), rule: s };
  }
  const roles: Role[] = ['issuer', 'wallet', 'verifier'];
  const versions = {} as Record<Role, string>;
  const envs = {} as RunSpec['env'];
  for (const role of roles) {
    const id = req[role];
    const a = env.availability(id);
    if (opts.checkAvailability && a && !a.available) {
      throw new ApiError('adapter_unavailable', `${id} is not available.`, {
        adapterId: id,
        reason: a.reason ?? 'probe failed',
      });
    }
    versions[role] = a?.versionFingerprint ?? 'unprobed';
    envs[role] = catalogEntry(id).envClass;
  }
  // flow selection (04 §4.2) and its shipped file
  const clientIdScheme: RunSpec['clientIdScheme'] =
    req.wallet === 'wallet.inji-mobile' ? 'redirect_uri' : 'plain';
  const wantedIssuance = issuanceFlowOf({ ...req, grant });
  const wantedPresentation =
    scope === 'issuance' ? null : presentationFlowOf(req, delivery, clientIdScheme);
  const issuanceFlowId = shippedFlow(flows, wantedIssuance);
  const presentationFlowId =
    wantedPresentation === null ? null : shippedFlow(flows, wantedPresentation);
  if (issuanceFlowId === null || (wantedPresentation !== null && presentationFlowId === null)) {
    const missing = issuanceFlowId === null ? wantedIssuance : wantedPresentation;
    throw new ApiError('adapter_unavailable', `Flow ${String(missing)} is not available yet.`, {
      adapterId: issuanceFlowId === null ? req.wallet : req.verifier,
      reason: 'flow-not-available',
      flowId: missing,
    });
  }
  // 7. env-derived fields
  const tunnelDependent =
    req.wallet === 'wallet.inji-mobile' ||
    (req.format === 'ldp_vc' && req.verifier === 'verifier.inji-verify-collab');
  const spec: RunSpec = {
    issuer: req.issuer,
    wallet: req.wallet,
    verifier: req.verifier,
    grant,
    presentationMode: scope === 'issuance' ? null : req.presentationMode,
    format: req.format,
    configurationId: req.configurationId ?? DEFAULT_CONFIG[req.issuer]?.[req.format] ?? 'default',
    env: envs,
    versions,
    tamperCase: null,
    knobs: {},
    parentRunId: null,
    knobDelta: null,
    tunnelHost: tunnelDependent ? tunnel.host : null,
    scope,
    issuanceFlowId,
    presentationFlowId,
    delivery,
    withTxCode,
    withIae,
    disclosure: req.disclosure ?? DEFAULT_DISCLOSURE[req.format],
    clientIdScheme,
    suiteId: req.suiteId ?? null,
    controlRunId: null,
    causeFingerprintId: null,
  };
  if (wantedIssuance !== issuanceFlowId)
    warnings.push(`${wantedIssuance} runs as its base ${issuanceFlowId}`);
  if (wantedPresentation !== null && wantedPresentation !== presentationFlowId)
    warnings.push(`${wantedPresentation} runs as its base ${String(presentationFlowId)}`);
  return { ok: true, spec, warnings, label: req.label ?? null };
}
