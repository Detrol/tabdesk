const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { createProjectFiles } = require('../project-files');
const {
  classifyTmuxSessionList,
  createSessionOwnership,
  createSessionRegistry,
} = require('../session-ownership');
const TabOrder = require('../renderer/tab-order');

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tabdesk-session-owner-'));
  const project = path.join(base, 'project');
  fs.mkdirSync(project);
  execFileSync('git', ['-C', project, 'init', '--initial-branch=main']);
  execFileSync('git', ['-C', project, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', project, 'config', 'user.name', 'TabDesk test']);
  fs.writeFileSync(path.join(project, '.gitignore'), '.worktrees/\n');
  execFileSync('git', ['-C', project, 'add', '.gitignore']);
  execFileSync('git', ['-C', project, 'commit', '-m', 'initial']);
  const worktree = path.join(project, '.worktrees', 'topic');
  fs.mkdirSync(path.dirname(worktree));
  execFileSync('git', ['-C', project, 'worktree', 'add', '-b', 'topic', worktree]);
  return {
    base,
    project,
    worktree,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

function fatalGitProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  child.kill = () => true;
  process.nextTick(() => {
    child.stderr.emit('data', Buffer.from('fatal: expected test failure\n'));
    child.emit('close', 1, null);
  });
  return child;
}

function registry(initial, projectFiles, options = {}) {
  let records = initial.map((record) => ({ ...record }));
  let durable = options.durable !== false;
  let writes = 0;
  const sessions = createSessionRegistry({
    read: () => records,
    write(next) {
      writes += 1;
      records = next;
      return durable;
    },
    upsert: TabOrder.upsertRecord,
  });
  const ownership = createSessionOwnership({
    projectFiles,
    remember: sessions.remember,
    forget: sessions.forget,
  });
  return {
    ownership,
    records: sessions.records,
    setDurable(value) { durable = value; },
    writes: () => writes,
  };
}

test('tmux listing classifier trusts only complete success or stable C-locale absence', () => {
  assert.deepEqual(classifyTmuxSessionList(null, 'td-one /one\nother /two\n', ''), {
    known: true,
    rows: [
      { session: 'td-one', cwd: '/one' },
      { session: 'other', cwd: '/two' },
    ],
  });
  assert.deepEqual(classifyTmuxSessionList(null, '', ''), { known: true, rows: [] });
  assert.deepEqual(classifyTmuxSessionList(
    Object.assign(new Error('no server'), { code: 1 }),
    '',
    'no server running on /tmp/tmux-test/default\n',
  ), { known: true, rows: [] });

  const unknown = [
    [Object.assign(new Error('missing'), { code: 'ENOENT' }), '', ''],
    [Object.assign(new Error('denied'), { code: 'EACCES' }), '', ''],
    [Object.assign(new Error('signal'), { code: null, signal: 'SIGTERM' }), '', ''],
    [Object.assign(new Error('partial'), { code: 1 }), 'td-one /one\n', 'transient socket error\n'],
    [Object.assign(new Error('other'), { code: 1 }), '', 'failed to connect to server\n'],
    [Object.assign(new Error('partial absence'), { code: 1 }), 'td-one /one\n',
      'no server running on /tmp/tmux-test/default\n'],
    [null, 'missing-path\n', ''],
    [null, ' /missing-session\n', ''],
  ];
  for (const [error, stdout, stderr] of unknown) {
    assert.deepEqual(classifyTmuxSessionList(error, stdout, stderr), {
      known: false,
      rows: [],
    });
  }
});

test('session registry rolls back cache mutations when durable remember or forget fails', () => {
  const initial = [
    { session: 'td-codex-one', cwd: '/one', name: 'One', marker: 'first' },
    { session: 'td-claude-two', cwd: '/two', name: 'Two', marker: 'second' },
  ];
  let cache = initial.map((record) => ({ ...record }));
  let fail = true;
  let writes = 0;
  const sessions = createSessionRegistry({
    read: () => cache,
    write(next) {
      writes += 1;
      cache = next;
      return !fail;
    },
    upsert: TabOrder.upsertRecord,
  });

  assert.equal(sessions.remember({
    session: 'td-codex-one', name: 'Changed', projectPath: '/verified',
  }), false);
  assert.deepEqual(cache, initial);
  assert.equal(writes, 2);

  assert.equal(sessions.forget('td-claude-two'), false);
  assert.deepEqual(cache, initial);
  assert.equal(writes, 4);

  assert.equal(sessions.replace([initial[1], initial[0]]), false);
  assert.deepEqual(cache, initial);
  assert.equal(writes, 6);

  fail = false;
  assert.equal(sessions.replace([initial[1], initial[0]]), true);
  assert.deepEqual(cache, [initial[1], initial[0]]);
  assert.equal(sessions.remember({
    session: 'td-codex-one', name: 'Changed', projectPath: '/verified',
  }), true);
  assert.deepEqual(cache, [
    initial[1],
    { ...initial[0], name: 'Changed', projectPath: '/verified' },
  ]);
  assert.equal(sessions.forget('td-claude-two'), true);
  assert.deepEqual(cache, [
    { ...initial[0], name: 'Changed', projectPath: '/verified' },
  ]);
});

test('current ownership persists only the main-derived admitted parent', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const projectFiles = createProjectFiles();
  projectFiles.admitProject(fx.project, 'picker');
  const existing = {
    session: 'td-codex-topic', cwd: fx.worktree, agent: 'codex', name: 'Reserved',
    agentSession: 'conversation-1', marker: 'first',
  };
  const following = { session: 'td-claude-other', cwd: fx.project, marker: 'second' };
  const state = registry([existing, following], projectFiles);

  const verified = await state.ownership.rememberCurrent({
    session: 'td-codex-topic',
    cwd: fx.worktree,
    agent: 'codex',
    name: 'Topic',
    projectPath: path.join(fx.base, 'renderer-forgery'),
  });

  assert.deepEqual(verified, {
    session: 'td-codex-topic',
    cwd: fx.worktree,
    agent: 'codex',
    name: 'Topic',
    projectPath: fx.project,
  });
  assert.deepEqual(state.records(), [
    { ...existing, ...verified },
    following,
  ]);
  assert.equal(state.records()[0].agentSession, 'conversation-1');
  assert.deepEqual(state.records().map(({ marker }) => marker), ['first', 'second']);
});

test('current ownership does not persist after its caller is invalidated during verification', async () => {
  let resolveOwner;
  const owner = new Promise((resolve) => { resolveOwner = resolve; });
  const projectFiles = {
    resolveOwner: () => owner,
    verifySelectionOwner: async () => ({ ok: false, error: 'project-unavailable' }),
    restoreSelection: async () => ({ ok: false, error: 'project-unavailable' }),
    replaceAdmissions() {},
  };
  const state = registry([], projectFiles);
  let current = true;
  const pending = state.ownership.rememberCurrent({
    session: 'td-codex-cancelled', cwd: '/project', agent: 'codex', name: 'Cancelled',
  }, () => current);

  current = false;
  resolveOwner({ ok: true, projectPath: '/project', selectedPath: '/project' });

  assert.equal(await pending, null);
  assert.deepEqual(state.records(), []);
});

test('transient attach verification failure preserves an existing stored claim for restart quarantine', async () => {
  const record = {
    session: 'td-codex-topic', cwd: '/external/.worktrees/topic', projectPath: '/external',
    agent: 'codex', name: 'Topic', marker: 'existing',
  };
  let legacyFallbacks = 0;
  const projectFiles = {
    resolveOwner: async () => ({ ok: false, error: 'project-unavailable' }),
    verifySelectionOwner: async () => ({ ok: false, error: 'project-unavailable' }),
    restoreSelection: async () => ({ ok: false, error: 'project-unavailable' }),
    admitSelection: async () => {
      legacyFallbacks += 1;
      return { ok: true, projectPath: record.cwd, selectedPath: record.cwd };
    },
    replaceAdmissions() {},
  };
  const state = registry([record], projectFiles);

  assert.equal(await state.ownership.rememberCurrent(record), null);
  assert.deepEqual(state.records(), [record]);

  const prepared = state.ownership.prepareRestore(state.records(), () => true);
  assert.equal(prepared.claimed.has(record.session), true);
  const keep = state.ownership.reconcileLive(prepared, new Set([record.session]));
  assert.deepEqual(await state.ownership.restore(keep, {
    persistedSessions: prepared.claimed,
  }), []);
  assert.equal(legacyFallbacks, 0);
  assert.deepEqual(state.records(), [record]);
});

test('failed ownership verification for a new allocation leaves an empty registry unchanged', async () => {
  const projectFiles = {
    resolveOwner: async () => ({ ok: false, error: 'project-unavailable' }),
    verifySelectionOwner: async () => ({ ok: false, error: 'project-unavailable' }),
    restoreSelection: async () => ({ ok: false, error: 'project-unavailable' }),
    admitSelection: async () => ({ ok: false, error: 'project-unavailable' }),
    replaceAdmissions() {},
  };
  const state = registry([], projectFiles);

  assert.equal(await state.ownership.rememberCurrent({
    session: 'td-codex-new', cwd: '/new', agent: 'codex', name: 'New',
  }), null);
  assert.deepEqual(state.records(), []);
});

test('current ownership fails closed and rolls back the registry when persistence fails', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const projectFiles = createProjectFiles();
  projectFiles.admitProject(fx.project, 'configured');
  const initial = [{
    session: 'td-codex-topic', cwd: fx.worktree, agent: 'codex', name: 'Reserved', marker: 'first',
  }];
  const state = registry(initial, projectFiles, { durable: false });

  assert.equal(await state.ownership.rememberCurrent({
    session: 'td-codex-topic', cwd: fx.worktree, agent: 'codex', name: 'Started',
  }), null);
  assert.deepEqual(state.records(), initial);

  state.setDurable(true);
  assert.deepEqual(await state.ownership.rememberCurrent({
    session: 'td-codex-topic', cwd: fx.worktree, agent: 'codex', name: 'Started',
  }), {
    session: 'td-codex-topic', cwd: fx.worktree, agent: 'codex', name: 'Started',
    projectPath: fx.project,
  });
  assert.deepEqual(state.records(), [{
    ...initial[0], name: 'Started', projectPath: fx.project,
  }]);
});

