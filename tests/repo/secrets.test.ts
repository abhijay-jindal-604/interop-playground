/** plan/11 §4.3 `secrets`: check-secrets.mjs on generated temp trees; .gitignore entries. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot, runNode, tempTree } from './helpers.js';

const SCRIPT = 'scripts/check-secrets.mjs';
// Fake key material is built in memory (plan/11 §2), never committed.
const pemHeader = ['-----BEGIN', 'EC', 'PRIVATE', 'KEY-----'].join(' ');
const pem = `${pemHeader}\nMHcCAQEEIFakeFakeFake\n-----END EC PRIVATE KEY-----\n`;
const jwkPrivate = JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'a', y: 'b', ['d']: 'c' });
const allowFile = readFileSync(path.join(repoRoot, 'scripts/check-secrets.allow'), 'utf8');

function check(files: Record<string, string>): { status: number; output: string } {
  const dir = tempTree({ 'scripts/check-secrets.allow': allowFile, ...files });
  return runNode(SCRIPT, ['--all', '--root', dir]);
}

describe('secrets', () => {
  const failing: Record<string, Record<string, string>> = {
    'PEM private key': { 'apps/a.ts': pem },
    '.p12 file': { 'apps/keystore.p12': 'binary' },
    'JWK with d': { 'packages/k.json': jwkPrivate },
    '.env file': { '.env': 'PUBLIC_HOST=192.0.2.10\n' },
    'certs/ content': { 'certs/ca.crt': 'x' },
    'registry value': {
      '.env.local': 'TUNNEL_TOKEN=tok-0123456789abcdef\n',
      'docs/notes.md': 'the token is tok-0123456789abcdef\n',
    },
  };
  for (const [name, files] of Object.entries(failing)) {
    it(`fails on ${name}`, () => {
      const result = check(files);
      expect(result.status, result.output).toBe(1);
      if (name === 'registry value')
        expect(result.output).toContain('docs/notes.md: value of TUNNEL_TOKEN');
    });
  }

  it('passes allow-listed test keys and a clean tree', () => {
    const result = check({
      'fixtures/keys/holder.json': `{"_comment":"TEST-ONLY",${jwkPrivate.slice(1)}`,
      'apps/a.ts': "export const truststorePassword = 'changeit';\n",
    });
    expect(result.status, result.output).toBe(0);
  });

  it('passes on the real tree', () => {
    const result = runNode(SCRIPT, ['--all']);
    expect(result.status, result.output).toBe(0);
  });

  it('.gitignore lists the required entries', () => {
    const lines = readFileSync(path.join(repoRoot, '.gitignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim());
    for (const entry of [
      'certs/',
      'data/',
      '.env',
      '.env.local',
      '.generated/',
      '*.p12',
      '*.jks',
      '*.pem',
      '*.key',
    ]) {
      expect(lines).toContain(entry);
    }
  });
});
