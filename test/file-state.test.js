const test = require('node:test');
const assert = require('node:assert/strict');
const State = require('../renderer/file-state');

const loading = State.reduce(State.initial(), {
  type: 'open-start', request: 1, path: 'src/app.js',
});
const opened = State.reduce(loading, {
  type: 'open-success', request: 1, path: 'src/app.js',
  content: 'one\n', revision: 'a', ignored: false,
});

test('initial state has no live or disk document', () => {
  assert.deepEqual(State.initial(), {
    status: 'unopened',
    request: 0,
    path: null,
    content: '',
    diskContent: '',
    revision: null,
    exists: false,
    ignored: false,
    error: null,
  });
  assert.equal(State.needsDiscard(State.initial()), false);
});

test('matching open result becomes a clean document', () => {
  assert.deepEqual(loading, {
    status: 'loading',
    request: 1,
    path: 'src/app.js',
    content: '',
    diskContent: '',
    revision: null,
    exists: false,
    ignored: false,
    error: null,
  });
  assert.deepEqual(opened, {
    status: 'clean',
    request: 1,
    path: 'src/app.js',
    content: 'one\n',
    diskContent: 'one\n',
    revision: 'a',
    exists: true,
    ignored: false,
    error: null,
  });
});

test('clean edit becomes dirty and successful save becomes clean', () => {
  const dirty = State.reduce(opened, { type: 'edit', content: 'two\n' });
  assert.equal(dirty.status, 'dirty');
  assert.equal(dirty.content, 'two\n');
  assert.equal(dirty.diskContent, 'one\n');
  assert.equal(State.needsDiscard(dirty), true);

  const saved = State.reduce(dirty, { type: 'save-success', revision: 'b' });
  assert.equal(saved.status, 'clean');
  assert.equal(saved.revision, 'b');
  assert.equal(saved.content, 'two\n');
  assert.equal(saved.diskContent, 'two\n');
  assert.equal(saved.exists, true);
  assert.equal(State.needsDiscard(saved), false);
});

test('dirty external change becomes a conflict without losing local text', () => {
  const dirty = State.reduce(opened, { type: 'edit', content: 'local\n' });
  const conflict = State.reduce(dirty, { type: 'disk-changed', exists: true });
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.content, 'local\n');
  assert.equal(conflict.diskContent, 'one\n');
  assert.equal(conflict.exists, true);
  assert.equal(State.needsDiscard(conflict), true);
});

test('clean external snapshot auto-reloads content and revision', () => {
  const reloaded = State.reduce(opened, {
    type: 'disk-snapshot', content: 'external\n', revision: 'b', ignored: true,
  });
  assert.deepEqual(reloaded, {
    ...opened,
    status: 'clean',
    content: 'external\n',
    diskContent: 'external\n',
    revision: 'b',
    exists: true,
    ignored: true,
    error: null,
  });
});

test('disk snapshot during a local edit records disk data but keeps local text conflicted', () => {
  const dirty = State.reduce(opened, { type: 'edit', content: 'local\n' });
  const conflict = State.reduce(dirty, {
    type: 'disk-snapshot', content: 'external\n', revision: 'b', ignored: true,
  });
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.content, 'local\n');
  assert.equal(conflict.diskContent, 'external\n');
  assert.equal(conflict.revision, 'b');
  assert.equal(conflict.exists, true);
  assert.equal(conflict.ignored, true);
});

test('clean deletion keeps the last text as a read-only deleted document', () => {
  const deleted = State.reduce(opened, { type: 'disk-changed', exists: false });
  assert.equal(deleted.status, 'deleted');
  assert.equal(deleted.content, 'one\n');
  assert.equal(deleted.diskContent, 'one\n');
  assert.equal(deleted.revision, 'a');
  assert.equal(deleted.exists, false);
  assert.equal(State.needsDiscard(deleted), false);
});

test('dirty deletion retains local text as a non-recreatable conflict', () => {
  const dirty = State.reduce(opened, { type: 'edit', content: 'local\n' });
  const conflict = State.reduce(dirty, { type: 'disk-changed', exists: false });
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.content, 'local\n');
  assert.equal(conflict.diskContent, 'one\n');
  assert.equal(conflict.exists, false);
  assert.equal(State.needsDiscard(conflict), true);
});

test('reload success replaces a conflict with the latest disk document', () => {
  const dirty = State.reduce(opened, { type: 'edit', content: 'local\n' });
  const conflict = State.reduce(dirty, { type: 'disk-changed', exists: true });
  const reloaded = State.reduce(conflict, {
    type: 'reload-success', content: 'external\n', revision: 'b', ignored: true,
  });
  assert.deepEqual(reloaded, {
    ...opened,
    status: 'clean',
    content: 'external\n',
    diskContent: 'external\n',
    revision: 'b',
    exists: true,
    ignored: true,
    error: null,
  });
});

test('overwrite success makes existing conflict content the clean disk version', () => {
  const dirty = State.reduce(opened, { type: 'edit', content: 'local\n' });
  const conflict = State.reduce(dirty, { type: 'disk-changed', exists: true });
  const overwritten = State.reduce(conflict, {
    type: 'overwrite-success', revision: 'c',
  });
  assert.equal(overwritten.status, 'clean');
  assert.equal(overwritten.content, 'local\n');
  assert.equal(overwritten.diskContent, 'local\n');
  assert.equal(overwritten.revision, 'c');
  assert.equal(overwritten.exists, true);
  assert.equal(State.needsDiscard(overwritten), false);
});

test('discard clears the live document instead of retaining a dirty path or buffer', () => {
  const dirty = State.reduce(opened, { type: 'edit', content: 'local\n' });
  assert.deepEqual(State.reduce(dirty, { type: 'discard' }), State.initial());
});

test('save success is blocked outside dirty state', () => {
  const cleanResult = State.reduce(opened, { type: 'save-success', revision: 'b' });
  const conflict = State.reduce(
    State.reduce(opened, { type: 'edit', content: 'local\n' }),
    { type: 'disk-changed', exists: true },
  );
  const conflictResult = State.reduce(conflict, { type: 'save-success', revision: 'b' });

  assert.strictEqual(cleanResult, opened);
  assert.strictEqual(conflictResult, conflict);
});

test('stale open results cannot replace the current request', () => {
  const newer = State.reduce(loading, {
    type: 'open-start', request: 2, path: 'src/new.js',
  });
  const staleSuccess = State.reduce(newer, {
    type: 'open-success', request: 1, path: 'src/app.js',
    content: 'stale\n', revision: 'old', ignored: false,
  });
  const staleFailure = State.reduce(newer, {
    type: 'open-failure', request: 1, error: 'stale error',
  });

  assert.strictEqual(staleSuccess, newer);
  assert.strictEqual(staleFailure, newer);
});

test('matching open failure becomes an error without exposing stale document data', () => {
  const failed = State.reduce(loading, {
    type: 'open-failure', request: 1, error: 'read_failed',
  });
  assert.deepEqual(failed, {
    ...loading,
    status: 'error',
    error: 'read_failed',
  });
});

test('request gate allows only the newest read or language result', () => {
  const readGate = State.createRequestGate();
  const firstRead = readGate.next();
  const secondRead = readGate.next();
  assert.equal(readGate.isCurrent(firstRead), false);
  assert.equal(readGate.isCurrent(secondRead), true);

  const languageGate = State.createRequestGate();
  const firstLanguage = languageGate.next();
  languageGate.invalidate();
  assert.equal(languageGate.isCurrent(firstLanguage), false);
  const secondLanguage = languageGate.next();
  assert.equal(languageGate.isCurrent(secondLanguage), true);
});