test('restore verifies stored owners, migrates legacy records, and preserves record order and metadata', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const legacy = path.join(fx.base, 'legacy');
  const foreign = path.join(fx.base, 'foreign');
  fs.mkdirSync(legacy);
  fs.mkdirSync(foreign);
  const initial = [
    {
      session: 'td-codex-topic', cwd: fx.worktree, projectPath: fx.project,
      agent: 'codex', name: 'Topic', agentSession: 'conversation-1', marker: 'first',
    },
    {
      session: 'td-claude-legacy', cwd: legacy,
      agent: 'claude', name: 'Legacy', agentSession: 'conversation-2', marker: 'second',
    },
    {
      session: 'td-codex-forged', cwd: fx.worktree, projectPath: foreign,
      agent: 'codex', name: 'Forged', marker: 'third',
    },
  ];
  const projectFiles = createProjectFiles();
  const state = registry(initial, projectFiles);

  const restored = await state.ownership.restore(initial, {
    persistedSessions: new Set(initial.map(({ session }) => session)),
  });

  assert.deepEqual(restored.map(({ session, projectPath }) => ({ session, projectPath })), [
    { session: 'td-codex-topic', projectPath: fx.project },
    { session: 'td-claude-legacy', projectPath: legacy },
  ]);
  assert.deepEqual(state.records(), [
    initial[0],
    { ...initial[1], projectPath: legacy },
    initial[2],
  ]);
  assert.deepEqual(state.records().map(({ marker }) => marker), ['first', 'second', 'third']);
  assert.equal((await projectFiles.openProject(fx.project)).ok, true);
  assert.deepEqual((await projectFiles.openProject(fx.project)).roots.map(({ kind }) => kind), [
    'project', 'worktree',
  ]);
  assert.equal((await projectFiles.openProject(fx.worktree)).error, 'project-unavailable');
  assert.equal((await projectFiles.openProject(foreign)).error, 'project-unavailable');
});

