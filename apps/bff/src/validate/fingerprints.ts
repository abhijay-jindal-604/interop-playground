/**
 * Startup validator for `fingerprints/` (09 A2 `Fingerprint`, A4 `knobs.json`; plan/10 §1.1
 * maps `diagnosis/` to `fingerprints/`). The directory may be absent or empty until the
 * diagnosis tasks fill it; every file present must be well-formed.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

const FP_REQUIRED = [
  'id',
  'version',
  'gapIds',
  'title',
  'appliesWhen',
  'evidenceClass',
  'deviatingSide',
  'component',
  'specClause',
  'scope',
  'match',
  'evidence',
  'fix',
  'issue',
  'status',
];
const FP_OPTIONAL = ['stepKey', 'noFixReason'];
const ENUMS: Record<string, readonly string[]> = {
  appliesWhen: ['run-failed', 'always', 'environment'],
  evidenceClass: ['full', 'observed-only'],
  deviatingSide: ['issuer', 'wallet', 'verifier', 'issuer+verifier', 'environment', 'playground'],
  status: ['active', 'historical'],
};

export function validateFingerprint(fp: unknown, fileName: string): string[] {
  const errs: string[] = [];
  if (!isObj(fp)) return ['$: must be an object'];
  for (const k of Object.keys(fp))
    if (!FP_REQUIRED.includes(k) && !FP_OPTIONAL.includes(k)) errs.push(`$.${k}: unknown field`);
  for (const k of FP_REQUIRED) if (!(k in fp)) errs.push(`$.${k}: missing`);
  if (typeof fp.id !== 'string' || !/^FP-\d+$/.test(fp.id)) errs.push('$.id: must be FP-<n>');
  else if (`${fp.id}.json` !== fileName) errs.push(`$.id: must equal the file name ${fileName}`);
  if (!Number.isInteger(fp.version)) errs.push('$.version: must be an integer');
  if (!Array.isArray(fp.gapIds)) errs.push('$.gapIds: must be an array');
  if (typeof fp.title !== 'string' || fp.title === '') errs.push('$.title: must be non-empty');
  for (const [k, allowed] of Object.entries(ENUMS))
    if (k in fp && (typeof fp[k] !== 'string' || !allowed.includes(fp[k])))
      errs.push(`$.${k}: must be one of ${allowed.join('|')}`);
  if (!Array.isArray(fp.match) || fp.match.length === 0 || !fp.match.every(Array.isArray))
    errs.push('$.match: must be a non-empty array of predicate arrays');
  if ('fix' in fp && fp.fix === null && typeof fp.noFixReason !== 'string')
    errs.push('$.noFixReason: required when fix is null');
  if (!isObj(fp.scope)) errs.push('$.scope: must be an object');
  if (!isObj(fp.evidence)) errs.push('$.evidence: must be an object');
  return errs;
}

export function validateKnobs(k: unknown): string[] {
  const list = Array.isArray(k) ? k : isObj(k) && Array.isArray(k.knobs) ? k.knobs : null;
  if (list === null) return ['$: must be an array of knobs (or {knobs:[...]})'];
  const errs: string[] = [];
  list.forEach((knob: unknown, i) => {
    if (!isObj(knob) || typeof knob.id !== 'string' || !/^KNOB-\d+$/.test(knob.id))
      errs.push(`$[${i}].id: must be KNOB-<n>`);
  });
  return errs;
}

export interface FingerprintLoadResult {
  count: number;
  errors: { file: string; errors: string[] }[];
}

export function loadFingerprints(dir: string): FingerprintLoadResult {
  const errors: FingerprintLoadResult['errors'] = [];
  if (!existsSync(dir)) return { count: 0, errors };
  let count = 0;
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(dir, f);
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    } catch (e) {
      errors.push({ file, errors: [`cannot read: ${(e as Error).message}`] });
      continue;
    }
    const errs =
      f === 'knobs.json'
        ? validateKnobs(data)
        : /^FP-\d+\.json$/.test(f)
          ? validateFingerprint(data, f)
          : ['unexpected file name (FP-<n>.json or knobs.json)'];
    if (errs.length > 0) errors.push({ file, errors: errs });
    else if (f !== 'knobs.json') count++;
  }
  return { count, errors };
}
