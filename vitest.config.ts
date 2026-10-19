import { defineConfig } from 'vitest/config';

const networkGuard = './packages/testkit/src/setup-network-guard.ts';
const common = ['**/node_modules/**', '**/dist/**', 'sidecar/**', 'e2e/**'];

/** plan/11 §2: projects unit, contract, integration, repo; `ui` runs apps/ui in jsdom (T-13). */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
          exclude: [...common, 'apps/ui/**', '**/*.contract.test.ts', '**/*.int.test.ts'],
          setupFiles: [networkGuard],
        },
      },
      {
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: ['apps/ui/src/**/*.test.ts', 'apps/ui/src/**/*.test.tsx'],
          exclude: common,
          setupFiles: [networkGuard, './apps/ui/src/test/setup.ts'],
        },
      },
      {
        test: {
          name: 'contract',
          environment: 'node',
          include: ['**/*.contract.test.ts'],
          exclude: common,
          setupFiles: [networkGuard],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['**/*.int.test.ts'],
          exclude: common,
        },
      },
      {
        test: {
          name: 'repo',
          environment: 'node',
          include: ['tests/repo/*.test.ts'],
          exclude: common,
          testTimeout: 60_000,
        },
      },
    ],
  },
});
