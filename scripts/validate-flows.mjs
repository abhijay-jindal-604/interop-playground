#!/usr/bin/env node
// Validates flow definition files against plan/04 section 10 and the stepKey registries
// of plan/03 section 1.15 (vci.*) and section 2.0 (vp.*). Plain Node ESM, no dependencies.
// Usage: node scripts/validate-flows.mjs [file.json ...]   (default: flows/*.json next to this script's repo root)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// plan/03 section 1.15 (issuance); `vci.prereq.<suffix>` is matched by pattern below.
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
// plan/03 section 2.0 (presentation): the 20 shared keys.
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
const isRegistered = (k) => VCI.has(k) || VP.has(k) || /^vci\.prereq\.[a-z0-9][a-z0-9.-]*$/.test(k);

// Closed vocabularies (plan/02 section 5.2, plan/04 section 3.1).
const ENUMS = {
  adapters: [
    'issuer.certify-preauth',
    'issuer.certify-authcode',
    'issuer.certify-mdoc',
    'issuer.certify-collab',
    'issuer.waltid',
    'issuer.fixture',
    'wallet.playground-ts',
    'wallet.inji-jvm',
    'wallet.inji-web',
    'wallet.inji-mobile',
    'wallet.credo',
    'verifier.inji-verify-local',
    'verifier.inji-verify-collab',
    'verifier.inji-verify-sdk',
    'verifier.vcverifier-offline',
    'verifier.waltid',
    'verifier.eudi',
    'verifier.credo',
  ],
  formats: ['ldp_vc', 'dc+sd-jwt', 'mso_mdoc', 'jwt_vc_json'],
  grants: ['pre-authorized_code', 'authorization_code'],
  modes: ['cross-device', 'same-device', 'dc-api'],
  deliveries: ['qr', 'deep-link', 'web-wallet-redirect', 'adb-intent', 'in-process'],
  envs: ['local', 'collab'],
  clientIdSchemes: ['plain', 'decentralized_identifier', 'x509_san_dns', 'redirect_uri'],
};
const BOOLS = ['withTxCode', 'withIae'];
const KINDS = ['http', 'engine', 'ui', 'manual'];
const LIFELINES = { issuance: ['IUI', 'I', 'W', 'L'], presentation: ['VUI', 'V', 'W', 'L'] };

// Message layout (stepKey per step, in order, with its message count) read off the plan/03 step tables.
// FLOW-01: 03 FLOW-01 step table (11 keys). FLOW-04 is a delta of FLOW-01 and keeps the layout.
// FLOW-30: 03 section 3.3 (all 20 shared vp.* keys, skipped rows included, ADR-29).
const FLOW01 = [
  ['vci.setup.variant', 2],
  ['vci.setup.config-read', 2],
  ['vci.offer.mint', 2],
  ['vci.offer.fetch', 2],
  ['vci.metadata.issuer', 2],
  ['vci.metadata.as', 2],
  ['vci.token', 2],
  ['vci.nonce', 2],
  ['vci.proof.sign', 1],
  ['vci.credential', 2],
  ['vci.credential.inspect', 1],
];
const FLOW30 = [
  ['vp.request.create', 2],
  ['vp.request.deliver', 1],
  ['vp.request.fetch', 2],
  ['vp.request.validate', 1],
  ['vp.credential.match', 1],
  ['vp.token.build', 1],
  ['vp.response.post', 2],
  ['vp.error.dispatch', 2],
  ['vp.response.redirect', 1],
  ['vp.result.poll', 2],
  ['vp.result.fetch', 2],
  ['vp.vc.verify', 2],
  ['vp.verdict.evaluate', 1],
  ['vp.wallet.observe', 1],
  ['vp.dcapi.probe', 1],
  ['vp.dcapi.request.create', 2],
  ['vp.dcapi.request.fetch', 2],
  ['vp.dcapi.invoke', 1],
  ['vp.dcapi.response.post', 2],
  ['vp.dcapi.holder', 1],
];
// FLOW-08: 03 FLOW-08 step table (9 keys; no variant/config-read, offer fetch skipped by value).
const FLOW08 = FLOW01.filter(([k]) => k !== 'vci.setup.variant' && k !== 'vci.setup.config-read');
// FLOW-14: 03 FLOW-14 (one engine step, no exchanges). FLOW-40: 03 FLOW-40 step table (the two
// steps that replace section 2.0's chain; every other vp.* key is skipped "credential-level adapter").
const FLOW14 = [['vci.fixture.load', 1]];
const FLOW40 = [
  ['vp.vc.verify', 2],
  ['vp.verdict.evaluate', 1],
];
const EXPECTED = {
  'FLOW-01': FLOW01,
  // FLOW-03 (T-46): FLOW-01 + the issuer DID resolution step (ADR-96); FLOW-31 keeps the FLOW-30 layout
  'FLOW-03': [...FLOW01, ['vci.issuer.did', 2]],
  'FLOW-04': FLOW01,
  'FLOW-08': FLOW08,
  'FLOW-14': FLOW14,
  'FLOW-30': FLOW30,
  'FLOW-31': FLOW30,
  'FLOW-40': FLOW40,
};

