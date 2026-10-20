/**
 * `wallet.playground-ts` (plan/12 T-24 issuance, T-26 presentation; 02 §5.3, ADR-09, ADR-10): our
 * TypeScript reference wallet, a port of research/spikes/vci-preauth.mjs and vp-sdjwt.mjs.
 *
 * Issuance (03 FLOW-01, FLOW-04): offer fetch, issuer + AS metadata, token (form), nonce right
 * before signing (40 s c_nonce, S-189), ES256 proof signed P1363 with `ctx.holderKey()` /
 * `ctx.sign()` (the private key never leaves the key service), credential, then
 * `vci.credential.inspect` emitting the decoded artifact (`engine.call{op:"inspect-credential"}`)
 * and one `verdict.check` per structural lint.
 * Presentation (03 FLOW-30, §2.0): parse + validate the `openid4vp://` request, DCQL match and
 * disclosure selection, KB-JWT `{iat, aud: clientId, nonce, sd_hash}` signed ES256 P1363,
 * `direct_post` of `vp_token={"<id>":["<sd-jwt>~<kb-jwt>"]}&state=<requestId>`.
 * `ldp_vc` (T-46, 03 FLOW-03 and FLOW-31 tier 2, S-199): the inspect lints of `ldp.ts`, the
 * `vci.issuer.did` fetch of the issuer's did:web document, and a JsonWebSignature2020 ES256 VP
 * signed by the credential's own issuance key, posted as `vp_token={"<id>":[<VP JSON>]}`.
 * Every HTTP hop goes through the injected `CapturingHttp` (to the gateway URLs the issuer and
 * the verifier advertise); protocol rejections are failed steps, not exceptions (02 §5.1).
 */
import { createHash } from 'node:crypto';
import { descriptorOf } from '../catalog.js';
import type {
  AdapterContext,
  AdapterDescriptor,
  Availability,
  CheckResult,
  CredentialOffer,
  DisclosureSelection,
  GatewayCorrelation,
  HeldCredential,
  HolderKeyRef,
  IssuanceOutcome,
  PresentationOutcome,
  PresentationRequestRef,
  WalletAdapter,
} from '../contracts.js';
import { preAuthorizedCodeOf } from '../issuers/certify-preauth.js';
import {
  UPSTREAM_TIMEOUT_MS,
  callSignal,
  correlate,
  inStep,
  isRecord,
  jsonBody,
  str,
  trimSlash,
} from '../support.js';
import type { Canonize } from './ldp.js';
import {
  didWebUrl,
  inspectLdpVc,
  ldpClaimPresent,
  ldpTypeMatches,
  loadJsonldCanonize,
  proofCreated,
  signLdpVp,
  unsignedVp,
} from './ldp.js';
import type { Disclosure } from './sd-jwt.js';
import { decodeSdJwt, findClaim, inspectSdJwt, presentationOf, sdHashOf } from './sd-jwt.js';

export const PLAYGROUND_TS_VERSION = 'playground-ts:0.1.0';
const ENGINE = 'playground-ts' as const;
const ACTOR = 'wallet.playground-ts';

const b64u = (b: Uint8Array | string): string =>
  (typeof b === 'string' ? Buffer.from(b, 'utf8') : Buffer.from(b)).toString('base64url');
const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * The well-known URL of an issuer or AS identifier (OID4VCI 1.0 §12.2.2, RFC 8414 §3): the
 * well-known segment goes between the host and the identifier's path (walt.id
 * `…:18103/.well-known/openid-credential-issuer/openid4vci`); an identifier without a path
 * (Certify `https://<PUBLIC_HOST>`) gives the plain `<origin>/.well-known/<name>`.
 */
export function wellKnownUrl(identifier: string, name: string): string {
  const u = new URL(identifier);
  const p = u.pathname.replace(/\/+$/, '');
  return `${u.origin}/.well-known/${name}${p}`;
}

export interface PlaygroundTsOptions {
  gateway?: GatewayCorrelation;
  /** clock in ms (KB-JWT / proof `iat`, ldp VP `created`) */
  now?: () => number;
  /** URDNA2015 canonicaliser for `ldp_vc` VPs (default: `jsonld` with the offline contexts) */
  canonize?: Canonize;
}

