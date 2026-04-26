import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', 'eslint.config.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Use a lint-specific tsconfig that includes src/, test/, and
        // examples/ — the production tsconfig only covers src/.
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Underscore-prefixed args/vars are intentionally unused (e.g. `_extra`,
      // `_msg`, `_` for required-but-unused destructure positions).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Off globally: too many false positives in this codebase. Most
      // violations are interface conformance (Backend.close, Session
      // methods returning Promise<T>) or test mocks that match an async
      // signature without doing async work. The rule's intent — flag
      // unintended `async` keywords — doesn't outweigh the noise here.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Tests narrow SDK event payloads to a few relevant fields and `as any`
    // them past the full type. Modeling the entire SDK event tree just to
    // exercise one branch of a translator is busywork that obscures the
    // test, not type safety we'd actually catch bugs from. The unsafe-*
    // rules from recommendedTypeChecked also fall out of this — they're
    // downstream consequences of the same `as any` decision. `unbound-method`
    // fires on `expect(obj.method).toBe(...)` identity checks — fine in test
    // context.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
