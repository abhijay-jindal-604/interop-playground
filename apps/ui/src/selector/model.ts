/**
 * Selector state (06 UI-03..UI-06, UI-08): the selection, its defaults, the deep link
 * `/?issuer&wallet&verifier&format&grant&mode` (UI-50), `localStorage` persistence and the
 * `CreateRunRequest` built from it. The compatibility rules are never copied here (UI-05): API-03
 * judges every card; only the grant mapping (04 §4.3 first row) and the two tunnel rules are local.
 */
import type {
  AdapterEntry,
  AdapterId,
  CreateRunRequest,
  CredentialFormat,
  EnvSnapshot,
  Grant,
  PresentationMode,
} from '@interop-playground/api';

export type Role = 'issuer' | 'wallet' | 'verifier';
/** the selector's mode: an OID4VP presentation mode, or credential-level (no OID4VP, ADR-94) */
export type UiMode = PresentationMode | 'credential-level';
export type Scope = 'full' | 'issuance';

export interface Selection {
  issuer: AdapterId;
  wallet: AdapterId;
  verifier: AdapterId;
  format: CredentialFormat;
  mode: UiMode;
  scope: Scope;
  /** `issuer.fixture` only: the REQ-23 case (`?config=`); null = the API-08 default */
  configurationId: string | null;
  /** set only by a deep link; otherwise derived from the issuer */
  grant: Grant | null;
}

export const COLUMN_ORDER: Record<Role, AdapterId[]> = {
  issuer: [
    'issuer.certify-preauth',
    'issuer.certify-authcode',
    'issuer.certify-mdoc',
    'issuer.certify-collab',
    'issuer.waltid',
    'issuer.fixture',
  ],
  wallet: [
    'wallet.playground-ts',
    'wallet.inji-jvm',
    'wallet.inji-web',
    'wallet.inji-mobile',
    'wallet.credo',
  ],
  verifier: [
    'verifier.inji-verify-local',
    'verifier.inji-verify-collab',
    'verifier.inji-verify-sdk',
    'verifier.vcverifier-offline',
    'verifier.waltid',
    'verifier.eudi',
    'verifier.credo',
  ],
} as unknown as Record<Role, AdapterId[]>;

export const FORMATS: CredentialFormat[] = ['dc+sd-jwt', 'ldp_vc', 'mso_mdoc'];
export const MODES: UiMode[] = ['cross-device', 'same-device', 'dc-api', 'credential-level'];
/** the `issuer.fixture` configurations (catalog API-08 rows; T-47 REQ-23 cases) */
export const FIXTURE_CONFIGS = [
  'PlaygroundSdJwt',
  'PlaygroundSdJwtExpired',
  'PlaygroundSdJwtInvalid',
] as const;
const FIXTURE = 'issuer.fixture' as AdapterId;
export const SCOPES: Scope[] = ['full', 'issuance'];
const GRANTS: Grant[] = ['pre-authorized_code', 'authorization_code'];

/** The starting selection: the fully automated issuer, wallet and verifier. */
export function defaultSelection(env: EnvSnapshot | null): Selection {
  return {
    issuer: 'issuer.certify-preauth',
    wallet: 'wallet.playground-ts',
    verifier: env?.mode === 'collab' ? 'verifier.inji-verify-collab' : 'verifier.inji-verify-local',
    format: 'dc+sd-jwt',
    mode: 'cross-device',
    scope: 'full',
    grant: null,
    configurationId: null,
  };
}

/** UI-06 grant chip: derived from the issuer (04 §4.3 first row) */
export function derivedGrant(issuer: AdapterId): Grant {
  return issuer === ('issuer.certify-authcode' as AdapterId) ||
    issuer === ('issuer.certify-collab' as AdapterId)
    ? 'authorization_code'
    : 'pre-authorized_code';
}
/** The grant in effect: the user's choice, or the one the chosen issuer implies. */
export const grantOf = (s: Selection): Grant => s.grant ?? derivedGrant(s.issuer);

const known = <T extends string>(list: readonly T[], v: string | null): T | undefined =>
  v !== null && (list as readonly string[]).includes(v) ? (v as T) : undefined;