test('restore treats orphan tmux sessions as legacy but does not persist them prematurely', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const projectFiles = createProjectFiles();
  const state = registry([], projectFiles);
  const orphan = { session: 'td-codex-orphan', cwd: fx.worktree, agent: null, name: 'topic' };

  const restored = await state.ownership.restore([orphan], { persistedSessions: new Set() });

  assert.deepEqual(restored, [{ ...orphan, projectPath: fx.worktree }]);
  assert.deepEqual(state.records(), []);
  assert.equal((await projectFiles.openProject(fx.worktree)).ok, true);
});

test('legacy restore is unauthorized until its ownership migration persists durably', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const record = {
    session: 'td-codex-legacy', cwd: fx.worktree, agent: 'codex', name: 'Legacy', marker: 'first',
  };
  const projectFiles = createProjectFiles();
  const state = registry([record], projectFiles, { durable: false });

  assert.deepEqual(await state.ownership.restore([record], {
    persistedSessions: new Set([record.session]),
  }), []);
  assert.deepEqual(state.records(), [record]);
  assert.equal((await projectFiles.openProject(fx.worktree)).error, 'project-unavailable');

  state.setDurable(true);
  assert.deepEqual(await state.ownership.restore(state.records(), {
    persistedSessions: new Set([record.session]),
  }), [{ ...record, projectPath: fx.worktree }]);
  assert.deepEqual(state.records(), [{ ...record, projectPath: fx.worktree }]);
  assert.equal((await projectFiles.openProject(fx.worktree)).ok, true);
});

