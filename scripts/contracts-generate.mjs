#!/usr/bin/env node
/**
 * contracts:generate (plan/10 §5, 04 §11).
 *   packages/api/src/api.ts  --typescript-json-schema-->  packages/api/api.schema.json
 *   packages/api/openapi.base.yaml + api.schema.json  -->  packages/api/openapi.yaml
 *   packages/api/openapi.yaml  --openapi-typescript-->    packages/api/src/client.gen.ts
 * Fails when a 04 §3 type has no schema, when a route of 04 §2 (packages/api/src/routes.ts) has no
 * path, or when an event type of 04 §7.2 has no schema. Output is deterministic (sorted keys).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as TJS from 'typescript-json-schema';
import YAML from 'yaml';
import openapiTS, { astToString } from 'openapi-typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = path.join(root, 'packages/api');
const apiFile = path.join(apiDir, 'src/api.ts');
const OUT_SCHEMA = path.join(apiDir, 'api.schema.json');
const OUT_OPENAPI = path.join(apiDir, 'openapi.yaml');
const OUT_CLIENT = path.join(apiDir, 'src/client.gen.ts');

const { SCHEMA_TYPE_NAMES: REQUIRED_TYPES } = await import(
  pathToFileURL(path.join(apiDir, 'src/schema-types.ts')).href
);

const COMPONENT_KEY = /^[a-zA-Z0-9.\-_]+$/;

/**
 * Shapes typescript-json-schema cannot derive (template-literal record keys, labelled tuples) and the
 * id patterns of 04 §11 (`components.schemas`); everything else comes from the TypeScript.
 */
const SCHEMA_OVERRIDES = {
  KnobValues: {
    type: 'object',
    description: 'Every knob of every chosen adapter, explicit (04 §11 KnobValues).',
    propertyNames: { pattern: '^KNOB-[0-9]{2}$' },
    additionalProperties: { type: 'string' },
  },
  Headers: {
    type: 'array',
    description: 'Header list, order and duplicates preserved; each entry is [name, value].',
    items: {
      type: 'array',
      items: [{ type: 'string' }, { type: 'string' }],
      minItems: 2,
      maxItems: 2,
    },
  },
  KnobId: { type: 'string', pattern: '^KNOB-[0-9]{2}$' },
  TmpId: { type: 'string', pattern: '^TMP-[0-9]{2}$' },
  FlowId: { type: 'string', pattern: '^FLOW-[0-9]{2}$' },
  FingerprintId: { type: 'string', pattern: '^FP-[0-9]{2}$' },
  Ulid: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
  Iso: { type: 'string', format: 'date-time' },
};

function fail(message) {
  process.stderr.write(`contracts:generate: ${message}\n`);
  process.exit(1);
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

function rewriteRefs(value, from, to) {
  if (Array.isArray(value)) return value.map((v) => rewriteRefs(v, from, to));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (key === '$ref' && typeof v === 'string' && v.startsWith(from)) {
        out[key] = to + v.slice(from.length);
      } else {
        out[key] = rewriteRefs(v, from, to);
      }
    }
    return out;
  }
  return value;
}

function collectRefs(value, acc = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => collectRefs(v, acc));
  else if (value !== null && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (key === '$ref' && typeof v === 'string') acc.add(v);
      else collectRefs(v, acc);
    }
  }
  return acc;
}

// ---------- 1. JSON Schema from api.ts ----------
function generateJsonSchema() {
  const compilerOptions = {
    strict: true,
    target: 'ES2023',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    skipLibCheck: true,
    types: ['node'],
  };
  const program = TJS.getProgramFromFiles([apiFile], compilerOptions, root);
  const generator = TJS.buildGenerator(program, {
    required: true,
    noExtraProps: true,
    strictNullChecks: true,
    ref: true,
    aliasRef: true,
    topRef: false,
    titles: false,
    constAsEnum: false,
    uniqueNames: false,
    ignoreErrors: false,
  });
  if (generator === null) fail('typescript-json-schema could not build a generator (type errors?)');
  const userSymbols = new Set(generator.getUserSymbols());
  const missing = REQUIRED_TYPES.filter((name) => !userSymbols.has(name));
  if (missing.length > 0) fail(`types named in 04 §3 are not declared: ${missing.join(', ')}`);
  const schema = generator.getSchemaForSymbols(REQUIRED_TYPES, true);
  const definitions = schema.definitions ?? {};
  const noSchema = REQUIRED_TYPES.filter((name) => definitions[name] === undefined);
  if (noSchema.length > 0) fail(`no schema generated for: ${noSchema.join(', ')}`);
  return definitions;
}