/** apply `?issuer&wallet&verifier&format&grant&mode` (and `scope`, `config`) over a base selection */
export function fromQuery(params: URLSearchParams, base: Selection): Selection {
  const pick = (role: Role) => known(COLUMN_ORDER[role], params.get(role)) ?? base[role];
  const issuer = pick('issuer');
  return {
    issuer,
    wallet: pick('wallet'),
    verifier: pick('verifier'),
    format: known(FORMATS, params.get('format')) ?? base.format,
    mode: known(MODES, params.get('mode')) ?? base.mode,
    scope: known(SCOPES, params.get('scope')) ?? base.scope,
    grant: known(GRANTS, params.get('grant')) ?? base.grant,
    configurationId:
      issuer === FIXTURE
        ? (known(FIXTURE_CONFIGS, params.get('config')) ??
          (issuer === base.issuer ? base.configurationId : null))
        : null,
  };
}

/** True when the URL already carries a selection, which then takes priority over the remembered one. */
export const hasSelectionQuery = (params: URLSearchParams): boolean =>
  ['issuer', 'wallet', 'verifier', 'format', 'grant', 'mode', 'scope', 'config'].some((k) =>
    params.has(k),
  );

export const STORAGE_KEY = 'pg.selection.v1';

/** Restores the last selection from localStorage; falls back to `base` when storage is empty or unavailable. */
export function loadStored(base: Selection): Selection {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const v = JSON.parse(raw) as Record<string, string>;
    return fromQuery(new URLSearchParams(v), { ...base, grant: null });
  } catch {
    return base;
  }
}

/** Remembers the selection in localStorage; ignores storage errors (private windows). */
export function store(s: Selection): void {
  try {
    const { issuer, wallet, verifier, format, mode, scope } = s;
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        issuer,
        wallet,
        verifier,
        format,
        mode,
        scope,
        ...(s.configurationId ? { config: s.configurationId } : {}),
      }),
    );
  } catch {
    // storage blocked: the defaults apply next time
  }
}

/** Converts the selection into a `CreateRunRequest`. */
export function toRequest(s: Selection): CreateRunRequest {
  return {
    issuer: s.issuer,
    wallet: s.wallet,
    verifier: s.verifier,
    grant: grantOf(s),
    presentationMode: s.mode === 'credential-level' ? null : s.mode,
    format: s.format,
    scope: s.scope,
    ...(s.issuer === FIXTURE && s.configurationId ? { configurationId: s.configurationId } : {}),
  };
}

/** the request for card `id` in column `role`, the other columns as selected (UI-05 step 2) */
export function cardRequest(s: Selection, role: Role, id: AdapterId): CreateRunRequest {
  const next = { ...s, [role]: id };
  if (role === 'issuer') {
    next.grant = null;
    if (id !== s.issuer) next.configurationId = null;
  }
  return toRequest(next);
}

/** Orders a column's adapter cards in the fixed display order. */
export function ordered(entries: readonly AdapterEntry[], role: Role): AdapterEntry[] {
  const order = COLUMN_ORDER[role];
  const at = (e: AdapterEntry) => {
    const i = order.indexOf(e.descriptor.id);
    return i < 0 ? order.length : i;
  };
  return [...entries].sort((a, b) => at(a) - at(b));
}

/** UI-05: the two stateful rules the UI evaluates itself against `EnvSnapshot.tunnel` (OI-5) */
export type TunnelRule = 'phone' | 'collab-ldp';
/** Which tunnel rule a card needs (the phone wallet, or a public verifier), or null when none. */
export function cardTunnel(s: Selection, role: Role, id: AdapterId): TunnelRule | null {
  if (role === 'wallet' && id === ('wallet.inji-mobile' as AdapterId)) return 'phone';
  if (
    role === 'verifier' &&
    s.scope === 'full' &&
    s.format === 'ldp_vc' &&
    id === ('verifier.inji-verify-collab' as AdapterId)
  )
    return 'collab-ldp';
  return null;
}
/** The tunnel rule the whole selection needs, or null. */
export const selectionTunnel = (s: Selection): TunnelRule | null =>
  cardTunnel(s, 'wallet', s.wallet) ?? cardTunnel(s, 'verifier', s.verifier);
