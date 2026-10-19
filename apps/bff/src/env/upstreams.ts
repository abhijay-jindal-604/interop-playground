/**
 * Upstreams the environment manager probes (02 §1.1 C8, ADR-05: backend well-knowns, never UI
 * ports) and which adapter of 02 §5.3 depends on which upstream. Internal URLs are the
 * `scripts/up.sh` readiness table (playground_net names); Collab hosts are read-only (ADR-13).
 */
import type { AdapterId } from '@interop-playground/api';

/** compose profile of the service (`core` = no profile), or `collab` for the public hosts */
export type UpstreamProfile = 'core' | 'local' | 'mdoc-spec' | 'iae' | 'peers' | 'collab';

export interface UpstreamDef {
  name: string;
  url: string;
  profile: UpstreamProfile;
  /** accepted status: a number, a list, or 'any' (< 500: the server answers) */
  expect: number | readonly number[] | 'any';
  /** versions.lock image whose digest is the version fingerprint (local upstreams) */
  image?: string;
  /** fingerprint from the response: Collab endpoint shape (S-007, RISK-09) or `{version}` JSON */
  fingerprintFrom?: 'collab-shape' | 'json-version';
}

const CERTIFY_ALPHA1 = 'injistack/inji-certify-with-plugins:1.0.0-alpha.1';

export const UPSTREAMS: readonly UpstreamDef[] = [
  {
    name: 'certify-preauth',
    url: 'http://certify-preauth:8090/v1/certify/.well-known/openid-credential-issuer',
    profile: 'core',
    expect: 200,
    image: CERTIFY_ALPHA1,
  },
  {
    name: 'certify-preauth-nginx',
    url: 'http://certify-preauth-nginx:80/.well-known/openid-credential-issuer',
    profile: 'core',
    expect: 200,
    image: 'nginx:stable',
  },
  {
    name: 'sidecar',
    url: 'http://sidecar:7070/health',
    profile: 'core',
    expect: 200,
    fingerprintFrom: 'json-version',
  },
  {
    name: 'certify-authcode',
    url: 'http://certify-authcode:8090/v1/certify/.well-known/openid-credential-issuer',
    profile: 'local',
    expect: 200,
    image: CERTIFY_ALPHA1,
  },
  {
    name: 'esignet',
    url: 'http://esignet:8088/v1/esignet/oidc/.well-known/openid-configuration',
    profile: 'local',
    expect: 200,
    image: 'mosipid/esignet-with-plugins:1.8.0',
  },
  {
    name: 'mimoto',
    url: 'http://mimoto:8099/v1/mimoto/issuers',
    profile: 'local',
    expect: 200,
    image: 'injistack/mimoto:1.0.0-alpha.1',
  },
  {
    name: 'inji-web',
    url: 'http://inji-web:3004/v1/mimoto/issuers',
    profile: 'local',
    expect: 200,
    image: 'injistack/inji-web:1.0.0-alpha.1',
  },
  {
    name: 'verify-service',
    url: 'http://verify-service:8080/v1/verify/actuator/health',
    profile: 'local',
    expect: 200,
    image: 'injistack/inji-verify-service:1.0.0-alpha.1',
  },
  {
    name: 'oauth2-mock',
    url: 'http://oauth2-mock:8095/.well-known/openid-configuration',
    profile: 'local',
    expect: 200,
  },
  {
    name: 'datashare-service',
    url: 'http://datashare-service:8097/v1/datashare/get/static-policyid/static-subscriberid/readiness-probe.json',
    profile: 'local',
    expect: 404,
    image: 'nginx:stable',
  },
  {
    name: 'certify-mdoc',
    url: 'http://certify-mdoc:8090/v1/certify/.well-known/openid-credential-issuer',
    profile: 'mdoc-spec',
    expect: 200,
    image: 'injistackdev/inji-certify-with-plugins:develop',
  },
  {
    name: 'certify-iae',
    url: 'http://certify-iae:8090/v1/certify/.well-known/openid-credential-issuer',
    profile: 'iae',
    expect: 200,
    image: 'injistackdev/inji-certify-with-plugins:develop#iae',
  },
  {
    name: 'waltid-issuer-api2',
    url: 'http://waltid-issuer-api2:8080/.well-known/openid-credential-issuer/openid4vci',
    profile: 'peers',
    expect: 200,
    image: 'waltid/issuer-api2:1.1.0',
  },
  {
    name: 'waltid-verifier-api2',
    url: 'http://waltid-verifier-api2:8080/',
    profile: 'peers',
    expect: 'any',
    image: 'waltid/verifier-api2:1.1.0',
  },
  {
    name: 'eudi-verifier',
    url: 'http://eudi-verifier:8080/wallet/public-keys.json',
    profile: 'peers',
    expect: 200,
    image: 'ghcr.io/eu-digital-identity-wallet/eudi-srv-verifier-endpoint:v0.11.0',
  },
  {
    name: 'collab-certify',
    url: 'https://injicertify-farmer.collab.mosip.net/v1/certify/.well-known/openid-credential-issuer',
    profile: 'collab',
    expect: 200,
    fingerprintFrom: 'collab-shape',
  },
  {
    name: 'collab-mimoto',
    url: 'https://api.collab.mosip.net/v1/mimoto/issuers',
    profile: 'collab',
    expect: 200,
    fingerprintFrom: 'collab-shape',
  },
  {
    name: 'collab-verify',
    url: 'https://injiverify.collab.mosip.net/v1/verify/v2/vp-request',
    profile: 'collab',
    expect: 'any',
    fingerprintFrom: 'collab-shape',
  },
];

/** upstreams each adapter needs (02 §5.3); [] = in-process, nothing to probe */
export const ADAPTER_UPSTREAMS: Readonly<Record<AdapterId, readonly string[]>> = {
  'issuer.certify-preauth': ['certify-preauth', 'certify-preauth-nginx'],
  'issuer.certify-authcode': ['certify-authcode', 'esignet'],
  'issuer.certify-mdoc': ['certify-mdoc'],
  'issuer.certify-collab': ['collab-certify', 'collab-mimoto'],
  'issuer.waltid': ['waltid-issuer-api2'],
  'issuer.fixture': [],
  'wallet.playground-ts': [],
  'wallet.inji-jvm': ['sidecar'],
  'wallet.inji-web': ['mimoto', 'inji-web', 'datashare-service', 'oauth2-mock'],
  'wallet.inji-mobile': [],
  'wallet.credo': [],
  'verifier.inji-verify-local': ['verify-service'],
  'verifier.inji-verify-collab': ['collab-verify'],
  'verifier.inji-verify-sdk': ['verify-service'],
  'verifier.vcverifier-offline': ['sidecar'],
  'verifier.waltid': ['waltid-verifier-api2'],
  'verifier.eudi': ['eudi-verifier'],
  'verifier.credo': [],
};

/** version labels of the in-process adapters (no upstream to fingerprint) */
export function inProcessFingerprint(id: AdapterId, bffVersion: string): string {
  switch (id) {
    case 'wallet.credo':
    case 'verifier.credo':
      return 'credo@0.7.1';
    case 'issuer.fixture':
      return 'fixture@r3d2';
    case 'wallet.inji-mobile':
      return 'inji-wallet@v30';
    default:
      return `playground-ts@${bffVersion}`;
  }
}
