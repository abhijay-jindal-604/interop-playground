/**
 * One-shot bring-up commands of plan/10 §8.2 that `scripts/up.sh` runs inside a throw-away bff
 * container on `playground_net` (ADR-14 chain, ADR-05 readiness):
 *   esignet-onboard  create-or-update the Mimoto OIDC client and the two test personas (S-023)
 *   certify-didurl   re-assert the per-config didUrl of FarmerCredential on both Certify (G-20)
 *   guest-smoke      Mimoto guest download through the eSignet auth-code leg (S-025)
 *   wait-ready       backend well-known probes through the internal names (ADR-05)
 * All HTTP goes through the injected `Http` (a fetch-shaped function); the CLI passes global
 * fetch until `CapturingHttp` (T-09) offers a capture-less mode for one-shot commands.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type Http = (url: string, init?: RequestInit) => Promise<Response>;
export type Log = (line: string) => void;

export interface BringupEnv {
  publicHost: string;
  esignetUrl: string;
  mockIdentityUrl: string;
  mimotoUrl: string;
  certifyUrls: Record<string, string>;
  clientId: string;
  clientKeyPath: string;
}

/** Internal service URLs on playground_net (compose service names, never published). */
export function bringupEnv(env: NodeJS.ProcessEnv): BringupEnv {
  const v = (k: string, d: string): string => (env[k] !== undefined && env[k] !== '' ? env[k] : d);
  return {
    publicHost: v('PUBLIC_HOST', ''),
    esignetUrl: v('ESIGNET_URL', 'http://esignet:8088'),
    mockIdentityUrl: v('MOCK_IDENTITY_URL', 'http://mock-identity-system:8082'),
    mimotoUrl: v('MIMOTO_URL', 'http://mimoto:8099'),
    certifyUrls: {
      'certify-preauth': v('CERTIFY_PREAUTH_URL', 'http://certify-preauth:8090'),
      'certify-authcode': v('CERTIFY_AUTHCODE_URL', 'http://certify-authcode:8090'),
    },
    clientId: v('ESIGNET_CLIENT_ID', 'playground-mimoto'),
    clientKeyPath: v('ESIGNET_CLIENT_KEY', '/certs/esignet/playground-mimoto.key.pem'),
  };
}

const now = (): string => new Date().toISOString();
const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

async function json(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text.slice(0, 300) };
  }
}
const errorsOf = (body: Record<string, unknown>): { errorCode?: string; message?: string }[] =>
  Array.isArray(body.errors) ? (body.errors as { errorCode?: string; message?: string }[]) : [];

export class BringupError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'BringupError';
    this.exitCode = exitCode;
  }
}

// ------------------------------------------------------------------ esignet-onboard (S-023) --
/** The farmer CSV ids, so Certify's MockCSVDataProviderPlugin finds them via `sub` (S-023). */
export const PERSONAS: readonly [string, string][] = [
  ['2154189532', 'Gorge Cooper'],
  ['8267411578', 'James Rodrigious'],
];
/** 1x1 JPEG; the mock identity system stores but never checks the photo. */
const TINY_JPEG =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP////////////////////////////////////////////////////////////////////////////////////8AAAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

export function personaRequest(individualId: string, name: string): Record<string, unknown> {
  const ml = (value: string): { language: string; value: string }[] => [{ language: 'eng', value }];
  return {
    requestTime: now(),
    request: {
      individualId,
      pin: '545411',
      email: `${individualId}@example.org`,
      phone: '+919427357934',
      fullName: ml(name),
      nickName: ml(name),
      preferredUsername: ml(name),
      givenName: ml(name),
      middleName: ml(name),
      familyName: ml(name.split(' ').slice(-1)[0] ?? name),
      gender: ml('Male'),
      dateOfBirth: '1987/11/25',
      streetAddress: ml('Slung'),
      locality: ml('yuanwee'),
      password: 'Mosip@123',
      preferredLang: 'eng',
      locale: 'en',
      region: ml('yuanwee'),
      zoneInfo: 'test zone',
      postalCode: '45009',
      country: ml('Cmattey'),
      encodedPhoto: TINY_JPEG,
    },
  };
}

