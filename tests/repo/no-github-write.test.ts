/** plan/11 §4.3 `no-github-write`: the lint fails on each forbidden pattern and passes on the tree. */
import { describe, expect, it } from 'vitest';
import { runNode, tempTree } from './helpers.js';

const SCRIPT = 'scripts/lint-no-github-write.mjs';
// Assembled at runtime so this test file never contains the literal patterns.
const host = ['api', 'github', 'com'].join('.');
const CASES: Record<string, string> = {
  'github-api-host': `const u = 'https://${host}/x';\n`,
  octokit: `import { Octo${'kit'} } from '@octo${'kit'}/rest';\n`,
  'gh-issue': `gh ${'issue'} create --title x\n`,
  'gh-pr': `gh ${'pr'} create\n`,
  'gh-api-write': `gh api -X ${'POST'} /x\n`,
  'permission-issues': `permissions:\n  ${'issues'}: write\n`,
  'permission-pull-requests': `permissions:\n  ${'pull-requests'}: read\n`,
  'repos-url': `curl https://example.org/${'repos'}/a/b\n`,
};

describe('no-github-write', () => {
  for (const [rule, content] of Object.entries(CASES)) {
    it(`fails on ${rule}`, () => {
      const dir = tempTree({ 'scripts/bad.sh': content });
      const result = runNode(SCRIPT, ['--root', dir]);
      expect(result.status).toBe(1);
      expect(result.output).toContain(rule);
    });
  }

  it('passes on a clean temp tree', () => {
    const dir = tempTree({ 'apps/x/src/a.ts': "export const a = 'gh run download is a read';\n" });
    expect(runNode(SCRIPT, ['--root', dir]).status).toBe(0);
  });

  it('passes on the real tree', () => {
    const result = runNode(SCRIPT, []);
    expect(result.output).toContain('clean');
    expect(result.status).toBe(0);
  });
});
