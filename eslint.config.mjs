// ESLint flat config (plan/10 §4.1). Architecture rules live in eslint-rules/index.mjs.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import playground, {
  NO_RAW_HTTP_ALLOWED,
  NO_RAW_HTTP_FILES,
  NO_RAW_HTTP_GLOBALS,
  NO_RAW_HTTP_IMPORTS,
} from './eslint-rules/index.mjs';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'coverage/**',
      'sidecar/**',
      'fixtures/**',
      'flows/**',
      'docker/**',
      'certs/**',
      'data/**',
      '.generated/**',
      'test-results/**',
      'playwright-report/**',
      'packages/api/src/client.gen.ts',
    ],
  },
  js.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        structuredClone: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    plugins: { playground },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['error', 'warn'] }],
      'no-warning-comments': [
        'error',
        { terms: ['todo', 'fixme', 'xxx', 'hack'], location: 'start' },
      ],
      'playground/sink-only-writer': 'error',
      'playground/dependency-direction': 'error',
      'playground/ui-imports-api-only': 'error',
      'playground/no-localhost-literals': 'error',
    },
  },
  // TypeScript: recommended-type-checked
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['**/*.ts', '**/*.tsx'],
  })),
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // no-raw-http (plan/10 §4.1 rule 1)
  {
    files: NO_RAW_HTTP_FILES,
    ignores: NO_RAW_HTTP_ALLOWED,
    rules: {
      'no-restricted-imports': ['error', NO_RAW_HTTP_IMPORTS],
      'no-restricted-globals': ['error', ...NO_RAW_HTTP_GLOBALS],
    },
  },
  // Tests: no sleep-based assertions (plan/11 §7)
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='setTimeout']",
          message: 'Use FakeClock instead of setTimeout in tests (plan/11 §7).',
        },
      ],
    },
  },
  // RuleTester fixtures contain the very SQL and literals the rules forbid
  {
    files: ['tests/repo/lint-rules.test.ts'],
    rules: { 'playground/sink-only-writer': 'off', 'playground/no-localhost-literals': 'off' },
  },
  // Node scripts may print
  {
    files: ['scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
