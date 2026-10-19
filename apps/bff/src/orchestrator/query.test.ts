/**
 * ADR-88 (T-44): the presentation query a run sends names what the issuer actually issued.
 *  - `queryTypeOf`: a `dc+sd-jwt` uses the held credential's own `vct` (walt.id's is a URL on
 *    PUBLIC_HOST, not its configuration id); other formats and unreadable credentials keep the
 *    configuration id (Certify: vct = configuration id);
 *  - the default disclosure of an `issuer.waltid` run is `birthdate` (its one selectively
 *    disclosable claim), other issuers keep the format default; an explicit selection wins.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HeldCredential } from '@interop-playground/adapters';
import type { CreateRunRequest } from '@interop-playground/api';
import { REPO_ROOT } from '../config/index.js';
import { queryTypeOf } from './engine.js';
import { loadFlowTable } from './flows.js';
import { DEFAULT_RESOLVE_ENV, resolveRunSpec } from './resolve.js';

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const held = (format: HeldCredential['format'], raw: string): HeldCredential => ({
  format,
  raw,
  holderKey: { keyId: 'hk', alg: 'ES256', publicJwk: {}, didJwk: 'did:jwk:e30' },
  issuerAdapter: 'issuer.waltid',
  configurationId: 'identityCredentialSdJwt',
});
const VCT = 'http://192.168.1.84:18103/openid4vci/identity_credential';

describe('queryTypeOf (ADR-88)', () => {
  it('dc+sd-jwt: the credential vct', () => {
    const raw = `${b64({ alg: 'ES256', typ: 'dc+sd-jwt' })}.${b64({ vct: VCT })}.sig~disc~`;
    expect(queryTypeOf(held('dc+sd-jwt', raw), 'identityCredentialSdJwt')).toBe(VCT);
  });
  it('no vct, an unreadable credential or another format: the configuration id', () => {
    expect(queryTypeOf(held('dc+sd-jwt', `${b64({})}.${b64({})}.s~`), 'PlaygroundSdJwt')).toBe(
      'PlaygroundSdJwt',
    );
    expect(queryTypeOf(held('dc+sd-jwt', 'not-a-jwt'), 'PlaygroundSdJwt')).toBe('PlaygroundSdJwt');
    expect(queryTypeOf(held('ldp_vc', '{"type":["X"]}'), 'FarmerCredential')).toBe(
      'FarmerCredential',
    );
  });
});

describe('default disclosure per issuer (ADR-88)', () => {
  const flows = loadFlowTable(path.join(REPO_ROOT, 'flows'));
  const spec = (r: Partial<CreateRunRequest>) => {
    const res = resolveRunSpec(
      {
        issuer: 'issuer.waltid',
        wallet: 'wallet.playground-ts',
        verifier: 'verifier.inji-verify-local',
        grant: 'pre-authorized_code',
        presentationMode: 'cross-device',
        format: 'dc+sd-jwt',
        ...r,
      },
      flows,
      DEFAULT_RESOLVE_ENV,
      { stateful: false, checkAvailability: false },
    );
    if (!res.ok) throw new Error(res.hit.reason);
    return res.spec;
  };
  it('walt.id → birthdate, on FLOW-08 + FLOW-30', () => {
    const s = spec({});
    expect(s.disclosure).toEqual({ claimPaths: [['birthdate']] });
    expect([s.issuanceFlowId, s.presentationFlowId]).toEqual(['FLOW-08', 'FLOW-30']);
  });
  it('Certify keeps the format default; an explicit selection wins', () => {
    expect(spec({ issuer: 'issuer.certify-preauth' }).disclosure).toEqual({
      claimPaths: [['fullName']],
    });
    expect(spec({ disclosure: { claimPaths: [['given_name']] } }).disclosure).toEqual({
      claimPaths: [['given_name']],
    });
  });
});