/** The client key: reuse the existing one (S-105, S-150: never a new key under an old p12). */
export function ensureClientKey(keyPath: string, log: Log): ReturnType<typeof createPrivateKey> {
  if (!existsSync(keyPath)) {
    mkdirSync(path.dirname(keyPath), { recursive: true });
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    log(`esignet-onboard: new client key ${keyPath}`);
  }
  return createPrivateKey(readFileSync(keyPath));
}

export function clientRequest(
  e: BringupEnv,
  jwk: Record<string, unknown>,
): Record<string, unknown> {
  return {
    requestTime: now(),
    request: {
      clientId: e.clientId,
      clientName: 'Interop Playground (Mimoto)',
      publicKey: jwk,
      relyingPartyId: 'playground-rp',
      userClaims: [
        'name',
        'email',
        'gender',
        'phone_number',
        'picture',
        'birthdate',
        'individual_id',
      ],
      authContextRefs: [
        'mosip:idp:acr:generated-code',
        'mosip:idp:acr:password',
        'mosip:idp:acr:linked-wallet',
      ],
      logoUri: 'https://mosip.github.io/inji-config/logos/agro-vertias-logo.png',
      // Inji Web's baked origin is localhost:3004 (S-105); the LAN form for phones (ADR-06)
      redirectUris: [
        'http://localhost:3004/redirect',
        `http://${e.publicHost}:3004/redirect`,
        'io.mosip.residentapp.inji://oauthredirect',
      ],
      grantTypes: ['authorization_code'],
      clientAuthMethods: ['private_key_jwt'],
      additionalConfig: {
        userinfo_response_type: 'JWS',
        purpose: { type: 'verify' },
        signup_banner_required: false,
        forgot_pwd_link_required: false,
        consent_expire_in_mins: 20,
      },
    },
  };
}

async function csrf(http: Http, base: string): Promise<{ token: string; cookie: string }> {
  const res = await http(`${base}/v1/esignet/csrf/token`);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const token = (await json(res)).token;
  if (res.status !== 200 || typeof token !== 'string')
    throw new BringupError(`eSignet csrf token: HTTP ${res.status}`);
  return { token, cookie };
}

