/**
 * Golden-test runner over `fixtures/golden/manifest.json` (plan/11 §2 fixture handling, §3.2): checks
 * that every listed file exists with its sha256, that no file is unlisted, then hands each entry to
 * the registered checks whose pattern matches (judge / fingerprint / report suites plug in here).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { GOLDEN_DIR } from '../paths.js';

export interface GoldenEntry {
  file: string;
  sids: string[];
  sha256: string;
}
export interface GoldenManifest {
  note?: string;
  files: GoldenEntry[];
}

export interface GoldenCheck {
  name: string;
  /** matched against the manifest-relative path */
  match: RegExp;
  /** throw (or return a message) to fail */
  run: (entry: GoldenEntry, bytes: Buffer) => void | string;
}

export interface GoldenReport {
  checked: number;
  missing: string[];
  changed: string[];
  unlisted: string[];
  badSids: string[];
  failures: { file: string; check: string; message: string }[];
  ok: boolean;
}

const SELF = new Set(['manifest.json', 'make-manifest.mjs']);

function walk(dir: string, root: string = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, root));
    else out.push(path.relative(root, p).split(path.sep).join('/'));
  }
  return out;
}

export function readManifest(dir: string = GOLDEN_DIR): GoldenManifest {
  return JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as GoldenManifest;
}

export function runGolden(
  checks: readonly GoldenCheck[] = [],
  dir: string = GOLDEN_DIR,
): GoldenReport {
  const manifest = readManifest(dir);
  const report: GoldenReport = {
    checked: 0,
    missing: [],
    changed: [],
    unlisted: [],
    badSids: [],
    failures: [],
    ok: false,
  };
  const listed = new Set(manifest.files.map((f) => f.file));
  for (const entry of manifest.files) {
    const p = path.join(dir, entry.file);
    if (!existsSync(p)) {
      report.missing.push(entry.file);
      continue;
    }
    if (entry.sids.length === 0 || entry.sids.some((s) => !/^S-\d{3}[a-z]?$/.test(s)))
      report.badSids.push(entry.file);
    const bytes = readFileSync(p);
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      report.changed.push(entry.file);
      continue;
    }
    report.checked += 1;
    for (const check of checks) {
      if (!check.match.test(entry.file)) continue;
      try {
        const msg = check.run(entry, bytes);
        if (typeof msg === 'string')
          report.failures.push({ file: entry.file, check: check.name, message: msg });
      } catch (err) {
        report.failures.push({
          file: entry.file,
          check: check.name,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  for (const f of walk(dir)) if (!SELF.has(f) && !listed.has(f)) report.unlisted.push(f);
  report.ok =
    report.missing.length +
      report.changed.length +
      report.unlisted.length +
      report.badSids.length +
      report.failures.length ===
    0;
  return report;
}

/** the checks every golden file gets today: JSON files parse; traces are arrays of recorded exchanges */
export const BASE_GOLDEN_CHECKS: GoldenCheck[] = [
  {
    name: 'json.parses',
    match: /\.json$/,
    run: (_e, bytes) => {
      JSON.parse(bytes.toString('utf8'));
    },
  },
  {
    name: 'trace.shape',
    match: /^traces\/.*\.json$/,
    run: (e, bytes) => {
      const t = JSON.parse(bytes.toString('utf8')) as unknown;
      const list = Array.isArray(t) ? t : (t as { exchanges?: unknown[] }).exchanges;
      if (!Array.isArray(list) || list.length === 0) return `${e.file}: no recorded exchanges`;
      for (const x of list as Record<string, unknown>[]) {
        if (typeof x.method !== 'string' || typeof x.url !== 'string')
          return `${e.file}: an exchange without method/url`;
      }
      return undefined;
    },
  },
];
