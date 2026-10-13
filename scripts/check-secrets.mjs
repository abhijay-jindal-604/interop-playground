#!/usr/bin/env node
/**
 * Secret check (plan/10 §4.3). Fails when a checked file outside scripts/check-secrets.allow:
 *   1. contains a PEM private key block;
 *   2. has extension .p12/.pfx/.jks/.key, is named .env/.env.local, or lives under certs/, data/, .generated/;
 *   3. contains a JWK with a private member ("d");
 *   4. contains a value of the secret registry (02 §6.2) read from a local .env/.env.local.
 *
 * Usage: node scripts/check-secrets.mjs [--all | --staged] [--root <dir>]
 *   --all (default)  every tracked and untracked-but-not-ignored file (git), or every file under
 *                    --root when it is not a git work tree (used by tests/repo/secrets.test.ts)
 *   --staged         files staged for commit (pre-commit hook)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const mode = args.includes('--staged') ? 'staged' : 'all';
const rootArg = args.indexOf('--root');
const root =
  rootArg >= 0 && args[rootArg + 1]
    ? path.resolve(args[rootArg + 1])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PEM_PRIVATE = /-----BEGIN (RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;
const SECRET_EXT = /\.(p12|pfx|jks|key)$/i;
const SECRET_NAMES = new Set(['.env', '.env.local']);
const SECRET_DIRS = ['certs/', 'data/', '.generated/'];
const JWK_KTY = /"kty"\s*:/;
const JWK_PRIVATE_D = /"d"\s*:\s*"/;
/** Secret registry names of 02 §6.2 held in .env/.env.local, plus any generated *_PASSWORD/_TOKEN/_SECRET. */
const REGISTRY_NAMES = new Set([
  'TUNNEL_TOKEN',
  'TUNNEL_HOSTNAME',
  'COLLAB_ESIGNET_MOCK_UIN',
  'COLLAB_ESIGNET_MOCK_OTP',
]);
const REGISTRY_SUFFIX = /(_PASSWORD|_TOKEN|_SECRET|_KEYSTORE_PASS)$/;
/** Public by design (02 §6.2), never a hit. */
const PUBLIC_VALUES = new Set(['changeit', 'keystore']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'build', '.gradle']);
const MAX_BYTES = 5 * 1024 * 1024;

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else re += '[^/]*';
    } else if ('.+?^${}()|[]\\'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

function loadAllowList() {
  const file = path.join(root, 'scripts/check-secrets.allow');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map(globToRegExp);
}

function isGitWorkTree() {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return path.resolve(top) === root;
  } catch {
    return false;
  }
}

function gitFiles() {
  const gitArgs =
    mode === 'staged'
      ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
      : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
  return execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f !== '');
}

function walkFiles(dir = root, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkFiles(path.join(dir, entry.name), acc);
    } else if (entry.isFile()) {
      acc.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/'));
    }
  }
  return acc;
}

function parseEnv(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (value.length >= 6 && !PUBLIC_VALUES.has(value)) out.push({ name: m[1], value });
  }
  return out;
}

function registryValues() {
  const values = [];
  for (const name of ['.env', '.env.local']) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    for (const entry of parseEnv(readFileSync(file, 'utf8'))) {
      if (REGISTRY_NAMES.has(entry.name) || REGISTRY_SUFFIX.test(entry.name)) values.push(entry);
    }
  }
  return values;
}

function main() {
  const allow = loadAllowList();
  const files = isGitWorkTree() ? gitFiles() : walkFiles();
  const registry = registryValues();
  const hits = [];
  for (const file of files) {
    if (allow.some((re) => re.test(file))) continue;
    const base = path.posix.basename(file);
    if (
      SECRET_EXT.test(file) ||
      SECRET_NAMES.has(base) ||
      SECRET_DIRS.some((d) => file.startsWith(d))
    ) {
      hits.push(`${file}: secret file type or location (rule 2)`);
      continue;
    }
    const abs = path.join(root, file);
    if (!existsSync(abs)) continue;
    const stat = statSync(abs);
    if (!stat.isFile() || stat.size > MAX_BYTES) continue;
    const text = readFileSync(abs, 'utf8');
    if (PEM_PRIVATE.test(text)) hits.push(`${file}: PEM private key (rule 1)`);
    if (JWK_KTY.test(text) && JWK_PRIVATE_D.test(text))
      hits.push(`${file}: JWK with private member "d" (rule 3)`);
    for (const { name, value } of registry) {
      if (text.includes(value)) hits.push(`${file}: value of ${name} from the local env (rule 4)`);
    }
  }
  if (hits.length > 0) {
    process.stderr.write(
      `check-secrets: ${hits.length} hit(s)\n${hits.map((h) => `  ${h}`).join('\n')}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`check-secrets: ${files.length} files clean (${mode})\n`);
}

main();
