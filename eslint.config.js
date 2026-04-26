import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'coverage/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Underscore-prefixed args/vars are intentionally unused (e.g. `_extra`,
      // `_msg`, `_` for required-but-unused destructure positions).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Tests narrow SDK event payloads to a few relevant fields and `as any`
    // them past the full type. Modeling the entire SDK event tree just to
    // exercise one branch of a translator is busywork that obscures the
    // test, not type safety we'd actually catch bugs from.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