test('stored ownership restores without a gratuitous registry rewrite', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const record = {
    session: 'td-codex-topic', cwd: fx.worktree, projectPath: fx.project,
    agent: 'codex', name: 'Topic',
  };
  const projectFiles = createProjectFiles();
  const state = registry([record], projectFiles, { durable: false });

  assert.deepEqual(await state.ownership.restore([record], {
    persistedSessions: new Set([record.session]),
  }), [record]);
  assert.deepEqual(state.records(), [record]);
  assert.equal(state.writes(), 0);
});

test('restore verifies stored parents before legacy records without changing output or registry order', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const legacy = {
    session: 'td-codex-legacy', cwd: fx.worktree,
    agent: 'codex', name: 'Legacy', marker: 'legacy',
  };
  const stored = {
    session: 'td-claude-parent', cwd: fx.project, projectPath: fx.project,
    agent: 'claude', name: 'Parent', marker: 'stored',
  };

  for (const initial of [[legacy, stored], [stored, legacy]]) {
    const projectFiles = createProjectFiles();
    const state = registry(initial, projectFiles);
    const restored = await state.ownership.restore(initial, {
      persistedSessions: new Set(initial.map(({ session }) => session)),
    });

    assert.deepEqual(restored.map(({ session }) => session), initial.map(({ session }) => session));
    assert.deepEqual(restored.map(({ projectPath }) => projectPath), [fx.project, fx.project]);
    assert.deepEqual(state.records().map(({ session }) => session), initial.map(({ session }) => session));
    assert.deepEqual(state.records().map(({ marker }) => marker), initial.map(({ marker }) => marker));
    assert.deepEqual(state.records().find(({ session }) => session === legacy.session), {
      ...legacy,
      projectPath: fx.project,
    });
    assert.deepEqual((await projectFiles.openProject(fx.project)).roots.map(({ kind }) => kind), [
      'project', 'worktree',
    ]);
    assert.equal((await projectFiles.openProject(fx.worktree)).error, 'project-unavailable');
  }
});

test('all-legacy parent and worktree records restore under the parent in either order', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const worktree = {
    session: 'td-codex-worktree', cwd: fx.worktree,
    agent: 'codex', name: 'Worktree', agentSession: 'conversation-worktree', marker: 'worktree',
  };
  const parent = {
    session: 'td-claude-parent', cwd: fx.project,
    agent: 'claude', name: 'Parent', agentSession: 'conversation-parent', marker: 'parent',
  };

  for (const initial of [[worktree, parent], [parent, worktree]]) {
    const projectFiles = createProjectFiles();
    const state = registry(initial, projectFiles);
    const restored = await state.ownership.restore(initial, {
      persistedSessions: new Set(initial.map(({ session }) => session)),
    });

    assert.deepEqual(restored.map(({ session }) => session), initial.map(({ session }) => session));
    assert.deepEqual(restored.map(({ projectPath }) => projectPath), [fx.project, fx.project]);
    assert.deepEqual(restored.map(({ marker }) => marker), initial.map(({ marker }) => marker));
    assert.deepEqual(state.records(), initial.map((record) => ({
      ...record,
      projectPath: fx.project,
    })));
    assert.deepEqual((await projectFiles.openProject(fx.project)).roots.map(({ kind }) => kind), [
      'project', 'worktree',
    ]);
    assert.equal((await projectFiles.openProject(fx.worktree)).error, 'project-unavailable');
  }
});

