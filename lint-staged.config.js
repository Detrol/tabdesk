/**
 * lint-staged configuration
 *
 * Runs `node --check` on every staged JS/MJS file individually so that
 * syntax errors are caught before a commit lands.  A function is used
 * (instead of a plain string command) because `node --check` only
 * validates the *first* file it receives — passing all staged files in
 * one invocation would silently skip the rest.
 *
 * ESLint is then run on all staged JS/MJS files together to enforce
 * cyclomatic-complexity thresholds (see eslint.config.js).
 *
 * @param {string[]} files - Staged file paths matching the glob.
 * @returns {string[]} One `node --check` command per file, plus a single eslint pass.
 */
module.exports = {
  '*.{js,mjs}': (files) => [
    ...files.map((file) => `node --check "${file}"`),
    `eslint ${files.join(' ')}`,
  ],
};