const messageIndex = (steps) => steps.flatMap((s) => Array(s.messages).fill(s.stepKey));

function checkKeys(obj, allowed, required, path, errs) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    errs.push(`${path}: must be an object`);
    return false;
  }
  for (const k of Object.keys(obj))
    if (!allowed.includes(k)) errs.push(`${path}.${k}: unknown field`);
  for (const k of required) if (!(k in obj)) errs.push(`${path}.${k}: missing`);
  return true;
}

function checkStep(s, i, def, isExtends, errs) {
  const p = `$.steps[${i}]`;
  if (
    !checkKeys(
      s,
      [
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
      ],
      ['stepKey', 'order', 'from', 'to', 'label', 'kind', 'messages'],
      p,
      errs,
    )
  )
    return;
  if (typeof s.stepKey !== 'string' || !isRegistered(s.stepKey))
    errs.push(`${p}.stepKey: "${s.stepKey}" is not in the plan/03 registries`);
  else if (def.kind === 'issuance' && !s.stepKey.startsWith('vci.'))
    errs.push(`${p}.stepKey: issuance flow needs a vci.* key`);
  else if (def.kind === 'presentation' && !s.stepKey.startsWith('vp.'))
    errs.push(`${p}.stepKey: presentation flow needs a vp.* key`);
  if (!Number.isInteger(s.order) || s.order < 1) errs.push(`${p}.order: must be an integer >= 1`);
  const ll = LIFELINES[def.kind] ?? [];
  for (const f of ['from', 'to'])
    if (!ll.includes(s[f]))
      errs.push(`${p}.${f}: "${s[f]}" is not a lifeline of a ${def.kind} flow (${ll.join(',')})`);
  if (typeof s.label !== 'string' || s.label.length === 0)
    errs.push(`${p}.label: must be a non-empty string`);
  if (!KINDS.includes(s.kind)) errs.push(`${p}.kind: must be one of ${KINDS.join('|')}`);
  else if (s.messages !== (s.kind === 'http' ? 2 : 1))
    errs.push(
      `${p}.messages: ${s.kind} step needs ${s.kind === 'http' ? 2 : 1}, got ${s.messages}`,
    );
  if (s.skipReason !== undefined && typeof s.skipReason !== 'string')
    errs.push(`${p}.skipReason: must be a string`);
  if (s.deprecated !== undefined && typeof s.deprecated !== 'boolean')
    errs.push(`${p}.deprecated: must be a boolean`);
  if (s.after !== undefined) {
    if (!isExtends) errs.push(`${p}.after: only allowed in an extends file`);
    else if (typeof s.after !== 'string') errs.push(`${p}.after: must be a string`);
  }
  if (s.appliesTo !== undefined) {
    const ap = `${p}.appliesTo`;
    if (!checkKeys(s.appliesTo, [...Object.keys(ENUMS), ...BOOLS], [], ap, errs)) return;
    for (const [k, v] of Object.entries(s.appliesTo)) {
      if (BOOLS.includes(k)) {
        if (typeof v !== 'boolean') errs.push(`${ap}.${k}: must be a boolean`);
        continue;
      }
      if (!Array.isArray(v) || v.length === 0) {
        errs.push(`${ap}.${k}: must be a non-empty array`);
        continue;
      }
      for (const x of v)
        if (!ENUMS[k]?.includes(x)) errs.push(`${ap}.${k}: "${x}" is not a valid value`);
    }
  }
}

function checkDefinition(def, file, isExtends, errs) {
  if (
    !checkKeys(
      def,
      ['flowId', 'kind', 'title', 'targetStepKey', 'extends', 'lifelines', 'steps'],
      ['flowId', 'kind', 'title', 'targetStepKey', 'lifelines', 'steps'],
      '$',
      errs,
    )
  )
    return;
  if (typeof def.flowId !== 'string' || !/^FLOW-\d+$/.test(def.flowId))
    errs.push('$.flowId: must look like FLOW-<n>');
  else if (def.flowId !== basename(file, '.json'))
    errs.push(`$.flowId: "${def.flowId}" must equal the file name "${basename(file, '.json')}"`);
  if (!['issuance', 'presentation'].includes(def.kind))
    errs.push('$.kind: must be issuance|presentation');
  else if (typeof def.flowId === 'string') {
    const n = Number(def.flowId.slice(5));
    const want = n <= 14 ? 'issuance' : 'presentation';
    if (def.kind !== want) errs.push(`$.kind: ${def.flowId} is a ${want} flow`);
  }
  if (typeof def.title !== 'string' || !def.title) errs.push('$.title: must be a non-empty string');
  if (typeof def.targetStepKey !== 'string') errs.push('$.targetStepKey: must be a string');
  if (
    def.extends !== undefined &&
    (typeof def.extends !== 'string' || !/^FLOW-\d+$/.test(def.extends))
  )
    errs.push('$.extends: must be a FlowId');
  const ll = LIFELINES[def.kind];
  if (
    !Array.isArray(def.lifelines) ||
    (ll && (def.lifelines.length !== ll.length || def.lifelines.some((x, i) => x !== ll[i])))
  ) {
    errs.push(`$.lifelines: must be ${JSON.stringify(ll)}`);
  }
  if (!Array.isArray(def.steps) || def.steps.length === 0) {
    errs.push('$.steps: must be a non-empty array');
    return;
  }
  def.steps.forEach((s, i) => checkStep(s, i, def, isExtends, errs));
  // rule 2: every stepKey once per file; order unique and ascending
  const seen = new Set();
  let prev = 0;
  def.steps.forEach((s, i) => {
    if (seen.has(s?.stepKey)) errs.push(`$.steps[${i}].stepKey: "${s.stepKey}" appears twice`);
    seen.add(s?.stepKey);
    if (Number.isInteger(s?.order)) {
      if (s.order <= prev)
        errs.push(`$.steps[${i}].order: ${s.order} is not above the previous order ${prev}`);
      prev = s.order;
    }
  });
}