export async function esignetOnboard(http: Http, e: BringupEnv, log: Log): Promise<void> {
  if (e.publicHost === '') throw new BringupError('PUBLIC_HOST must be set');
  const key = ensureClientKey(e.clientKeyPath, log);
  const jwk = { ...createPublicKey(key).export({ format: 'jwk' }), alg: 'RS256', use: 'sig' };
  const x = await csrf(http, e.esignetUrl);
  const headers = { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': x.token, Cookie: x.cookie };
  const body = clientRequest(e, jwk);
  const res = await http(`${e.esignetUrl}/v1/esignet/client-mgmt/client`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const out = await json(res);
  const errs = errorsOf(out);
  if (res.status === 200 && errs.length === 0) log(`esignet-onboard: client ${e.clientId} created`);
  else if (errs.some((er) => /duplicate|exists/i.test(`${er.errorCode} ${er.message}`))) {
    // create-or-update (10 §8.1): eSignet cannot change a client's public key; the ADR-14 chain
    // runs only on empty volumes, so a duplicate here means the same key was registered before.
    const req = body.request as Record<string, unknown>;
    const upd = {
      requestTime: now(),
      request: {
        clientName: req.clientName,
        status: 'ACTIVE',
        logoUri: req.logoUri,
        redirectUris: req.redirectUris,
        userClaims: req.userClaims,
        authContextRefs: req.authContextRefs,
        grantTypes: req.grantTypes,
        clientAuthMethods: req.clientAuthMethods,
        additionalConfig: req.additionalConfig,
      },
    };
    const x2 = await csrf(http, e.esignetUrl);
    const u = await http(`${e.esignetUrl}/v1/esignet/client-mgmt/client/${e.clientId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': x2.token, Cookie: x2.cookie },
      body: JSON.stringify(upd),
    });
    const ub = await json(u);
    if (u.status !== 200 || errorsOf(ub).length > 0)
      throw new BringupError(
        `eSignet client update: HTTP ${u.status} ${JSON.stringify(ub).slice(0, 300)}`,
      );
    log(`esignet-onboard: client ${e.clientId} existed, updated (public key unchanged)`);
  } else {
    throw new BringupError(
      `eSignet client create: HTTP ${res.status} ${JSON.stringify(out).slice(0, 300)}`,
    );
  }
  for (const [id, name] of PERSONAS) {
    const r = await http(`${e.mockIdentityUrl}/v1/mock-identity-system/identity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(personaRequest(id, name)),
    });
    const rb = await json(r);
    const re = errorsOf(rb);
    if (r.status === 200 && re.length === 0) log(`esignet-onboard: persona ${id} created`);
    else if (re.some((er) => /duplicate|exists/i.test(`${er.errorCode} ${er.message}`)))
      log(`esignet-onboard: persona ${id} already present`);
    else
      throw new BringupError(`persona ${id}: HTTP ${r.status} ${JSON.stringify(rb).slice(0, 300)}`);
  }
}

// ------------------------------------------------------------------- certify-didurl (G-20) --
export const DIDURL_CONFIG = 'FarmerCredential';
export function expectedDidUrl(service: string, publicHost: string): string {
  return service === 'certify-authcode'
    ? `did:web:${publicHost}:authcode`
    : `did:web:${publicHost}`;
}

export async function certifyDidurl(http: Http, e: BringupEnv, log: Log): Promise<void> {
  if (e.publicHost === '') throw new BringupError('PUBLIC_HOST must be set');
  for (const [svc, base] of Object.entries(e.certifyUrls)) {
    const url = `${base}/v1/certify/credential-configurations/${DIDURL_CONFIG}`;
    const res = await http(url);
    if (res.status === 404) {
      log(`certify-didurl: ${svc} has no ${DIDURL_CONFIG}, skipped`);
      continue;
    }
    if (res.status !== 200) throw new BringupError(`certify-didurl: GET ${svc} HTTP ${res.status}`);
    const cfg = await json(res);
    const want = expectedDidUrl(svc, e.publicHost);
    if (cfg.didUrl === want) {
      log(`certify-didurl: ${svc} ${DIDURL_CONFIG} didUrl = ${want}`);
      continue;
    }
    const put = await http(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...cfg, didUrl: want }),
    });
    if (put.status !== 200) throw new BringupError(`certify-didurl: PUT ${svc} HTTP ${put.status}`);
    log(`certify-didurl: ${svc} ${DIDURL_CONFIG} didUrl ${String(cfg.didUrl)} -> ${want}`);
  }
}

// --------------------------------------------------------------------- guest-smoke (S-025) --
/** Exit code when the gateway URLs Mimoto needs are missing (8093 issuer, 443 did:web; T-11, G-131). */
export const GUEST_SMOKE_GATEWAY_MISSING = 3;
const GUEST_ISSUER = 'PlaygroundFarmer';
const GUEST_CONFIG = 'FarmerCredential';
const GUEST_SCOPE = 'mock_identity_vc_ldp';
const GUEST_REDIRECT = 'http://localhost:3004/redirect';

