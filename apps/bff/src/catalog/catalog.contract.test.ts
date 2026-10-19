/**
 * T-21 acceptance (plan/12): the catalog and compatibility API.
 *  - one API-03 test per 04 §4.3 rule: the rule is the first hit, with its reason and gap ID
 *  - API-02/04/07/08/09 answer and validate against the generated contract schema
 *  - knob validation (04 §4.4), presets, API-08 defaults, tamper applicability (§4.5), KNOB-02
 *  - API-05/06 still serve the validated flow files
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import type { FastifyInstance } from 'fastify';
import { ADAPTER_IDS } from '@interop-playground/adapters';
import type {
  AdapterListResponse,
  ConfigurationListResponse,
  ErrorEnvelope,
  IncompatibilityListResponse,
  KnobCatalogResponse,
  PresetListResponse,
  PreviewResponse,
} from '@interop-playground/api';
import { REPO_ROOT } from '../config/index.js';
import { COMPAT_RULES } from '../orchestrator/rules.js';
import { createServer } from '../server.js';
import { openStore } from '../store/index.js';
import type { Store } from '../store/index.js';
import { applicableTamperCases, resolveKnobs, tamperInapplicability } from './index.js';

const flowsDir = path.join(REPO_ROOT, 'flows');
const H = { host: '127.0.0.1:3100' };
const POST = { ...H, origin: 'http://127.0.0.1:3100', 'content-type': 'application/json' };
const schema = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'packages', 'api', 'api.schema.json'), 'utf8'),
) as Record<string, unknown>;
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema({ $id: 'api', ...schema });
function expectValid(name: string, body: unknown): void {
  const v = ajv.getSchema(`api#/definitions/${name}`);
  expect(v, name).toBeDefined();
  expect(v?.(body), JSON.stringify(v?.errors)).toBe(true);
}

const SLICE = {
  issuer: 'issuer.certify-preauth',
  wallet: 'wallet.playground-ts',
  verifier: 'verifier.inji-verify-local',
  grant: 'pre-authorized_code',
  presentationMode: 'cross-device',
  format: 'dc+sd-jwt',
};
const AUTHCODE = { grant: 'authorization_code', issuer: 'issuer.certify-authcode' };

let app: FastifyInstance;
let store: Store;
beforeAll(async () => {
  store = openStore(':memory:');
  app = await createServer({
    config: {
      flowsDir,
      fingerprintsDir: path.join(REPO_ROOT, 'no-fingerprints-here'),
      uiDistDir: path.join(REPO_ROOT, 'no-ui'),
    },
    probeSidecar: () => Promise.resolve({ reachable: true, version: 't' }),
    store,
  });
});
afterAll(async () => {
  await app.close();
  store.close();
});

async function preview(body: object): Promise<{ status: number; json: unknown }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/runs/preview',
    headers: POST,
    payload: body,
  });
  return { status: res.statusCode, json: res.json() };
}
async function get<T>(url: string): Promise<{ status: number; json: T }> {
  const res = await app.inject({ method: 'GET', url, headers: H });
  return { status: res.statusCode, json: res.json<T>() };
}

/** a request whose first hit is the rule, and the reason the rule shows for it */
const RULE_CASES: Record<string, { body: object; reason: string }> = {
  'issuer-grant-mismatch': {
    body: { ...SLICE, grant: 'authorization_code' },
    reason: 'This issuer only supports pre-authorized_code.',
  },
  'issuer-format-unsupported': {
    body: { ...SLICE, issuer: 'issuer.waltid', format: 'ldp_vc' },
    reason: 'Issuer does not issue ldp_vc.',
  },
  'verifier-format-unsupported': {
    body: { ...SLICE, format: 'ldp_vc', verifier: 'verifier.waltid' },
    reason: 'Verifier does not verify ldp_vc.',
  },
  'mdoc-at-inji-verify': {
    body: { ...SLICE, format: 'mso_mdoc' },
    reason: 'Inji Verify has no mso_mdoc path.',
  },
  'mdoc-no-oid4vp': {
    body: { ...SLICE, format: 'mso_mdoc', verifier: 'verifier.credo', delivery: 'qr' },
    reason: 'mso_mdoc is verified at credential level only.',
  },
  'ldp-at-eudi': {
    body: { ...SLICE, format: 'ldp_vc', verifier: 'verifier.eudi' },
    reason: 'EUDI verifier has no ldp_vc.',
  },
  'webwallet-no-preauth': {
    body: { ...SLICE, wallet: 'wallet.inji-web', format: 'ldp_vc' },
    reason: 'Inji Web has no offer entry.',
  },
  'collab-issuer-no-preauth': {
    body: { ...SLICE, issuer: 'issuer.certify-collab', wallet: 'wallet.inji-web' },
    reason: 'Collab Certify does not offer pre-authorized issuance.',
  },
  'collab-issuer-wallet': {
    body: { ...SLICE, ...AUTHCODE, issuer: 'issuer.certify-collab', format: 'ldp_vc' },
    reason: 'Collab issuance runs only through Inji Web (best-effort).',
  },
  'jvm-http-issuer': {
    body: { ...SLICE, wallet: 'wallet.inji-jvm', issuer: 'issuer.waltid' },
    reason: 'VCIClient refuses http issuers.',
  },
  'jvm-preauth-only': {
    body: { ...SLICE, ...AUTHCODE, wallet: 'wallet.inji-jvm', format: 'ldp_vc' },
    reason: 'inji-jvm issues by pre-authorized offer only.',
  },
  'jvm-mdoc-unoffered': {
    body: { ...SLICE, wallet: 'wallet.inji-jvm', format: 'mso_mdoc', scope: 'issuance' },
    reason: 'mso_mdoc through VCIClient is not offered (needs a did:jwk proof, FP-07).',
  },
  'jvm-eudi-verifier': {
    body: { ...SLICE, wallet: 'wallet.inji-jvm', verifier: 'verifier.eudi' },
    reason: 'The jar accepts only EdDSA request objects; EUDI signs with ES512.',
  },
  'mobile-preauth-only': {
    body: { ...SLICE, ...AUTHCODE, wallet: 'wallet.inji-mobile', format: 'ldp_vc' },
    reason: 'The phone leg uses a pre-authorized offer QR.',
  },
  'mobile-peer-verifier': {
    body: { ...SLICE, wallet: 'wallet.inji-mobile', verifier: 'verifier.waltid' },
    reason: 'The tunnel exposes only Inji Verify and certify-preauth.',
  },
  'mobile-needs-tunnel': {
    body: { ...SLICE, wallet: 'wallet.inji-mobile' },
    reason: 'Start scripts/tunnel.sh first.',
  },
  'ldp-collab-verify-needs-tunnel': {
    body: { ...SLICE, format: 'ldp_vc', verifier: 'verifier.inji-verify-collab' },
    reason: 'Collab resolves the issuer did:web publicly; start the tunnel.',
  },
  'webwallet-only-local-verify': {
    body: {
      ...SLICE,
      ...AUTHCODE,
      wallet: 'wallet.inji-web',
      format: 'ldp_vc',
      verifier: 'verifier.inji-verify-sdk',
    },
    reason: 'The Mimoto trusted-verifier list registers only the local Verify.',
  },
  'webwallet-collab-redirect': {
    body: {
      ...SLICE,
      verifier: 'verifier.inji-verify-collab',
      presentationMode: 'same-device',
      delivery: 'web-wallet-redirect',
    },
    reason: "response_code redirect target is Collab's configuration.",
  },
  'dcapi-needs-sdk-verifier': {
    body: { ...SLICE, presentationMode: 'dc-api' },
    reason: 'The DC API probe runs through the Verify SDK.',
  },
  'credo-needs-fixture': {
    body: { ...SLICE, wallet: 'wallet.credo', verifier: 'verifier.credo' },
    reason: 'Credo holds fixture credentials only (no issuance).',
  },
  'fixture-formats': {
    body: { ...SLICE, issuer: 'issuer.fixture', format: 'ldp_vc' },
    reason: 'Fixtures exist for dc+sd-jwt and mso_mdoc.',
  },
  'txcode-scope': {
    body: { ...SLICE, issuer: 'issuer.waltid', withTxCode: true },
    reason: 'tx_code runs only on the local pre-auth issuer with the reference wallet.',
  },
  'iae-scope': {
    body: { ...SLICE, issuer: 'issuer.waltid', withIae: true },
    reason:
      'Presentation during issuance runs only on the local pre-auth issuer with the reference wallet.',
  },
};

