#!/usr/bin/env node
/**
 * no-github-write (plan/10 §4.1 rule 3, ADR-38): nothing in the product writes to GitHub.
 * Scans apps/, packages/, scripts/ and .github/ for the forbidden patterns below.
 * The one allowed GitHub read is `gh run download` in nightly.yml (pinned by tests/repo).
 *
 * Usage: node scripts/lint-no-github-write.mjs [--root <dir>]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const rootArg = args.indexOf('--root');
const root =
  rootArg >= 0 && args[rootArg + 1]
    ? path.resolve(args[rootArg + 1])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SCAN_DIRS = ['apps', 'packages', 'scripts', '.github'];
const SELF = 'scripts/lint-no-github-write.mjs';
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'vendor']);
const TEXT_EXT = /\.(m?[jt]sx?|cjs|json|ya?ml|sh|md|html|css)$/;

/** [rule id, pattern]. Patterns are assembled from parts so this file does not match itself. */
const RULES = [
  ['github-api-host', new RegExp(['api', 'github', 'com'].join('\\.'), 'i')],
  ['octokit', new RegExp('octo' + 'kit', 'i')],
  ['gh-issue', new RegExp('\\bgh\\s+' + 'issue\\b')],
  ['gh-pr', new RegExp('\\bgh\\s+' + 'pr\\b')],
  [
    'gh-api-write',
    new RegExp('\\bgh\\s+api\\b[^\\n]*(-X|--method)\\s*=?\\s*[\'"]?(POST|PUT|PATCH|DELETE)', 'i'),
  ],
  ['permission-issues', new RegExp('^\\s*' + 'issues' + '\\s*:', 'm')],
  ['permission-pull-requests', new RegExp('^\\s*' + 'pull-requests' + '\\s*:', 'm')],
  ['repos-url', new RegExp('https?://[^\\s\'"]*/' + 'repos/', 'i')],
];

function walk(dir, acc) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(abs, acc);
    } else if (entry.isFile() && TEXT_EXT.test(entry.name)) {
      acc.push(abs);
    }
  }
  return acc;
}

const hits = [];
let scanned = 0;
for (const dir of SCAN_DIRS) {
  const abs = path.join(root, dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
  for (const file of walk(abs, [])) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (rel === SELF) continue;
    scanned += 1;
    const text = readFileSync(file, 'utf8');
    for (const [id, re] of RULES) {
      const m = re.exec(text);
      if (m) {
        const line = text.slice(0, m.index).split('\n').length;
        hits.push(`${rel}:${line}: ${id}`);
      }
    }
  }
}

if (hits.length > 0) {
  process.stderr.write(
    `no-github-write: ${hits.length} hit(s)\n${hits.map((h) => `  ${h}`).join('\n')}\n`,
  );
  process.exit(1);
}
process.stdout.write(`no-github-write: ${scanned} files clean\n`);
