/** plan/11 §4.3 `lint-rules`: RuleTester cases for the architecture rules of plan/10 §4.1. */
import path from 'node:path';
import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { builtinRules } from 'eslint/use-at-your-own-risk';
import playground, { NO_RAW_HTTP_GLOBALS, NO_RAW_HTTP_IMPORTS } from '../../eslint-rules/index.mjs';
import { repoRoot } from './helpers.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2023, sourceType: 'module', parser: tseslint.parser },
});
const at = (rel: string): string => path.join(repoRoot, rel);
const rule = (name: string) => playground.rules[name as keyof typeof playground.rules];

describe('lint-rules', () => {
  tester.run('no-raw-http (imports)', builtinRules.get('no-restricted-imports')!, {
    valid: [{ code: "import { x } from './capture.js';", options: [NO_RAW_HTTP_IMPORTS] }],
    invalid: [
      { code: "import http from 'node:http';", options: [NO_RAW_HTTP_IMPORTS], errors: 1 },
      { code: "import { request } from 'undici';", options: [NO_RAW_HTTP_IMPORTS], errors: 1 },
      { code: "import axios from 'axios';", options: [NO_RAW_HTTP_IMPORTS], errors: 1 },
    ],
  });

  tester.run('no-raw-http (globals)', builtinRules.get('no-restricted-globals')!, {
    valid: [{ code: 'await ctx.http.fetch(c, url);', options: NO_RAW_HTTP_GLOBALS }],
    invalid: [
      { code: 'await fetch(url);', options: NO_RAW_HTTP_GLOBALS, errors: 1 },
      { code: 'new WebSocket(url);', options: NO_RAW_HTTP_GLOBALS, errors: 1 },
    ],
  });

  tester.run('sink-only-writer', rule('sink-only-writer'), {
    valid: [
      {
        code: "db.prepare('INSERT INTO run_events (seq) VALUES (?)');",
        filename: at('apps/bff/src/store/sink.ts'),
      },
      { code: "import Database from 'better-sqlite3';", filename: at('apps/bff/src/store/db.ts') },
      {
        code: "db.prepare('SELECT * FROM run_events');",
        filename: at('apps/bff/src/store/read.ts'),
      },
      {
        code: "db.prepare('INSERT INTO runs (id) VALUES (?)');",
        filename: at('apps/bff/src/store/runs.ts'),
      },
    ],
    invalid: [
      {
        code: "db.prepare('INSERT INTO run_events (seq) VALUES (?)');",
        filename: at('apps/bff/src/store/other.ts'),
        errors: [{ messageId: 'write' }],
      },
      {
        code: 'db.exec(`DELETE FROM exchanges WHERE run_id = ${id}`);',
        filename: at('apps/bff/src/orchestrator/x.ts'),
        errors: [{ messageId: 'write' }],
      },
      {
        code: "import Database from 'better-sqlite3';",
        filename: at('apps/bff/src/orchestrator/x.ts'),
        errors: [{ messageId: 'driver' }],
      },
    ],
  });

  tester.run('ui-imports-api-only', rule('ui-imports-api-only'), {
    valid: [
      {
        code: "import type { Run } from '@interop-playground/api';",
        filename: at('apps/ui/src/a.ts'),
      },
      { code: "import { b } from './b.js';", filename: at('apps/ui/src/a.ts') },
    ],
    invalid: [
      {
        code: "import { x } from '@interop-playground/adapters';",
        filename: at('apps/ui/src/a.ts'),
        errors: [{ messageId: 'forbidden' }],
      },
      {
        code: "import { x } from '../../bff/src/index.js';",
        filename: at('apps/ui/src/a.ts'),
        errors: [{ messageId: 'escape' }],
      },
    ],
  });

  tester.run('dependency-direction', rule('dependency-direction'), {
    valid: [
      {
        code: "import type { Run } from '@interop-playground/api';",
        filename: at('apps/bff/src/a.ts'),
      },
      {
        code: "import type { Role } from '@interop-playground/adapters';",
        filename: at('packages/api/src/a.ts'),
      },
    ],
    invalid: [
      {
        code: "import type { Run } from '@interop-playground/api';",
        filename: at('packages/adapters/src/a.ts'),
        errors: [{ messageId: 'forbidden' }],
      },
      {
        code: "import { x } from '@interop-playground/bff';",
        filename: at('packages/testkit/src/a.ts'),
        errors: [{ messageId: 'forbidden' }],
      },
    ],
  });

  tester.run('no-localhost-literals', rule('no-localhost-literals'), {
    valid: [
      { code: "const u = 'http://127.0.0.1:3100';", filename: at('apps/bff/src/config/base.ts') },
      { code: 'const u = `https://${publicHost}:8443`;', filename: at('apps/bff/src/env/x.ts') },
    ],
    invalid: [
      {
        code: "const u = 'https://localhost:8443/x';",
        filename: at('apps/bff/src/env/x.ts'),
        errors: [{ messageId: 'literal' }],
      },
      {
        code: 'const u = `http://127.0.0.1:${port}`;',
        filename: at('apps/bff/src/gateway/x.ts'),
        errors: [{ messageId: 'literal' }],
      },
    ],
  });
});