describe('catalog.rules (04 §4.3 via API-03)', () => {
  it('every rule of the table has a case here', () => {
    expect(Object.keys(RULE_CASES).sort()).toEqual(COMPAT_RULES.map((r) => r.ruleId).sort());
    expect(COMPAT_RULES).toHaveLength(24);
  });
  for (const rule of COMPAT_RULES) {
    it(`${rule.ruleId} → its reason and gap ${rule.gapId ?? '—'}`, async () => {
      const c = RULE_CASES[rule.ruleId];
      expect(c).toBeDefined();
      const res = await preview(c?.body ?? {});
      expect(res.status).toBe(200);
      expect(res.json).toEqual({
        ok: false,
        hit: { ruleId: rule.ruleId, reason: c?.reason, gapId: rule.gapId },
      });
      expectValid('PreviewResponse', res.json);
    });
  }
  it('stateful rules are 409 tunnel_required at API-20, the others 422 incompatible_selection', async () => {
    const create = async (body: object): Promise<ErrorEnvelope> =>
      (
        await app.inject({ method: 'POST', url: '/api/v1/runs', headers: POST, payload: body })
      ).json<ErrorEnvelope>();
    const t = await create(RULE_CASES['mobile-needs-tunnel']?.body ?? {});
    expect(t.error).toMatchObject({ code: 'tunnel_required', status: 409 });
    const i = await create(RULE_CASES['ldp-at-eudi']?.body ?? {});
    expect(i.error).toMatchObject({ code: 'incompatible_selection', status: 422 });
    expect(i.error.details).toMatchObject({ ruleId: 'ldp-at-eudi' });
  });
});

