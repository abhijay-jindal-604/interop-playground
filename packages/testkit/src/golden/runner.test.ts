/** `golden.manifest` (plan/11 §2): the golden set is complete and unchanged; the runner catches drift. */
import { appendFileSync, cpSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GOLDEN_DIR } from '../paths.js';
import { BASE_GOLDEN_CHECKS, readManifest, runGolden } from './runner.js';

const tmp = mkdtempSync(path.join(tmpdir(), 'golden-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function copy(): string {
  const d = mkdtempSync(path.join(tmp, 'g-'));
  cpSync(GOLDEN_DIR, d, { recursive: true });
  return d;
}

describe('golden.manifest', () => {
  it('fixtures/golden passes: every file listed, present, unchanged, with S-IDs, base checks green', () => {
    const r = runGolden(BASE_GOLDEN_CHECKS);
    expect(r).toMatchObject({
      missing: [],
      changed: [],
      unlisted: [],
      badSids: [],
      failures: [],
      ok: true,
    });
    expect(r.checked).toBe(readManifest().files.length);
  });

  it('fails on a changed, a missing and an unlisted file', () => {
    const d = copy();
    const files = readManifest(d).files;
    const [a, b] = [files[0]?.file ?? '', files[1]?.file ?? ''];
    appendFileSync(path.join(d, a), ' ');
    unlinkSync(path.join(d, b));
    writeFileSync(path.join(d, 'traces', 'new.json'), '[]');
    const r = runGolden([], d);
    expect(r.ok).toBe(false);
    expect(r.changed).toEqual([a]);
    expect(r.missing).toEqual([b]);
    expect(r.unlisted).toEqual(['traces/new.json']);
  });

  it('reports a failing registered check per file', () => {
    const r = runGolden([{ name: 'always', match: /^collab\//, run: () => 'nope' }]);
    expect(r.ok).toBe(false);
    expect(r.failures.length).toBeGreaterThan(0);
    expect(r.failures.every((f) => f.file.startsWith('collab/') && f.check === 'always')).toBe(
      true,
    );
  });
});
