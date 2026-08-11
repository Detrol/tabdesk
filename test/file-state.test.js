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

test('canceling a dirty navigation guard keeps the document and selection unchanged', () => {
  const dirty = State.reduce(opened, { type: 'edit', content: 'local\n' });
  const selection = { rootId: 'root-a', path: 'src/app.js' };
  const confirmDiscard = () => false;

  const nextState = confirmDiscard() ? State.reduce(dirty, { type: 'discard' }) : dirty;
  const nextSelection = confirmDiscard()
    ? { rootId: 'root-b', path: 'src/next.js' }
    : selection;

  assert.strictEqual(nextState, dirty);
  assert.strictEqual(nextSelection, selection);
});

test('accepting a dirty navigation guard discards the live local buffer before navigation', () => {
  const dirty = State.reduce(opened, { type: 'edit', content: 'local\n' });
  const discarded = State.reduce(dirty, { type: 'discard' });
  const navigating = State.reduce(discarded, {
    type: 'open-start', request: 2, path: 'src/next.js',
  });

  assert.deepEqual(discarded, State.initial());
  assert.equal(navigating.status, 'loading');
  assert.equal(navigating.path, 'src/next.js');
  assert.equal(navigating.content, '');
});

test('changed-file reload applies a newer snapshot only after confirmation', () => {
  const dirty = State.reduce(opened, { type: 'edit', content: 'local\n' });
  const conflict = State.reduce(dirty, { type: 'disk-changed', exists: true });
  const canceled = conflict;
  const confirmed = State.reduce(conflict, {
    type: 'reload-success', content: 'disk\n', revision: 'new', ignored: false,
  });

  assert.strictEqual(canceled, conflict);
  assert.equal(canceled.content, 'local\n');
  assert.equal(confirmed.status, 'clean');
  assert.equal(confirmed.content, 'disk\n');
  assert.equal(confirmed.revision, 'new');
});

test('overwrite is unavailable after deletion and copy is a state-preserving action', () => {
  const dirty = State.reduce(opened, { type: 'edit', content: 'local\n' });
  const deletedConflict = State.reduce(dirty, { type: 'disk-changed', exists: false });
  const overwriteAttempt = State.reduce(deletedConflict, {
    type: 'overwrite-success', revision: 'new',
  });
  const copied = deletedConflict;

  assert.equal(deletedConflict.exists, false);
  assert.strictEqual(overwriteAttempt, deletedConflict);
  assert.strictEqual(copied, deletedConflict);
  assert.equal(copied.content, 'local\n');
});

test('project, root, and file identity changes invalidate stale read results', () => {
  const gate = State.createRequestGate();
  const first = {
    token: gate.next(), projectPath: 'project-a', rootId: 'root-a', path: 'a.txt',
  };
  const active = {
    token: gate.next(), projectPath: 'project-b', rootId: 'root-b', path: 'b.txt',
  };
  const matches = (request, identity) => gate.isCurrent(request.token)
    && request.projectPath === identity.projectPath
    && request.rootId === identity.rootId
    && request.path === identity.path;

  assert.equal(matches(first, active), false);
  assert.equal(matches(active, active), true);
  gate.invalidate();
  assert.equal(matches(active, active), false);
});

test('a clean ignored file survives hiding ignored tree entries', () => {
  const ignored = State.reduce(loading, {
    type: 'open-success', request: 1, path: 'build/generated.js',
    content: 'generated\n', revision: 'ignored-revision', ignored: true,
  });
  const treeFilter = { showIgnored: true };
  const hiddenTreeFilter = { ...treeFilter, showIgnored: false };

  assert.equal(hiddenTreeFilter.showIgnored, false);
  assert.equal(ignored.status, 'clean');
  assert.equal(ignored.path, 'build/generated.js');
  assert.equal(ignored.content, 'generated\n');
  assert.equal(ignored.ignored, true);
});

test('verified write snapshot updates the disk base while preserving a later local edit', () => {
  const firstEdit = State.reduce(opened, { type: 'edit', content: 'saved\n' });
  const laterEdit = State.reduce(firstEdit, { type: 'edit', content: 'newer\n' });
  const reconciled = State.reduce(laterEdit, {
    type: 'write-snapshot', content: 'saved\n', revision: 'r1', ignored: true,
  });

  assert.equal(reconciled.status, 'dirty');
  assert.equal(reconciled.content, 'newer\n');
  assert.equal(reconciled.diskContent, 'saved\n');
  assert.equal(reconciled.revision, 'r1');
  assert.equal(reconciled.exists, true);
  assert.equal(reconciled.ignored, true);
  assert.equal(State.needsDiscard(reconciled), true);
});

test('verified overwrite snapshot converts a later conflicted edit into dirty against the new base', () => {
  const dirty = State.reduce(opened, { type: 'edit', content: 'overwritten\n' });
  const conflict = State.reduce(dirty, { type: 'disk-changed', exists: true });
  const laterEdit = State.reduce(conflict, { type: 'edit', content: 'newer\n' });
  const reconciled = State.reduce(laterEdit, {
    type: 'write-snapshot', content: 'overwritten\n', revision: 'r1', ignored: false,
  });

  assert.equal(reconciled.status, 'dirty');
  assert.equal(reconciled.content, 'newer\n');
  assert.equal(reconciled.diskContent, 'overwritten\n');
  assert.equal(reconciled.revision, 'r1');
  assert.equal(reconciled.exists, true);
});
