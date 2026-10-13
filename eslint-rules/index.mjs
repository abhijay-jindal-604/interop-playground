/**
 * Local ESLint plugin `playground`: the architecture rules of plan/10 §4.1.
 *   no-raw-http          (config of core `no-restricted-imports` / `no-restricted-globals`, see NO_RAW_HTTP_*)
 *   sink-only-writer     only apps/bff/src/store/sink.ts writes the event tables (05 §6)
 *   ui-imports-api-only  apps/ui imports only @interop-playground/api from the repo
 *   dependency-direction workspace import direction of plan/10 §1
 *   no-localhost-literals advertised URLs are built from PUBLIC_HOST (ADR-06)
 */
import path from 'node:path';

// ---------- no-raw-http (core rules, options exported for the config and RuleTester) ----------
export const RAW_HTTP_MODULES = [
  'node:http',
  'node:https',
  'node:net',
  'http',
  'https',
  'net',
  'undici',
  'axios',
  'got',
];
const RAW_HTTP_MESSAGE =
  'Network access goes through the injected CapturingHttp (02 §3.2, plan/10 §4.1 no-raw-http).';
export const NO_RAW_HTTP_IMPORTS = {
  paths: RAW_HTTP_MODULES.map((name) => ({ name, message: RAW_HTTP_MESSAGE })),
};
export const NO_RAW_HTTP_GLOBALS = ['fetch', 'XMLHttpRequest', 'WebSocket'].map((name) => ({
  name,
  message: RAW_HTTP_MESSAGE,
}));
/** Files where no-raw-http applies, and the files that implement CapturingHttp (exempt). */
export const NO_RAW_HTTP_FILES = [
  'apps/bff/src/orchestrator/**',
  'apps/bff/src/env/**',
  'apps/bff/src/tamper/**',
  'apps/bff/src/report/**',
  'apps/bff/src/diagnosis/**',
  'packages/adapters/**',
  'packages/testkit/**',
];
export const NO_RAW_HTTP_ALLOWED = [
  'apps/bff/src/capture/**',
  'apps/bff/src/gateway/**',
  'apps/bff/src/cli.ts',
  // the testkit network guard wraps global fetch / net to block it (plan/11 §2)
  'packages/testkit/src/network-guard.ts',
  'packages/testkit/src/network-guard.test.ts',
];

// ---------- helpers ----------
function toPosix(file) {
  return file.split(path.sep).join('/');
}
function relativeToRepo(context) {
  const cwd = context.cwd ?? process.cwd();
  return toPosix(path.relative(cwd, context.filename ?? ''));
}
function importSources(node) {
  // ImportDeclaration, ExportNamedDeclaration/ExportAllDeclaration with source, ImportExpression
  return node.source && typeof node.source.value === 'string' ? node.source.value : null;
}

// ---------- sink-only-writer ----------
export const EVENT_TABLES = [
  'run_events',
  'blobs',
  'artifacts',
  'exchanges',
  'checks',
  'tamper_results',
  'unattributed_exchanges',
  'env_events',
];
const WRITE_SQL = new RegExp(
  String.raw`\b(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+["\x60]?(` +
    EVENT_TABLES.join('|') +
    String.raw`)\b`,
  'i',
);

const sinkOnlyWriter = {
  meta: {
    type: 'problem',
    docs: { description: 'Only apps/bff/src/store/sink.ts writes the event tables (05 §6).' },
    schema: [],
    messages: {
      driver: 'better-sqlite3 may be imported only under apps/bff/src/store/ (05 §6).',
      write: 'Only apps/bff/src/store/sink.ts may write the event table "{{table}}" (05 §6).',
    },
  },
  create(context) {
    const file = relativeToRepo(context);
    const inStore = file.startsWith('apps/bff/src/store/');
    const isSink = file === 'apps/bff/src/store/sink.ts';
    const checkText = (node, text) => {
      if (isSink) return;
      const m = WRITE_SQL.exec(text);
      if (m) context.report({ node, messageId: 'write', data: { table: m[3] } });
    };
    const checkImport = (node) => {
      const source = importSources(node);
      if (source === 'better-sqlite3' && !inStore) context.report({ node, messageId: 'driver' });
    };
    return {
      ImportDeclaration: checkImport,
      ImportExpression: checkImport,
      Literal(node) {
        if (typeof node.value === 'string') checkText(node, node.value);
      },
      TemplateLiteral(node) {
        checkText(node, node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(' '));
      },
    };
  },
};