/** typescript-json-schema names some anonymous/generic types with characters OpenAPI rejects. */
function sanitizeDefinitionNames(definitions) {
  const renames = new Map();
  for (const name of Object.keys(definitions)) {
    if (!COMPONENT_KEY.test(name)) {
      renames.set(name, name.replace(/[^a-zA-Z0-9.\-_]/g, '_'));
    }
  }
  if (renames.size === 0) return definitions;
  let text = JSON.stringify(definitions);
  for (const [from, to] of renames) {
    const encodedFrom = JSON.stringify(`#/definitions/${encodeURIComponent(from)}`);
    const plainFrom = JSON.stringify(`#/definitions/${from}`);
    const target = JSON.stringify(`#/definitions/${to}`);
    text = text.split(encodedFrom).join(target).split(plainFrom).join(target);
  }
  const out = JSON.parse(text);
  for (const [from, to] of renames) {
    out[to] = out[from];
    delete out[from];
  }
  return out;
}

/**
 * typescript-json-schema emits helper definitions for anonymous and utility types (`__type_3`,
 * `Pick_1`, `Record_2`, `AdapterId_1` duplicates of a named type). Keep only the named types of
 * REQUIRED_TYPES: duplicates are pointed at their named twin, every other helper is inlined.
 */
function normaliseDefinitions(definitions) {
  const named = new Set(REQUIRED_TYPES);
  const defs = structuredClone(definitions);
  const replacement = new Map();
  for (const name of Object.keys(defs)) {
    if (named.has(name)) continue;
    const twin = name.startsWith('EventEnvelope') ? 'EventEnvelope' : /^(.*)_\d+$/.exec(name)?.[1];
    if (twin !== undefined && (named.has(twin) || twin === 'EventEnvelope')) {
      replacement.set(name, { $ref: `#/definitions/${twin}` });
    } else {
      replacement.set(name, defs[name]);
    }
  }
  const resolve = (value, depth) => {
    if (depth > 50) fail('recursive helper definition; give it a name in api.ts');
    if (Array.isArray(value)) return value.map((v) => resolve(v, depth));
    if (value !== null && typeof value === 'object') {
      if (typeof value.$ref === 'string' && value.$ref.startsWith('#/definitions/')) {
        const target = decodeURIComponent(value.$ref.slice('#/definitions/'.length));
        if (replacement.has(target)) {
          const rest = { ...value };
          delete rest.$ref;
          const inlined = resolve(replacement.get(target), depth + 1);
          return Object.keys(rest).length === 0 ? inlined : { ...rest, ...inlined };
        }
        return value;
      }
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = resolve(v, depth);
      return out;
    }
    return value;
  };
  const out = {};
  for (const name of named) {
    if (defs[name] !== undefined) out[name] = resolve(defs[name], 0);
  }
  return out;
}

/** Template-literal ids are inlined by the generator as `^PREFIX-.*$`; point them at the named id type. */
const INLINE_ID_PATTERNS = {
  '^KNOB-.*$': 'KnobId',
  '^TMP-.*$': 'TmpId',
  '^FLOW-.*$': 'FlowId',
  '^FP-.*$': 'FingerprintId',
};

function applyOverrides(definitions) {
  const walk = (value, owner) => {
    if (Array.isArray(value)) return value.map((v) => walk(v, owner));
    if (value !== null && typeof value === 'object') {
      const keys = Object.keys(value).filter((k) => k !== 'description');
      if (
        value.type === 'string' &&
        typeof value.pattern === 'string' &&
        keys.length === 2 &&
        INLINE_ID_PATTERNS[value.pattern] !== undefined &&
        INLINE_ID_PATTERNS[value.pattern] !== owner
      ) {
        return withDescription(
          { $ref: `#/definitions/${INLINE_ID_PATTERNS[value.pattern]}` },
          value,
        );
      }
      if (value.type === 'object' && value.additionalProperties === false && keys.length === 2) {
        // Record<KnobId, string> (KnobValues, Partial<KnobValues>) has no derivable properties.
        return withDescription({ $ref: '#/definitions/KnobValues' }, value);
      }
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, owner);
      return out;
    }
    return value;
  };
  const out = {};
  for (const [name, def] of Object.entries(definitions)) out[name] = walk(def, name);
  for (const [name, override] of Object.entries(SCHEMA_OVERRIDES)) {
    out[name] = withDescription(override, definitions[name] ?? {});
  }
  return out;
}

function withDescription(schema, source) {
  return typeof source.description === 'string' && schema.description === undefined
    ? { description: source.description, ...schema }
    : schema;
}