// Merge an extends file onto its base: replace by stepKey, insert new keys after `after`.
function merge(base, delta, errs) {
  const out = base.steps.map((s) => ({ ...s }));
  for (const [i, s] of delta.steps.entries()) {
    const at = out.findIndex((b) => b.stepKey === s.stepKey);
    if (at >= 0) {
      out[at] = { ...s };
      continue;
    }
    if (!s.after) {
      errs.push(`$.steps[${i}]: "${s.stepKey}" is not in ${base.flowId} and has no "after"`);
      continue;
    }
    const pos = out.findIndex((b) => b.stepKey === s.after);
    if (pos < 0) {
      errs.push(`$.steps[${i}].after: "${s.after}" not found in the merged list`);
      continue;
    }
    out.splice(pos + 1, 0, { ...s });
  }
  return out;
}

function readJson(file, errs) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    errs.push(`cannot read ${file}: ${e.message}`);
    return null;
  }
}

function validateFile(file) {
  const errs = [];
  const def = readJson(file, errs);
  if (!def) return errs;
  const isExtends = def?.extends !== undefined;
  checkDefinition(def, file, isExtends, errs);
  if (errs.length) return errs;
  let merged = def.steps;
  if (isExtends) {
    const baseFile = join(dirname(file), `${def.extends}.json`);
    if (!existsSync(baseFile)) {
      errs.push(`$.extends: base file ${baseFile} not found`);
      return errs;
    }
    const base = readJson(baseFile, errs);
    if (!base) return errs;
    if (base.extends !== undefined) {
      errs.push('$.extends: a base file may not itself extend another file');
      return errs;
    }
    const baseErrs = [];
    checkDefinition(base, baseFile, false, baseErrs);
    if (baseErrs.length) {
      errs.push(...baseErrs.map((e) => `[base ${def.extends}] ${e}`));
      return errs;
    }
    if (base.kind !== def.kind) errs.push(`$.kind: differs from base ${def.extends}`);
    merged = merge(base, def, errs);
  }
  // rule 0: target step is a step of the merged list
  if (!merged.some((s) => s.stepKey === def.targetStepKey))
    errs.push(`$.targetStepKey: "${def.targetStepKey}" is not a step of the merged list`);
  // rule 4: message index -> stepKey equals the plan/03 step table
  const want = EXPECTED[def.flowId];
  if (want) {
    const wantIdx = want.flatMap(([k, n]) => Array(n).fill(k));
    const gotIdx = messageIndex(merged);
    if (gotIdx.length !== wantIdx.length)
      errs.push(`message count ${gotIdx.length} != ${wantIdx.length} in the plan/03 step table`);
    for (let i = 0; i < Math.min(gotIdx.length, wantIdx.length); i++) {
      if (gotIdx[i] !== wantIdx[i]) {
        errs.push(
          `message ${i + 1}: stepKey "${gotIdx[i]}" != "${wantIdx[i]}" of the plan/03 step table`,
        );
        break;
      }
    }
  } else errs.push(`no plan/03 step table is registered in this validator for ${def.flowId}`);
  return errs;
}

const args = process.argv.slice(2);
const files = args.length
  ? args
  : readdirSync(join(root, 'flows'))
      .filter((f) => /^FLOW-\d+\.json$/.test(f))
      .sort()
      .map((f) => join(root, 'flows', f));
let bad = 0;
for (const f of files) {
  const errs = validateFile(f);
  if (errs.length) {
    bad++;
    console.error(`FAIL ${f}`);
    for (const e of errs) console.error(`  ${e}`);
  } else console.log(`ok   ${f}`);
}
if (files.length === 0) {
  console.error('no flow files found');
  process.exit(1);
}
process.exit(bad ? 1 : 0);
