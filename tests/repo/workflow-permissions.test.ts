/**
 * plan/11 §4.3 `workflow-permissions`, plan/10 §9.3: every workflow is read-only, pinned by SHA and
 * holds no GitHub write path (ADR-38, 08 §4).
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { repoRoot } from './helpers.js';

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: unknown;
};
type Job = {
  steps?: Step[];
  permissions?: unknown;
  env?: Record<string, unknown>;
  'timeout-minutes'?: number;
};
type Workflow = {
  on?: unknown;
  permissions?: unknown;
  env?: Record<string, unknown>;
  jobs?: Record<string, Job>;
};

const workflowDir = path.join(repoRoot, '.github/workflows');
const files = readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f));
const workflows = files.map((file) => {
  const text = readFileSync(path.join(workflowDir, file), 'utf8');
  return { file, text, doc: YAML.parse(text) as Workflow };
});

const ALLOWED_PERMISSIONS: Record<string, Record<string, string>> = {
  'ci.yml': { contents: 'read' },
  'nightly.yml': { contents: 'read', actions: 'read' },
};
const FORBIDDEN_KEYS = ['issues', 'pull-requests', 'id-token', 'packages'];
const FORBIDDEN_RUN = [
  /\bgh\s+issue\b/,
  /\bgh\s+pr\b/,
  /\bgit\s+push\b/,
  /\bgh\s+api\b[^\n]*(-X|--method)\s*=?\s*['"]?(POST|PUT|PATCH|DELETE)/i,
  /\bcurl\b[^\n]*api\.github\.com/i,
];

describe('workflow-permissions', () => {
  it('finds ci.yml', () => {
    expect(files).toContain('ci.yml');
  });

  for (const { file, text, doc } of workflows) {
    describe(file, () => {
      it('declares top-level permissions with only the allowed read scopes', () => {
        expect(doc.permissions).toBeTypeOf('object');
        const expected = ALLOWED_PERMISSIONS[file];
        if (expected !== undefined) expect(doc.permissions).toEqual(expected);
        for (const [key, value] of Object.entries(doc.permissions as Record<string, unknown>)) {
          expect(['contents', 'actions']).toContain(key);
          expect(value).toBe('read');
        }
      });

      it('has no write permission, no issues/pull-requests/id-token/packages anywhere', () => {
        expect(text).not.toMatch(/:\s*write\b/);
        for (const key of FORBIDDEN_KEYS) {
          expect(text).not.toMatch(new RegExp(`^\\s*${key}\\s*:`, 'm'));
        }
        for (const job of Object.values(doc.jobs ?? {})) {
          if (job.permissions !== undefined) {
            for (const value of Object.values(job.permissions as Record<string, unknown>)) {
              expect(value).toBe('read');
            }
          }
        }
      });

      it('pins every uses: by a 40-hex commit SHA', () => {
        for (const job of Object.values(doc.jobs ?? {})) {
          for (const step of job.steps ?? []) {
            if (step.uses !== undefined) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
          }
        }
      });

      it('references no secrets and runs no GitHub write command', () => {
        expect(text).not.toMatch(/\bsecrets\./);
        for (const job of Object.values(doc.jobs ?? {})) {
          for (const step of job.steps ?? []) {
            for (const re of FORBIDDEN_RUN) expect(step.run ?? '').not.toMatch(re);
          }
        }
      });

      it('uses GH_TOKEN only in the nightly step "Download previous bundles"', () => {
        const holders: string[] = [];
        if (doc.env && 'GH_TOKEN' in doc.env) holders.push('<workflow>');
        for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
          if (job.env && 'GH_TOKEN' in job.env) holders.push(jobName);
          for (const step of job.steps ?? []) {
            if (step.env && 'GH_TOKEN' in step.env) holders.push(`${jobName}/${step.name ?? ''}`);
          }
        }
        if (file === 'nightly.yml') {
          expect(holders.every((h) => h.endsWith('/Download previous bundles'))).toBe(true);
        } else {
          expect(holders).toEqual([]);
        }
        if (file === 'ci.yml') expect(text).not.toMatch(/actions:\s*read/);
      });

      if (file === 'nightly.yml') {
        it('runs at 30 20 * * * with a timeout', () => {
          expect(text).toMatch(/cron:\s*['"]30 20 \* \* \*['"]/);
          for (const job of Object.values(doc.jobs ?? {})) {
            expect(job['timeout-minutes']).toBeTypeOf('number');
          }
        });
      }
    });
  }
});
