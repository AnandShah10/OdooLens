// @ts-check
const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

/**
 * Flat ESLint config (ESLint 9+). Deliberately light-touch: this project's actual guardrails
 * are TypeScript's `strict` mode (tsconfig.json) and the test suite, not a large lint rule set.
 * These rules catch the mistakes that TS strict mode doesn't (unused imports/vars, accidental
 * `any`, floating promises in an async-heavy codebase) without imposing a house style.
 */
module.exports = [
  {
    ignores: ['out/**', 'node_modules/**', '**/*.js', 'tests/fixtures/**', '*.vsix'],
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-explicit-any': 'off', // used deliberately at a few vscode/tree-sitter interop boundaries
      'no-console': 'off', // fine in this codebase (output channel logging, test debug output)
      eqeqeq: ['warn', 'smart'],
    },
  },
];