export async function guestSmoke(http: Http, e: BringupEnv, log: Log): Promise<void> {
  const t0 = Date.now();
  // Mimoto reaches the issuer through the advertised gateway URL (http://PUBLIC_HOST:8093, S-025);
  // without a gateway listener there (T-11) nothing below can pass (G-131)
  const viaGateway = `http://${e.publicHost}:8093/.well-known/openid-credential-issuer`;
  const gw = await http(viaGateway, { signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (gw === null || gw.status !== 200)
    throw new BringupError(
      `guest-smoke: ${viaGateway} answered ${gw === null ? 'nothing' : `HTTP ${gw.status}`}; ` +
        'Mimoto reaches Certify only through the gateway (T-11)',
      GUEST_SMOKE_GATEWAY_MISSING,
    );
  const cfgRes = await http(`${e.mimotoUrl}/v1/mimoto/issuers/${GUEST_ISSUER}/configuration`);
  if (cfgRes.status !== 200)
    throw new BringupError(`guest-smoke: Mimoto issuer configuration HTTP ${cfgRes.status}`);
  // eSignet auth-code leg, the JSON calls oidc-ui makes (S-024): OTP 111111 of the mock plugin
  const x = await csrf(http, e.esignetUrl);
  const J = { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': x.token, Cookie: x.cookie };
  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash('sha256').update(verifier).digest());
  const od = await http(`${e.esignetUrl}/v1/esignet/authorization/v3/oauth-details`, {
    method: 'POST',
    headers: J,
    body: JSON.stringify({
      requestTime: now(),
      request: {
        clientId: e.clientId,
        scope: GUEST_SCOPE,
        responseType: 'code',
        redirectUri: GUEST_REDIRECT,
        display: 'popup',
        prompt: 'login',
        acrValues: 'mosip:idp:acr:generated-code',
        nonce: b64u(randomBytes(12)),
        state: `smoke${Date.now()}`,
        claimsLocales: 'en',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
      },
    }),
  });
  const odb = await json(od);
  const odr = odb.response as Record<string, unknown> | null | undefined;
  if (
    od.status !== 200 ||
    odr === null ||
    odr === undefined ||
    typeof odr.transactionId !== 'string'
  )
    throw new BringupError(
      `guest-smoke: oauth-details HTTP ${od.status} ${JSON.stringify(odb).slice(0, 300)}`,
    );
  const txn = odr.transactionId;
  const H = {
    ...J,
    'oauth-details-key': txn,
    'oauth-details-hash': b64u(createHash('sha256').update(JSON.stringify(odr)).digest()),
  };
  const individualId = PERSONAS[0]?.[0] ?? '';
  const steps: [string, Record<string, unknown>][] = [
    [
      'send-otp',
      { transactionId: txn, individualId, otpChannels: ['email'], captchaToken: 'dummy' },
    ],
    [
      'v3/authenticate',
      {
        transactionId: txn,
        individualId,
        challengeList: [{ authFactorType: 'OTP', challenge: '111111', format: 'alpha-numeric' }],
      },
    ],
    ['auth-code', { transactionId: txn, acceptedClaims: [], permittedAuthorizeScopes: [] }],
  ];
  let code = '';
  for (const [p, request] of steps) {
    const r = await http(`${e.esignetUrl}/v1/esignet/authorization/${p}`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ requestTime: now(), request }),
    });
    const rb = await json(r);
    if (r.status !== 200 || errorsOf(rb).length > 0)
      throw new BringupError(
        `guest-smoke: ${p} HTTP ${r.status} ${JSON.stringify(rb).slice(0, 300)}`,
      );
    const resp = rb.response as Record<string, unknown> | undefined;
    if (p === 'auth-code' && typeof resp?.code === 'string') code = resp.code;
  }
  if (code === '') throw new BringupError('guest-smoke: eSignet returned no code');
  // guest download, as Inji Web posts it (form body, Accept: application/pdf, S-025 HAR)
  const dl = await http(`${e.mimotoUrl}/v1/mimoto/credentials/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/pdf' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: GUEST_REDIRECT,
      code_verifier: verifier,
      issuer: GUEST_ISSUER,
      credential: GUEST_CONFIG,
      vcStorageExpiryLimitInTimes: '-1',
      locale: 'en',
    }).toString(),
  });
  const buf = Buffer.from(await dl.arrayBuffer());
  if (dl.status === 200 && buf.subarray(0, 5).toString('latin1') === '%PDF-') {
    log(
      `guest-smoke: ${GUEST_ISSUER} guest download 200, PDF ${buf.length} bytes, ${Date.now() - t0} ms`,
    );
    return;
  }
  const text = buf.toString('utf8').slice(0, 400);
  if (
    /signature_verification_failed|did\.json|did:web|PublicKeyResolution|LOADING_REMOTE_CONTEXT/i.test(
      text,
    )
  )
    throw new BringupError(
      `guest-smoke: download HTTP ${dl.status}: Mimoto could not resolve the issuer did:web ` +
        `(needs the gateway's did:web host on ${e.publicHost}:443, T-11): ${text}`,
      GUEST_SMOKE_GATEWAY_MISSING,
    );
  throw new BringupError(`guest-smoke: download HTTP ${dl.status}: ${text}`);
}

