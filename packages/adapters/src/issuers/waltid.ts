/**
 * `issuer.waltid` (plan/12 T-43; 03 FLOW-08, 02 §5.4, 09 A4 KNOB-01): walt.id issuer-api2 1.1.0,
 * pre-authorized code, offer **by value**, `dc+sd-jwt` (profile `identityCredentialSdJwt`).
 *
 * `vci.offer.mint` is the only BFF-internal hop: `POST /issuer2/credential-offers` on the service
 * name (the gateway hard-denies `/issuer2/*` on 18103, 02 §5.4). The minted offer names
 * `http://<PUBLIC_HOST>:18103/openid4vci`, so every wallet hop (metadata, token, nonce,
 * credential) goes through the gateway's 18103 listener; the route table registered here
 * attributes those hops to the run.
 *
 * KNOB-01 (`waltid.sdjwt.x5c`, peer-runtime-option, 02 §5.7): `absent` (default, walt.id's shipped
 * behaviour: bare `did:jwk` issuer key, no `x5c`) sends no `runtimeOverrides`; `present` sends
 * `runtimeOverrides: {issuerKey: {type:"jwk", jwk:<private JWK>}, x5Chain:[<PEM>]}` with the
 * bundle's peer key and self-signed certificate (`certs/peers/waltid-issuer.{key,pem}`, S-120).
 * The knob is read from the run spec's `KnobValues` (`ctx.knobs`), nothing else.
 *
 * `metadata()` makes no call: FLOW-08 has no `vci.setup.config-read` (the wallet reads the
 * metadata itself at `vci.metadata.issuer`), and `resolveVariant` is never called for a
 * peer-runtime-option knob (the orchestrator calls it for `issuer-variant-config` knobs only).
 */
import { createPrivateKey } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { descriptorOf } from '../catalog.js';
import type {
  AdapterContext,
  AdapterDescriptor,
  Availability,
  CredentialOffer,
  GatewayCorrelation,
  IssuerAdapter,
} from '../contracts.js';
import { inStep, isRecord, jsonBody, str, trimSlash } from '../support.js';
import { preAuthorizedCodeOf } from './certify-preauth.js';

export const WALTID_ISSUER_VERSION = 'waltid/issuer-api2:1.1.0';
/** the issuer path walt.id advertises under its base URL (`credential_issuer`) */
export const WALTID_ISSUER_PATH = '/openid4vci';

/** 03 FLOW-08: the profiles offered per run configuration (catalog `configurationId`) */
export const WALTID_PROFILES: Readonly<Record<string, string>> = {
  identityCredentialSdJwt: 'identityCredentialSdJwt',
};

/** inbound wallet hops on the 18103 listener → FLOW-08 stepKeys (gateway route table) */
export const WALTID_ROUTES = [
  {
    method: 'GET',
    pattern: /\/\.well-known\/openid-credential-issuer(\/openid4vci)?$/,
    stepKey: 'vci.metadata.issuer',
  },
  {
    method: 'GET',
    pattern: /\/\.well-known\/oauth-authorization-server(\/openid4vci)?$/,
    stepKey: 'vci.metadata.as',
  },
  { method: 'POST', pattern: /\/openid4vci\/token$/, stepKey: 'vci.token' },
  { method: 'POST', pattern: /\/openid4vci\/nonce$/, stepKey: 'vci.nonce' },
  { method: 'POST', pattern: /\/openid4vci\/credential$/, stepKey: 'vci.credential' },
] as const;

/** the material KNOB-01 `present` sends (S-120 shape) */
export interface WaltidX5cMaterial {
  /** private EC P-256 JWK (`d` included) of the leaf certificate's key */
  issuerJwk: JsonWebKey;
  /** PEM strings, leaf first (`OpenId4VciProtocolService.kt:1087`@7ac0710e) */
  x5Chain: string[];
}

export interface WaltidIssuerOptions {
  /** `http://waltid-issuer-api2:8080` (service name; BFF-internal) */
  internalBase: string;
  /** `http://<PUBLIC_HOST>:18103` (gateway 18103, 02 §5.4) */
  publicBase: string;
  /** KNOB-01 `present` material; loaded lazily (a run with `absent` never needs it) */
  x5c?: () => WaltidX5cMaterial;
  gateway?: GatewayCorrelation;
}

/** KNOB-01 material from the bundle's peer key + certificate files (PEM) */
export function x5cMaterialFromFiles(keyFile: string, certFile: string): () => WaltidX5cMaterial {
  return () => {
    if (!existsSync(keyFile) || !existsSync(certFile))
      throw new Error(`KNOB-01 present needs ${keyFile} and ${certFile}`);
    const issuerJwk = createPrivateKey(readFileSync(keyFile)).export({ format: 'jwk' });
    const pem = readFileSync(certFile, 'utf8');
    const x5Chain = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
    if (!x5Chain || x5Chain.length === 0) throw new Error(`${certFile} holds no certificate`);
    return { issuerJwk, x5Chain };
  };
}

