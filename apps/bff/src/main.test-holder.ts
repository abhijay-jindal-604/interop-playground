/**
 * TEST-ONLY minimal holder for the T-23/T-25 tests (main.test.ts, main.bundle.int.test.ts): the
 * wallet side of FLOW-01/04 with a fresh P-256 key, every hop through the run's CapturingHttp.
 * Not registered by main(); T-24 (`wallet.playground-ts`) replaces it in wave 5.
 * `present` never answers, so a full run reaches Verify's result call before any submission.
 */
import { generateKeyPairSync, sign as signRaw } from 'node:crypto';
import type {
  AdapterContext,
  CredentialOffer,
  HeldCredential,
  IssuanceOutcome,
  PresentationOutcome,
  WalletAdapter,
} from '@interop-playground/adapters';
import {
  catalogEntry,
  inStep,
  isRecord,
  jsonBody,
  preAuthorizedCodeOf,
  str,
} from '@interop-playground/adapters';

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

export function testHolder(): WalletAdapter {
  const descriptor = { ...catalogEntry('wallet.playground-ts'), knobs: [] };
  return {
    descriptor,
    probe: () => Promise.resolve({ available: true, versionFingerprint: 'test-holder' }),
    async receiveOffer(ctx: AdapterContext, offer: CredentialOffer): Promise<IssuanceOutcome> {
      const cap = (stepKey: string) => ({
        runId: ctx.runId,
        stepKey,
        actor: 'wallet.test-holder',
        counterpart: 'issuer.certify-preauth',
      });
      const get = async (stepKey: string, url: string) => {
        const res = await ctx.http.fetch(cap(stepKey), url, { signal: ctx.signal });
        return { status: res.status, body: await jsonBody(res) };
      };
      const fail = { ok: false, checks: [] } as IssuanceOutcome;
      const ref = new URL(offer.uri).searchParams.get('credential_offer_uri') ?? '';
      const offerJson = await inStep(ctx, 'vci.offer.fetch', async () => {
        const r = await get('vci.offer.fetch', ref);
        return {
          outcome: r.status === 200 && preAuthorizedCodeOf(r.body) ? 'pass' : 'fail',
          value: r.body,
        };
      });
      const code = preAuthorizedCodeOf(offerJson);
      const iss = isRecord(offerJson) ? str(offerJson.credential_issuer) : null;
      if (!code || !iss) return fail;
      const md = await inStep(ctx, 'vci.metadata.issuer', async () => {
        const r = await get('vci.metadata.issuer', `${iss}/.well-known/openid-credential-issuer`);
        return { outcome: r.status === 200 && isRecord(r.body) ? 'pass' : 'fail', value: r.body };
      });
      if (!isRecord(md)) return fail;
      const asBase = Array.isArray(md.authorization_servers)
        ? (str(md.authorization_servers[0]) ?? iss)
        : iss;
      const as = await inStep(ctx, 'vci.metadata.as', async () => {
        const r = await get('vci.metadata.as', `${asBase}/.well-known/oauth-authorization-server`);
        return { outcome: r.status === 200 && isRecord(r.body) ? 'pass' : 'fail', value: r.body };
      });
      const tokenUrl =
        (isRecord(as) ? str(as.token_endpoint) : null) ?? `${iss}/v1/certify/oauth/token`;
      const token = await inStep(ctx, 'vci.token', async () => {
        const res = await ctx.http.fetch(cap('vci.token'), tokenUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:pre-authorized_code',
            'pre-authorized_code': code,
          }).toString(),
          signal: ctx.signal,
        });
        const b = await jsonBody(res);
        const t = isRecord(b) ? str(b.access_token) : null;
        return { outcome: res.status === 200 && t ? 'pass' : 'fail', value: t };
      });
      if (!token) return fail;
      const nonceUrl = str(md.nonce_endpoint) ?? `${iss}/v1/certify/nonce`;
      const cNonce = await inStep(ctx, 'vci.nonce', async () => {
        const res = await ctx.http.fetch(cap('vci.nonce'), nonceUrl, {
          method: 'POST',
          signal: ctx.signal,
        });
        const b = await jsonBody(res);
        const n = isRecord(b) ? str(b.c_nonce) : null;
        return { outcome: res.status === 200 && n ? 'pass' : 'fail', value: n };
      });
      if (!cNonce) return fail;
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const jwk = publicKey.export({ format: 'jwk' });
      const didJwk = `did:jwk:${b64u(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }))}`;
      const proof = await inStep(ctx, 'vci.proof.sign', async () => {
        const header = { alg: 'ES256', typ: 'openid4vci-proof+jwt', kid: `${didJwk}#0` };
        const payload = { aud: iss, iat: Math.floor(Date.now() / 1000), nonce: cNonce };
        const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
        const sig = signRaw('sha256', Buffer.from(input), {
          key: privateKey,
          dsaEncoding: 'ieee-p1363',
        });
        await ctx.emit({
          type: 'engine.call',
          stepKey: 'vci.proof.sign',
          engine: 'playground-ts',
          op: 'sign-proof',
          inputSummary: { alg: 'ES256', kid: header.kid, aud: iss, nonce: cNonce },
          outputSummary: { sigBytes: sig.length },
        });
        return { outcome: 'pass', capture: 'none', value: `${input}.${b64u(sig)}` };
      });
      const credUrl = str(md.credential_endpoint) ?? `${iss}/v1/certify/issuance/credential`;
      const raw = await inStep(ctx, 'vci.credential', async () => {
        const res = await ctx.http.fetch(cap('vci.credential'), credUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({
            credential_configuration_id: offer.configurationId,
            proofs: { jwt: [proof] },
          }),
          signal: ctx.signal,
        });
        const b = await jsonBody(res);
        const first =
          isRecord(b) && Array.isArray(b.credentials) && isRecord(b.credentials[0])
            ? b.credentials[0].credential
            : null;
        const v = typeof first === 'string' ? first : first ? JSON.stringify(first) : null;
        return { outcome: res.status === 200 && v ? 'pass' : 'fail', value: v };
      });
      if (!raw) return fail;
      await inStep(ctx, 'vci.credential.inspect', () =>
        Promise.resolve({ outcome: 'pass' as const, capture: 'none' as const, value: null }),
      );
      const credential: HeldCredential = {
        format: ctx.spec.format,
        raw,
        holderKey: { keyId: 'test-holder', alg: 'ES256', publicJwk: jwk, didJwk },
        issuerAdapter: ctx.spec.issuer,
        configurationId: offer.configurationId,
      };
      return { ok: true, credential, checks: [] };
    },
    present(): Promise<PresentationOutcome> {
      return Promise.resolve({ submitted: false, checks: [] });
    },
  };
}
