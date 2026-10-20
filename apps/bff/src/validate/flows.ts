/**
 * Startup validator for `flows/FLOW-xx.json` (04 §10, API-72, 03 §3.1). Same structural rules as
 * `scripts/validate-flows.mjs` (CI): closed field sets, the plan/03 stepKey registries, lifelines,
 * message counts, unique ascending order, `extends` merge, target step in the merged list. The
 * per-flow step-table layout check stays CI-only (the script owns those tables).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FlowDefinition } from '@interop-playground/api';

const VCI = new Set([
  'vci.setup.variant',
  'vci.setup.config-read',
  'vci.offer.mint',
  'vci.offer.deliver',
  'vci.offer.fetch',
  'vci.txcode.obtain',
  'vci.metadata.issuer',
  'vci.metadata.as',
  'vci.authz.oauth-details',
  'vci.authz.send-otp',
  'vci.authz.authenticate',
  'vci.authz.code',
  'vci.web.login',
  'vci.web.catalog',
  'vci.web.authorize',
  'vci.web.otp',
  'vci.web.redirect',
  'vci.web.download',
  'vci.iae.request',
  'vci.iae.present',
  'vci.iae.response',
  'vci.token',
  'vci.nonce',
  'vci.proof.sign',
  'vci.credential',
  'vci.jwks.self',
  'vci.credential.inspect',
  'vci.issuer.did',
  'vci.engine.session',
  'vci.tunnel.require',
  'vci.wallet.observe',
  'vci.wallet.card.status',
  'vci.fixture.load',
]);
const VP = new Set([
  'vp.request.create',
  'vp.request.deliver',
  'vp.request.fetch',
  'vp.request.validate',
  'vp.credential.match',
  'vp.token.build',
  'vp.response.post',
  'vp.error.dispatch',
  'vp.response.redirect',
  'vp.result.poll',
  'vp.result.fetch',
  'vp.vc.verify',
  'vp.verdict.evaluate',
  'vp.wallet.observe',
  'vp.dcapi.probe',
  'vp.dcapi.request.create',
  'vp.dcapi.request.fetch',
  'vp.dcapi.invoke',
  'vp.dcapi.response.post',
  'vp.dcapi.holder',
]);
/** True for a step key the platform knows: a VCI or VP step, or a `vci.prereq.*` prerequisite step. */
export const isRegisteredStepKey = (k: string): boolean =>
  VCI.has(k) || VP.has(k) || /^vci\.prereq\.[a-z0-9][a-z0-9.-]*$/.test(k);

const APPLIES_TO_KEYS = [
  'adapters',
  'formats',
  'grants',
  'modes',
  'deliveries',
  'envs',
  'clientIdSchemes',
  'withTxCode',
  'withIae',
];
const BOOL_KEYS = new Set(['withTxCode', 'withIae']);
const KINDS = ['http', 'engine', 'ui', 'manual'];
const LIFELINES: Record<string, string[]> = {
  issuance: ['IUI', 'I', 'W', 'L'],
  presentation: ['VUI', 'V', 'W', 'L'],
};
const STEP_FIELDS = [
  'stepKey',
  'order',
  'from',
  'to',
  'label',
  'kind',
  'messages',
  'appliesTo',
  'skipReason',
  'after',
  'deprecated',
];
const STEP_REQUIRED = ['stepKey', 'order', 'from', 'to', 'label', 'kind', 'messages'];
const DEF_FIELDS = ['flowId', 'kind', 'title', 'targetStepKey', 'extends', 'lifelines', 'steps'];
const DEF_REQUIRED = ['flowId', 'kind', 'title', 'targetStepKey', 'lifelines', 'steps'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkKeys(
  v: unknown,
  allowed: string[],
  required: string[],
  at: string,
  errs: string[],
): v is Obj {
  if (!isObj(v)) {
    errs.push(`${at}: must be an object`);
    return false;
  }
  for (const k of Object.keys(v)) if (!allowed.includes(k)) errs.push(`${at}.${k}: unknown field`);
  for (const k of required) if (!(k in v)) errs.push(`${at}.${k}: missing`);
  return true;
}

function checkStep(s: unknown, i: number, kind: string, isExtends: boolean, errs: string[]): void {
  const at = `$.steps[${i}]`;
  if (!checkKeys(s, STEP_FIELDS, STEP_REQUIRED, at, errs)) return;
  const key = s.stepKey;
  if (typeof key !== 'string' || !isRegisteredStepKey(key))
    errs.push(`${at}.stepKey: "${String(key)}" is not in the plan/03 registries`);
  else if (kind === 'issuance' && !key.startsWith('vci.'))
    errs.push(`${at}.stepKey: issuance flow needs a vci.* key`);
  else if (kind === 'presentation' && !key.startsWith('vp.'))
    errs.push(`${at}.stepKey: presentation flow needs a vp.* key`);
  if (!Number.isInteger(s.order) || (s.order as number) < 1)
    errs.push(`${at}.order: must be an integer >= 1`);
  const ll = LIFELINES[kind] ?? [];
  for (const f of ['from', 'to'] as const)
    if (typeof s[f] !== 'string' || !ll.includes(s[f]))
      errs.push(`${at}.${f}: not a lifeline of a ${kind} flow`);
  if (typeof s.label !== 'string' || s.label === '') errs.push(`${at}.label: must be non-empty`);
  if (typeof s.kind !== 'string' || !KINDS.includes(s.kind))
    errs.push(`${at}.kind: must be one of ${KINDS.join('|')}`);
  else if (s.messages !== (s.kind === 'http' ? 2 : 1))
    errs.push(`${at}.messages: ${s.kind} step needs ${s.kind === 'http' ? 2 : 1}`);
  if (s.after !== undefined && (!isExtends || typeof s.after !== 'string'))
    errs.push(`${at}.after: only a string, only in an extends file`);
  if (s.appliesTo !== undefined) {
    if (!checkKeys(s.appliesTo, APPLIES_TO_KEYS, [], `${at}.appliesTo`, errs)) return;
    for (const [k, v] of Object.entries(s.appliesTo)) {
      if (BOOL_KEYS.has(k) ? typeof v !== 'boolean' : !Array.isArray(v) || v.length === 0)
        errs.push(`${at}.appliesTo.${k}: wrong type`);
    }
  }
}

function checkDefinition(def: unknown, file: string, errs: string[]): def is Obj {
  if (!checkKeys(def, DEF_FIELDS, DEF_REQUIRED, '$', errs)) return false;
  const name = path.basename(file, '.json');
  if (typeof def.flowId !== 'string' || !/^FLOW-\d+$/.test(def.flowId))
    errs.push('$.flowId: must look like FLOW-<n>');
  else if (def.flowId !== name) errs.push(`$.flowId: must equal the file name "${name}"`);
  const kind = typeof def.kind === 'string' ? def.kind : '';
  if (!(kind in LIFELINES)) errs.push('$.kind: must be issuance|presentation');
  if (typeof def.title !== 'string' || def.title === '') errs.push('$.title: must be non-empty');
  if (typeof def.targetStepKey !== 'string') errs.push('$.targetStepKey: must be a string');
  const ll = LIFELINES[kind];
  if (
    !Array.isArray(def.lifelines) ||
    (ll !== undefined && JSON.stringify(def.lifelines) !== JSON.stringify(ll))
  )
    errs.push(`$.lifelines: must be ${JSON.stringify(ll)}`);
  if (!Array.isArray(def.steps) || def.steps.length === 0) {
    errs.push('$.steps: must be a non-empty array');
    return false;
  }
  const isExtends = def.extends !== undefined;
  const steps = def.steps as unknown[];
  steps.forEach((s, i) => checkStep(s, i, kind, isExtends, errs));
  const seen = new Set<unknown>();
  let prev = 0;
  steps.forEach((s, i) => {
    if (!isObj(s)) return;
    if (seen.has(s.stepKey)) errs.push(`$.steps[${i}].stepKey: appears twice`);
    seen.add(s.stepKey);
    if (typeof s.order === 'number') {
      if (s.order <= prev) errs.push(`$.steps[${i}].order: not ascending`);
      prev = s.order;
    }
  });
  return true;
}

function readJson(file: string, errs: string[]): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (e) {
    errs.push(`cannot read: ${(e as Error).message}`);
    return null;
  }
}