describe('catalog.routes (API-02/04/07/08/09)', () => {
  it('API-02 lists the 18 adapters by role with availability', async () => {
    const { status, json } = await get<AdapterListResponse>('/api/v1/adapters');
    expect(status).toBe(200);
    expectValid('AdapterListResponse', json);
    const ids = [...json.issuers, ...json.wallets, ...json.verifiers].map((e) => e.descriptor.id);
    expect(ids.sort()).toEqual([...ADAPTER_IDS].sort());
    const verify = json.verifiers.find((e) => e.descriptor.id === 'verifier.inji-verify-local');
    expect(verify?.descriptor.knobs.map((k) => k.id)).toEqual(['KNOB-07', 'KNOB-10']);
    // never probed (no probe loop in this server): not available, with a reason
    expect(verify?.availability).toMatchObject({ available: false, reason: 'not probed yet' });
    const ts = json.wallets.find((e) => e.descriptor.id === 'wallet.playground-ts');
    expect(ts?.availability.available).toBe(true);
  });

  it('API-04 serves KNOB-01..10 and filters by adapter and format', async () => {
    const all = await get<KnobCatalogResponse>('/api/v1/knobs');
    expectValid('KnobCatalogResponse', all.json);
    expect(all.json.knobs.map((k) => k.def.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `KNOB-${String(i + 1).padStart(2, '0')}`),
    );
    const sd = await get<KnobCatalogResponse>(
      '/api/v1/knobs?adapter=issuer.certify-preauth&format=dc%2Bsd-jwt',
    );
    expect(sd.json.knobs.map((k) => k.def.id)).toEqual(['KNOB-04']);
    const bad = await get<ErrorEnvelope>('/api/v1/knobs?adapter=issuer.nope');
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('validation_failed');
    const unknown = await get<ErrorEnvelope>('/api/v1/knobs?typo=1');
    expect(unknown.json.error.code).toBe('validation_failed');
  });

  it('API-07 serves the "Inji shipped samples" preset', async () => {
    const { json } = await get<PresetListResponse>('/api/v1/presets');
    expectValid('PresetListResponse', json);
    expect(json.presets).toEqual([
      expect.objectContaining({
        presetId: 'inji-shipped-samples',
        knobs: { 'KNOB-04': 'plain', 'KNOB-05': 'postman-sample', 'KNOB-06': 'seeded' },
      }),
    ]);
  });

  it('API-08 serves configurations with one default per issuer × format', async () => {
    const { json } = await get<ConfigurationListResponse>('/api/v1/configurations');
    expectValid('ConfigurationListResponse', json);
    const pairs = new Map<string, number>();
    for (const c of json.configurations) {
      const k = `${c.issuer}|${c.format}`;
      pairs.set(k, (pairs.get(k) ?? 0) + (c.default ? 1 : 0));
    }
    for (const [k, n] of pairs) expect(n, k).toBe(1);
    const f = await get<ConfigurationListResponse>(
      '/api/v1/configurations?issuer=issuer.certify-preauth&format=ldp_vc',
    );
    expect(f.json.configurations).toEqual([
      expect.objectContaining({ configurationId: 'FarmerCredential', default: true }),
    ]);
    const wrongRole = await get<ErrorEnvelope>('/api/v1/configurations?issuer=wallet.credo');
    expect(wrongRole.json.error.code).toBe('validation_failed');
  });

  it('API-09 lists the 24 rules with reason templates and gap IDs', async () => {
    const { json } = await get<IncompatibilityListResponse>('/api/v1/incompatibilities');
    expectValid('IncompatibilityListResponse', json);
    expect(json.rules).toHaveLength(24);
    expect(json.rules.find((r) => r.ruleId === 'issuer-grant-mismatch')?.reason).toBe(
      'This issuer only supports <grant>.',
    );
    expect(json.rules.find((r) => r.ruleId === 'mdoc-at-inji-verify')).toMatchObject({
      gapId: 'G-09',
      evidence: ['02 §5.3'],
    });
    expect(json.rules.find((r) => r.ruleId === 'mobile-needs-tunnel')?.when).toMatch(/stateful/);
  });

  it('API-05/06 still serve the validated flow files', async () => {
    const index = await get<{ flows: { flowId: string }[] }>('/api/v1/flows');
    expect(index.status).toBe(200);
    expect(index.json.flows.map((f) => f.flowId)).toContain('FLOW-30');
    const one = await get<{ flowId: string }>('/api/v1/flows/FLOW-04');
    expect(one.status).toBe(200);
    expect(one.json.flowId).toBe('FLOW-04');
  });
});

