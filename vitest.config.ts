import { defineConfig } from 'vitest/config';

const INFRA_SETUP = './test/helpers/globalSetup.ts';

/**
 * One config, several projects. `unit` and `contract` need no infrastructure;
 * `integration`, `concurrency` and `e2e` need Redis + Postgres (docker compose / CI services).
 */
export default defineConfig({
  test: {
    environment: 'node',
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'text', 'lcov'],
      thresholds: {
        'src/domain/**': { lines: 85, functions: 85, branches: 85, statements: 85 },
        'src/application/**': { lines: 85, functions: 85, branches: 85, statements: 85 },
      },
    },
    projects: [
      { extends: true, test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      { extends: true, test: { name: 'contract', include: ['test/contract/**/*.test.ts'] } },
      {
        extends: true,
        test: {
          name: 'integration',
          globalSetup: [INFRA_SETUP],
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'concurrency',
          globalSetup: [INFRA_SETUP],
          include: ['test/concurrency/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          globalSetup: [INFRA_SETUP],
          include: ['test/e2e/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
