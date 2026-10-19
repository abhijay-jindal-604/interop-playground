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
export type Scope = 'full' | 'issuance';

export interface Selection {
  issuer: AdapterId;
  wallet: AdapterId;
  verifier: AdapterId;
  format: CredentialFormat;
  mode: PresentationMode;
  scope: Scope;
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
export const MODES: PresentationMode[] = ['cross-device', 'same-device', 'dc-api'];
export const SCOPES: Scope[] = ['full', 'issuance'];
const GRANTS: Grant[] = ['pre-authorized_code', 'authorization_code'];

export function defaultSelection(env: EnvSnapshot | null): Selection {
  return {
    issuer: 'issuer.certify-preauth',
    wallet: 'wallet.playground-ts',
    verifier: env?.mode === 'collab' ? 'verifier.inji-verify-collab' : 'verifier.inji-verify-local',
    format: 'dc+sd-jwt',
    mode: 'cross-device',
    scope: 'full',
    grant: null,
  };
}

/** UI-06 grant chip: derived from the issuer (04 §4.3 first row) */
export function derivedGrant(issuer: AdapterId): Grant {
  return issuer === ('issuer.certify-authcode' as AdapterId) ||
    issuer === ('issuer.certify-collab' as AdapterId)
    ? 'authorization_code'
    : 'pre-authorized_code';
}
export const grantOf = (s: Selection): Grant => s.grant ?? derivedGrant(s.issuer);

const known = <T extends string>(list: readonly T[], v: string | null): T | undefined =>
  v !== null && (list as readonly string[]).includes(v) ? (v as T) : undefined;

/** apply `?issuer&wallet&verifier&format&grant&mode` (and `scope`) over a base selection */
export function fromQuery(params: URLSearchParams, base: Selection): Selection {
  const pick = (role: Role) => known(COLUMN_ORDER[role], params.get(role)) ?? base[role];
  return {
    issuer: pick('issuer'),
    wallet: pick('wallet'),
    verifier: pick('verifier'),
    format: known(FORMATS, params.get('format')) ?? base.format,
    mode: known(MODES, params.get('mode')) ?? base.mode,
    scope: known(SCOPES, params.get('scope')) ?? base.scope,
    grant: known(GRANTS, params.get('grant')) ?? base.grant,
  };
}

export const hasSelectionQuery = (params: URLSearchParams): boolean =>
  ['issuer', 'wallet', 'verifier', 'format', 'grant', 'mode', 'scope'].some((k) => params.has(k));

export const STORAGE_KEY = 'pg.selection.v1';

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

export function store(s: Selection): void {
  try {
    const { issuer, wallet, verifier, format, mode, scope } = s;
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ issuer, wallet, verifier, format, mode, scope }),
    );
  } catch {
    // storage blocked: the defaults apply next time
  }
}

export function toRequest(s: Selection): CreateRunRequest {
  return {
    issuer: s.issuer,
    wallet: s.wallet,
    verifier: s.verifier,
    grant: grantOf(s),
    presentationMode: s.mode,
    format: s.format,
    scope: s.scope,
  };
}

/** the request for card `id` in column `role`, the other columns as selected (UI-05 step 2) */
export function cardRequest(s: Selection, role: Role, id: AdapterId): CreateRunRequest {
  const next = { ...s, [role]: id };
  if (role === 'issuer') next.grant = null;
  return toRequest(next);
}

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
export const selectionTunnel = (s: Selection): TunnelRule | null =>
  cardTunnel(s, 'wallet', s.wallet) ?? cardTunnel(s, 'verifier', s.verifier);