/** the parsed `openid4vp://authorize?…` request (03 FLOW-30 message 2) */
export interface ParsedRequest {
  clientId: string | null;
  state: string | null;
  responseMode: string | null;
  responseType: string | null;
  nonce: string | null;
  responseUri: string | null;
  dcqlQuery: unknown;
  requestUriRef: string | null;
}

/** Parses an `openid4vp://` request URI into the fields the wallet needs, decoding the DCQL query when present. */
export function parseRequestUri(uri: string): ParsedRequest {
  const q = new URL(uri).searchParams;
  let dcql: unknown = null;
  const raw = q.get('dcql_query');
  if (raw !== null) {
    try {
      dcql = JSON.parse(raw) as unknown;
    } catch {
      dcql = raw;
    }
  }
  return {
    clientId: q.get('client_id'),
    state: q.get('state'),
    responseMode: q.get('response_mode'),
    responseType: q.get('response_type'),
    nonce: q.get('nonce'),
    responseUri: q.get('response_uri'),
    dcqlQuery: dcql,
    requestUriRef: q.get('request_uri'),
  };
}

/** wallet-side request validation (OID4VP 1.0 "Client Identifier Prefix", "Response Mode direct_post") */
export function validateRequest(p: ParsedRequest, ref: PresentationRequestRef): string[] {
  const errs: string[] = [];
  if (p.requestUriRef !== null) errs.push('request by reference is not supported for this flow');
  if (!p.clientId) errs.push('client_id missing');
  else if (ref.clientIdScheme === 'plain' && p.clientId.includes(':'))
    errs.push(`client_id ${p.clientId} carries a prefix but the request is plain`);
  if (p.responseType !== 'vp_token') errs.push(`response_type ${String(p.responseType)}`);
  if (p.responseMode !== 'direct_post') errs.push(`response_mode ${String(p.responseMode)}`);
  if (!p.nonce) errs.push('nonce missing');
  if (!p.state) errs.push('state missing');
  if (!p.responseUri) errs.push('response_uri missing');
  else {
    try {
      const u = new URL(p.responseUri);
      if (u.protocol !== 'https:' && u.protocol !== 'http:')
        errs.push(`response_uri scheme ${u.protocol}`);
    } catch {
      errs.push('response_uri is not a URL');
    }
  }
  if (!isRecord(p.dcqlQuery) || !Array.isArray(p.dcqlQuery.credentials))
    errs.push('dcql_query has no credentials');
  return errs;
}

interface DcqlCredentialQuery {
  id: string;
  format: string;
  meta: Record<string, unknown>;
  claims: { path: string[] }[];
}

/** The credential queries of a DCQL query, or none if the shape is wrong. */
function dcqlCredentials(q: unknown): DcqlCredentialQuery[] {
  if (!isRecord(q) || !Array.isArray(q.credentials)) return [];
  return q.credentials.filter(isRecord).map((c) => ({
    id: str(c.id) ?? '',
    format: str(c.format) ?? '',
    meta: isRecord(c.meta) ? c.meta : {},
    claims: Array.isArray(c.claims)
      ? c.claims
          .filter(isRecord)
          .map((x) => ({ path: Array.isArray(x.path) ? x.path.map(String) : [] }))
      : [],
  }));
}

/** Our reference wallet: receives credentials over OID4VCI and presents SD-JWT or ldp_vc credentials over OID4VP, signing with the key service so the private key never leaves it. */
export class PlaygroundTsWallet implements WalletAdapter {
  readonly descriptor: AdapterDescriptor;

  constructor(private readonly opts: PlaygroundTsOptions = {}) {
    this.descriptor = descriptorOf('wallet.playground-ts');
  }

  /** Current time in whole seconds, from the injectable clock. */
  private nowS(): number {
    return Math.floor((this.opts.now ?? Date.now)() / 1000);
  }

  probe(): Promise<Availability> {
    // in-process engine: always available
    return Promise.resolve({ available: true, versionFingerprint: PLAYGROUND_TS_VERSION });
  }

