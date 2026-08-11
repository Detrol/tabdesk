const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createProjectFiles } = require('../project-files');
const { createSessionOwnership, createSessionRegistry } = require('../session-ownership');
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

  fail = false;
  assert.equal(sessions.remember({
    session: 'td-codex-one', name: 'Changed', projectPath: '/verified',
  }), true);
  assert.deepEqual(cache, [
    { ...initial[0], name: 'Changed', projectPath: '/verified' },
    initial[1],
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

test('current ownership removes a stale reservation when cwd has no admitted owner', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const projectFiles = createProjectFiles();
  const state = registry([{
    session: 'td-codex-topic', cwd: fx.worktree, agent: 'codex', name: 'Topic',
  }], projectFiles);

  assert.equal(await state.ownership.rememberCurrent({
    session: 'td-codex-topic', cwd: fx.worktree, agent: 'codex', name: 'Topic',
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

test('failed stale-reservation cleanup keeps the prior claim until retry', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const record = {
    session: 'td-codex-stale', cwd: fx.worktree, projectPath: fx.project,
    agent: 'codex', name: 'Stale',
  };
  const state = registry([record], createProjectFiles(), { durable: false });

  assert.equal(await state.ownership.rememberCurrent(record), null);
  assert.deepEqual(state.records(), [record]);

  state.setDurable(true);
  assert.equal(await state.ownership.rememberCurrent(record), null);
  assert.deepEqual(state.records(), []);
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
