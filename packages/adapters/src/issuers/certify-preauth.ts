/**
 * `issuer.certify-preauth` (plan/12 T-23; 02 §5.3, 03 FLOW-01/02/04): Inji Certify 1.0.0-alpha.1
 * with its internal AS and the pre-authorized-data plugin.
 *
 * BFF-internal admin calls go to the service name (`internalBase`, never through the gateway):
 * `vci.setup.variant`, `vci.setup.config-read`, `vci.offer.mint`. The minted offer names the
 * public base `https://<PUBLIC_HOST>` (ADR-24), so every wallet-side hop (offer fetch, metadata,
 * token, nonce, credential, did.json) reaches Certify through the gateway's 443 listener; the
 * correlation keys and the route table registered here attribute those inbound hops to the run.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { catalogEntry } from '../catalog.js';
import type {
  AdapterContext,
  AdapterDescriptor,
  Availability,
  CredentialOffer,
  GatewayCorrelation,
  IssuerAdapter,
  KnobId,
} from '../contracts.js';
import { correlate, inStep, isRecord, jsonBody, str, trimSlash } from '../support.js';

export const CERTIFY_PREAUTH_VERSION = 'inji-certify:1.0.0-alpha.1';

export interface CertifyPreauthOptions {
  /** `http://certify-preauth:8090` (service name; BFF-internal) */
  internalBase: string;
  /** `https://<PUBLIC_HOST>` (gateway 443, ADR-24) */
  publicBase: string;
  /** rendered `credential-configs/` directory (variant bodies `<id>.knobNN-<value>.json`) */
  configDir?: string;
  gateway?: GatewayCorrelation;
  /** pre-auth code lifetime (03 §1.0: 600 s for automated runs) */
  offerTtlSeconds?: number;
  /** six random digits per run (FLOW-02); injectable for tests */
  txCode?: () => string;
}

/** claims sent at `vci.offer.mint` when the request carries none (the golden traces' values) */
export const DEFAULT_CLAIMS: Readonly<Record<string, Record<string, unknown>>> = {
  PlaygroundSdJwt: {
    fullName: 'Asha Rao',
    dateOfBirth: '1994-03-12',
    gender: 'Female',
    email: 'asha@example.org',
  },
  FarmerCredential: {
    fullName: 'Playground Farmer',
    phone: '9999999999',
    dateOfBirth: '1990-01-01',
    gender: 'Female',
  },
  DrivingLicenseCredential: {
    family_name: 'Rao',
    given_name: 'Asha',
    birth_date: '1994-03-12',
    document_number: 'DL-2154189532',
  },
};

/** issuer-side knobs of this adapter (09 A4) with their defaults (ADR-21: working values) */
export const ISSUER_KNOB_DEFAULTS: Readonly<Record<string, string>> = {
  'KNOB-04': 'jsonpath',
  'KNOB-05': 'metadata-names',
  'KNOB-06': 'issuer-did',
};

const PRE_AUTH_GRANT = 'urn:ietf:params:oauth:grant-type:pre-authorized_code';

/** inbound wallet hops on the 443 listener → FLOW-01 stepKeys (gateway route table) */
export const PREAUTH_ROUTES = [
  { method: 'GET', pattern: /\/credential-offer-data\/[^/]+$/, stepKey: 'vci.offer.fetch' },
  {
    method: 'GET',
    pattern: /\/\.well-known\/openid-credential-issuer$/,
    stepKey: 'vci.metadata.issuer',
  },
  {
    method: 'GET',
    pattern: /\/\.well-known\/oauth-authorization-server$/,
    stepKey: 'vci.metadata.as',
  },
  { method: 'POST', pattern: /\/v1\/certify\/oauth\/token$/, stepKey: 'vci.token' },
  { method: 'POST', pattern: /\/v1\/certify\/nonce$/, stepKey: 'vci.nonce' },
  { method: 'POST', pattern: /\/v1\/certify\/issuance\/credential$/, stepKey: 'vci.credential' },
] as const;

/** Short stable name for a knob setting, used in variant configuration ids. */
function knobSlug(knobId: string, value: string): string {
  return `${knobId.replace('-', '').toLowerCase()}-${value}`;
}

/** `<baseline>__<knobId>_<value>` (02 §5.7), one segment per differing knob in id order */
export function variantId(baseline: string, differing: readonly [string, string][]): string {
  return [baseline, ...differing.map(([k, v]) => `${k}_${v}`)].join('__');
}