test('legacy relationship discovery exposes no file authority before migration is durable', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  fs.writeFileSync(path.join(fx.project, 'safe.txt'), 'private');
  const files = createProjectFiles();
  let releasePause;
  const pause = new Promise((resolve) => { releasePause = resolve; });
  let signalPaused;
  const paused = new Promise((resolve) => { signalPaused = resolve; });
  let didPause = false;
  async function pauseAfterRelationship(operation, candidateProjectPath, selectedPath) {
    const result = await operation(candidateProjectPath, selectedPath);
    if (!didPause && result.ok
      && candidateProjectPath === fx.project && selectedPath === fx.worktree) {
      didPause = true;
      signalPaused();
      await pause;
    }
    return result;
  }
  const guardedFiles = {
    ...files,
    verifySelectionOwner: (...args) => pauseAfterRelationship(
      files.verifySelectionOwner,
      ...args,
    ),
    restoreSelection: (...args) => pauseAfterRelationship(files.restoreSelection, ...args),
  };
  const initial = [
    { session: 'td-codex-worktree', cwd: fx.worktree, name: 'Worktree' },
    { session: 'td-claude-parent', cwd: fx.project, name: 'Parent' },
  ];
  const state = registry(initial, guardedFiles, { durable: false });
  const restorePromise = state.ownership.restore(initial, {
    persistedSessions: new Set(initial.map(({ session }) => session)),
  });
  t.after(() => releasePause());

  assert.equal(await Promise.race([
    paused.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 500)),
  ]), true);
  const opened = await files.openProject(fx.project);
  const worktreeOpened = await files.openProject(fx.worktree);
  const root = opened.ok && opened.roots.find(({ kind }) => kind === 'project');
  const identity = opened.ok
    ? { projectId: opened.projectId, rootId: root.id }
    : { projectId: 'not-admitted', rootId: 'not-admitted' };
  const listed = await files.list({ ...identity, directory: '' });
  const read = await files.read({ ...identity, path: 'safe.txt' });
  assert.deepEqual({ opened, worktreeOpened, listed, read }, {
    opened: { ok: false, error: 'project-unavailable' },
    worktreeOpened: { ok: false, error: 'project-unavailable' },
    listed: { ok: false, error: 'project-unavailable' },
    read: { ok: false, error: 'project-unavailable' },
  });

  releasePause();
  assert.deepEqual(await restorePromise, []);
  assert.deepEqual(state.records(), initial);
  assert.equal((await files.openProject(fx.project)).error, 'project-unavailable');
  assert.equal((await files.openProject(fx.worktree)).error, 'project-unavailable');
});

test('legacy migration persists its derived owner before a fresh final admission check', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const files = createProjectFiles();
  let finalChecks = 0;
  const guardedFiles = {
    ...files,
    restoreSelection: async () => {
      finalChecks += 1;
      return { ok: false, error: 'project-unavailable', verificationFailed: true };
    },
  };
  const worktree = {
    session: 'td-codex-worktree', cwd: fx.worktree, name: 'Worktree', marker: 'persisted',
  };
  const parentOrphan = {
    session: 'td-claude-parent-orphan', cwd: fx.project, name: 'Parent', marker: 'orphan',
  };
  const state = registry([worktree], guardedFiles);

  assert.deepEqual(await state.ownership.restore([worktree, parentOrphan], {
    persistedSessions: new Set([worktree.session]),
  }), []);
  assert.equal(finalChecks >= 1, true);
  assert.deepEqual(state.records(), [{ ...worktree, projectPath: fx.project }]);
  assert.equal((await files.openProject(fx.project)).error, 'project-unavailable');
  assert.equal((await files.openProject(fx.worktree)).error, 'project-unavailable');
});

test('current-admission Git failure cannot downgrade a legacy worktree to itself', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const candidate = fx.worktree;
  const files = createProjectFiles({
    spawn: fatalGitProcess,
  });
  files.admitProject(fx.project, 'configured');
  const record = {
    session: 'td-codex-worktree', cwd: candidate, name: 'Worktree', marker: 'legacy',
  };
  const state = registry([record], files);

  assert.deepEqual(await state.ownership.restore([record], {
    persistedSessions: new Set([record.session]),
  }), []);
  assert.deepEqual(state.records(), [record]);
  assert.equal(state.writes(), 0);
  files.replaceAdmissions('configured', []);
  assert.equal((await files.openProject(candidate)).error, 'project-unavailable');
});

test('legacy relationship discovery rejects fake convention paths and different repositories', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const fake = path.join(fx.project, '.worktrees', 'fake');
  fs.mkdirSync(fake);
  const foreign = path.join(fx.base, 'foreign');
  fs.mkdirSync(foreign);
  execFileSync('git', ['-C', foreign, 'init', '--initial-branch=main']);
  const initial = [
    { session: 'td-codex-fake', cwd: fake, name: 'Fake', marker: 'fake' },
    { session: 'td-claude-foreign', cwd: foreign, name: 'Foreign', marker: 'foreign' },
    { session: 'td-codex-parent', cwd: fx.project, name: 'Parent', marker: 'parent' },
  ];
  const projectFiles = createProjectFiles();
  const state = registry(initial, projectFiles);

  const restored = await state.ownership.restore(initial, {
    persistedSessions: new Set(initial.map(({ session }) => session)),
  });

  assert.deepEqual(restored.map(({ projectPath }) => projectPath), [fake, foreign, fx.project]);
  assert.deepEqual(restored.map(({ marker }) => marker), initial.map(({ marker }) => marker));
  assert.deepEqual(state.records(), initial.map((record) => ({
    ...record,
    projectPath: record.cwd,
  })));
});