  /** Capture labels for a call made by this wallet. */
  private cap(ctx: AdapterContext, stepKey: string, counterpart: string) {
    return { runId: ctx.runId, stepKey, actor: ACTOR, counterpart };
  }

  private async signJws(
    ctx: AdapterContext,
    key: HolderKeyRef,
    header: Record<string, unknown>,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
    const sig = await ctx.sign(key, key.alg, Buffer.from(input, 'ascii'));
    return `${input}.${b64u(sig)}`;
  }

  /** KNOB-03 (`wallet.proof.kid`): the proof header's key reference */
  private proofKeyHeader(ctx: AdapterContext, key: HolderKeyRef): Record<string, unknown> {
    const form = ctx.knobs['KNOB-03'] ?? 'did:jwk#0';
    if (form === 'jwk') return { jwk: key.publicJwk };
    if (form === 'did:jwk') return { kid: key.didJwk };
    return { kid: `${key.didJwk}#0` };
  }

  // ---------------- issuance (T-24) ----------------
  async receiveOffer(ctx: AdapterContext, offer: CredentialOffer): Promise<IssuanceOutcome> {
    const issuerId = ctx.spec.issuer;
    const cap = (k: string) => this.cap(ctx, k, issuerId);
    const fail: IssuanceOutcome = { ok: false, checks: [] };
    const get = async (stepKey: string, url: string) => {
      const res = await ctx.http.fetch(cap(stepKey), url, {
        signal: callSignal(ctx, UPSTREAM_TIMEOUT_MS),
      });
      return { status: res.status, body: await jsonBody(res) };
    };

    // vci.offer.fetch: by reference (Certify) or by value
    const u = new URL(offer.uri);
    const byRef = u.searchParams.get('credential_offer_uri');
    const byValue = u.searchParams.get('credential_offer');
    let offerJson: unknown;
    if (byRef) {
      offerJson = await inStep(ctx, 'vci.offer.fetch', async () => {
        const r = await get('vci.offer.fetch', byRef);
        return {
          outcome: r.status === 200 && preAuthorizedCodeOf(r.body) ? 'pass' : 'fail',
          value: r.body,
        };
      });
    } else {
      try {
        offerJson = byValue ? (JSON.parse(byValue) as unknown) : null;
      } catch {
        offerJson = null;
      }
      // FLOW-08: an offer by value has no fetch hop; the step is recorded as skipped
      await inStep(ctx, 'vci.offer.fetch', () =>
        Promise.resolve({ outcome: 'skipped' as const, value: null }),
      );
    }
    const code = preAuthorizedCodeOf(offerJson);
    const iss = isRecord(offerJson) ? str(offerJson.credential_issuer) : null;
    if (!code || !iss) return fail;
    correlate(
      ctx,
      this.opts.gateway,
      { kind: 'pre-authorized-code', value: code },
      'vci.token',
      ACTOR,
    );
    const configurationId =
      (isRecord(offerJson) && Array.isArray(offerJson.credential_configuration_ids)
        ? str(offerJson.credential_configuration_ids[0])
        : null) ?? offer.configurationId;

    // vci.metadata.issuer / vci.metadata.as
    const issBase = trimSlash(iss);
    const md = await inStep(ctx, 'vci.metadata.issuer', async () => {
      const r = await get('vci.metadata.issuer', wellKnownUrl(issBase, 'openid-credential-issuer'));
      return { outcome: r.status === 200 && isRecord(r.body) ? 'pass' : 'fail', value: r.body };
    });
    if (!isRecord(md)) return fail;
    const asBase = trimSlash(
      Array.isArray(md.authorization_servers)
        ? (str(md.authorization_servers[0]) ?? issBase)
        : issBase,
    );
    const as = await inStep(ctx, 'vci.metadata.as', async () => {
      const r = await get('vci.metadata.as', wellKnownUrl(asBase, 'oauth-authorization-server'));
      return { outcome: r.status === 200 && isRecord(r.body) ? 'pass' : 'fail', value: r.body };
    });
    if (!isRecord(as)) return fail;

    // vci.token (form body; a JSON body gets 403, S-007)
    const tokenUrl = str(as.token_endpoint) ?? `${issBase}/v1/certify/oauth/token`;
    const grants = isRecord(offerJson) && isRecord(offerJson.grants) ? offerJson.grants : {};
    const pre = grants['urn:ietf:params:oauth:grant-type:pre-authorized_code'];
    const needsTx = isRecord(pre) && pre.tx_code !== undefined;
    const token = await inStep(ctx, 'vci.token', async () => {
      const form = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:pre-authorized_code',
        'pre-authorized_code': code,
      });
      if (needsTx && offer.txCode) form.set('tx_code', offer.txCode.value);
      const res = await ctx.http.fetch(cap('vci.token'), tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: callSignal(ctx, UPSTREAM_TIMEOUT_MS),
      });
      const b = await jsonBody(res);
      const t = isRecord(b) ? str(b.access_token) : null;
      return { outcome: res.status === 200 && t ? 'pass' : 'fail', value: t };
    });
    if (!token) return fail;
    correlate(
      ctx,
      this.opts.gateway,
      { kind: 'access-token-sha256', value: sha256Hex(token) },
      'vci.credential',
      ACTOR,
    );

    // vci.nonce: immediately before signing (c_nonce lives 40 s, S-189)
    const nonceUrl = str(md.nonce_endpoint) ?? `${issBase}/v1/certify/nonce`;
    const cNonce = await inStep(ctx, 'vci.nonce', async () => {
      const res = await ctx.http.fetch(cap('vci.nonce'), nonceUrl, {
        method: 'POST',
        signal: callSignal(ctx, UPSTREAM_TIMEOUT_MS),
      });
      const b = await jsonBody(res);
      const n = isRecord(b) ? str(b.c_nonce) : null;
      return { outcome: res.status === 200 && n ? 'pass' : 'fail', value: n };
    });
    if (!cNonce) return fail;

    // vci.proof.sign (engine): ES256, P1363 by the key service
    const key = await ctx.holderKey();
    const proof = await inStep(ctx, 'vci.proof.sign', async () => {
      const header = {
        alg: key.alg,
        typ: 'openid4vci-proof+jwt',
        ...this.proofKeyHeader(ctx, key),
      };
      const payload = { aud: iss, iat: this.nowS(), nonce: cNonce };
      const jws = await this.signJws(ctx, key, header, payload);
      const kid = 'kid' in header && typeof header.kid === 'string' ? header.kid : 'jwk';
      await ctx.emit({
        type: 'engine.call',
        stepKey: 'vci.proof.sign',
        engine: ENGINE,
        op: 'sign-proof',
        inputSummary: { alg: key.alg, kid, aud: iss, nonce: cNonce },
        outputSummary: {
          alg: key.alg,
          kid,
          jwsSha256: sha256Hex(jws),
          sigBytes: Buffer.from(jws.split('.')[2] ?? '', 'base64url').length,
          header,
          payload,
        },
      });
      return { outcome: 'pass', capture: 'none', value: jws };
    });

    // vci.credential
    const credUrl = str(md.credential_endpoint) ?? `${issBase}/v1/certify/issuance/credential`;
    const raw = await inStep(ctx, 'vci.credential', async () => {
      const res = await ctx.http.fetch(cap('vci.credential'), credUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          credential_configuration_id: configurationId,
          proofs: { jwt: [proof] },
        }),
        signal: callSignal(ctx, UPSTREAM_TIMEOUT_MS),
      });
      const b = await jsonBody(res);
      const first =
        isRecord(b) && Array.isArray(b.credentials) && isRecord(b.credentials[0])
          ? b.credentials[0].credential
          : isRecord(b)
            ? b.credential
            : null;
      const v = typeof first === 'string' ? first : first ? JSON.stringify(first) : null;
      return { outcome: res.status === 200 && v ? 'pass' : 'fail', value: v };
    });
    if (!raw) return fail;

    // vci.credential.inspect (engine): the decoded artifact + structural lints
    const checks = await inStep(ctx, 'vci.credential.inspect', async () => {
      const r = this.inspect(ctx.spec.format, raw, key.didJwk);
      await ctx.emit({
        type: 'engine.call',
        stepKey: 'vci.credential.inspect',
        engine: ENGINE,
        op: 'inspect-credential',
        inputSummary: { format: ctx.spec.format, bytes: raw.length },
        outputSummary: r.decoded,
      });
      for (const check of r.checks)
        await ctx.emit({ type: 'verdict.check', stepKey: 'vci.credential.inspect', check });
      return { outcome: r.ok ? 'pass' : 'fail', capture: 'none', value: r.checks };
    });
    // vci.issuer.did (FLOW-03): the issuer's DID document, through the gateway (ADR-24)
    if (ctx.spec.format === 'ldp_vc' && checks.every((c) => c.outcome !== 'fail'))
      await this.issuerDid(ctx, raw);
    const credential: HeldCredential = {
      format: ctx.spec.format,
      raw,
      holderKey: key,
      issuerAdapter: issuerId,
      configurationId,
    };
    const ok = checks.every((c) => c.outcome !== 'fail');
    return ok ? { ok, credential, checks } : { ok, checks };
  }

  /**
   * `vci.issuer.did`: `GET` of the did:web document named by the credential's `issuer`, with an
   * `info` check that sets it beside `proof.verificationMethod` (G-20, G-88 evidence). Skipped for
   * a non-did:web issuer. A failed fetch is a failed step; the credential is still held.
   */
  private async issuerDid(ctx: AdapterContext, raw: string): Promise<void> {
    const vc = JSON.parse(raw) as Record<string, unknown>;
    const issuer = str(vc.issuer) ?? (isRecord(vc.issuer) ? str(vc.issuer.id) : null);
    const vm = isRecord(vc.proof) ? str(vc.proof.verificationMethod) : null;
    const url = issuer ? didWebUrl(issuer) : null;
    await inStep(ctx, 'vci.issuer.did', async () => {
      if (!url) return { outcome: 'skipped' as const, value: null };
      const res = await ctx.http.fetch(this.cap(ctx, 'vci.issuer.did', ctx.spec.issuer), url, {
        headers: { accept: 'application/did+json, application/json' },
        signal: callSignal(ctx, UPSTREAM_TIMEOUT_MS),
      });
      const doc = await jsonBody(res);
      const ok = res.status === 200 && isRecord(doc);
      const methods =
        ok && Array.isArray(doc.verificationMethod)
          ? doc.verificationMethod.filter(isRecord).map((m) => str(m.id) ?? '')
          : [];
      const assertion = ok && Array.isArray(doc.assertionMethod) ? doc.assertionMethod : [];
      const check: CheckResult = {
        checkId: 'vc.ldp.did-document',
        outcome: 'info',
        source: 'playground-lint',
        message: !ok
          ? `did.json answered HTTP ${res.status}`
          : [
              `DID document id ${String(str(doc.id))}`,
              vm && methods.includes(vm)
                ? `lists ${vm}`
                : `does not list proof.verificationMethod ${String(vm)} (G-20, FP-10 evidence)`,
              assertion.some((a) => typeof a === 'string' && !a.includes('#'))
                ? 'assertionMethod holds a bare DID (G-88, FP-19 evidence)'
                : 'assertionMethod holds key ids',
            ].join('; '),
        specClause: 'did:web Method Specification §3.2 (Read)',
        exchangeIds: [],
      };
      await ctx.emit({ type: 'verdict.check', stepKey: 'vci.issuer.did', check });
      return { outcome: ok ? ('pass' as const) : ('fail' as const), value: null };
    });
  }

  private inspect(
    format: string,
    raw: string,
    holderDid: string | null = null,
  ): { ok: boolean; decoded: unknown; checks: CheckResult[] } {
    if (format === 'dc+sd-jwt') {
      try {
        const { inspection, checks } = inspectSdJwt(raw);
        return { ok: checks.every((c) => c.outcome !== 'fail'), decoded: inspection, checks };
      } catch (e) {
        const check: CheckResult = {
          checkId: 'vc.sd-jwt.decode',
          outcome: 'fail',
          source: 'playground-lint',
          message: (e as Error).message,
          exchangeIds: [],
        };
        return { ok: false, decoded: { format, error: (e as Error).message }, checks: [check] };
      }
    }
    if (format === 'ldp_vc') {
      try {
        const { inspection, checks } = inspectLdpVc(raw, holderDid);
        return { ok: true, decoded: inspection, checks };
      } catch (e) {
        const check: CheckResult = {
          checkId: 'vc.ldp.decode',
          outcome: 'fail',
          source: 'playground-lint',
          message: (e as Error).message,
          exchangeIds: [],
        };
        return { ok: false, decoded: { format, error: (e as Error).message }, checks: [check] };
      }
    }
    // mso_mdoc: the normaliser (02 §5.5) decodes it; here only the envelope size
    return { ok: true, decoded: { format, bytes: raw.length }, checks: [] };
  }

  // ---------------- presentation (T-26) ----------------
  async present(
    ctx: AdapterContext,
    req: PresentationRequestRef,
    held: HeldCredential,
    sel: DisclosureSelection,
  ): Promise<PresentationOutcome> {
    const none: PresentationOutcome = { submitted: false, checks: [] };

    // vp.request.validate
    const parsed = await inStep(ctx, 'vp.request.validate', async () => {
      const p = parseRequestUri(req.requestUri);
      const errors = validateRequest(p, req);
      await ctx.emit({
        type: 'engine.call',
        stepKey: 'vp.request.validate',
        engine: ENGINE,
        op: 'validate-request',
        inputSummary: { uriSha256: sha256Hex(req.requestUri), clientIdScheme: req.clientIdScheme },
        outputSummary: {
          clientId: p.clientId,
          responseUri: p.responseUri,
          responseMode: p.responseMode,
          nonce: p.nonce,
          state: p.state,
          errors,
        },
      });
      return { outcome: errors.length === 0 ? 'pass' : 'fail', capture: 'none', value: p };
    });
    if (validateRequest(parsed, req).length > 0) return none;
    const clientId = parsed.clientId ?? req.clientId;
    const nonce = parsed.nonce ?? req.nonce;
    const state = parsed.state ?? req.state;
    const responseUri = parsed.responseUri ?? req.responseUri;

    if (held.format === 'ldp_vc')
      return this.presentLdp(ctx, req, held, sel, parsed.dcqlQuery, {
        clientId,
        nonce,
        state,
        responseUri,
      });

    // vp.credential.match: DCQL against the held credential, disclosure selection
    const match = await inStep(ctx, 'vp.credential.match', async () => {
      const m = this.match(parsed.dcqlQuery, held, sel);
      await ctx.emit({
        type: 'engine.call',
        stepKey: 'vp.credential.match',
        engine: ENGINE,
        op: 'match-credential',
        inputSummary: { format: held.format, dcqlQuery: parsed.dcqlQuery },
        outputSummary: m.ok
          ? {
              credentialQueryId: m.queryId,
              disclosed: m.chosen.map((d) => d.name),
              plainClaims: m.plain,
            }
          : { error: m.error },
      });
      return { outcome: m.ok ? 'pass' : 'fail', capture: 'none', value: m };
    });
    if (!match.ok) return none;

    // vp.token.build: KB-JWT {iat, aud = clientId, nonce, sd_hash}, ES256 P1363
    const vpToken = await inStep(ctx, 'vp.token.build', async () => {
      const presented = presentationOf(match.decoded, match.chosen);
      const header = { alg: held.holderKey.alg, typ: 'kb+jwt' };
      const payload = { iat: this.nowS(), aud: clientId, nonce, sd_hash: sdHashOf(presented) };
      const kb = await this.signJws(ctx, held.holderKey, header, payload);
      await ctx.emit({
        type: 'engine.call',
        stepKey: 'vp.token.build',
        engine: ENGINE,
        op: 'build-kb-jwt',
        inputSummary: {
          alg: held.holderKey.alg,
          kid: held.holderKey.didJwk,
          disclosures: match.chosen.length,
        },
        outputSummary: { header, payload, jwsSha256: sha256Hex(kb) },
      });
      return {
        outcome: 'pass',
        capture: 'none',
        value: JSON.stringify({ [match.queryId]: [presented + kb] }),
      };
    });

    return this.post(ctx, req, responseUri, vpToken, state);
  }

  /** `vp.response.post` (direct_post to the verifier's gateway response_uri), `vp.error.dispatch` */
  private async post(
    ctx: AdapterContext,
    req: PresentationRequestRef,
    responseUri: string,
    vpToken: string,
    state: string,
  ): Promise<PresentationOutcome> {
    const posted = await inStep(ctx, 'vp.response.post', async () => {
      const res = await ctx.http.fetch(
        this.cap(ctx, 'vp.response.post', req.verifierAdapter),
        responseUri,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ vp_token: vpToken, state }).toString(),
          signal: callSignal(ctx, UPSTREAM_TIMEOUT_MS),
        },
      );
      const body = await jsonBody(res);
      const ok = res.status >= 200 && res.status < 300;
      const checks: CheckResult[] = [];
      if (!ok) {
        const check: CheckResult = {
          checkId: 'vp.response.post',
          outcome: 'fail',
          source: 'verifier-response',
          ...(isRecord(body) && str(body.errorCode) ? { code: str(body.errorCode) as string } : {}),
          ...(isRecord(body) && (str(body.errorMessage) ?? str(body.error_description))
            ? { message: (str(body.errorMessage) ?? str(body.error_description)) as string }
            : { message: `HTTP ${res.status}` }),
          specClause: 'OID4VP 1.0 "Response Mode direct_post"',
          exchangeIds: [],
        };
        checks.push(check);
        await ctx.emit({ type: 'verdict.check', stepKey: 'vp.response.post', check });
      }
      return { outcome: ok ? 'pass' : 'fail', value: { ok, checks } };
    });
    if (!posted.ok) return { submitted: false, checks: posted.checks };

    // vp.error.dispatch: the wallet raised nothing (FLOW-45 is the error path)
    await inStep(ctx, 'vp.error.dispatch', () =>
      Promise.resolve({ outcome: 'skipped' as const, capture: 'none' as const, value: null }),
    );
    return { submitted: true, checks: [] };
  }

  /**
   * FLOW-31 tier 2 (S-199): DCQL `ldp_vc` match (type_values; claim paths relative to
   * `credentialSubject`), then the JsonWebSignature2020 ES256 VP signed by the issuance key with
   * `domain` = the full clientId and `challenge` = the nonce, posted as `{"<id>":[<VP>]}`.
   */
  private async presentLdp(
    ctx: AdapterContext,
    req: PresentationRequestRef,
    held: HeldCredential,
    sel: DisclosureSelection,
    dcql: unknown,
    r: { clientId: string; nonce: string; state: string; responseUri: string },
  ): Promise<PresentationOutcome> {
    const none: PresentationOutcome = { submitted: false, checks: [] };
    const match = await inStep(ctx, 'vp.credential.match', async () => {
      const m = this.matchLdp(dcql, held, sel);
      await ctx.emit({
        type: 'engine.call',
        stepKey: 'vp.credential.match',
        engine: ENGINE,
        op: 'match-credential',
        inputSummary: { format: held.format, dcqlQuery: dcql },
        outputSummary: m.ok
          ? {
              credentialQueryId: m.queryId,
              claimPaths: m.paths,
              note: 'ldp_vc has no selective disclosure: the whole credential is presented',
            }
          : { error: m.error },
      });
      return { outcome: m.ok ? 'pass' : 'fail', capture: 'none', value: m };
    });
    if (!match.ok) return none;

    const vpToken = await inStep(ctx, 'vp.token.build', async () => {
      const key = held.holderKey;
      const fail = async (message: string) => {
        await ctx.emit({
          type: 'engine.exception',
          stepKey: 'vp.token.build',
          engine: ENGINE,
          exceptionClass: 'LdpVpBuildError',
          message,
        });
        return { outcome: 'fail' as const, capture: 'none' as const, value: null };
      };
      // S-199 point 2: the VP is signed by the P-256 issuance key (no Ed25519 holder key exists)
      if (key.alg !== 'ES256') return fail(`the issuance key is ${key.alg}; S-199 needs ES256`);
      let canonize: Canonize;
      try {
        canonize = this.opts.canonize ?? (await loadJsonldCanonize());
      } catch (e) {
        return fail((e as Error).message);
      }
      const { vp, proof } = unsignedVp({
        credential: match.vc,
        holderDid: key.didJwk,
        domain: r.clientId,
        challenge: r.nonce,
        created: proofCreated((this.opts.now ?? Date.now)()),
      });
      let signed;
      try {
        signed = await signLdpVp(vp, proof, canonize, (d) => ctx.sign(key, 'ES256', d));
      } catch (e) {
        return fail(`canonicalisation or signing failed: ${(e as Error).message}`);
      }
      await ctx.emit({
        type: 'engine.call',
        stepKey: 'vp.token.build',
        engine: ENGINE,
        op: 'build-ldp-vp',
        inputSummary: {
          alg: key.alg,
          kid: `${key.didJwk}#0`,
          credentialType: match.type,
        },
        outputSummary: {
          holder: signed.holder,
          proof,
          jwsSha256: sha256Hex(signed.proof?.jws ?? ''),
        },
      });
      return {
        outcome: 'pass' as const,
        capture: 'none' as const,
        value: JSON.stringify({ [match.queryId]: [signed] }),
      };
    });
    if (vpToken === null) return none;
    return this.post(ctx, req, r.responseUri, vpToken, r.state);
  }

  private matchLdp(
    dcql: unknown,
    held: HeldCredential,
    sel: DisclosureSelection,
  ):
    | { ok: true; queryId: string; vc: Record<string, unknown>; type: string[]; paths: string[][] }
    | { ok: false; error: string } {
    let vc: unknown;
    try {
      vc = JSON.parse(held.raw) as unknown;
    } catch (e) {
      return { ok: false, error: `held credential is not JSON: ${(e as Error).message}` };
    }
    if (!isRecord(vc)) return { ok: false, error: 'held credential is not a JSON object' };
    const type = Array.isArray(vc.type) ? vc.type.map(String) : [];
    const q = dcqlCredentials(dcql).find(
      (c) => c.format === 'ldp_vc' && ldpTypeMatches(type, c.meta.type_values),
    );
    if (!q)
      return { ok: false, error: `no DCQL ldp_vc credential query matches type ${type.join(',')}` };
    const paths =
      q.claims.length > 0 ? q.claims.map((c) => c.path) : sel.claimPaths.map((p) => [...p]);
    for (const p of paths)
      if (!ldpClaimPresent(vc, p))
        return { ok: false, error: `claim ${p.join('.')} not in credentialSubject` };
    return { ok: true, queryId: q.id, vc, type, paths };
  }

  private match(
    dcql: unknown,
    held: HeldCredential,
    sel: DisclosureSelection,
  ):
    | {
        ok: true;
        queryId: string;
        decoded: ReturnType<typeof decodeSdJwt>;
        chosen: Disclosure[];
        plain: string[];
      }
    | { ok: false; error: string } {
    if (held.format !== 'dc+sd-jwt')
      return { ok: false, error: `presentation of ${held.format} is not an OID4VP flow (ADR-30)` };
    let decoded: ReturnType<typeof decodeSdJwt>;
    try {
      decoded = decodeSdJwt(held.raw);
    } catch (e) {
      return { ok: false, error: `held credential does not decode: ${(e as Error).message}` };
    }
    const vct = decoded.payload.vct;
    const q = dcqlCredentials(dcql).find((c) => {
      if (c.format !== held.format) return false;
      const vcts = Array.isArray(c.meta.vct_values) ? c.meta.vct_values : null;
      return vcts === null || vcts.includes(vct);
    });
    if (!q) return { ok: false, error: `no DCQL credential query matches vct ${String(vct)}` };
    const paths = q.claims.length > 0 ? q.claims.map((c) => c.path) : sel.claimPaths;
    const chosen: Disclosure[] = [];
    const plain: string[] = [];
    for (const path of paths) {
      const hit = findClaim(decoded, path);
      if (!hit) return { ok: false, error: `claim ${path.join('.')} not in the credential` };
      if (hit.via === 'disclosure') {
        if (!chosen.includes(hit.disclosure)) chosen.push(hit.disclosure);
      } else plain.push(path.join('.'));
    }
    return { ok: true, queryId: q.id, decoded, chosen, plain };
  }
}