/** The issuer knobs set to something other than their default; any difference means a variant configuration is needed. */
export function differingIssuerKnobs(knobs: Readonly<Record<string, string>>): [string, string][] {
  return Object.entries(ISSUER_KNOB_DEFAULTS)
    .filter(([k, d]) => knobs[k as KnobId] !== undefined && knobs[k as KnobId] !== d)
    .map(([k]) => [k, knobs[k as KnobId] as string]);
}

/** Extracts the offer id from a by-reference offer URI, or null if it cannot be parsed. */
export function offerIdOf(offerUri: string): string | null {
  try {
    const u = new URL(offerUri);
    const ref = u.searchParams.get('credential_offer_uri');
    if (!ref) return null;
    const last = new URL(ref).pathname.split('/').filter(Boolean).at(-1);
    return last ?? null;
  } catch {
    return null;
  }
}

/** Drives Inji Certify (pre-authorized grant): creates the offer through the internal admin API and registers the gateway routes that attribute the wallet's hops to the run. */
export class CertifyPreauthIssuer implements IssuerAdapter {
  readonly descriptor: AdapterDescriptor;
  private readonly internal: string;
  private readonly publicBase: string;
  /** configuration in use per run (the variant once `resolveVariant` ran) */
  private readonly configs = new Map<string, string>();

  constructor(private readonly opts: CertifyPreauthOptions) {
    this.descriptor = { ...catalogEntry('issuer.certify-preauth'), knobs: [] };
    this.internal = `${trimSlash(opts.internalBase)}/v1/certify`;
    this.publicBase = trimSlash(opts.publicBase);
  }

  /** Capture labels for a call made by this adapter. */
  private cap(ctx: { runId: string }, stepKey: string) {
    return {
      runId: ctx.runId,
      stepKey,
      actor: 'playground(issuer-ui)',
      counterpart: 'issuer.certify-preauth',
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
      `${this.internal}/.well-known/openid-credential-issuer`,
      { signal: ctx.signal },
    );
    const body = await jsonBody(res);
    const ok = res.status === 200 && isRecord(body) && typeof body.credential_issuer === 'string';
    return ok
      ? { available: true, versionFingerprint: CERTIFY_PREAUTH_VERSION }
      : {
          available: false,
          reason: `well-known answered ${res.status}`,
          versionFingerprint: CERTIFY_PREAUTH_VERSION,
        };
  }