// ---------- 2. Per-event envelope schemas (04 §7.2) ----------
function eventSchemas(definitions, eventTypes) {
  const payloadMap = definitions.PayloadMap;
  if (payloadMap === undefined || typeof payloadMap !== 'object' || !payloadMap.properties) {
    fail('PayloadMap has no schema');
  }
  const out = {};
  for (const type of eventTypes) {
    const payload = payloadMap.properties[type];
    if (payload === undefined) fail(`event type ${type} has no payload schema`);
    out[`Event.${type}`] = {
      type: 'object',
      additionalProperties: false,
      required: ['v', 'runId', 'seq', 'ts', 'type', 'payload'],
      properties: {
        v: { const: 1 },
        runId: { $ref: '#/definitions/StreamId' },
        seq: { type: 'integer', minimum: 1 },
        ts: { $ref: '#/definitions/Iso' },
        type: { const: type },
        stepKey: { type: 'string' },
        payload,
      },
    };
  }
  out.AnyEvent = { oneOf: eventTypes.map((t) => ({ $ref: `#/definitions/Event.${t}` })) };
  return out;
}

/** OpenAPI 3.1 uses JSON Schema 2020-12: draft-07 tuple `items: [...]` becomes `prefixItems`. */
function toJsonSchema2020(value) {
  if (Array.isArray(value)) return value.map(toJsonSchema2020);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'items' && Array.isArray(v)) out.prefixItems = v.map(toJsonSchema2020);
      else if (k === 'additionalItems') out.items = toJsonSchema2020(v);
      else out[k] = toJsonSchema2020(v);
    }
    return out;
  }
  return value;
}

async function main() {
  const check = process.argv.includes('--check-only');
  const apiModule = await import(pathToFileURL(path.join(apiDir, 'src/api.ts')).href);
  const routesModule = await import(pathToFileURL(path.join(apiDir, 'src/routes.ts')).href);
  const eventTypes = [...apiModule.EVENT_TYPES];

  let definitions = applyOverrides(normaliseDefinitions(generateJsonSchema()));
  // EventEnvelope is generic in api.ts; its wire schema is the union of the per-type envelopes.
  definitions.EventEnvelope = { $ref: '#/definitions/AnyEvent' };
  definitions = sanitizeDefinitionNames(definitions);
  definitions = { ...definitions, ...eventSchemas(definitions, eventTypes) };
  definitions = sortKeysDeep(definitions);

  const jsonSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $comment:
      'GENERATED by scripts/contracts-generate.mjs from packages/api/src/api.ts; do not edit.',
    definitions,
  };

  // ---------- 3. openapi.yaml ----------
  const base = YAML.parse(readFileSync(path.join(apiDir, 'openapi.base.yaml'), 'utf8'));
  const components = { ...(base.components ?? {}) };
  components.schemas = toJsonSchema2020(
    rewriteRefs(definitions, '#/definitions/', '#/components/schemas/'),
  );
  const openapi = { ...base, components };

  const refs = collectRefs(openapi);
  for (const ref of refs) {
    const m = /^#\/components\/(schemas|parameters|responses|requestBodies)\/(.+)$/.exec(ref);
    if (m === null) fail(`unexpected $ref ${ref}`);
    if (components[m[1]]?.[decodeURIComponent(m[2])] === undefined) fail(`unresolved $ref ${ref}`);
  }
  for (const route of routesModule.ROUTES) {
    const op = openapi.paths?.[route.path]?.[route.method.toLowerCase()];
    if (op === undefined) fail(`route ${route.apiId} ${route.method} ${route.path} has no path`);
    if (op['x-api-id'] !== route.apiId) {
      fail(
        `route ${route.method} ${route.path} has x-api-id ${op['x-api-id']}, expected ${route.apiId}`,
      );
    }
  }

  const header =
    '# GENERATED by scripts/contracts-generate.mjs from packages/api/openapi.base.yaml and\n' +
    '# packages/api/src/api.ts (plan/04-api-contracts.md §11); do not edit.\n';
  const openapiText =
    header + YAML.stringify(openapi, { lineWidth: 0, aliasDuplicateObjects: false });

  // ---------- 4. client.gen.ts ----------
  const ast = await openapiTS(YAML.parse(openapiText), { alphabetize: true });
  const clientText =
    '/* eslint-disable */\n' +
    '// GENERATED by scripts/contracts-generate.mjs (openapi-typescript) from packages/api/openapi.yaml; do not edit.\n' +
    astToString(ast);

  const schemaText = JSON.stringify(jsonSchema, null, 2) + '\n';
  if (check) {
    const same =
      readFileSync(OUT_SCHEMA, 'utf8') === schemaText &&
      readFileSync(OUT_OPENAPI, 'utf8') === openapiText &&
      readFileSync(OUT_CLIENT, 'utf8') === clientText;
    if (!same) fail('generated files are stale; run npm run contracts:generate');
    return;
  }
  writeFileSync(OUT_SCHEMA, schemaText);
  writeFileSync(OUT_OPENAPI, openapiText);
  writeFileSync(OUT_CLIENT, clientText);
  process.stdout.write(
    `contracts:generate: ${Object.keys(definitions).length} schemas, ${Object.keys(openapi.paths).length} paths\n`,
  );
}

await main();