// ---------------------------------------------------------------- wait-ready (ADR-05) --
/** Backend well-knowns through the internal names; expected status (`any` = server answers). */
export const READY_PROBES: Record<string, { url: string; expect: number | 'any' }> = {
  'certify-preauth': {
    url: 'http://certify-preauth:8090/v1/certify/.well-known/openid-credential-issuer',
    expect: 200,
  },
  'certify-preauth-nginx': {
    url: 'http://certify-preauth-nginx:80/.well-known/openid-credential-issuer',
    expect: 200,
  },
  'certify-authcode': {
    url: 'http://certify-authcode:8090/v1/certify/.well-known/openid-credential-issuer',
    expect: 200,
  },
  'certify-authcode-nginx': {
    url: 'http://certify-authcode-nginx:80/.well-known/openid-credential-issuer',
    expect: 200,
  },
  mimoto: { url: 'http://mimoto:8099/v1/mimoto/issuers', expect: 200 },
  'inji-web': { url: 'http://inji-web:3004/v1/mimoto/issuers', expect: 200 },
  'verify-service': { url: 'http://verify-service:8080/v1/verify/actuator/health', expect: 200 },
  esignet: {
    url: 'http://esignet:8088/v1/esignet/oidc/.well-known/openid-configuration',
    expect: 200,
  },
  'esignet-ui': { url: 'http://esignet-ui:3000/.well-known/openid-configuration', expect: 200 },
  'mock-identity-system': {
    url: 'http://mock-identity-system:8082/v1/mock-identity-system/actuator/health',
    expect: 200,
  },
  'oauth2-mock': { url: 'http://oauth2-mock:8095/.well-known/openid-configuration', expect: 200 },
  'datashare-service': {
    url: 'http://datashare-service:8097/v1/datashare/get/static-policyid/static-subscriberid/readiness-probe.json',
    expect: 404,
  },
  'certify-mdoc': {
    url: 'http://certify-mdoc:8090/v1/certify/.well-known/openid-credential-issuer',
    expect: 200,
  },
  'certify-mdoc-nginx': {
    url: 'http://certify-mdoc-nginx:80/.well-known/openid-credential-issuer',
    expect: 200,
  },
  'certify-iae': {
    url: 'http://certify-iae:8090/v1/certify/.well-known/openid-credential-issuer',
    expect: 200,
  },
  'certify-iae-mint': {
    url: 'http://certify-iae-mint:8090/v1/certify/.well-known/openid-credential-issuer',
    expect: 200,
  },
  'certify-iae-nginx': {
    url: 'http://certify-iae-nginx:82/vp_request_config-dcql-ldp.json',
    expect: 200,
  },
  'waltid-issuer-api2': {
    url: 'http://waltid-issuer-api2:8080/.well-known/openid-credential-issuer/openid4vci',
    expect: 200,
  },
  'waltid-verifier-api2': { url: 'http://waltid-verifier-api2:8080/', expect: 'any' },
  'waltid-verifier-api2-signed': { url: 'http://waltid-verifier-api2-signed:8080/', expect: 'any' },
  'eudi-verifier': { url: 'http://eudi-verifier:8080/wallet/public-keys.json', expect: 200 },
  sidecar: { url: 'http://sidecar:7070/health', expect: 200 },
};

export interface WaitReadyOptions {
  services: string[];
  timeoutMs: number;
  intervalMs: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function waitReady(http: Http, opts: WaitReadyOptions, log: Log): Promise<number> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let failed = 0;
  for (const svc of opts.services) {
    const probe = READY_PROBES[svc];
    if (probe === undefined) continue;
    const deadline = Date.now() + opts.timeoutMs;
    let last: string;
    for (;;) {
      try {
        const res = await http(probe.url, {
          signal: AbortSignal.timeout(5000),
          redirect: 'manual',
        });
        await res.arrayBuffer().catch(() => undefined);
        last = String(res.status);
        if (probe.expect === 'any' || res.status === probe.expect) {
          log(`wait-ready: ${svc.padEnd(28)} ${res.status}  ${probe.url}`);
          break;
        }
      } catch (err) {
        last = (err as Error).name;
      }
      if (Date.now() >= deadline) {
        log(`wait-ready: ${svc.padEnd(28)} FAIL (${last})  ${probe.url}`);
        failed++;
        break;
      }
      await sleep(opts.intervalMs);
    }
  }
  log('wait-ready: gateway-URL probes SKIPPED (the gateway listeners arrive with T-11)');
  return failed;
}
