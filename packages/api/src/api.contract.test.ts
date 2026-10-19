/**
 * T-02 contract tests (plan/12 T-02 acceptance; plan/11 §4.3 `contracts.generated`):
 * OpenAPI 3.1 validates; every API-xx of 04 §2 has its method+path; 18 adapters; CheckResult.outcome
 * accepts 'info'; exactly the 40 error codes of 04 §6.2; every 04 §3 / §7.2 type has a schema.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import YAML from 'yaml';
import { ADAPTER_CATALOG, ADAPTER_IDS } from '@interop-playground/adapters';
import type { AdapterId, CheckResult } from '@interop-playground/adapters';
import { ERROR_CODES, ERROR_STATUS, EVENT_TYPES } from './api.js';
import type { ErrorCode, EventType } from './api.js';
import { NON_ROUTE_CONTRACTS, ROUTES } from './routes.js';
import { SCHEMA_TYPE_NAMES } from './schema-types.js';

const addFormats = addFormatsModule as unknown as (ajv: Ajv | Ajv2020) => void;
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
type Schema = Record<string, unknown>;
type OpenApi = {
  openapi: string;
  paths: Record<string, Record<string, { 'x-api-id'?: string }>>;
  components: { schemas: Record<string, Schema> };
};
const openapi = YAML.parse(readFileSync(path.join(pkgDir, 'openapi.yaml'), 'utf8')) as OpenApi;
const jsonSchema = JSON.parse(readFileSync(path.join(pkgDir, 'api.schema.json'), 'utf8')) as {
  definitions: Record<string, Schema>;
};
const oasMeta = JSON.parse(
  readFileSync(path.join(pkgDir, 'vendor/oas-3.1-2022-10-07.schema.json'), 'utf8'),
) as Schema;

/** The API ids of the route tables of 04 §2.1–§2.8 (API-01..74 and API-80; 13, 14, 16–19 do not exist). */
const EXPECTED_API_IDS = [
  ...Array.from({ length: 12 }, (_, i) => i + 1),
  15,
  ...Array.from({ length: 18 }, (_, i) => i + 20),
  ...Array.from({ length: 22 }, (_, i) => i + 38),
  ...Array.from({ length: 10 }, (_, i) => i + 60),
  ...Array.from({ length: 5 }, (_, i) => i + 70),
  80,
].map((n) => `API-${String(n).padStart(2, '0')}`);

/** 04 §6.2 table, in table order. */
const EXPECTED_ERROR_CODES = [
  'validation_failed',
  'request_guard_failed',
  'unauthorized',
  'not_found',
  'conflict',
  'payload_too_large',
  'unsupported_media_type',
  'gone',
  'idempotency_conflict',
  'incompatible_selection',
  'knob_invalid',
  'knob_not_applicable',
  'tamper_not_applicable',
  'tunnel_required',
  'adapter_unavailable',
  'env_not_ready',
  'queue_full',
  'rate_limited',
  'run_not_cancellable',
  'run_not_terminal',
  'run_in_use',
  'key_unavailable',
  'parent_not_failed',
  'tamper_run_not_derivable',
  'derive_not_one_knob',
  'fix_not_offered',
  'knob_reverted',
  'version_drift',
  'environment_changed',
  'observation_not_expected',
  'compare_not_comparable',
  'draft_not_editable',
  'proxy_path_denied',
  'proxy_run_not_active',
  'upstream_unreachable',
  'gateway_denied',
  'sidecar_unavailable',
  'engine_exception',
  'callback_not_pending',
  'internal_error',
];

function draft07(): Ajv {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ $id: 'api', ...jsonSchema });
  return ajv;
}