// ---------- dependency direction (plan/10 §1) ----------
/** Which repo packages each workspace may import (no entry = may import nothing in the repo). */
export const ALLOWED_DEPENDENCIES = {
  'apps/ui': ['@interop-playground/api'],
  'apps/bff': [
    '@interop-playground/adapters',
    '@interop-playground/api',
    '@interop-playground/testkit',
  ],
  'packages/api': ['@interop-playground/adapters'],
  'packages/adapters': [],
  'packages/testkit': ['@interop-playground/adapters', '@interop-playground/api'],
};
const WORKSPACE_DIRS = Object.keys(ALLOWED_DEPENDENCIES);

function workspaceOf(file) {
  return WORKSPACE_DIRS.find((dir) => file === dir || file.startsWith(`${dir}/`)) ?? null;
}

function makeDirectionRule(onlyWorkspace) {
  return {
    meta: {
      type: 'problem',
      docs: { description: 'Workspace import direction of plan/10 §1.' },
      schema: [],
      messages: {
        forbidden: '{{from}} may not import {{target}} (plan/10 §1 dependency direction).',
        escape: '{{from}} may not reach into {{target}} by relative path; import its package.',
      },
    },
    create(context) {
      const file = relativeToRepo(context);
      const from = workspaceOf(file);
      if (from === null) return {};
      if (onlyWorkspace !== null && from !== onlyWorkspace) return {};
      if (onlyWorkspace === null && from === 'apps/ui') return {}; // ui-imports-api-only covers it
      const allowed = ALLOWED_DEPENDENCIES[from];
      const check = (node) => {
        const source = importSources(node);
        if (source === null) return;
        if (source.startsWith('@interop-playground/')) {
          const pkg = source.split('/').slice(0, 2).join('/');
          if (!allowed.includes(pkg)) {
            context.report({ node, messageId: 'forbidden', data: { from, target: pkg } });
          }
          return;
        }
        if (source.startsWith('.')) {
          const resolved = toPosix(path.normalize(path.join(path.dirname(file), source)));
          const target = workspaceOf(resolved);
          if (resolved.startsWith('apps/') || resolved.startsWith('packages/')) {
            if (target !== from) {
              context.report({
                node,
                messageId: 'escape',
                data: { from, target: target ?? resolved },
              });
            }
          }
        }
      };
      return {
        ImportDeclaration: check,
        ImportExpression: check,
        ExportNamedDeclaration: check,
        ExportAllDeclaration: check,
      };
    },
  };
}

// ---------- no-localhost-literals ----------
const LOCALHOST = /\b(localhost|127\.0\.0\.1)\b|\[::1\]/;
const noLocalhostLiterals = {
  meta: {
    type: 'problem',
    docs: { description: 'apps/bff/src outside config/ builds URLs from PUBLIC_HOST (ADR-06).' },
    schema: [],
    messages: {
      literal:
        'Loopback literal outside apps/bff/src/config/: build advertised URLs from PUBLIC_HOST (ADR-06).',
    },
  },
  create(context) {
    const file = relativeToRepo(context);
    if (!file.startsWith('apps/bff/src/') || file.startsWith('apps/bff/src/config/')) return {};
    if (/\.(test|contract\.test|int\.test)\.ts$/.test(file)) return {};
    const check = (node, text) => {
      if (LOCALHOST.test(text)) context.report({ node, messageId: 'literal' });
    };
    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      TemplateLiteral(node) {
        check(node, node.quasis.map((q) => q.value.raw).join(''));
      },
    };
  },
};

const plugin = {
  meta: { name: 'playground', version: '0.0.0' },
  rules: {
    'sink-only-writer': sinkOnlyWriter,
    'ui-imports-api-only': makeDirectionRule('apps/ui'),
    'dependency-direction': makeDirectionRule(null),
    'no-localhost-literals': noLocalhostLiterals,
  },
};

export default plugin;
