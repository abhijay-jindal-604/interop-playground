/**
 * Gateway listener table (02 §2.3, §2.4, §5.4, §6.3; ADR-22, ADR-24, ADR-48, ADR-50, ADR-66).
 * One listener per port, mapped 1:1 to one upstream on `playground_net`, except the two exact
 * path routes on 443 (`GET /authcode/did.json`, `GET /iae/did.json`). Paths are never rewritten.
 */

/** 04 §8.5 / S-202: Verify holds a long poll for up to 55 s; the gateway waits at least 60 s. */
export const PROXY_UPSTREAM_TIMEOUT_MS = 65000;

export type Profile = 'core' | 'local' | 'mdoc-spec' | 'iae' | 'peers';
/** allowlist family of 02 §2.3 (M1..M4) or the per-upstream rule of the local UI services */
export type AllowKind = 'M1' | 'M2' | 'M3' | 'M4' | 'mimoto' | 'inji-web' | 'open';

export interface StaticRule {
  /** upper-case methods, or `*` for any */
  methods: readonly string[] | '*';
  /** matched against the normalised (decoded, slash-collapsed) path without query */
  pattern: RegExp;
}

export interface PathRoute {
  method: string;
  path: string;
  upstream: string;
  counterpart: string;
  profile: Profile;
}

export interface ListenerSpec {
  port: number;
  scheme: 'http' | 'https';
  profile: Profile;
  /** `http://<service>:<port>` on playground_net */
  upstream: string;
  /** the upstream as named in exchange records (`counterpart`, 04 §8.1) */
  counterpart: string;
  allow: AllowKind;
  /** M1: well-known documents whose advertised endpoints become the allowlist */
  metadata?: readonly string[];
  /** fixed allow rules (M2..M4, and the M1 additions of ADR-66) */
  rules?: readonly StaticRule[];
  /** upstream-specific hard-deny prefixes of 02 §6.3 / §5.4 (`*` = any suffix) */
  hardDeny?: readonly string[];
  /** exact-path routes to another upstream (443 only) */
  routes?: readonly PathRoute[];
  /** BFF-served relay path (API-53/54, 8443 only) */
  relay?: RegExp;
}

/** 02 §6.3 "every upstream": matched as a path segment anywhere (Spring mounts actuator under its context path) */
export const GLOBAL_HARD_DENY: readonly { label: string; re: RegExp }[] = [
  { label: '/actuator/*', re: /(^|\/)actuator(\/|$)/i },
  { label: '/swagger*', re: /(^|\/)swagger/i },
  { label: '/v3/api-docs*', re: /(^|\/)v3\/api-docs/i },
  { label: '/api.json', re: /(^|\/)api\.json$/i },
];

const CERTIFY_DENY = [
  '/v1/certify/credential-configurations*',
  '/v1/certify/pre-authorized-data*',
  '/v1/certify/system-info/*',
];
const CERTIFY_WELL_KNOWNS = [
  '/.well-known/openid-credential-issuer',
  '/v1/certify/.well-known/openid-credential-issuer',
  '/.well-known/oauth-authorization-server',
  '/v1/certify/.well-known/oauth-authorization-server',
];
/** ADR-66: the offer document Certify mints is not advertised in metadata but is wallet-facing */
const CERTIFY_OFFER: StaticRule = {
  methods: ['GET'],
  pattern: /^\/v1\/certify\/credential-offer-data\/[A-Za-z0-9_-]+$/,
};
const WS_ID = '[A-Za-z0-9_-]+';
const WALTID_VERIFIER_RULES: readonly StaticRule[] = [
  { methods: ['GET', 'POST'], pattern: new RegExp(`^/verification-session/${WS_ID}/request$`) },
  { methods: ['POST'], pattern: new RegExp(`^/verification-session/${WS_ID}/response$`) },
];
const WALTID_VERIFIER_DENY = [
  '/verification-session/create',
  '/verification-session/*/info',
  '/verification-session/*/events',
  '/vical/*',
  '/transaction-data-profiles',
];

