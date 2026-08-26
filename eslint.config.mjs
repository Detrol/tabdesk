import eslint from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/.worktrees/**',
      '**/.remember/**',
      'build/**',
      'dist/**',
      'renderer/files.bundle.js',
    ],
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.browser,
        t: 'readonly',
      },
    },
    rules: {
      ...eslint.configs.recommended.rules,
      'no-console': 'off',
      'no-warning-comments': ['warn', { terms: ['todo', 'fixme'], location: 'anywhere' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Terminal parsing intentionally matches control characters.
      'no-control-regex': 'off',
      'no-unused-vars': ['warn', {
        args: 'after-used',
        caughtErrors: 'none',
        varsIgnorePattern: '^_',
        argsIgnorePattern: '^_',
      }],
      'no-useless-assignment': 'off',
    },
  },
  {
    files: ['**/*.mjs', 'renderer/files-entry.js', 'renderer/files/**/*.js'],
    languageOptions: {
      sourceType: 'module',
    },
  },
];
