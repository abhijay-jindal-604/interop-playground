// G-166 (ADR-100): scripts/up.sh decides whether the shared Inji state volumes belong to this
// checkout from the checkout marker plus a stamp label on a project volume. The decision lives in
// scripts/lib/state-check.sh (sourced, no side effects); this runs it with bash, no Docker.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..', '..');
const lib = resolve(root, 'scripts', 'lib', 'state-check.sh');

function sh(fn: string, ...args: string[]): string {
  return execFileSync('bash', ['-c', `source "$0"; ${fn} "$@"`, lib, ...args], {
    encoding: 'utf8',
  }).trim();
}

const MAIN = 'public_host=192.0.2.10 ca=AA:BB';
const CLONE = 'public_host=192.0.2.10 ca=CC:DD';

describe('repo.up-state-check (G-166)', () => {
  it('stamp is the sha256 of the marker line', () => {
    expect(sh('state_stamp_of', MAIN)).toMatch(/^[0-9a-f]{64}$/);
    expect(sh('state_stamp_of', MAIN)).not.toBe(sh('state_stamp_of', CLONE));
  });

  it('no state → create; marker for another CA → wipe', () => {
    expect(sh('state_action', '0', '', MAIN, '')).toBe('create');
    expect(sh('state_action', '1', CLONE, MAIN, sh('state_stamp_of', CLONE))).toBe('wipe');
  });

  it('second checkout rebuilt the shared volumes: marker matches, stamp is foreign → other', () => {
    expect(sh('state_action', '1', MAIN, MAIN, sh('state_stamp_of', CLONE))).toBe('other');
  });

  it('own state → keep; state from before the stamp existed → adopt', () => {
    expect(sh('state_action', '1', MAIN, MAIN, sh('state_stamp_of', MAIN))).toBe('keep');
    expect(sh('state_action', '1', MAIN, MAIN, '')).toBe('adopt');
  });

  it('up.sh wires it: wipes on "other", stamps after the chain, reset removes the stamp', () => {
    const up = readFileSync(resolve(root, 'scripts', 'up.sh'), 'utf8');
    expect(up).toContain('source "$ROOT/scripts/lib/state-check.sh"');
    expect(up).toMatch(/state_check" == other \]\]; then[\s\S]{0,400}remove_state/);
    expect(up).toMatch(/> "\$MARKER"\n\s+write_stamp "\$want_marker"/);
    expect(up).toMatch(/remove_state\(\)[\s\S]{0,400}docker volume rm "\$STAMP_VOLUME"/);
  });
});