/** the `POST /issuer2/credential-offers` body for a run (03 FLOW-08 trimmed HTTP) */
export function waltidOfferBody(
  profileId: string,
  x5c: 'absent' | 'present',
  material: (() => WaltidX5cMaterial) | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    profileId,
    authMethod: 'PRE_AUTHORIZED',
    valueMode: 'BY_VALUE',
  };
  if (x5c === 'present') {
    if (!material) throw new Error('KNOB-01 present: no x5c material configured');
    const m = material();
    body.runtimeOverrides = {
      issuerKey: { type: 'jwk', jwk: m.issuerJwk },
      x5Chain: m.x5Chain,
    };
  }
  return body;
}

/** the offer JSON inside `openid-credential-offer://?credential_offer=…` (by value) */
export function offerByValue(uri: string): unknown {
  try {
    const v = new URL(uri).searchParams.get('credential_offer');
    return v ? (JSON.parse(v) as unknown) : null;
  } catch {
    return null;
  }
}

export class WaltidIssuer implements IssuerAdapter {
  readonly descriptor: AdapterDescriptor;
  private readonly internal: string;
  private readonly publicBase: string;

  constructor(private readonly opts: WaltidIssuerOptions) {
    this.descriptor = descriptorOf('issuer.waltid');
    this.internal = trimSlash(opts.internalBase);
    this.publicBase = trimSlash(opts.publicBase);
  }

  private cap(ctx: { runId: string }, stepKey: string) {
    return {
      runId: ctx.runId,
      stepKey,
      actor: 'playground(issuer-ui)',
      counterpart: 'issuer.waltid',
    };
  }

  async probe(
    ctx: Omit<AdapterContext, 'spec' | 'knobs' | 'holderKey' | 'sign'>,
  ): Promise<Availability> {
    const res = await ctx.http.fetch(
      {
        runId: ctx.runId,
        stepKey: 'env.probe',
        actor: 'playground(env)',
        counterpart: this.descriptor.id,
      },
      `${this.internal}/.well-known/openid-credential-issuer${WALTID_ISSUER_PATH}`,
      { signal: ctx.signal },
    );
    const body = await jsonBody(res);
    const ok = res.status === 200 && isRecord(body) && typeof body.credential_issuer === 'string';
    return ok
      ? { available: true, versionFingerprint: WALTID_ISSUER_VERSION }
      : {
          available: false,
          reason: `well-known answered ${res.status}`,
          versionFingerprint: WALTID_ISSUER_VERSION,
        };
  }

  /** never called for KNOB-01 (peer-runtime-option); answers the baseline unchanged */
  resolveVariant(_ctx: AdapterContext, baselineConfigurationId: string): Promise<string> {
    return Promise.resolve(baselineConfigurationId);
  }

  metadata(): Promise<{ issuer: unknown; authorizationServer: unknown; exchangeIds: string[] }> {
    return Promise.resolve({
      issuer: `${this.publicBase}${WALTID_ISSUER_PATH}`,
      authorizationServer: `${this.publicBase}${WALTID_ISSUER_PATH}`,
      exchangeIds: [],
    });
  }

  async createOffer(
    ctx: AdapterContext,
    req: { configurationId: string; claims: Record<string, unknown>; withTxCode: boolean },
  ): Promise<CredentialOffer> {
    const profileId = WALTID_PROFILES[req.configurationId] ?? req.configurationId;
    const x5c = ctx.knobs['KNOB-01'] === 'present' ? 'present' : 'absent';
    return inStep(ctx, 'vci.offer.mint', async () => {
      const offer: CredentialOffer = {
        uri: '',
        credentialIssuer: `${this.publicBase}${WALTID_ISSUER_PATH}`,
        configurationId: req.configurationId,
        grant: 'pre-authorized_code',
      };
      const res = await ctx.http.fetch(
        this.cap(ctx, 'vci.offer.mint'),
        `${this.internal}/issuer2/credential-offers`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(waltidOfferBody(profileId, x5c, this.opts.x5c)),
          signal: ctx.signal,
        },
      );
      const body = await jsonBody(res);
      const uri = isRecord(body) ? str(body.credentialOffer) : null;
      const offerJson = uri ? offerByValue(uri) : null;
      const ok =
        (res.status === 200 || res.status === 201) &&
        uri !== null &&
        preAuthorizedCodeOf(offerJson) !== null;
      if (!ok) return { outcome: 'fail', value: offer };
      const configs =
        isRecord(offerJson) && Array.isArray(offerJson.credential_configuration_ids)
          ? offerJson.credential_configuration_ids
          : [];
      const iss = isRecord(offerJson) ? str(offerJson.credential_issuer) : null;
      this.opts.gateway?.addRoutes?.(ctx.runId, WALTID_ROUTES);
      return {
        outcome: 'pass',
        value: {
          ...offer,
          uri,
          credentialIssuer: iss ?? offer.credentialIssuer,
          configurationId: str(configs[0]) ?? req.configurationId,
        },
      };
    });
  }
}
