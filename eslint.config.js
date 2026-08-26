/**
 * ESLint flat config for tabdesk.
 *
 * Primary purpose: analyse and enforce cyclomatic-complexity thresholds
 * across the codebase so complexity is continuously monitored.
 *
 * Complexity rules (set as errors so `npm run lint:complexity` fails when
 * thresholds are breached):
 *   - complexity              – cyclomatic complexity per function  (max 50)
 *   - max-lines-per-function  – lines per function                  (max 1200, excl. comments)
 *   - max-statements          – statements per function             (max 200)
 *   - max-depth               – nesting depth                        (max 8)
 *   - max-params              – function parameters                  (max 8)
 */
const complexityRules = {
  // These thresholds establish a ratchet above the current legacy baseline.
  // Lowering them requires first refactoring the existing large modules.
  complexity: ['error', 50],
  'max-lines-per-function': ['error', { max: 1200, skipComments: true }],
  'max-statements': ['error', 200],
  'max-depth': ['error', 8],
  'max-params': ['error', 8],
};

module.exports = [
  // ── Ignored files ──────────────────────────────────────────────
  {
    ignores: [
      'node_modules/**',
      '.worktrees/**',
      'dist/**',
      'out/**',
      'build/**',
      'renderer/files.bundle.js',
      'eslint.config.mjs',
      // Large generated/fixture test harnesses – not subject to complexity limits
      'test/main.js',
      'test/editor-controller.js',
      'test/renderer-session-controller.js',
      'test/main-pending-starts.js',
      'test/project-files.test.js',
      'test/main-lifecycle.test.js',
      'test/session-ownership.test.js',
    ],
  },

  // ── Default linter options ────────────────────────────────────
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },

  // ── Main / Node process files (CommonJS) ──────────────────────
  {
    files: [
      '*.js',
      'project-files/*.js',
      'sync/*.js',
      'scripts/*.js',
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        exports: 'writable',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        URL: 'readonly',
      },
    },
    rules: complexityRules,
  },

  // ── Preload scripts (Node + limited browser globals) ───────────
  {
    files: ['*-preload.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        exports: 'writable',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        window: 'readonly',
        document: 'readonly',
      },
    },
    rules: complexityRules,
  },

  // ── Renderer / browser files (script, not module) ─────────────
  {
    files: ['renderer/**/*.js', '!renderer/files/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        fetch: 'readonly',
        localStorage: 'readonly',
        CustomEvent: 'readonly',
        Event: 'readonly',
        EventTarget: 'readonly',
        HTMLElement: 'readonly',
        Node: 'readonly',
        Element: 'readonly',
        MutationObserver: 'readonly',
        DOMParser: 'readonly',
        XMLSerializer: 'readonly',
        URL: 'readonly',
        FileReader: 'readonly',
        Blob: 'readonly',
      },
    },
    rules: complexityRules,
  },

  // ── ES module renderer files (bundled by esbuild) ──────────────
  {
    files: ['renderer/files-entry.js', 'renderer/files/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
      },
    },
    rules: complexityRules,
  },

  // ── Test files (Node test runner, CommonJS) ───────────────────
  {
    files: ['test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        exports: 'writable',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        test: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        before: 'readonly',
        after: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
      },
    },
    rules: {
      ...complexityRules,
      // Test files legitimately need longer setup functions
      'max-lines-per-function': ['error', { max: 400, skipComments: true }],
    },
  },

  // ── ES module test files (.mjs) ────────────────────────────────
  {
    files: ['test/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    rules: {
      ...complexityRules,
      'max-lines-per-function': ['error', { max: 400, skipComments: true }],
    },
  },
];
