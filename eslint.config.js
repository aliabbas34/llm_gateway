// @ts-check
import js from '@eslint/js';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Layering rule: the core (domain + application) depends only on ports.
 * Concrete technology lives in infrastructure/http/observability and is wired in server.ts.
 */
const coreForbiddenImports = {
  patterns: [
    {
      group: ['**/infrastructure/**', '**/http/**', '**/observability/**', '**/server.js'],
      message: 'domain/application must depend on ports (src/domain/ports.ts), not adapters.',
    },
    {
      group: ['fastify', 'fastify-*', '@fastify/*', 'ioredis', 'pg', 'jose', 'undici', 'pino'],
      message: 'domain/application must not depend on I/O libraries.',
    },
  ],
};

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/', 'load-test-results/'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  comments.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@eslint-community/eslint-comments/require-description': ['error', { ignore: [] }],
      '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },
  {
    files: ['src/domain/**/*.ts', 'src/application/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', coreForbiddenImports] },
  },
  {
    // CLI scripts talk to a human on stdout.
    files: ['scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