describe('catalog.resolution (04 §4.1 step 4–5, §4.4, §4.5)', () => {
  const spec = async (body: object): Promise<PreviewResponse> =>
    (await preview(body)).json as PreviewResponse;
  const error = async (body: object): Promise<ErrorEnvelope['error']> =>
    ((await preview(body)).json as ErrorEnvelope).error;

  it('writes out every applicable knob at its default; inapplicable knobs are absent', async () => {
    const p = await spec(SLICE);
    expect(p.ok && p.spec.knobs).toEqual({ 'KNOB-04': 'jsonpath', 'KNOB-07': 'plain' });
    // KNOB-10 needs wallet.inji-web (its flow FLOW-11 ships later, so the resolver is called directly)
    const ldpWeb = resolveKnobs(
      {
        issuer: 'issuer.certify-authcode',
        wallet: 'wallet.inji-web',
        verifier: 'verifier.inji-verify-local',
        format: 'ldp_vc',
      },
      undefined,
      undefined,
      [],
    );
    expect(ldpWeb).toEqual({ 'KNOB-06': 'issuer-did', 'KNOB-07': 'plain', 'KNOB-10': 'expanded' });
  });

  it('knob_invalid only for an unknown knob or value; knob_not_applicable otherwise', async () => {
    expect(await error({ ...SLICE, knobs: { 'KNOB-99': 'x' } })).toMatchObject({
      code: 'knob_invalid',
      details: { knobId: 'KNOB-99', reason: 'unknown-knob' },
    });
    expect(await error({ ...SLICE, knobs: { 'KNOB-04': 'nope' } })).toMatchObject({
      code: 'knob_invalid',
      details: { knobId: 'KNOB-04', reason: 'unknown-value' },
    });
    expect(await error({ ...SLICE, knobs: { 'KNOB-01': 'present' } })).toMatchObject({
      code: 'knob_not_applicable',
      details: { knobId: 'KNOB-01', reason: 'not-applicable' },
    });
    const ok = await spec({ ...SLICE, knobs: { 'KNOB-04': 'plain' } });
    expect(ok.ok && ok.spec.knobs['KNOB-04']).toBe('plain');
  });

  it('Collab issuer-side knob is collab-no-write; inji-mobile × KNOB-07 is fixed-request-profile', async () => {
    const collab = {
      ...SLICE,
      ...AUTHCODE,
      issuer: 'issuer.certify-collab',
      wallet: 'wallet.inji-web',
      format: 'ldp_vc',
    };
    expect(await error({ ...collab, knobs: { 'KNOB-06': 'seeded' } })).toMatchObject({
      code: 'knob_not_applicable',
      details: { reason: 'collab-no-write' },
    });
    expect(
      await error({ ...SLICE, wallet: 'wallet.inji-mobile', knobs: { 'KNOB-07': 'x509_san_dns' } }),
    ).toMatchObject({ code: 'knob_not_applicable', details: { reason: 'fixed-request-profile' } });
  });

  it('a preset applies first; explicit knobs override; inapplicable entries are warnings', async () => {
    const p = await spec({
      ...SLICE,
      preset: 'inji-shipped-samples',
      knobs: { 'KNOB-04': 'jsonpath' },
    });
    expect(p.ok && p.spec.knobs).toEqual({ 'KNOB-04': 'jsonpath', 'KNOB-07': 'plain' });
    expect(p.ok && p.warnings.filter((w) => w.startsWith('preset'))).toHaveLength(2);
    expect(await error({ ...SLICE, preset: 'nope' })).toMatchObject({ code: 'validation_failed' });
  });

  it('API-08 defaults fill configurationId; an unknown configuration is validation_failed', async () => {
    const p = await spec({ ...SLICE, format: 'ldp_vc' });
    expect(p.ok && p.spec.configurationId).toBe('FarmerCredential');
    expect(await error({ ...SLICE, configurationId: 'Nope' })).toMatchObject({
      code: 'validation_failed',
    });
  });

  it('KNOB-02 normalises the mso_mdoc issuer', async () => {
    const base = { ...SLICE, format: 'mso_mdoc', scope: 'issuance' };
    const dev = await spec(base);
    expect(dev.ok && dev.spec.issuer).toBe('issuer.certify-mdoc');
    expect(dev.ok && dev.spec.knobs['KNOB-02']).toBe('develop-spec');
    const alpha = await spec({ ...base, knobs: { 'KNOB-02': 'alpha1-template' } });
    expect(alpha.ok && alpha.spec.issuer).toBe('issuer.certify-preauth');
    expect(alpha.ok && alpha.spec.knobs['KNOB-02']).toBe('alpha1-template');
  });

  it('API-03 lists applicable tamper cases; an inapplicable case is tamper_not_applicable', async () => {
    const p = await spec(SLICE);
    expect(p.ok && p.tamperApplicable).toEqual(
      applicableTamperCases({ ...SLICE, scope: 'full' } as Parameters<
        typeof applicableTamperCases
      >[0]),
    );
    expect(p.ok && p.tamperApplicable).toContain('TMP-30');
    expect(p.ok && p.tamperApplicable).not.toContain('TMP-44');
    const t = await spec({ ...SLICE, tamperCase: 'TMP-30' });
    expect(t.ok && t.controlRequired).toBe(true);
    expect(await error({ ...SLICE, tamperCase: 'TMP-44' })).toMatchObject({
      code: 'tamper_not_applicable',
      details: { tmpId: 'TMP-44' },
    });
    expect(await error({ ...SLICE, scope: 'issuance', tamperCase: 'TMP-30' })).toMatchObject({
      code: 'tamper_not_applicable',
    });
  });

  it('tamper applicability follows 04 §4.5 and the 07 §4.9 note', () => {
    const t = {
      issuer: 'issuer.certify-preauth',
      wallet: 'wallet.playground-ts',
      verifier: 'verifier.eudi',
      format: 'dc+sd-jwt',
      scope: 'full',
    } as const;
    expect(tamperInapplicability('TMP-55', t)).toMatch(/G-59/);
    expect(
      tamperInapplicability('TMP-55', { ...t, verifier: 'verifier.inji-verify-local' }),
    ).toBeNull();
    const b48 = {
      ...t,
      wallet: 'wallet.inji-jvm',
      verifier: 'verifier.inji-verify-collab',
    } as const;
    expect(tamperInapplicability('TMP-74', b48)).toBeNull();
    expect(tamperInapplicability('TMP-76', b48)).not.toBeNull();
    expect(tamperInapplicability('TMP-99', t)).toBe('unknown tamper case');
  });
});