describe('contracts.openapi', () => {
  it('is an OpenAPI 3.1 document that validates against the OAS 3.1 schema', () => {
    expect(openapi.openapi).toBe('3.1.0');
    // `format` is an annotation in JSON Schema 2020-12 (server URLs carry `{publicHost}` templates).
    // The OAS schema points Schema Objects at `$dynamicRef: #meta`, whose default target is
    // `$defs/schema` ({type: object|boolean}); ajv mis-resolves that dynamic anchor, so it is
    // bound statically here. The component schemas are compiled as 2020-12 in the next test.
    const meta = JSON.parse(JSON.stringify(oasMeta), (key, value: unknown) => {
      if (value !== null && typeof value === 'object' && '$dynamicRef' in value) {
        const { $dynamicRef: _dynamic, ...rest } = value as Record<string, unknown>;
        return { ...rest, $ref: '#/$defs/schema' };
      }
      return value;
    }) as Schema;
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
    const validate = ajv.compile(meta);
    const ok = validate(openapi);
    expect(validate.errors ?? [], JSON.stringify(validate.errors?.slice(0, 5))).toEqual([]);
    expect(ok).toBe(true);
  });

  it('every component schema compiles as JSON Schema 2020-12 and every $ref resolves', () => {
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    ajv.addSchema({ $id: 'oas', components: openapi.components }, 'oas');
    for (const name of Object.keys(openapi.components.schemas)) {
      expect(() => ajv.getSchema(`oas#/components/schemas/${name}`), name).not.toThrow();
    }
  });

  it('has method+path for every API-xx of 04 §2 (API-01..74 and API-80)', () => {
    const routeIds = new Set(ROUTES.map((r) => r.apiId));
    const contractIds = NON_ROUTE_CONTRACTS.map((c) => c.apiId);
    expect([...new Set([...routeIds, ...contractIds])].sort()).toEqual(
      [...EXPECTED_API_IDS].sort(),
    );
    for (const route of ROUTES) {
      const op = openapi.paths[route.path]?.[route.method.toLowerCase()];
      expect(op, `${route.apiId} ${route.method} ${route.path}`).toBeDefined();
      expect(op?.['x-api-id']).toBe(route.apiId);
    }
    // and nothing in the document is outside the table
    const documented = Object.entries(openapi.paths).flatMap(([p, ops]) =>
      Object.entries(ops)
        .filter(([m]) => ['get', 'post', 'patch', 'delete', 'put'].includes(m))
        .map(([m, op]) => `${op['x-api-id']} ${m.toUpperCase()} ${p}`),
    );
    expect(documented.sort()).toEqual(ROUTES.map((r) => `${r.apiId} ${r.method} ${r.path}`).sort());
  });
});

describe('contracts.adapters', () => {
  it('the adapter catalog lists the 18 adapters of 02 §5.3', () => {
    expect(ADAPTER_IDS).toHaveLength(18);
    expect(new Set(ADAPTER_IDS).size).toBe(18);
    expect(ADAPTER_CATALOG.map((a) => a.id)).toEqual([...ADAPTER_IDS]);
    const roles = ADAPTER_CATALOG.reduce<Record<string, number>>(
      (acc, a) => ({ ...acc, [a.role]: (acc[a.role] ?? 0) + 1 }),
      {},
    );
    expect(roles).toEqual({ issuer: 6, wallet: 5, verifier: 7 });
    for (const entry of ADAPTER_CATALOG) expect(entry.id.startsWith(`${entry.role}.`)).toBe(true);
    const schemaEnum = (openapi.components.schemas.AdapterId as { enum: string[] }).enum;
    expect([...schemaEnum].sort()).toEqual([...ADAPTER_IDS].sort());
    expectTypeOf<(typeof ADAPTER_IDS)[number]>().toEqualTypeOf<AdapterId>();
  });
});

describe('contracts.check-result', () => {
  it("CheckResult.outcome accepts 'info'", () => {
    const check: CheckResult = {
      checkId: 'vp.wallet.verifier-badges',
      outcome: 'info',
      source: 'engine',
      exchangeIds: [],
    };
    const validate = draft07().getSchema('api#/definitions/CheckResult');
    expect(validate?.(check), JSON.stringify(validate?.errors)).toBe(true);
    expect(validate?.({ ...check, outcome: 'maybe' })).toBe(false);
    expectTypeOf<CheckResult['outcome']>().toEqualTypeOf<'pass' | 'fail' | 'not-run' | 'info'>();
  });
});

