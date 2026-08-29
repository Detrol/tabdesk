const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const recent = require('../recent-projects');

test('sanitize keeps only finite timestamps on non-empty paths', () => {
  assert.deepEqual(recent.sanitize(null), {});
  assert.deepEqual(recent.sanitize(['/a']), {});
  assert.deepEqual(recent.sanitize({
    '/used': 100,
    '': 200,
    '/bad': 'nope',
    '/ok': 3.5,
  }), { '/used': 100, '/ok': 3.5 });
});

test('mark records the given time and ignores empty paths', () => {
  const next = recent.mark({ '/old': 1 }, '/new', 9);
  assert.deepEqual(next, { '/old': 1, '/new': 9 });
  assert.deepEqual(recent.mark({ '/old': 1 }, '', 9), { '/old': 1 });
  assert.deepEqual(recent.mark({ '/old': 1 }, '/new', Number.NaN), { '/old': 1 });
});

const rows = [
  { name: 'root', path: '/projects', root: true, mtime: 500 },
  { name: 'alpha', path: '/projects/alpha', mtime: 300 },
  { name: 'beta', path: '/projects/beta', mtime: 100 },
  { name: 'gamma', path: '/projects/gamma', mtime: 200 },
];

test('order keeps the projects-folder row first', () => {
  const ordered = recent.order(rows, { '/projects/beta': 999 });
  assert.equal(ordered[0].path, '/projects');
  assert.equal(ordered[0].root, true);
});

test('order prefers last-used over older directory mtime', () => {
  const ordered = recent.order(rows, { '/projects/beta': 400 });
  assert.deepEqual(ordered.slice(1).map((row) => row.name), ['beta', 'alpha', 'gamma']);
});

test('order falls back to mtime when nothing has been used', () => {
  const ordered = recent.order(rows, {});
  assert.deepEqual(ordered.slice(1).map((row) => row.name), ['alpha', 'gamma', 'beta']);
});

test('order treats a newer disk update as recent even without a use', () => {
  const ordered = recent.order(rows, { '/projects/beta': 150 });
  assert.deepEqual(ordered.slice(1).map((row) => row.name), ['alpha', 'gamma', 'beta']);
});

test('packaged app includes recent-projects', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('recent-projects.js'));
});
