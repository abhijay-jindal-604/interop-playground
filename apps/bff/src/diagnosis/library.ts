/**
 * Fingerprint library loader (plan/09 A2, plan/10 §1.1): reads every `fingerprints/FP-<n>.json`,
 * applies the startup validator of `validate/` plus the predicate schema below, and returns the
 * typed library sorted by id. A malformed file is an error (the BFF refuses to start, plan/12 T-07);
 * `knobs.json` is ignored here (the knob catalogue is `KNOB_CATALOG`, ADR-72).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { knobEntry } from '@interop-playground/adapters';
import { validateFingerprint } from '../validate/index.js';
import type { Fingerprint } from './types.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v !== '';

const PRED_FIELDS: Record<string, { required: string[]; optional: string[] }> = {
  exchange: {
    required: ['counterpart'],
    optional: ['method', 'pathGlob', 'status', 'present', 'bodyPath', 'op', 'value'],
  },
  'engine.call': { required: ['engine', 'op', 'result'], optional: [] },
  'engine.exception': { required: ['engine', 'messageContains'], optional: ['exceptionClass'] },
  check: { required: ['checkId', 'outcome'], optional: ['code', 'messageContains'] },
  artifact: { required: ['kind', 'path', 'op'], optional: ['value'] },
  env: { required: ['probe', 'op'], optional: ['value'] },
  manual: { required: ['step', 'shown'], optional: [] },
};
const ARTIFACT_KINDS = [
  'credential',
  'credential-header',
  'mdoc-cbor',
  'x509-leaf',
  'did-document',
  'request-object',
  'token',
];
const VALUE_OPS = ['eq', 'contains', 'regex', 'count-eq', 'equals-path', 'differs-from-path'];

/** Checks one fingerprint predicate against the field set its kind allows. */
export function validatePredicate(p: unknown, at: string): string[] {
  if (!isObj(p) || typeof p.on !== 'string') return [`${at}: must be an object with "on"`];
  const shape = PRED_FIELDS[p.on];
  if (!shape) return [`${at}.on: unknown predicate kind ${String(p.on)}`];
  const errs: string[] = [];
  for (const k of Object.keys(p))
    if (k !== 'on' && !shape.required.includes(k) && !shape.optional.includes(k))
      errs.push(`${at}.${k}: unknown field`);
  for (const k of shape.required) if (!(k in p)) errs.push(`${at}.${k}: missing`);
  if (p.on === 'check' && p.outcome !== 'pass' && p.outcome !== 'fail')
    errs.push(`${at}.outcome: pass or fail`);
  if (p.on === 'engine.call' && p.result !== 'ok' && p.result !== 'error')
    errs.push(`${at}.result: ok or error`);
  if (p.on === 'artifact') {
    if (!ARTIFACT_KINDS.includes(String(p.kind))) errs.push(`${at}.kind: unknown artifact kind`);
    if (typeof p.op === 'string' && VALUE_OPS.includes(p.op) && !isStr(p.value))
      errs.push(`${at}.value: required for op ${p.op}`);
  }
  if (p.on === 'exchange') {
    if ('status' in p && !Number.isInteger(p.status)) errs.push(`${at}.status: integer`);
    if ('op' in p && !('bodyPath' in p)) errs.push(`${at}.bodyPath: required with op`);
    if (typeof p.op === 'string' && ['eq', 'contains', 'regex'].includes(p.op) && !isStr(p.value))
      errs.push(`${at}.value: required for op ${p.op}`);
  }
  if (p.op === 'regex' && isStr(p.value))
    try {
      new RegExp(p.value);
    } catch {
      errs.push(`${at}.value: invalid regex`);
    }
  return errs;
}

/** the full A2 check: the startup validator, predicates, scope lists and the fix knob */
export function checkFingerprint(fp: unknown, fileName: string): string[] {
  const errs = validateFingerprint(fp, fileName);
  if (errs.length > 0 || !isObj(fp)) return errs;
  (fp.match as unknown[][]).forEach((rule, i) => {
    if (rule.length === 0) errs.push(`$.match[${i}]: a rule needs at least one predicate`);
    rule.forEach((p, j) => errs.push(...validatePredicate(p, `$.match[${i}][${j}]`)));
  });
  const scope = fp.scope as Obj;
  for (const [k, v] of Object.entries(scope))
    if (!Array.isArray(v) || !v.every(isStr)) errs.push(`$.scope.${k}: array of strings`);
  if (fp.fix !== null) {
    const fix = fp.fix as Obj;
    const knob = isObj(fix) && isStr(fix.knobId) ? knobEntry(fix.knobId) : undefined;
    if (!knob) errs.push('$.fix.knobId: unknown knob');
    else if (
      !knob.def.values.includes(String(fix.from)) ||
      !knob.def.values.includes(String(fix.to))
    )
      errs.push(`$.fix: from/to must be values of ${knob.def.id}`);
  }
  const ev = fp.evidence as Obj;
  if (!Array.isArray(ev.sIds) || !ev.sIds.every((s) => /^S-\d{3}[a-z]?$/.test(String(s))))
    errs.push('$.evidence.sIds: S-xxx ids');
  return errs;
}

export interface LibraryLoad {
  fingerprints: Fingerprint[];
  errors: { file: string; errors: string[] }[];
}

/** Reads every fingerprint file in `dir`, collecting errors instead of stopping at the first. */
export function readLibrary(dir: string): LibraryLoad {
  const out: LibraryLoad = { fingerprints: [], errors: [] };
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort()) {
    if (!/^FP-\d+\.json$/.test(f)) continue;
    const file = path.join(dir, f);
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    } catch (e) {
      out.errors.push({ file, errors: [`cannot read: ${(e as Error).message}`] });
      continue;
    }
    const errs = checkFingerprint(data, f);
    if (errs.length > 0) out.errors.push({ file, errors: errs });
    else out.fingerprints.push(data as Fingerprint);
  }
  out.fingerprints.sort((a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3)));
  return out;
}

/** Thrown when the fingerprint library has any invalid file. */
export class LibraryError extends Error {
  constructor(readonly problems: LibraryLoad['errors']) {
    super(
      'fingerprint library invalid:\n' +
        problems.map((p) => `  ${p.file}: ${p.errors.join('; ')}`).join('\n'),
    );
    this.name = 'LibraryError';
  }
}

/** throws `LibraryError` on any malformed file */
export function loadLibrary(dir: string): Fingerprint[] {
  const r = readLibrary(dir);
  if (r.errors.length > 0) throw new LibraryError(r.errors);
  return r.fingerprints;
}