test('a forged stored owner is excluded and cannot seed legacy ownership', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const foreign = path.join(fx.base, 'foreign');
  fs.mkdirSync(foreign);
  const legacy = {
    session: 'td-codex-legacy', cwd: fx.worktree, agent: 'codex', name: 'Legacy',
  };
  const forged = {
    session: 'td-claude-forged', cwd: fx.worktree, projectPath: foreign,
    agent: 'claude', name: 'Forged',
  };
  const projectFiles = createProjectFiles();
  const state = registry([legacy, forged], projectFiles);

  assert.deepEqual(await state.ownership.restore([legacy, forged], {
    persistedSessions: new Set([legacy.session, forged.session]),
  }), [{ ...legacy, projectPath: fx.worktree }]);
  assert.equal((await projectFiles.openProject(foreign)).error, 'project-unavailable');
  assert.equal((await projectFiles.openProject(fx.worktree)).ok, true);
  assert.deepEqual(state.records(), [{ ...legacy, projectPath: fx.worktree }, forged]);
});

test('a rejected live stored owner stays claimed across consecutive restarts until tmux proves absence', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const foreign = path.join(fx.base, 'foreign');
  fs.mkdirSync(foreign);
  const record = {
    session: 'td-codex-forged', cwd: fx.worktree, projectPath: foreign,
    agent: 'codex', name: 'Forged',
  };
  const projectFiles = createProjectFiles();
  const state = registry([record], projectFiles);

  for (let restart = 0; restart < 2; restart++) {
    const prepared = state.ownership.prepareRestore(state.records(), fs.existsSync);
    assert.equal(prepared.claimed.has(record.session), true);
    const keep = state.ownership.reconcileLive(prepared, new Set([record.session]));
    assert.deepEqual(await state.ownership.restore(keep, {
      persistedSessions: prepared.claimed,
    }), []);
    assert.deepEqual(state.records(), [record]);
    assert.equal((await projectFiles.openProject(foreign)).error, 'project-unavailable');
    assert.equal((await projectFiles.openProject(fx.worktree)).error, 'project-unavailable');
  }

  const final = state.ownership.prepareRestore(state.records(), fs.existsSync);
  assert.deepEqual(state.ownership.reconcileLive(final, new Set()), []);
  assert.deepEqual(state.records(), []);
});

test('a missing live cwd stays claimed across consecutive restarts until tmux proves absence', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const missing = path.join(fx.base, 'missing');
  const record = {
    session: 'td-codex-missing', cwd: missing, projectPath: fx.project,
    agent: 'codex', name: 'Missing',
  };
  const state = registry([record], createProjectFiles());

  for (let restart = 0; restart < 2; restart++) {
    const prepared = state.ownership.prepareRestore(state.records(), fs.existsSync);
    assert.deepEqual(prepared.records, []);
    assert.deepEqual([...prepared.claimed], ['td-codex-missing']);
    assert.deepEqual(state.ownership.reconcileLive(prepared, new Set([record.session])), []);
    assert.deepEqual(state.records(), [record]);
  }

  const final = state.ownership.prepareRestore(state.records(), fs.existsSync);
  assert.deepEqual(state.ownership.reconcileLive(final, new Set()), []);
  assert.deepEqual(state.records(), []);
});

test('failed durable cleanup keeps the quarantine record until a later retry succeeds', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const record = {
    session: 'td-codex-quarantine', cwd: fx.worktree, projectPath: fx.project,
    agent: 'codex', name: 'Quarantine',
  };
  const state = registry([record], createProjectFiles(), { durable: false });

  let prepared = state.ownership.prepareRestore(state.records(), fs.existsSync);
  assert.deepEqual(state.ownership.reconcileLive(prepared, new Set()), []);
  assert.deepEqual(state.records(), [record]);

  state.setDurable(true);
  prepared = state.ownership.prepareRestore(state.records(), fs.existsSync);
  assert.deepEqual(state.ownership.reconcileLive(prepared, new Set()), []);
  assert.deepEqual(state.records(), []);
});
