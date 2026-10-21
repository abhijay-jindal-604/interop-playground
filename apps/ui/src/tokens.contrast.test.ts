import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../..');
const script = path.join(root, 'scripts/contrast.mjs');
const tokens = path.join(root, 'apps/ui/src/tokens.css');
const run = (...args: string[]) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

describe('contrast', () => {
  it('passes every UI-75 token pair in both themes', () => {
    const r = run(tokens);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('fails on a tampered copy and names the pair', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'contrast-'));
    const file = path.join(dir, 'tokens.css');
    writeFileSync(
      file,
      readFileSync(tokens, 'utf8').replace('--text-muted: #5a5852;', '--text-muted: #94a3b8;'),
    );
    const r = run(file);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('light: --text-muted on --bg');
  });

  it('checks the chrome pairs (ADR-126, ADR-134)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'contrast-'));
    const file = path.join(dir, 'tokens.css');
    writeFileSync(
      file,
      readFileSync(tokens, 'utf8').replace('--chrome-muted: #5a5852;', '--chrome-muted: #c7c7cc;'),
    );
    const r = run(file);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('light: --chrome-muted on --chrome-bg');
  });
});