describe('contracts.errors', () => {
  it('has exactly the 40 error codes of 04 §6.2 with their fixed status', () => {
    expect(ERROR_CODES).toHaveLength(40);
    expect(ERROR_CODES).toEqual(EXPECTED_ERROR_CODES);
    expectTypeOf<ErrorCode>().toEqualTypeOf<keyof typeof ERROR_STATUS>();
    const envelope = openapi.components.schemas.ErrorEnvelope as {
      properties: {
        error: { $ref?: string; properties?: { code: { $ref?: string; enum?: string[] } } };
      };
    };
    const codeSchema = openapi.components.schemas.ErrorCode as { enum: string[] };
    expect([...codeSchema.enum].sort()).toEqual([...EXPECTED_ERROR_CODES].sort());
    expect(JSON.stringify(envelope)).toContain('#/components/schemas/ErrorCode');
    expect(ERROR_STATUS.request_guard_failed).toBe(403);
    expect(ERROR_STATUS.upstream_unreachable).toBe(502);
    for (const [code, status] of Object.entries(ERROR_STATUS)) {
      expect([400, 401, 403, 404, 409, 410, 413, 415, 422, 429, 500, 502, 503], code).toContain(
        status,
      );
    }
  });
});

describe('contracts.generated', () => {
  it('free-form records are not collapsed into KnobValues (G-139)', () => {
    const ajv = draft07();
    const validate = ajv.getSchema('api#/definitions/ErrorEnvelope');
    const envelope = {
      error: {
        code: 'engine_exception',
        message: 'The engine threw.',
        status: 500,
        requestId: '01JA0000000000000000000000',
        retryable: false,
        details: { exceptionClass: 'VCIClientException', message: 'proof rejected', n: 1 },
      },
    };
    expect(validate?.(envelope), JSON.stringify(validate?.errors)).toBe(true);
    const degraded = ajv.getSchema('api#/definitions/Event.env.degraded');
    const event = {
      v: 1,
      runId: 'env',
      seq: 3,
      ts: '2026-10-06T09:30:12.345Z',
      type: 'env.degraded',
      payload: { upstreams: ['verify-service'], reasons: { 'verify-service': 'HTTP 503' } },
    };
    expect(degraded?.(event), JSON.stringify(degraded?.errors)).toBe(true);
  });

  it('every 04 §3 type (and EventEnvelope) has a schema', () => {
    for (const name of [...SCHEMA_TYPE_NAMES, 'EventEnvelope']) {
      expect(jsonSchema.definitions[name], name).toBeDefined();
      expect(openapi.components.schemas[name], name).toBeDefined();
    }
  });

  it('every 04 §7.2 event type (22) has an envelope schema', () => {
    expect(EVENT_TYPES).toHaveLength(22);
    expectTypeOf<(typeof EVENT_TYPES)[number]>().toEqualTypeOf<EventType>();
    const ajv = draft07();
    for (const type of EVENT_TYPES) {
      expect(jsonSchema.definitions[`Event.${type}`], type).toBeDefined();
    }
    const validate = ajv.getSchema('api#/definitions/EventEnvelope');
    const sample = {
      v: 1,
      runId: '01JA0000000000000000000000',
      seq: 1,
      ts: '2026-10-06T09:30:12.345Z',
      type: 'run.started',
      payload: { startedAt: '2026-10-06T09:30:12.345Z' },
    };
    expect(validate?.(sample), JSON.stringify(validate?.errors)).toBe(true);
    expect(validate?.({ ...sample, type: 'run.unknown' })).toBe(false);
  });

  it('requests reject unknown fields (04 §1 versioning rule)', () => {
    const validate = draft07().getSchema('api#/definitions/CreateRunRequest');
    const body = {
      issuer: 'issuer.certify-preauth',
      wallet: 'wallet.playground-ts',
      verifier: 'verifier.inji-verify-local',
      grant: 'pre-authorized_code',
      presentationMode: 'cross-device',
      format: 'dc+sd-jwt',
      knobs: { 'KNOB-07': 'plain' },
    };
    expect(validate?.(body), JSON.stringify(validate?.errors)).toBe(true);
    expect(validate?.({ ...body, typo: true })).toBe(false);
    expect(validate?.({ ...body, knobs: { 'KNOB-7x': 'a' } })).toBe(false);
  });
});