/** Validates one flow file; returns its errors (empty = valid). */
export function validateFlowFile(file: string): string[] {
  const errs: string[] = [];
  const def = readJson(file, errs);
  if (def === null || !checkDefinition(def, file, errs) || errs.length > 0) return errs;
  let merged = def.steps as Obj[];
  if (typeof def.extends === 'string') {
    const baseFile = path.join(path.dirname(file), `${def.extends}.json`);
    if (!existsSync(baseFile)) return [`$.extends: base ${def.extends} not found`];
    const baseErrs: string[] = [];
    const base = readJson(baseFile, baseErrs);
    if (base === null || !checkDefinition(base, baseFile, baseErrs) || baseErrs.length > 0)
      return baseErrs.map((e) => `[base ${String(def.extends)}] ${e}`);
    if (base.extends !== undefined) return ['$.extends: a base file may not extend another file'];
    if (base.kind !== def.kind) errs.push(`$.kind: differs from base ${def.extends}`);
    merged = (base.steps as Obj[]).map((s) => ({ ...s }));
    for (const [i, s] of (def.steps as Obj[]).entries()) {
      const at = merged.findIndex((b) => b.stepKey === s.stepKey);
      if (at >= 0) {
        merged[at] = { ...s };
        continue;
      }
      const pos = merged.findIndex((b) => b.stepKey === s.after);
      if (pos < 0) errs.push(`$.steps[${i}]: not in the base and no valid "after"`);
      else merged.splice(pos + 1, 0, { ...s });
    }
  }
  if (!merged.some((s) => s.stepKey === def.targetStepKey))
    errs.push(`$.targetStepKey: "${String(def.targetStepKey)}" is not a step of the merged list`);
  return errs;
}

export interface FlowLoadResult {
  flows: Map<string, FlowDefinition>;
  errors: { file: string; errors: string[] }[];
}

/** Loads every `FLOW-<n>.json` of `dir` (a missing dir is an error: flows ship in the image). */
export function loadFlows(dir: string): FlowLoadResult {
  const flows = new Map<string, FlowDefinition>();
  const errors: FlowLoadResult['errors'] = [];
  if (!existsSync(dir)) return { flows, errors: [{ file: dir, errors: ['flows dir missing'] }] };
  const files = readdirSync(dir)
    .filter((f) => /^FLOW-\d+\.json$/.test(f))
    .sort();
  for (const f of files) {
    const file = path.join(dir, f);
    const errs = validateFlowFile(file);
    if (errs.length > 0) errors.push({ file, errors: errs });
    else
      flows.set(
        path.basename(f, '.json'),
        JSON.parse(readFileSync(file, 'utf8')) as FlowDefinition,
      );
  }
  if (files.length === 0) errors.push({ file: dir, errors: ['no FLOW-<n>.json files'] });
  return { flows, errors };
}