  /** Returns the configuration id to issue with. When no issuer knob differs from its default the baseline is used and the step is skipped; otherwise a variant configuration is looked up and created once if missing. */
  async resolveVariant(ctx: AdapterContext, baselineConfigurationId: string): Promise<string> {
    const differing = differingIssuerKnobs(ctx.knobs);
    if (differing.length === 0) {
      return inStep(ctx, 'vci.setup.variant', () =>
        Promise.resolve({ outcome: 'skipped' as const, value: baselineConfigurationId }),
      );
    }
    const id = variantId(baselineConfigurationId, differing);
    return inStep(ctx, 'vci.setup.variant', async () => {
      const cap = this.cap(ctx, 'vci.setup.variant');
      const existing = await ctx.http.fetch(
        cap,
        `${this.internal}/credential-configurations/${encodeURIComponent(id)}`,
        { signal: ctx.signal },
      );
      await existing.arrayBuffer();
      if (existing.status === 200) {
        this.configs.set(ctx.runId, id);
        return { outcome: 'pass', value: id };
      }
      const body = this.variantBody(baselineConfigurationId, differing, id);
      if (body === null) return { outcome: 'fail', value: baselineConfigurationId };
      const res = await ctx.http.fetch(cap, `${this.internal}/credential-configurations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
      await res.arrayBuffer();
      const ok = res.status === 200 || res.status === 201;
      if (ok) this.configs.set(ctx.runId, id);
      return { outcome: ok ? 'pass' : 'fail', value: ok ? id : baselineConfigurationId };
    });
  }

  /** the shipped variant file for exactly one differing knob, re-keyed to the variant id */
  private variantBody(
    baseline: string,
    differing: readonly [string, string][],
    id: string,
  ): Record<string, unknown> | null {
    if (differing.length !== 1 || !this.opts.configDir) return null;
    const [knob, value] = differing[0] as [string, string];
    const file = path.join(this.opts.configDir, `${baseline}.${knobSlug(knob, value)}.json`);
    if (!existsSync(file)) return null;
    const body = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const scope = str(body.scope);
    // never edits the baseline: own id and own scope (the token's scope selects the configuration)
    return {
      ...body,
      credentialConfigKeyId: id,
      ...(scope ? { scope: `${scope}__${knobSlug(knob, value)}` } : {}),
    };
  }

  async metadata(
    ctx: AdapterContext,
  ): Promise<{ issuer: unknown; authorizationServer: unknown; exchangeIds: string[] }> {
    const configurationId = this.configs.get(ctx.runId) ?? ctx.spec.configurationId;
    return inStep(ctx, 'vci.setup.config-read', async () => {
      const cap = this.cap(ctx, 'vci.setup.config-read');
      const conf = await ctx.http.fetch(
        cap,
        `${this.internal}/credential-configurations/${encodeURIComponent(configurationId)}`,
        { signal: ctx.signal },
      );
      const confBody = await jsonBody(conf);
      const wk = await ctx.http.fetch(
        cap,
        `${this.internal}/.well-known/openid-credential-issuer`,
        {
          signal: ctx.signal,
        },
      );
      const issuer = await jsonBody(wk);
      // the DID document every verifier resolves (did:web:<PUBLIC_HOST>, 02 §5.6) through the gateway
      const did = await ctx.http.fetch(
        { ...cap, actor: 'playground(issuer-ui)→gateway' },
        `${this.publicBase}/.well-known/did.json`,
        { signal: ctx.signal },
      );
      const didDoc = await jsonBody(did);
      const offered =
        isRecord(issuer) &&
        isRecord(issuer.credential_configurations_supported) &&
        configurationId in issuer.credential_configurations_supported;
      const ok =
        conf.status === 200 &&
        isRecord(confBody) &&
        wk.status === 200 &&
        offered &&
        did.status === 200 &&
        isRecord(didDoc) &&
        typeof didDoc.id === 'string';
      const as =
        isRecord(issuer) && Array.isArray(issuer.authorization_servers)
          ? (issuer.authorization_servers[0] as unknown)
          : null;
      return {
        outcome: ok ? 'pass' : 'fail',
        value: { issuer, authorizationServer: as, exchangeIds: [] },
      };
    });
  }

  async createOffer(
    ctx: AdapterContext,
    req: { configurationId: string; claims: Record<string, unknown>; withTxCode: boolean },
  ): Promise<CredentialOffer> {
    const configurationId = this.configs.get(ctx.runId) ?? req.configurationId;
    const baseline = req.configurationId.split('__')[0] ?? req.configurationId;
    const claims =
      Object.keys(req.claims).length > 0 ? req.claims : (DEFAULT_CLAIMS[baseline] ?? {});
    const txCode = req.withTxCode ? (this.opts.txCode ?? sixDigits)() : null;
    return inStep(ctx, 'vci.offer.mint', async () => {
      const res = await ctx.http.fetch(
        this.cap(ctx, 'vci.offer.mint'),
        `${this.internal}/pre-authorized-data`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            credential_configuration_id: configurationId,
            claims,
            expires_in: this.opts.offerTtlSeconds ?? 600,
            ...(txCode ? { tx_code: txCode } : {}),
          }),
          signal: ctx.signal,
        },
      );
      const body = await jsonBody(res);
      const uri = isRecord(body) ? str(body.credential_offer_uri) : null;
      // FLOW-02: a non-null `errors` array is a failed mint whatever the status
      const errors = isRecord(body) && Array.isArray(body.errors) && body.errors.length > 0;
      const offer: CredentialOffer = {
        uri: uri ?? '',
        credentialIssuer: this.publicBase,
        configurationId,
        grant: 'pre-authorized_code',
        ...(txCode ? { txCode: { value: txCode, inputMode: 'numeric' as const, length: 6 } } : {}),
      };
      if (res.status !== 200 || errors || uri === null) return { outcome: 'fail', value: offer };
      const offerId = offerIdOf(uri);
      if (offerId) {
        correlate(ctx, this.opts.gateway, { kind: 'offer-id', value: offerId }, 'vci.offer.fetch');
      }
      this.opts.gateway?.addRoutes?.(ctx.runId, PREAUTH_ROUTES);
      return { outcome: 'pass', value: offer };
    });
  }

  /** at the run's end: forget the run's configuration choice */
  release(runId: string): void {
    this.configs.delete(runId);
  }
}

/** A random six-digit code, used as the transaction code. */
function sixDigits(): string {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String((n[0] as number) % 1_000_000).padStart(6, '0');
}

/** the offer JSON's pre-authorized code (wallets register it at `vci.offer.fetch`) */
export function preAuthorizedCodeOf(offerJson: unknown): string | null {
  if (!isRecord(offerJson) || !isRecord(offerJson.grants)) return null;
  const g = offerJson.grants[PRE_AUTH_GRANT];
  return isRecord(g) ? str(g['pre-authorized_code']) : null;
}