export const LISTENERS: readonly ListenerSpec[] = [
  {
    port: 443,
    scheme: 'https',
    profile: 'core',
    upstream: 'http://certify-preauth-nginx:80',
    counterpart: 'certify-preauth',
    allow: 'M1',
    metadata: CERTIFY_WELL_KNOWNS,
    rules: [CERTIFY_OFFER],
    hardDeny: CERTIFY_DENY,
    routes: [
      {
        method: 'GET',
        path: '/authcode/did.json',
        upstream: 'http://certify-authcode-nginx:80',
        counterpart: 'certify-authcode',
        profile: 'local',
      },
      {
        method: 'GET',
        path: '/iae/did.json',
        upstream: 'http://certify-iae-nginx:80',
        counterpart: 'certify-iae',
        profile: 'iae',
      },
    ],
  },
  {
    port: 8093,
    scheme: 'http',
    profile: 'local',
    upstream: 'http://certify-authcode-nginx:80',
    counterpart: 'certify-authcode',
    allow: 'M1',
    metadata: CERTIFY_WELL_KNOWNS,
    rules: [CERTIFY_OFFER],
    hardDeny: CERTIFY_DENY,
  },
  {
    port: 8096,
    scheme: 'http',
    profile: 'iae',
    upstream: 'http://certify-iae-nginx:81',
    counterpart: 'certify-iae-mint',
    allow: 'M1',
    metadata: CERTIFY_WELL_KNOWNS,
    rules: [CERTIFY_OFFER],
    hardDeny: CERTIFY_DENY,
  },
  {
    port: 8097,
    scheme: 'http',
    profile: 'mdoc-spec',
    upstream: 'http://certify-mdoc-nginx:80',
    counterpart: 'certify-mdoc',
    allow: 'M1',
    metadata: CERTIFY_WELL_KNOWNS,
    rules: [CERTIFY_OFFER],
    hardDeny: CERTIFY_DENY,
  },
  {
    port: 8098,
    scheme: 'http',
    profile: 'iae',
    upstream: 'http://certify-iae-nginx:80',
    counterpart: 'certify-iae',
    allow: 'M1',
    metadata: CERTIFY_WELL_KNOWNS,
    rules: [CERTIFY_OFFER],
    hardDeny: CERTIFY_DENY,
  },
  {
    port: 8099,
    scheme: 'http',
    profile: 'local',
    upstream: 'http://mimoto:8099',
    counterpart: 'mimoto',
    allow: 'mimoto',
    rules: [{ methods: '*', pattern: /^\/v1\/mimoto\/.+/ }],
  },
  {
    port: 3004,
    scheme: 'http',
    profile: 'local',
    upstream: 'http://inji-web:3004',
    counterpart: 'inji-web',
    allow: 'inji-web',
    // "all GET; browser only" (02 §2.3); OPTIONS answers the CORS preflight of its /v1/mimoto proxy
    rules: [{ methods: ['GET', 'HEAD', 'OPTIONS'], pattern: /^\// }],
  },
  {
    port: 3005,
    scheme: 'http',
    profile: 'local',
    upstream: 'http://esignet-ui:3000',
    counterpart: 'esignet',
    allow: 'M2',
    // ADR-66: the authorize UI (every non-API GET, well-knowns included) and the /v1/esignet/* APIs
    rules: [
      { methods: ['GET', 'HEAD'], pattern: /^\/(?!v1\/)/ },
      { methods: '*', pattern: /^\/v1\/esignet\/.+/ },
    ],
    hardDeny: ['/v1/esignet/client-mgmt/*', '/v1/esignet/system-info/*'],
  },
  {
    port: 8095,
    scheme: 'http',
    profile: 'local',
    upstream: 'http://oauth2-mock:8095',
    counterpart: 'oauth2-mock',
    allow: 'open',
    rules: [{ methods: '*', pattern: /^\// }],
  },
  {
    port: 8443,
    scheme: 'https',
    profile: 'local',
    upstream: 'http://verify-service:8080',
    counterpart: 'inji-verify',
    allow: 'M3',
    rules: [
      { methods: ['GET'], pattern: /^\/v1\/verify\/v2\/vp-request\/[A-Za-z0-9_-]+$/ },
      { methods: ['POST'], pattern: /^\/v1\/verify\/v2\/vp-submission\/direct-post$/ },
      { methods: ['POST'], pattern: /^\/v1\/verify\/vp-submission\/dc-api$/ },
      { methods: ['GET'], pattern: /^\/v1\/verify\/did\.json$/ },
    ],
    relay: /^\/tamper\/request\/([0-9A-HJKMNP-TV-Z]{26})$/,
  },
  {
    port: 18103,
    scheme: 'http',
    profile: 'peers',
    upstream: 'http://waltid-issuer-api2:8080',
    counterpart: 'waltid-issuer',
    allow: 'M1',
    metadata: [
      '/.well-known/openid-credential-issuer/openid4vci',
      '/openid4vci/.well-known/openid-credential-issuer',
      '/.well-known/oauth-authorization-server/openid4vci',
      '/openid4vci/.well-known/oauth-authorization-server',
    ],
    hardDeny: ['/issuer2/*'],
  },
  {
    port: 18443,
    scheme: 'https',
    profile: 'peers',
    upstream: 'http://waltid-verifier-api2:8080',
    counterpart: 'waltid-verifier',
    allow: 'M4',
    rules: WALTID_VERIFIER_RULES,
    hardDeny: WALTID_VERIFIER_DENY,
  },
  {
    port: 18444,
    scheme: 'https',
    profile: 'peers',
    upstream: 'http://eudi-verifier:8080',
    counterpart: 'eudi-verifier',
    allow: 'M4',
    rules: [
      { methods: ['GET', 'POST'], pattern: new RegExp(`^/wallet/request\\.jwt/${WS_ID}$`) },
      { methods: ['POST'], pattern: new RegExp(`^/wallet/direct_post/${WS_ID}$`) },
      { methods: ['GET'], pattern: /^\/wallet\/public-keys\.json$/ },
    ],
    hardDeny: ['/ui/*', '/utilities/*'],
  },
  {
    port: 18445,
    scheme: 'https',
    profile: 'peers',
    upstream: 'http://waltid-verifier-api2-signed:8080',
    counterpart: 'waltid-verifier-signed',
    allow: 'M4',
    rules: WALTID_VERIFIER_RULES,
    hardDeny: WALTID_VERIFIER_DENY,
  },
];

export function listenerFor(
  port: number,
  table: readonly ListenerSpec[] = LISTENERS,
): ListenerSpec {
  const l = table.find((x) => x.port === port);
  if (!l) throw new Error(`no gateway listener on port ${port}`);
  return l;
}
