const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createProjectFiles } = require('../project-files');
const { createSessionOwnership } = require('../session-ownership');
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

function registry(initial, projectFiles) {
  let records = initial.map((record) => ({ ...record }));
  const ownership = createSessionOwnership({
    projectFiles,
    remember(record) {
      records = TabOrder.upsertRecord(records, record);
    },
    forget(session) {
      records = records.filter((record) => record.session !== session);
    },
  });
  return { ownership, records: () => records };
}

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
  ]);
  assert.deepEqual(state.records().map(({ marker }) => marker), ['first', 'second']);
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

test('prepareRestore removes missing records while keeping their sessions claimed', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const missing = path.join(fx.base, 'missing');
  const record = {
    session: 'td-codex-missing', cwd: missing, projectPath: fx.project,
    agent: 'codex', name: 'Missing',
  };
  const state = registry([record], createProjectFiles());

  const prepared = state.ownership.prepareRestore([record], fs.existsSync);

  assert.deepEqual(prepared.records, []);
  assert.deepEqual([...prepared.claimed], ['td-codex-missing']);
  assert.deepEqual(state.records(), []);
});
