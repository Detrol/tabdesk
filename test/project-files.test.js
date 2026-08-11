const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { EventEmitter } = require('events');
const { createProjectFiles } = require('../project-files');

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tabdesk-files-'));
  const project = path.join(base, 'project');
  fs.mkdirSync(project);
  return {
    base,
    project,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function gitProject(project) {
  git(project, ['init', '--initial-branch=main']);
  git(project, ['config', 'user.email', 'test@example.invalid']);
  git(project, ['config', 'user.name', 'TabDesk test']);
  fs.writeFileSync(path.join(project, '.gitignore'), '.worktrees/\n');
  git(project, ['add', '.gitignore']);
  git(project, ['commit', '-m', 'initial']);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function documentTemps(directory) {
  return fs.readdirSync(directory).filter((name) => name.includes('.tabdesk-'));
}

async function admittedFiles(project, options) {
  const files = createProjectFiles(options);
  files.admitProject(project, 'configured');
  return { files, ids: await openedRoot(files, project) };
}

class FakeRootWatcher extends EventEmitter {
  constructor() {
    super();
    this.closed = false;
    this.closeCalls = 0;
  }

  close() {
    this.closeCalls += 1;
    if (!this.closed) {
      this.closed = true;
      this.removeAllListeners();
    }
    return Promise.resolve();
  }
}

function manualScheduler() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(callback) {
      const id = nextId++;
      pending.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    flush() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
    get size() {
      return pending.size;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withDeadline(promise, milliseconds = 300) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ deadline: true }), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function waitForCondition(predicate, attempts = 1000, delayMs = 0) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => (delayMs ? setTimeout(resolve, delayMs) : setImmediate(resolve)));
  }
  assert.fail('condition was not reached');
}

async function waitForProcessExit(pid, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!processRunning(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`process ${pid} did not exit`);
}

function processExists(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function processRunning(pid) {
  if (!processExists(pid)) return false;
  if (process.platform !== 'linux') return true;
  try {
    const state = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').match(/\) ([A-Z]) /)?.[1];
    return state !== 'Z';
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function forceKillTestProcess(child, descendantPid) {
  if (process.platform !== 'win32' && Number.isInteger(child?.pid)) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  }
  try { child?.kill('SIGKILL'); } catch (_) {}
  try { if (processExists(descendantPid)) process.kill(descendantPid, 'SIGKILL'); } catch (_) {}
}

function fakeGitProcess({ code = 0, stdout = '', stderr = '', stdoutChunks, stderrChunks } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  child.kill = () => true;
  process.nextTick(() => {
    for (const chunk of stdoutChunks || (stdout ? [stdout] : [])) child.stdout.emit('data', Buffer.from(chunk));
    for (const chunk of stderrChunks || (stderr ? [stderr] : [])) child.stderr.emit('data', Buffer.from(chunk));
    child.emit('close', code, null);
  });
  return child;
}

test('only an admitted project can be opened', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const files = createProjectFiles();

  assert.equal((await files.openProject(fx.project)).error, 'project-unavailable');
  assert.equal(files.admitProject(fx.project, 'configured').ok, true);

  const opened = await files.openProject(fx.project);
  assert.equal(opened.ok, true);
  assert.match(opened.projectId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(opened.roots.map(({ kind, label }) => ({ kind, label })), [
    { kind: 'project', label: 'project' },
  ]);
  assert.deepEqual(Object.keys(opened.roots[0]).sort(), ['id', 'kind', 'label']);
});

test('replaceAdmissions revokes paths no longer owned by that source', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const files = createProjectFiles();

  files.replaceAdmissions('configured', [fx.project]);
  assert.equal((await files.openProject(fx.project)).ok, true);
  files.replaceAdmissions('configured', []);
  assert.equal((await files.openProject(fx.project)).error, 'project-unavailable');
});

test('offers only verified Git worktrees after the project root', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  const worktree = path.join(fx.project, '.worktrees', 'topic');
  fs.mkdirSync(path.dirname(worktree));
  git(fx.project, ['worktree', 'add', '-b', 'topic', worktree]);
  fs.mkdirSync(path.join(fx.project, '.worktrees', 'fake'));

  const files = createProjectFiles();
  files.admitProject(fx.project, 'configured');
  const opened = await files.openProject(fx.project);

  assert.deepEqual(opened.roots.map(({ kind, label }) => ({ kind, label })), [
    { kind: 'project', label: 'project' },
    { kind: 'worktree', label: 'topic' },
  ]);
  assert.deepEqual(Object.keys(opened.roots[1]).sort(), ['id', 'kind', 'label']);
  assert.deepEqual(await files.describeWorktrees(fx.project), [
    { name: 'topic', path: worktree },
  ]);
});

test('accepts an admitted symlink spelling without admitting its real spelling', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const link = path.join(fx.base, 'project-link');
  fs.symlinkSync(fx.project, link, 'dir');
  const files = createProjectFiles();

  assert.equal(files.admitProject(link, 'picker').ok, true);
  assert.equal((await files.openProject(link)).ok, true);
  assert.equal((await files.openProject(fx.project)).error, 'project-unavailable');
});

test('rejects project roots whose logical or real path enters Git metadata', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  const metadataChild = path.join(fx.project, '.git', 'objects');
  const alias = path.join(fx.base, 'repository-data');
  fs.symlinkSync(path.join(fx.project, '.git'), alias, 'dir');
  const files = createProjectFiles();

  for (const selected of [path.join(fx.project, '.git'), metadataChild, alias]) {
    assert.deepEqual(files.admitProject(selected, 'picker'), {
      ok: false,
      error: 'project-unavailable',
    });
    assert.deepEqual(await files.admitSelection(selected, 'picker'), {
      ok: false,
      error: 'project-unavailable',
    });
    assert.deepEqual(await files.openProject(selected), {
      ok: false,
      error: 'project-unavailable',
    });
  }
});

test('allows ordinary dot-git-like names and real linked worktree roots', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const ordinary = path.join(fx.base, '.github-project');
  fs.mkdirSync(ordinary);
  const ordinaryFiles = createProjectFiles();
  assert.equal(ordinaryFiles.admitProject(ordinary, 'picker').ok, true);
  assert.equal((await ordinaryFiles.openProject(ordinary)).ok, true);

  gitProject(fx.project);
  const worktree = path.join(fx.project, '.worktrees', 'topic');
  fs.mkdirSync(path.dirname(worktree));
  git(fx.project, ['worktree', 'add', '-b', 'topic', worktree]);
  assert.equal(fs.statSync(path.join(worktree, '.git')).isFile(), true);
  const worktreeFiles = createProjectFiles();
  assert.equal(worktreeFiles.admitProject(worktree, 'picker').ok, true);
  assert.equal((await worktreeFiles.openProject(worktree)).ok, true);
});

test('revokes every root operation when an admitted alias is retargeted into Git metadata', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  fs.writeFileSync(path.join(fx.project, 'safe.txt'), 'original');
  const alias = path.join(fx.base, 'project-alias');
  fs.symlinkSync(fx.project, alias, 'dir');
  const files = createProjectFiles();
  assert.equal(files.admitProject(alias, 'picker').ok, true);
  const ids = await openedRoot(files, alias);
  const opened = await files.read({ ...ids, path: 'safe.txt' });

  fs.unlinkSync(alias);
  fs.symlinkSync(path.join(fx.project, '.git'), alias, 'dir');

  assert.deepEqual(await files.openProject(alias), { ok: false, error: 'project-unavailable' });
  await assertRootOperationsUnavailable(files, ids, opened.revision);
});

test('admitSelection keeps a verified selected worktree under its admitted project', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  const worktree = path.join(fx.project, '.worktrees', 'topic');
  fs.mkdirSync(path.dirname(worktree));
  git(fx.project, ['worktree', 'add', '-b', 'topic', worktree]);
  const files = createProjectFiles();
  files.admitProject(fx.project, 'configured');

  assert.deepEqual(await files.admitSelection(worktree, 'picker'), {
    ok: true,
    projectPath: fx.project,
    selectedPath: worktree,
  });
});

test('admitSelection does not broaden a fake convention-folder selection', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const fake = path.join(fx.project, '.worktrees', 'fake');
  fs.mkdirSync(fake, { recursive: true });
  const files = createProjectFiles();
  files.admitProject(fx.project, 'configured');

  assert.deepEqual(await files.admitSelection(fake, 'picker'), {
    ok: true,
    projectPath: fake,
    selectedPath: fake,
  });
});

test('preserves root IDs across unchanged refreshes', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  const worktree = path.join(fx.project, '.worktrees', 'topic');
  fs.mkdirSync(path.dirname(worktree));
  git(fx.project, ['worktree', 'add', '-b', 'topic', worktree]);
  const files = createProjectFiles();
  files.admitProject(fx.project, 'configured');

  const first = await files.openProject(fx.project);
  const second = await files.openProject(fx.project);
  assert.deepEqual(second.roots, first.roots);
});

test('removes a vanished worktree root and reissues its ID if recreated', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  const worktree = path.join(fx.project, '.worktrees', 'topic');
  fs.mkdirSync(path.dirname(worktree));
  git(fx.project, ['worktree', 'add', '-b', 'topic', worktree]);
  const files = createProjectFiles();
  files.admitProject(fx.project, 'configured');

  const first = await files.openProject(fx.project);
  const oldWorktreeId = first.roots.find((root) => root.kind === 'worktree').id;
  git(fx.project, ['worktree', 'remove', '--force', worktree]);
  assert.deepEqual((await files.openProject(fx.project)).roots.map((root) => root.kind), ['project']);
  git(fx.project, ['worktree', 'add', '-b', 'replacement', worktree]);
  const recreated = await files.openProject(fx.project);
  assert.notEqual(recreated.roots.find((root) => root.kind === 'worktree').id, oldWorktreeId);
});

test('revokes an admitted project when its symlink is repointed', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const replacement = path.join(fx.base, 'replacement');
  const link = path.join(fx.base, 'project-link');
  fs.mkdirSync(replacement);
  fs.symlinkSync(fx.project, link, 'dir');
  const files = createProjectFiles();
  files.admitProject(link, 'configured');
  assert.equal((await files.openProject(link)).ok, true);

  fs.unlinkSync(link);
  fs.symlinkSync(replacement, link, 'dir');
  assert.equal((await files.openProject(link)).error, 'project-unavailable');
});

test('reissues a worktree root ID when its symlink is repointed', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  const firstWorktree = path.join(fx.base, 'first-worktree');
  const secondWorktree = path.join(fx.base, 'second-worktree');
  const link = path.join(fx.project, '.worktrees', 'topic');
  fs.mkdirSync(path.dirname(link));
  git(fx.project, ['worktree', 'add', '-b', 'first-topic', firstWorktree]);
  git(fx.project, ['worktree', 'add', '-b', 'second-topic', secondWorktree]);
  fs.symlinkSync(firstWorktree, link, 'dir');
  const files = createProjectFiles();
  files.admitProject(fx.project, 'configured');
  const first = await files.openProject(fx.project);
  const oldWorktreeId = first.roots.find((root) => root.kind === 'worktree').id;

  fs.unlinkSync(link);
  fs.symlinkSync(secondWorktree, link, 'dir');
  const repointed = await files.openProject(fx.project);
  assert.notEqual(repointed.roots.find((root) => root.kind === 'worktree').id, oldWorktreeId);
});

test('rejects a project repointed during Git root discovery', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  const replacement = path.join(fx.base, 'replacement');
  const link = path.join(fx.base, 'project-link');
  fs.mkdirSync(replacement);
  fs.symlinkSync(fx.project, link, 'dir');
  let repointed = false;
  const files = createProjectFiles({
    fs: {
      statSync: fs.statSync,
      realpathSync: fs.realpathSync,
      readdirSync: fs.readdirSync,
    },
    spawn(file, args, options) {
      const child = spawn(file, args, options);
      child.once('close', () => {
        if (!repointed && args.includes('--git-common-dir')) {
          fs.unlinkSync(link);
          fs.symlinkSync(replacement, link, 'dir');
          repointed = true;
        }
      });
      return child;
    },
  });
  files.admitProject(link, 'configured');

  const opened = await files.openProject(link);
  assert.equal(repointed, true);
  assert.equal(opened.error, 'project-unavailable');
});

test('retries worktree discovery when a worktree symlink is repointed mid-refresh', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  const firstWorktree = path.join(fx.base, 'first-worktree');
  const secondWorktree = path.join(fx.base, 'second-worktree');
  const link = path.join(fx.project, '.worktrees', 'topic');
  fs.mkdirSync(path.dirname(link));
  git(fx.project, ['worktree', 'add', '-b', 'first-topic', firstWorktree]);
  git(fx.project, ['worktree', 'add', '-b', 'second-topic', secondWorktree]);
  fs.symlinkSync(firstWorktree, link, 'dir');
  let repointOnGit = false;
  let repointed = false;
  const files = createProjectFiles({
    fs: {
      statSync: fs.statSync,
      realpathSync: fs.realpathSync,
      readdirSync: fs.readdirSync,
    },
    spawn(file, args, options) {
      const child = spawn(file, args, options);
      child.once('close', () => {
        if (repointOnGit && !repointed && args.includes('--show-toplevel')) {
          fs.unlinkSync(link);
          fs.symlinkSync(secondWorktree, link, 'dir');
          repointed = true;
        }
      });
      return child;
    },
  });
  files.admitProject(fx.project, 'configured');
  const first = await files.openProject(fx.project);
  const oldWorktreeId = first.roots.find((root) => root.kind === 'worktree').id;

  repointOnGit = true;
  const refreshed = await files.openProject(fx.project);
  assert.equal(repointed, true);
  assert.notEqual(refreshed.roots.find((root) => root.kind === 'worktree').id, oldWorktreeId);
});

test('retries when a worktree candidate is repointed before Git reads it', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  const firstWorktree = path.join(fx.base, 'first-worktree');
  const secondWorktree = path.join(fx.base, 'second-worktree');
  const link = path.join(fx.project, '.worktrees', 'topic');
  fs.mkdirSync(path.dirname(link));
  git(fx.project, ['worktree', 'add', '-b', 'first-topic', firstWorktree]);
  git(fx.project, ['worktree', 'add', '-b', 'second-topic', secondWorktree]);
  fs.symlinkSync(firstWorktree, link, 'dir');
  let repointBeforeGit = false;
  let repointed = false;
  const files = createProjectFiles({
    fs: {
      statSync: fs.statSync,
      realpathSync: fs.realpathSync,
      readdirSync: fs.readdirSync,
    },
    spawn(file, args, options) {
      if (repointBeforeGit && !repointed && args.includes('--show-toplevel')) {
        fs.unlinkSync(link);
        fs.symlinkSync(secondWorktree, link, 'dir');
        repointed = true;
      }
      return spawn(file, args, options);
    },
  });
  files.admitProject(fx.project, 'configured');
  const first = await files.openProject(fx.project);
  const oldWorktreeId = first.roots.find((root) => root.kind === 'worktree').id;

  repointBeforeGit = true;
  const refreshed = await files.openProject(fx.project);
  assert.equal(repointed, true);
  assert.notEqual(refreshed.roots.find((root) => root.kind === 'worktree').id, oldWorktreeId);
});

async function openedRoot(files, project) {
  const opened = await files.openProject(project);
  assert.equal(opened.ok, true);
  return { projectId: opened.projectId, rootId: opened.roots[0].id };
}

async function assertRootOperationsUnavailable(files, ids, revision) {
  const operations = [
    files.list({ ...ids, directory: '' }),
    files.read({ ...ids, path: 'safe.txt' }),
    files.write({
      ...ids,
      path: 'safe.txt',
      content: 'changed',
      expectedRevision: revision,
      overwrite: false,
    }),
    files.watch('invalidated-renderer', ids, () => {}),
  ];
  for (const result of await Promise.all(operations)) {
    assert.match(result.error, /^(project|root)-unavailable$/);
  }
}

test('lists only canonical relative directories and denies Git metadata', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  const files = createProjectFiles();
  files.admitProject(fx.project, 'configured');
  const ids = await openedRoot(files, fx.project);

  for (const directory of ['../outside', '/etc', 'a\\b', 'a\0b']) {
    assert.equal((await files.list({ ...ids, directory })).error, 'invalid-path');
  }
  assert.equal((await files.list({ ...ids, directory: '.git' })).error, 'git-metadata-denied');
});

test('lists contained entries safely, omits Git metadata, and sorts directories first', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  const insideDir = path.join(fx.project, 'adir');
  const insideFile = path.join(fx.project, 'target.txt');
  const outsideDir = path.join(fx.base, 'outside');
  fs.mkdirSync(insideDir);
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(insideFile, 'inside');
  fs.writeFileSync(path.join(fx.project, 'z-file.txt'), 'z');
  fs.writeFileSync(path.join(fx.project, '.visible-dotfile'), 'dot');
  fs.symlinkSync('target.txt', path.join(fx.project, 'file-link'));
  fs.symlinkSync('adir', path.join(fx.project, 'directory-link'), 'dir');
  fs.symlinkSync(outsideDir, path.join(fx.project, 'external-link'), 'dir');
  fs.symlinkSync('missing-target', path.join(fx.project, 'broken-link'));
  fs.symlinkSync('.git', path.join(fx.project, 'git-link'), 'dir');

  const files = createProjectFiles();
  files.admitProject(fx.project, 'configured');
  const ids = await openedRoot(files, fx.project);
  const listed = await files.list({ ...ids, directory: '' });

  assert.equal(listed.ok, true);
  assert.deepEqual(listed.entries.map(({ name }) => name), [
    'adir', 'directory-link', 'external-link', '.gitignore', '.visible-dotfile', 'broken-link',
    'file-link', 'target.txt', 'z-file.txt',
  ]);
  assert.equal(listed.entries.some(({ name }) => name === '.git'), false);
  assert.equal(listed.entries.some(({ name }) => name === 'git-link'), false);
  assert.deepEqual(listed.entries.find(({ name }) => name === 'file-link'), {
    name: 'file-link', path: 'file-link', kind: 'file', hidden: false, ignored: false, symlink: true,
    unavailable: undefined,
  });
  assert.deepEqual(listed.entries.find(({ name }) => name === 'directory-link'), {
    name: 'directory-link', path: 'directory-link', kind: 'directory', hidden: false, ignored: false, symlink: true,
    unavailable: undefined,
  });
  assert.deepEqual(listed.entries.find(({ name }) => name === 'external-link'), {
    name: 'external-link', path: 'external-link', kind: 'directory', hidden: false, ignored: false, symlink: true,
    unavailable: 'outside-root',
  });
  assert.deepEqual(listed.entries.find(({ name }) => name === 'broken-link'), {
    name: 'broken-link', path: 'broken-link', kind: 'other', hidden: false, ignored: false, symlink: true,
    unavailable: 'unreadable',
  });
  assert.equal((await files.list({ ...ids, directory: 'external-link' })).error, 'outside-root');
  assert.equal((await files.list({ ...ids, directory: 'broken-link' })).error, 'unreadable');
  assert.equal((await files.list({ ...ids, directory: 'git-link' })).error, 'git-metadata-denied');
});

test('revalidates a symlink target on every listing call', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const inside = path.join(fx.project, 'inside');
  const outside = path.join(fx.base, 'outside');
  const link = path.join(fx.project, 'changing-link');
  fs.mkdirSync(inside);
  fs.mkdirSync(outside);
  fs.symlinkSync('inside', link, 'dir');
  const files = createProjectFiles();
  files.admitProject(fx.project, 'configured');
  const ids = await openedRoot(files, fx.project);

  assert.equal((await files.list({ ...ids, directory: 'changing-link' })).ok, true);
  fs.unlinkSync(link);
  fs.symlinkSync(outside, link, 'dir');
  assert.equal((await files.list({ ...ids, directory: 'changing-link' })).error, 'outside-root');
});

test('uses Git ignore rules in one listing while retaining tracked matches', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  fs.writeFileSync(path.join(fx.project, '.gitignore'), '*.tmp\nignored/\n');
  fs.mkdirSync(path.join(fx.project, 'nested'));
  fs.writeFileSync(path.join(fx.project, 'nested', '.gitignore'), '*.log\n!keep.log\n');
  fs.writeFileSync(path.join(fx.project, 'nested', 'hidden.log'), 'hidden');
  fs.writeFileSync(path.join(fx.project, 'nested', 'keep.log'), 'kept');
  fs.mkdirSync(path.join(fx.project, 'ignored'));
  fs.writeFileSync(path.join(fx.project, 'ignored', 'secret.txt'), 'secret');
  fs.writeFileSync(path.join(fx.project, 'untracked.tmp'), 'ignored');
  fs.writeFileSync(path.join(fx.project, 'tracked.tmp'), 'tracked');
  git(fx.project, ['add', '.gitignore', 'nested/.gitignore']);
  git(fx.project, ['add', '-f', 'tracked.tmp']);
  git(fx.project, ['commit', '-m', 'ignore fixtures']);

  const files = createProjectFiles();
  files.admitProject(fx.project, 'configured');
  const ids = await openedRoot(files, fx.project);
  const rootDefault = await files.list({ ...ids, directory: '' });
  assert.equal(rootDefault.entries.some(({ name }) => name === 'ignored'), false);
  assert.equal(rootDefault.entries.some(({ name }) => name === 'untracked.tmp'), false);
  assert.equal(rootDefault.entries.find(({ name }) => name === 'tracked.tmp').ignored, false);

  const rootAll = await files.list({ ...ids, directory: '', showIgnored: true });
  assert.equal(rootAll.entries.find(({ name }) => name === 'ignored').ignored, true);
  assert.equal(rootAll.entries.find(({ name }) => name === 'untracked.tmp').ignored, true);
  assert.equal(rootAll.entries.find(({ name }) => name === 'tracked.tmp').ignored, false);

  const nestedDefault = await files.list({ ...ids, directory: 'nested' });
  assert.equal(nestedDefault.entries.some(({ name }) => name === 'hidden.log'), false);
  assert.equal(nestedDefault.entries.find(({ name }) => name === 'keep.log').ignored, false);
  const nestedAll = await files.list({ ...ids, directory: 'nested', showIgnored: true });
  assert.equal(nestedAll.entries.find(({ name }) => name === 'hidden.log').ignored, true);
  assert.equal(nestedAll.entries.find(({ name }) => name === 'keep.log').ignored, false);
});

test('checks internal directory aliases through their canonical Git paths', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  fs.writeFileSync(path.join(fx.project, '.gitignore'), '*.tmp\n');
  fs.mkdirSync(path.join(fx.project, 'target'));
  fs.writeFileSync(path.join(fx.project, 'target', 'secret.tmp'), 'secret');
  fs.symlinkSync('target', path.join(fx.project, 'alias'), 'dir');
  const files = createProjectFiles();
  files.admitProject(fx.project, 'configured');
  const ids = await openedRoot(files, fx.project);

  const hidden = await files.list({ ...ids, directory: 'alias' });
  assert.equal(hidden.ok, true);
  assert.equal(hidden.entries.some(({ name }) => name === 'secret.tmp'), false);
  const shown = await files.list({ ...ids, directory: 'alias', showIgnored: true });
  assert.deepEqual(shown.entries.find(({ name }) => name === 'secret.tmp'), {
    name: 'secret.tmp', path: 'alias/secret.tmp', kind: 'file', hidden: false, ignored: true,
    symlink: false, unavailable: undefined,
  });
});

test('keeps a symlink entry on its logical Git path while canonicalizing its children', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  fs.mkdirSync(path.join(fx.project, 'target'));
  fs.writeFileSync(path.join(fx.project, 'target', 'secret.tmp'), 'secret');
  fs.symlinkSync('target', path.join(fx.project, 'alias'), 'dir');
  const files = createProjectFiles();
  files.admitProject(fx.project, 'configured');
  const ids = await openedRoot(files, fx.project);

  fs.writeFileSync(path.join(fx.project, '.gitignore'), 'alias\n*.tmp\n');
  assert.equal((await files.list({ ...ids, directory: '' })).entries.some(({ name }) => name === 'alias'), false);
  assert.equal((await files.list({ ...ids, directory: '', showIgnored: true }))
    .entries.find(({ name }) => name === 'alias').ignored, true);
  assert.equal((await files.list({ ...ids, directory: 'alias' })).entries.some(({ name }) => name === 'secret.tmp'), false);

  fs.writeFileSync(path.join(fx.project, '.gitignore'), 'target\n');
  const targetOnly = await files.list({ ...ids, directory: '', showIgnored: true });
  assert.equal(targetOnly.entries.find(({ name }) => name === 'alias').ignored, false);
});

test('applies parent-repository ignore rules to an admitted project subdirectory', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  const selected = path.join(fx.project, 'selected-project');
  fs.mkdirSync(selected);
  fs.writeFileSync(path.join(fx.project, '.gitignore'), '*.tmp\n');
  fs.writeFileSync(path.join(selected, 'hidden.tmp'), 'hidden');
  const files = createProjectFiles();
  files.admitProject(selected, 'configured');
  const ids = await openedRoot(files, selected);

  const hidden = await files.list({ ...ids, directory: '' });
  assert.equal(hidden.entries.some(({ name }) => name === 'hidden.tmp'), false);
  const shown = await files.list({ ...ids, directory: '', showIgnored: true });
  assert.equal(shown.entries.find(({ name }) => name === 'hidden.tmp').ignored, true);
});

test('uses one NUL Git batch, distinguishes fatal errors, and skips verified non-Git roots', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  fs.writeFileSync(path.join(fx.project, 'normal.txt'), 'normal');
  const spawns = [];
  let status = 1;
  function fakeSpawn(file, args, options) {
    if (!args.includes('check-ignore')) return spawn(file, args, options);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = {
      end(input) {
        spawns.push({ file, args, options, input: Buffer.from(input) });
        process.nextTick(() => child.emit('close', status));
      },
    };
    return child;
  }
  const files = createProjectFiles({ spawn: fakeSpawn });
  files.admitProject(fx.project, 'configured');
  const ids = await openedRoot(files, fx.project);

  const noMatches = await files.list({ ...ids, directory: '' });
  assert.equal(noMatches.ok, true);
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ['-C', fx.project, 'check-ignore', '--stdin', '-z']);
  assert.deepEqual(spawns[0].options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(spawns[0].options.env.LC_ALL, 'C');
  assert.equal(spawns[0].options.env.PATH, process.env.PATH);
  assert.equal(spawns[0].options.detached, process.platform !== 'win32');
  assert.equal(spawns[0].input.at(-1), 0);
  assert.match(spawns[0].input.toString('utf8'), /normal\.txt\0/);

  status = 128;
  assert.deepEqual(await files.list({ ...ids, directory: '' }), { ok: false, error: 'git-unavailable' });

  const plain = path.join(fx.base, 'plain');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, 'normal.txt'), 'normal');
  const plainFiles = createProjectFiles({
    spawn(file, args, options) {
      if (args.includes('check-ignore')) throw new Error('non-Git roots must not check ignore');
      return spawn(file, args, options);
    },
  });
  plainFiles.admitProject(plain, 'configured');
  const plainIds = await openedRoot(plainFiles, plain);
  assert.deepEqual(await plainFiles.list({ ...plainIds, directory: '' }), {
    ok: true,
    entries: [{
      name: 'normal.txt', path: 'normal.txt', kind: 'file', hidden: false, ignored: false,
      symlink: false, unavailable: undefined,
    }],
  });
});

test('probes Git repositories in a C locale before classifying non-Git roots', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  fs.writeFileSync(path.join(fx.project, 'normal.txt'), 'normal');
  let probeOptions;
  const nonGitFiles = createProjectFiles({
    spawn(file, args, options) {
      probeOptions = options;
      return fakeGitProcess({
        code: 128,
        stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
      });
    },
  });
  nonGitFiles.admitProject(fx.project, 'configured');
  const ids = await openedRoot(nonGitFiles, fx.project);
  assert.equal((await nonGitFiles.list({ ...ids, directory: '' })).ok, true);
  assert.equal(probeOptions.env.LC_ALL, 'C');
  assert.equal(probeOptions.env.PATH, process.env.PATH);

  let fatal = false;
  const fatalFiles = createProjectFiles({
    spawn(file, args, options) {
      if (!fatal) return spawn(file, args, options);
      return fakeGitProcess({ code: 128, stderr: 'fatal: malformed repository configuration\n' });
    },
  });
  fatalFiles.admitProject(fx.project, 'configured');
  const fatalIds = await openedRoot(fatalFiles, fx.project);
  fatal = true;
  assert.deepEqual(await fatalFiles.list({ ...fatalIds, directory: '' }), {
    ok: false, error: 'git-unavailable',
  });
  fatal = false;
  assert.equal((await fatalFiles.list({ ...fatalIds, directory: '' })).ok, true);
});

test('times out Git, kills its process group, and releases the execution slot', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  fs.writeFileSync(path.join(fx.project, 'normal.txt'), 'normal');
  const pidFile = path.join(fx.base, 'git-descendant.pid');
  const children = [];
  let hang = false;
  let timedOut = false;
  function controlledSpawn(file, args, options) {
    if (!hang || timedOut) return spawn(file, args, options);
    timedOut = true;
    const script = [
      "const fs = require('fs');",
      "const { spawn } = require('child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "fs.writeFileSync(process.argv[1], String(child.pid));",
      'setInterval(() => {}, 1000);',
    ].join('');
    const child = spawn(process.execPath, ['-e', script, pidFile], options);
    children.push(child);
    return child;
  }
  t.after(() => {
    const descendantPid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : undefined;
    for (const child of children) forceKillTestProcess(child, descendantPid);
  });
  const files = createProjectFiles({
    spawn: controlledSpawn,
    gitTimeoutMs: 100,
    gitMaxActive: 1,
    gitMaxQueued: 1,
  });
  files.admitProject(fx.project, 'configured');
  const ids = await openedRoot(files, fx.project);

  hang = true;
  const timedOutResult = await withDeadline(files.list({ ...ids, directory: '' }), 500);
  assert.deepEqual(timedOutResult, { ok: false, error: 'git-unavailable' });
  await waitForCondition(() => fs.existsSync(pidFile));
  const descendantPid = Number(fs.readFileSync(pidFile, 'utf8'));
  await waitForProcessExit(children[0].pid);
  await waitForProcessExit(descendantPid);

  assert.equal((await files.list({ ...ids, directory: '' })).ok, true);
});

test('caps active and queued Git jobs, rejects saturation, and drains the queue after timeouts', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  fs.writeFileSync(path.join(fx.project, 'normal.txt'), 'normal');
  const children = [];
  let hang = false;
  function controlledSpawn(file, args, options) {
    if (!hang) return spawn(file, args, options);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
    children.push(child);
    return child;
  }
  t.after(() => {
    for (const child of children) forceKillTestProcess(child);
  });
  const files = createProjectFiles({
    spawn: controlledSpawn,
    gitTimeoutMs: 30,
    gitMaxActive: 1,
    gitMaxQueued: 1,
  });
  files.admitProject(fx.project, 'configured');
  const ids = await openedRoot(files, fx.project);

  hang = true;
  const active = files.list({ ...ids, directory: '' });
  await waitForCondition(() => children.length === 1);
  const queued = files.list({ ...ids, directory: '' });
  const saturated = await withDeadline(files.list({ ...ids, directory: '' }));
  assert.deepEqual(saturated, { ok: false, error: 'git-unavailable' });
  assert.deepEqual(await withDeadline(active), { ok: false, error: 'git-unavailable' });
  assert.deepEqual(await withDeadline(queued), { ok: false, error: 'git-unavailable' });
  assert.equal(children.length, 2);
  assert.equal(children.every((child) => !processExists(child.pid)), true);
});

test('close kills active Git groups, rejects queued work, and prevents later spawns', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  fs.writeFileSync(path.join(fx.project, 'normal.txt'), 'normal');
  const pidFile = path.join(fx.base, 'close-descendant.pid');
  const children = [];
  let hang = false;
  function controlledSpawn(file, args, options) {
    if (!hang) return spawn(file, args, options);
    const script = [
      "const fs = require('fs');",
      "const { spawn } = require('child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "fs.writeFileSync(process.argv[1], String(child.pid));",
      'setInterval(() => {}, 1000);',
    ].join('');
    const child = spawn(process.execPath, ['-e', script, pidFile], options);
    children.push(child);
    return child;
  }
  t.after(() => {
    const descendantPid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : undefined;
    for (const child of children) forceKillTestProcess(child, descendantPid);
  });
  const files = createProjectFiles({
    spawn: controlledSpawn,
    gitTimeoutMs: 1_000,
    gitMaxActive: 1,
    gitMaxQueued: 1,
  });
  files.admitProject(fx.project, 'configured');
  const ids = await openedRoot(files, fx.project);

  hang = true;
  const active = files.list({ ...ids, directory: '' });
  await waitForCondition(() => children.length === 1 && fs.existsSync(pidFile), 100, 5);
  const queued = files.list({ ...ids, directory: '' });
  files.close();
  files.close();

  assert.deepEqual(await withDeadline(active), { ok: false, error: 'git-unavailable' });
  assert.deepEqual(await withDeadline(queued), { ok: false, error: 'git-unavailable' });
  assert.deepEqual(await withDeadline(files.list({ ...ids, directory: '' })), {
    ok: false,
    error: 'git-unavailable',
  });
  assert.equal(children.length, 1);
  const descendantPid = Number(fs.readFileSync(pidFile, 'utf8'));
  await waitForProcessExit(children[0].pid);
  await waitForProcessExit(descendantPid);
});

test('accepts the exact Git input limit and rejects one additional byte before spawning', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  git(fx.project, ['init', '--initial-branch=main']);
  fs.writeFileSync(path.join(fx.project, 'normal.txt'), 'normal');
  const inputBytes = Buffer.byteLength('normal.txt\0');

  function service(limit) {
    let ignoreSpawns = 0;
    const files = createProjectFiles({
      gitMaxInputBytes: limit,
      spawn(file, args, options) {
        if (!args.includes('check-ignore')) return spawn(file, args, options);
        ignoreSpawns += 1;
        return fakeGitProcess({ code: 1 });
      },
    });
    files.admitProject(fx.project, 'configured');
    return { files, ignoreSpawns: () => ignoreSpawns };
  }

  const exact = service(inputBytes);
  const exactIds = await openedRoot(exact.files, fx.project);
  assert.equal((await exact.files.list({ ...exactIds, directory: '' })).ok, true);
  assert.equal(exact.ignoreSpawns(), 1);

  const over = service(inputBytes - 1);
  const overIds = await openedRoot(over.files, fx.project);
  assert.deepEqual(await over.files.list({ ...overIds, directory: '' }), {
    ok: false,
    error: 'git-unavailable',
  });
  assert.equal(over.ignoreSpawns(), 0);
});

test('bounds cumulative Git stdout and stderr at the exact configured byte limit', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);

  async function openWithOutput({ code, stdout = '', stderr = '', stdoutChunks, stderrChunks, limit }) {
    const files = createProjectFiles({
      gitMaxOutputBytes: limit,
      spawn: () => fakeGitProcess({ code, stdout, stderr, stdoutChunks, stderrChunks }),
    });
    files.admitProject(fx.project, 'configured');
    return files.openProject(fx.project);
  }

  const commonDirOutput = `${fx.project}\n`;
  const stdoutLimit = Buffer.byteLength(commonDirOutput);
  const stdoutSplit = Math.floor(commonDirOutput.length / 2);
  assert.equal((await openWithOutput({
    code: 0,
    stdoutChunks: [commonDirOutput.slice(0, stdoutSplit), commonDirOutput.slice(stdoutSplit)],
    limit: stdoutLimit,
  })).ok, true);
  assert.deepEqual(await openWithOutput({
    code: 0,
    stdoutChunks: [commonDirOutput, '\n'],
    limit: stdoutLimit,
  }), { ok: false, error: 'project-unavailable' });

  const notRepository = 'fatal: not a git repository\n';
  const stderrLimit = Buffer.byteLength(notRepository);
  const stderrSplit = Math.floor(notRepository.length / 2);
  assert.equal((await openWithOutput({
    code: 128,
    stderrChunks: [notRepository.slice(0, stderrSplit), notRepository.slice(stderrSplit)],
    limit: stderrLimit,
  })).ok, true);
  assert.deepEqual(await openWithOutput({
    code: 128,
    stderrChunks: [notRepository, '\n'],
    limit: stderrLimit,
  }), { ok: false, error: 'project-unavailable' });
});

test('kills a real Git child whose output exceeds the limit and then releases its slot', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  fs.writeFileSync(path.join(fx.project, 'normal.txt'), 'normal');
  let noisy = false;
  let noisyChild;
  let killed = false;
  function controlledSpawn(file, args, options) {
    if (!noisy) return spawn(file, args, options);
    noisy = false;
    noisyChild = spawn(process.execPath, ['-e', "process.stdout.write('x'.repeat(1025)); setInterval(() => {}, 1000)"], options);
    const kill = noisyChild.kill.bind(noisyChild);
    noisyChild.kill = (signal) => { killed = true; return kill(signal); };
    return noisyChild;
  }
  t.after(() => forceKillTestProcess(noisyChild));
  const files = createProjectFiles({
    spawn: controlledSpawn,
    gitMaxOutputBytes: 1024,
    gitTimeoutMs: 1_000,
    gitMaxActive: 1,
    gitMaxQueued: 0,
  });
  files.admitProject(fx.project, 'configured');
  const ids = await openedRoot(files, fx.project);

  noisy = true;
  assert.deepEqual(await withDeadline(files.list({ ...ids, directory: '' })), {
    ok: false,
    error: 'git-unavailable',
  });
  assert.equal(killed, true);
  await waitForProcessExit(noisyChild.pid);
  assert.equal((await files.list({ ...ids, directory: '' })).ok, true);
});

test('retains a Git slot until the killed child reports close', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  fs.writeFileSync(path.join(fx.project, 'normal.txt'), 'normal');
  let intercept = false;
  let interceptedSpawns = 0;
  let noisyChild;
  let actualClosed = false;
  let releaseClose;
  function controlledSpawn(file, args, options) {
    if (!intercept) return spawn(file, args, options);
    interceptedSpawns += 1;
    if (interceptedSpawns > 1) return spawn(file, args, options);
    noisyChild = spawn(process.execPath, [
      '-e',
      "process.stdout.write('x'.repeat(1025)); setInterval(() => {}, 1000)",
    ], options);
    const child = new EventEmitter();
    child.pid = noisyChild.pid;
    child.stdin = noisyChild.stdin;
    child.stdout = noisyChild.stdout;
    child.stderr = noisyChild.stderr;
    child.kill = noisyChild.kill.bind(noisyChild);
    let closeArgs;
    noisyChild.on('error', (error) => child.emit('error', error));
    noisyChild.on('close', (code, signal) => {
      actualClosed = true;
      closeArgs = [code, signal];
    });
    releaseClose = () => child.emit('close', ...closeArgs);
    return child;
  }
  t.after(() => forceKillTestProcess(noisyChild));
  const files = createProjectFiles({
    spawn: controlledSpawn,
    gitMaxOutputBytes: 1024,
    gitTimeoutMs: 1_000,
    gitMaxActive: 1,
    gitMaxQueued: 1,
  });
  files.admitProject(fx.project, 'configured');
  const ids = await openedRoot(files, fx.project);

  intercept = true;
  const noisyRequest = files.list({ ...ids, directory: '' });
  const queuedRequest = files.list({ ...ids, directory: '' });
  await waitForCondition(() => actualClosed, 100, 5);
  assert.equal(interceptedSpawns, 1);
  releaseClose();

  assert.deepEqual(await noisyRequest, { ok: false, error: 'git-unavailable' });
  await waitForCondition(() => interceptedSpawns === 2);
  assert.equal(interceptedSpawns, 2);
  assert.equal((await queuedRequest).ok, true);
  assert.equal(interceptedSpawns, 3);
});

test('uses the kill fallback before releasing a slot when child close never arrives', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  fs.writeFileSync(path.join(fx.project, 'normal.txt'), 'normal');
  let intercept = false;
  let interceptedSpawns = 0;
  let killed = false;
  function controlledSpawn(file, args, options) {
    if (!intercept) return spawn(file, args, options);
    interceptedSpawns += 1;
    if (interceptedSpawns > 1) return spawn(file, args, options);
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin.end = () => process.nextTick(() => {
      child.stdout.emit('data', Buffer.from('x'.repeat(1025)));
    });
    child.kill = () => {
      killed = true;
      throw Object.assign(new Error('already gone'), { code: 'ESRCH' });
    };
    return child;
  }
  const files = createProjectFiles({
    spawn: controlledSpawn,
    gitMaxOutputBytes: 1024,
    gitKillFallbackMs: 30,
    gitTimeoutMs: 1_000,
    gitMaxActive: 1,
    gitMaxQueued: 1,
  });
  files.admitProject(fx.project, 'configured');
  const ids = await openedRoot(files, fx.project);

  intercept = true;
  const noisyRequest = files.list({ ...ids, directory: '' });
  const queuedRequest = files.list({ ...ids, directory: '' });
  await waitForCondition(() => killed);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(interceptedSpawns, 1);

  assert.deepEqual(await withDeadline(noisyRequest), { ok: false, error: 'git-unavailable' });
  await waitForCondition(() => interceptedSpawns === 2);
  assert.equal(interceptedSpawns, 2);
  assert.equal((await withDeadline(queuedRequest)).ok, true);
  assert.equal(interceptedSpawns, 3);
});

test('service close during Git termination rejects all work without draining the queue', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  fs.writeFileSync(path.join(fx.project, 'normal.txt'), 'normal');
  let intercept = false;
  let interceptedSpawns = 0;
  let killed = false;
  function controlledSpawn(file, args, options) {
    if (!intercept) return spawn(file, args, options);
    interceptedSpawns += 1;
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin.end = () => process.nextTick(() => {
      child.stderr.emit('data', Buffer.from('x'.repeat(1025)));
    });
    child.kill = () => { killed = true; return true; };
    return child;
  }
  const files = createProjectFiles({
    spawn: controlledSpawn,
    gitMaxOutputBytes: 1024,
    gitKillFallbackMs: 30,
    gitTimeoutMs: 1_000,
    gitMaxActive: 1,
    gitMaxQueued: 1,
  });
  files.admitProject(fx.project, 'configured');
  const ids = await openedRoot(files, fx.project);

  intercept = true;
  const terminating = files.list({ ...ids, directory: '' });
  const queued = files.list({ ...ids, directory: '' });
  await waitForCondition(() => killed);
  files.close();
  files.close();

  assert.deepEqual(await withDeadline(terminating), { ok: false, error: 'git-unavailable' });
  assert.deepEqual(await withDeadline(queued), { ok: false, error: 'git-unavailable' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(interceptedSpawns, 1);
  assert.deepEqual(await files.list({ ...ids, directory: '' }), {
    ok: false,
    error: 'git-unavailable',
  });
  assert.equal(interceptedSpawns, 1);
});

test('releases a Git execution slot after a synchronous launcher error', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  fs.writeFileSync(path.join(fx.project, 'normal.txt'), 'normal');
  let throwNext = false;
  function controlledSpawn(file, args, options) {
    if (throwNext) {
      throwNext = false;
      throw new Error('controlled launcher failure');
    }
    return spawn(file, args, options);
  }
  const files = createProjectFiles({
    spawn: controlledSpawn,
    gitTimeoutMs: 100,
    gitMaxActive: 1,
    gitMaxQueued: 0,
  });
  files.admitProject(fx.project, 'configured');
  const ids = await openedRoot(files, fx.project);

  throwNext = true;
  assert.deepEqual(await files.list({ ...ids, directory: '' }), {
    ok: false,
    error: 'git-unavailable',
  });
  assert.equal((await files.list({ ...ids, directory: '' })).ok, true);
});

test('kills an errored Git child and releases its execution slot', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  fs.writeFileSync(path.join(fx.project, 'normal.txt'), 'normal');
  let emitError = false;
  let killed = false;
  function controlledSpawn(file, args, options) {
    if (!emitError) return spawn(file, args, options);
    emitError = false;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    child.kill = () => { killed = true; return true; };
    process.nextTick(() => child.emit('error', new Error('controlled child error')));
    return child;
  }
  const files = createProjectFiles({
    spawn: controlledSpawn,
    gitTimeoutMs: 100,
    gitMaxActive: 1,
    gitMaxQueued: 0,
  });
  files.admitProject(fx.project, 'configured');
  const ids = await openedRoot(files, fx.project);

  emitError = true;
  assert.deepEqual(await files.list({ ...ids, directory: '' }), {
    ok: false,
    error: 'git-unavailable',
  });
  assert.equal(killed, true);
  assert.equal((await files.list({ ...ids, directory: '' })).ok, true);
});

test('handles stdin errors before and after Git close without leaking its execution slot', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  fs.writeFileSync(path.join(fx.project, 'normal.txt'), 'normal');
  let mode = 'real';
  const killed = [];
  function controlledSpawn(file, args, options) {
    if (mode === 'real') return spawn(file, args, options);
    const failureMode = mode;
    mode = 'real';
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => {
      if (failureMode === 'before-close') {
        process.nextTick(() => child.stdin.emit('error', new Error('controlled EPIPE')));
        return;
      }
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from('true\n'));
        child.emit('close', 0, null);
        child.stdin.emit('error', new Error('late controlled EPIPE'));
      });
    };
    child.kill = () => { killed.push(failureMode); return true; };
    return child;
  }
  const files = createProjectFiles({
    spawn: controlledSpawn,
    gitTimeoutMs: 100,
    gitMaxActive: 1,
    gitMaxQueued: 1,
  });
  files.admitProject(fx.project, 'configured');
  const ids = await openedRoot(files, fx.project);

  mode = 'before-close';
  const failed = files.list({ ...ids, directory: '' });
  const queued = files.list({ ...ids, directory: '' });
  assert.deepEqual(await failed, { ok: false, error: 'git-unavailable' });
  assert.equal((await queued).ok, true);
  assert.equal(killed.includes('before-close'), true);

  mode = 'after-close';
  assert.equal((await files.list({ ...ids, directory: '' })).ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(killed.includes('after-close'), true);
});

test('fails closed when a directory is retargeted between containment and enumeration', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const directory = path.join(fx.project, 'changing-directory');
  const outside = path.join(fx.base, 'outside');
  fs.mkdirSync(directory);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(directory, 'inside.txt'), 'inside');
  fs.writeFileSync(path.join(outside, 'outside-only.txt'), 'outside');
  let retargeted = false;
  const files = createProjectFiles({
    fs: {
      statSync: fs.statSync,
      lstatSync: fs.lstatSync,
      readdirSync: fs.readdirSync,
      realpathSync(value) {
        const resolved = fs.realpathSync(value);
        if (!retargeted && value === directory) {
          fs.rmSync(directory, { recursive: true, force: true });
          fs.symlinkSync(outside, directory, 'dir');
          retargeted = true;
        }
        return resolved;
      },
    },
  });
  files.admitProject(fx.project, 'configured');
  const ids = await openedRoot(files, fx.project);

  const listed = await files.list({ ...ids, directory: 'changing-directory' });
  assert.equal(retargeted, true);
  assert.deepEqual(listed, { ok: false, error: 'outside-root' });
  assert.notEqual(listed.entries?.some(({ name }) => name === 'outside-only.txt'), true);
});

test('denies cross-project, revoked, vanished, and repointed root IDs', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const other = path.join(fx.base, 'other-project');
  fs.mkdirSync(other);
  const files = createProjectFiles();
  files.replaceAdmissions('configured', [fx.project, other]);
  const first = await openedRoot(files, fx.project);
  const second = await openedRoot(files, other);

  assert.deepEqual(await files.list({ projectId: second.projectId, rootId: first.rootId, directory: '' }), {
    ok: false, error: 'project-unavailable',
  });
  files.replaceAdmissions('configured', [other]);
  assert.deepEqual(await files.list({ ...first, directory: '' }), { ok: false, error: 'project-unavailable' });

  files.replaceAdmissions('configured', [fx.project]);
  const reAdmitted = await openedRoot(files, fx.project);
  fs.rmSync(fx.project, { recursive: true, force: true });
  fs.mkdirSync(fx.project);
  assert.deepEqual(await files.list({ ...reAdmitted, directory: '' }), { ok: false, error: 'project-unavailable' });

  const replacement = path.join(fx.base, 'replacement');
  const link = path.join(fx.base, 'project-link');
  fs.mkdirSync(replacement);
  fs.symlinkSync(fx.project, link, 'dir');
  const linkedFiles = createProjectFiles();
  linkedFiles.admitProject(link, 'configured');
  const linked = await openedRoot(linkedFiles, link);
  fs.unlinkSync(link);
  fs.symlinkSync(replacement, link, 'dir');
  assert.deepEqual(await linkedFiles.list({ ...linked, directory: '' }), { ok: false, error: 'project-unavailable' });
});

test('revoking the final admission disables every root operation and its active watcher', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  fs.writeFileSync(path.join(fx.project, 'safe.txt'), 'original');
  const watcher = new FakeRootWatcher();
  const scheduler = manualScheduler();
  const files = createProjectFiles({ watchFactory: () => watcher, scheduler });
  t.after(() => files.close());
  files.replaceAdmissions('configured', [fx.project]);
  const ids = await openedRoot(files, fx.project);
  const opened = await files.read({ ...ids, path: 'safe.txt' });
  const events = [];
  assert.deepEqual(await files.watch('renderer-1', ids, (event) => events.push(event)), { ok: true });

  files.replaceAdmissions('configured', []);

  assert.equal((await files.openProject(fx.project)).error, 'project-unavailable');
  await assertRootOperationsUnavailable(files, ids, opened.revision);
  assert.equal(watcher.closed, true);
  watcher.emit('change', path.join(fx.project, 'safe.txt'));
  scheduler.flush();
  assert.deepEqual(events, []);
});

test('retargeting an admitted project symlink disables every issued root operation', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const replacement = path.join(fx.base, 'replacement');
  const link = path.join(fx.base, 'project-link');
  fs.mkdirSync(replacement);
  fs.writeFileSync(path.join(fx.project, 'safe.txt'), 'original');
  fs.symlinkSync(fx.project, link, 'dir');
  const files = createProjectFiles();
  files.admitProject(link, 'configured');
  const ids = await openedRoot(files, link);
  const opened = await files.read({ ...ids, path: 'safe.txt' });

  fs.unlinkSync(link);
  fs.symlinkSync(replacement, link, 'dir');

  assert.equal((await files.openProject(link)).error, 'project-unavailable');
  await assertRootOperationsUnavailable(files, ids, opened.revision);
});

test('re-admitting a replaced project identity revokes its old watcher and sources', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const replacement = path.join(fx.base, 'replacement');
  const link = path.join(fx.base, 'project-link');
  fs.mkdirSync(replacement);
  fs.writeFileSync(path.join(fx.project, 'safe.txt'), 'original');
  fs.symlinkSync(fx.project, link, 'dir');
  const watcher = new FakeRootWatcher();
  const scheduler = manualScheduler();
  const files = createProjectFiles({ watchFactory: () => watcher, scheduler });
  t.after(() => files.close());
  files.admitProject(link, 'configured');
  const oldIds = await openedRoot(files, link);
  const events = [];
  assert.deepEqual(await files.watch('renderer-1', oldIds, (event) => events.push(event)), { ok: true });
  watcher.emit('change', path.join(fx.project, 'safe.txt'));
  assert.equal(scheduler.size, 1);

  fs.unlinkSync(link);
  fs.symlinkSync(replacement, link, 'dir');
  const admitted = files.admitProject(link, 'picker');
  const opened = await files.openProject(link);

  assert.equal(admitted.ok, true);
  assert.equal(opened.ok, true);
  assert.equal(opened.projectId, admitted.projectId);
  assert.notEqual(opened.projectId, oldIds.projectId);
  assert.notEqual(opened.roots[0].id, oldIds.rootId);
  assert.equal(watcher.closed, true);
  assert.equal(watcher.closeCalls, 1);
  assert.equal(scheduler.size, 0);
  watcher.emit('change', path.join(fx.project, 'late.txt'));
  scheduler.flush();
  assert.deepEqual(events, []);
  assert.deepEqual(await files.list({ ...oldIds, directory: '' }), {
    ok: false,
    error: 'project-unavailable',
  });

  files.replaceAdmissions('picker', []);
  assert.equal((await files.openProject(link)).error, 'project-unavailable');
});

test('a stale project refresh cannot revoke its newly admitted replacement', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  const replacement = path.join(fx.base, 'replacement');
  const link = path.join(fx.base, 'project-link');
  fs.mkdirSync(replacement);
  gitProject(replacement);
  fs.symlinkSync(fx.project, link, 'dir');
  let files;
  let replaced = false;
  files = createProjectFiles({
    spawn(file, args, options) {
      const child = spawn(file, args, options);
      child.once('close', () => {
        if (!replaced && args.includes('--git-common-dir')) {
          fs.unlinkSync(link);
          fs.symlinkSync(replacement, link, 'dir');
          files.admitProject(link, 'picker');
          replaced = true;
        }
      });
      return child;
    },
  });
  files.admitProject(link, 'configured');

  assert.equal((await files.openProject(link)).error, 'project-unavailable');
  assert.equal(replaced, true);
  assert.equal((await files.openProject(link)).ok, true);
});

test('removing an issued worktree disables every operation on its root ID', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  const worktree = path.join(fx.project, '.worktrees', 'topic');
  fs.mkdirSync(path.dirname(worktree));
  git(fx.project, ['worktree', 'add', '-b', 'topic', worktree]);
  fs.writeFileSync(path.join(worktree, 'safe.txt'), 'original');
  const projectWatcher = new FakeRootWatcher();
  const worktreeWatcher = new FakeRootWatcher();
  const candidates = [projectWatcher, worktreeWatcher];
  const scheduler = manualScheduler();
  const files = createProjectFiles({ watchFactory: () => candidates.shift(), scheduler });
  t.after(() => files.close());
  files.admitProject(fx.project, 'configured');
  const openedProject = await files.openProject(fx.project);
  const projectIds = {
    projectId: openedProject.projectId,
    rootId: openedProject.roots.find(({ kind }) => kind === 'project').id,
  };
  const ids = {
    projectId: openedProject.projectId,
    rootId: openedProject.roots.find(({ kind }) => kind === 'worktree').id,
  };
  const opened = await files.read({ ...ids, path: 'safe.txt' });
  const worktreeEvents = [];
  assert.deepEqual(await files.watch('project-renderer', projectIds, () => {}), { ok: true });
  assert.deepEqual(await files.watch('worktree-renderer', ids, (event) => worktreeEvents.push(event)), { ok: true });
  worktreeWatcher.emit('change', path.join(worktree, 'safe.txt'));
  assert.equal(scheduler.size, 1);

  git(fx.project, ['worktree', 'remove', '--force', worktree]);
  assert.deepEqual((await files.openProject(fx.project)).roots.map(({ kind }) => kind), ['project']);

  await assertRootOperationsUnavailable(files, ids, opened.revision);
  assert.equal(worktreeWatcher.closed, true);
  assert.equal(worktreeWatcher.closeCalls, 1);
  assert.equal(projectWatcher.closed, false);
  assert.equal(scheduler.size, 0);
  worktreeWatcher.emit('change', path.join(worktree, 'late.txt'));
  scheduler.flush();
  assert.deepEqual(worktreeEvents, []);
});

test('denies every worktree operation after the checkout belongs to a foreign repository', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  const foreign = path.join(fx.base, 'foreign');
  fs.mkdirSync(foreign);
  gitProject(foreign);
  const worktree = path.join(fx.project, '.worktrees', 'topic');
  fs.mkdirSync(path.dirname(worktree));
  git(fx.project, ['worktree', 'add', '-b', 'topic', worktree]);
  fs.writeFileSync(path.join(worktree, 'safe.txt'), 'original');
  const watcher = new FakeRootWatcher();
  const scheduler = manualScheduler();
  const files = createProjectFiles({ watchFactory: () => watcher, scheduler });
  t.after(() => files.close());
  files.admitProject(fx.project, 'configured');
  const opened = await files.openProject(fx.project);
  const worktreeId = opened.roots.find(({ kind }) => kind === 'worktree').id;
  const ids = { projectId: opened.projectId, rootId: worktreeId };
  const document = await files.read({ ...ids, path: 'safe.txt' });
  const events = [];
  assert.deepEqual(await files.watch('worktree-renderer', ids, (event) => events.push(event)), { ok: true });
  watcher.emit('change', path.join(worktree, 'safe.txt'));
  assert.equal(scheduler.size, 1);

  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(foreign, '.git')}\n`);
  await assertRootOperationsUnavailable(files, ids, document.revision);
  assert.equal(watcher.closed, true);
  assert.equal(watcher.closeCalls, 1);
  assert.equal(scheduler.size, 0);
  watcher.emit('change', path.join(worktree, 'late.txt'));
  scheduler.flush();
  assert.deepEqual(events, []);
});

test('labels FIFO entries as unavailable and exposes only public entry keys', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const fifo = path.join(fx.project, 'pipe');
  execFileSync('mkfifo', [fifo]);
  const files = createProjectFiles();
  files.admitProject(fx.project, 'configured');
  const ids = await openedRoot(files, fx.project);

  const listed = await files.list({ ...ids, directory: '' });
  const entry = listed.entries.find(({ name }) => name === 'pipe');
  assert.deepEqual(entry, {
    name: 'pipe', path: 'pipe', kind: 'other', hidden: false, ignored: false, symlink: false,
    unavailable: 'not-file',
  });
  assert.deepEqual(Object.keys(entry).sort(), [
    'hidden', 'ignored', 'kind', 'name', 'path', 'symlink', 'unavailable',
  ]);
  assert.equal(Object.values(entry).some((value) => typeof value === 'string' && value.includes(fx.project)), false);
});

test('reads UTF-8 documents with exact-byte revisions and normalized format metadata', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const cases = [
    {
      name: 'ordinary.js', bytes: Buffer.from('alpha\nbeta\n'), content: 'alpha\nbeta\n', language: 'js',
      format: { bom: false, lineEnding: '\n', trailingNewline: true },
    },
    {
      name: 'unknown.oddity', bytes: Buffer.from('plain'), content: 'plain', language: 'oddity',
      format: { bom: false, lineEnding: '\n', trailingNewline: false },
    },
    {
      name: 'bom.txt', bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\ntwo')]),
      content: 'one\ntwo', language: 'txt',
      format: { bom: true, lineEnding: '\n', trailingNewline: false },
    },
    {
      name: 'crlf.txt', bytes: Buffer.from('one\r\ntwo\r\n'), content: 'one\ntwo\n', language: 'txt',
      format: { bom: false, lineEnding: '\r\n', trailingNewline: true },
    },
    {
      name: 'cr.txt', bytes: Buffer.from('one\rtwo\r'), content: 'one\ntwo\n', language: 'txt',
      format: { bom: false, lineEnding: '\r', trailingNewline: true },
    },
    {
      name: 'mixed.txt', bytes: Buffer.from('one\r\ntwo\r\nthree\nfour\r'),
      content: 'one\ntwo\nthree\nfour\n', language: 'txt',
      format: { bom: false, lineEnding: '\r\n', trailingNewline: true },
    },
  ];
  for (const item of cases) fs.writeFileSync(path.join(fx.project, item.name), item.bytes);
  const { files, ids } = await admittedFiles(fx.project);

  for (const item of cases) {
    assert.deepEqual(await files.read({ ...ids, path: item.name }), {
      ok: true,
      path: item.name,
      content: item.content,
      revision: sha256(item.bytes),
      ignored: false,
      language: item.language,
      format: item.format,
    });
  }
});

test('reports Git-ignored status on readable documents without making it an authorization rule', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  fs.appendFileSync(path.join(fx.project, '.gitignore'), '*.ignored\n');
  fs.writeFileSync(path.join(fx.project, 'visible.ignored'), 'still readable');
  const { files, ids } = await admittedFiles(fx.project);

  const result = await files.read({ ...ids, path: 'visible.ignored' });
  assert.equal(result.ok, true);
  assert.equal(result.ignored, true);
});

test('uses listing-equivalent Git paths for file aliases and children of directory aliases', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  fs.mkdirSync(path.join(fx.project, 'target-dir'));
  fs.writeFileSync(path.join(fx.project, 'target.txt'), 'target');
  fs.writeFileSync(path.join(fx.project, 'target-dir', 'child.txt'), 'child');
  fs.symlinkSync('target.txt', path.join(fx.project, 'alias.txt'));
  fs.symlinkSync('target-dir', path.join(fx.project, 'alias-dir'), 'dir');
  fs.appendFileSync(path.join(fx.project, '.gitignore'), 'alias.txt\ntarget-dir/child.txt\n');
  const { files, ids } = await admittedFiles(fx.project);

  assert.equal((await files.read({ ...ids, path: 'alias.txt' })).ignored, true);
  assert.equal((await files.read({ ...ids, path: 'target.txt' })).ignored, false);
  assert.equal((await files.read({ ...ids, path: 'alias-dir/child.txt' })).ignored, true);
});

test('rejects invalid UTF-8, NUL data, non-files, oversized files, and deleted files safely', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  fs.writeFileSync(path.join(fx.project, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
  fs.writeFileSync(path.join(fx.project, 'nul.txt'), Buffer.from('before\0after'));
  fs.mkdirSync(path.join(fx.project, 'directory'));
  execFileSync('mkfifo', [path.join(fx.project, 'pipe')]);
  fs.writeFileSync(path.join(fx.project, 'large.txt'), Buffer.alloc((5 * 1024 * 1024) + 1, 0x61));
  fs.writeFileSync(path.join(fx.project, 'deleted.txt'), 'gone soon');
  const { files, ids } = await admittedFiles(fx.project);
  fs.unlinkSync(path.join(fx.project, 'deleted.txt'));

  assert.deepEqual(await files.read({ ...ids, path: 'invalid.txt' }), { ok: false, error: 'not-text' });
  assert.deepEqual(await files.read({ ...ids, path: 'nul.txt' }), { ok: false, error: 'not-text' });
  assert.deepEqual(await files.read({ ...ids, path: 'directory' }), { ok: false, error: 'not-file' });
  assert.deepEqual(await files.read({ ...ids, path: 'pipe' }), { ok: false, error: 'not-file' });
  assert.deepEqual(await files.read({ ...ids, path: 'large.txt' }), { ok: false, error: 'too-large' });
  assert.deepEqual(await files.read({ ...ids, path: 'deleted.txt' }), { ok: false, error: 'deleted' });
});

test('maps file access denial to permission-denied without exposing system errors', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const denied = path.join(fx.project, 'denied.txt');
  fs.writeFileSync(denied, 'secret');
  const io = new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') {
        return (value, flags, mode) => {
          if (value === denied && (flags === 'r' || Number.isInteger(flags))) {
            throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
          }
          return target.openSync(value, flags, mode);
        };
      }
      return target[property];
    },
  });
  const { files, ids } = await admittedFiles(fx.project, { fs: io });

  assert.deepEqual(await files.read({ ...ids, path: 'denied.txt' }), {
    ok: false, error: 'permission-denied',
  });
});

test('atomically saves exact bytes while retaining mode, BOM, CRLF, and final newline', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const target = path.join(fx.project, 'formatted.txt');
  const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo\r\n')]);
  fs.writeFileSync(target, original, { mode: 0o640 });
  const { files, ids } = await admittedFiles(fx.project);
  const opened = await files.read({ ...ids, path: 'formatted.txt' });

  const saved = await files.write({
    ...ids,
    path: 'formatted.txt',
    content: opened.content.replace('two', 'edited'),
    expectedRevision: opened.revision,
    overwrite: false,
  });
  const expected = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\nedited\r\n')]);
  assert.deepEqual(saved, { ok: true, revision: sha256(expected) });
  assert.deepEqual(fs.readFileSync(target), expected);
  assert.equal(fs.statSync(target).mode & 0o777, 0o640);
  assert.deepEqual(documentTemps(fx.project), []);
});

test('preserves a no-final-newline convention when editing inside the document', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const target = path.join(fx.project, 'no-final.txt');
  fs.writeFileSync(target, 'one\ntwo');
  const { files, ids } = await admittedFiles(fx.project);
  const opened = await files.read({ ...ids, path: 'no-final.txt' });

  const saved = await files.write({
    ...ids, path: 'no-final.txt', content: 'one\nchanged',
    expectedRevision: opened.revision, overwrite: false,
  });
  assert.equal(saved.ok, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'one\nchanged');
});

test('rejects stale saves and permits explicit overwrite only for an existing eligible target', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const target = path.join(fx.project, 'conflict.txt');
  fs.writeFileSync(target, 'original\n');
  const { files, ids } = await admittedFiles(fx.project);
  const opened = await files.read({ ...ids, path: 'conflict.txt' });
  fs.writeFileSync(target, 'external\n');

  assert.deepEqual(await files.write({
    ...ids, path: 'conflict.txt', content: 'local\n',
    expectedRevision: opened.revision, overwrite: false,
  }), { ok: false, error: 'conflict' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'external\n');

  const overwritten = await files.write({
    ...ids, path: 'conflict.txt', content: 'local\n',
    expectedRevision: opened.revision, overwrite: true,
  });
  assert.equal(overwritten.ok, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'local\n');

  fs.unlinkSync(target);
  assert.deepEqual(await files.write({
    ...ids, path: 'conflict.txt', content: 'must not recreate\n',
    expectedRevision: overwritten.revision, overwrite: true,
  }), { ok: false, error: 'deleted' });
  assert.equal(fs.existsSync(target), false);
});

test('rejects oversized output before creating a temporary file', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  fs.writeFileSync(path.join(fx.project, 'small.txt'), 'small');
  const { files, ids } = await admittedFiles(fx.project);
  const opened = await files.read({ ...ids, path: 'small.txt' });

  assert.deepEqual(await files.write({
    ...ids, path: 'small.txt', content: 'x'.repeat((5 * 1024 * 1024) + 1),
    expectedRevision: opened.revision, overwrite: false,
  }), { ok: false, error: 'too-large' });
  assert.equal(fs.readFileSync(path.join(fx.project, 'small.txt'), 'utf8'), 'small');
  assert.deepEqual(documentTemps(fx.project), []);
});

test('detects a change after temp flush and removes only its own temporary file', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const target = path.join(fx.project, 'racing.txt');
  fs.writeFileSync(target, 'original');
  let hookCalls = 0;
  const { files, ids } = await admittedFiles(fx.project, {
    beforeReplace() {
      hookCalls += 1;
      fs.writeFileSync(target, 'external');
    },
  });
  const opened = await files.read({ ...ids, path: 'racing.txt' });

  assert.deepEqual(await files.write({
    ...ids, path: 'racing.txt', content: 'local',
    expectedRevision: opened.revision, overwrite: false,
  }), { ok: false, error: 'conflict' });
  assert.equal(hookCalls, 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'external');
  assert.deepEqual(documentTemps(fx.project), []);
});

test('cleans the exact temporary file when fsync fails', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const target = path.join(fx.project, 'fsync.txt');
  fs.writeFileSync(target, 'original');
  let tempFd;
  const io = new Proxy(fs, {
    get(source, property) {
      if (property === 'openSync') {
        return (value, flags, mode) => {
          const fd = source.openSync(value, flags, mode);
          if (flags === 'wx') tempFd = fd;
          return fd;
        };
      }
      if (property === 'fsyncSync') {
        return (fd) => {
          if (fd === tempFd) throw Object.assign(new Error('fixture fsync failure'), { code: 'EIO' });
          return source.fsyncSync(fd);
        };
      }
      return source[property];
    },
  });
  const { files, ids } = await admittedFiles(fx.project, { fs: io });
  const opened = await files.read({ ...ids, path: 'fsync.txt' });

  assert.deepEqual(await files.write({
    ...ids, path: 'fsync.txt', content: 'local',
    expectedRevision: opened.revision, overwrite: false,
  }), { ok: false, error: 'write-failed' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  assert.deepEqual(documentTemps(fx.project), []);
});

test('cleans the exact temporary file when applying the source mode fails', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const target = path.join(fx.project, 'mode.txt');
  fs.writeFileSync(target, 'original');
  const io = new Proxy(fs, {
    get(source, property) {
      if (property === 'fchmodSync') {
        return () => { throw Object.assign(new Error('fixture chmod failure'), { code: 'EIO' }); };
      }
      return source[property];
    },
  });
  const { files, ids } = await admittedFiles(fx.project, { fs: io });
  const opened = await files.read({ ...ids, path: 'mode.txt' });

  assert.deepEqual(await files.write({
    ...ids, path: 'mode.txt', content: 'local',
    expectedRevision: opened.revision, overwrite: false,
  }), { ok: false, error: 'write-failed' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  assert.deepEqual(documentTemps(fx.project), []);
});

test('writes through internal file symlinks without replacing the link', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const target = path.join(fx.project, 'target.txt');
  const link = path.join(fx.project, 'alias.txt');
  fs.writeFileSync(target, 'original');
  fs.symlinkSync('target.txt', link);
  const { files, ids } = await admittedFiles(fx.project);
  const opened = await files.read({ ...ids, path: 'alias.txt' });

  const saved = await files.write({
    ...ids, path: 'alias.txt', content: 'updated',
    expectedRevision: opened.revision, overwrite: false,
  });
  assert.equal(saved.ok, true);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(link), 'target.txt');
  assert.equal(fs.readFileSync(target, 'utf8'), 'updated');
});

test('fails closed when an internal symlink is retargeted outside before replacement', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const target = path.join(fx.project, 'target.txt');
  const outside = path.join(fx.base, 'outside.txt');
  const link = path.join(fx.project, 'alias.txt');
  fs.writeFileSync(target, 'inside');
  fs.writeFileSync(outside, 'outside');
  fs.symlinkSync('target.txt', link);
  const { files, ids } = await admittedFiles(fx.project, {
    beforeReplace() {
      fs.unlinkSync(link);
      fs.symlinkSync(outside, link);
    },
  });
  const opened = await files.read({ ...ids, path: 'alias.txt' });

  assert.deepEqual(await files.write({
    ...ids, path: 'alias.txt', content: 'must not escape',
    expectedRevision: opened.revision, overwrite: false,
  }), { ok: false, error: 'outside-root' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'inside');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
  assert.deepEqual(documentTemps(fx.project), []);
});

test('validates document request paths and write payloads before filesystem mutation', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  fs.writeFileSync(path.join(fx.project, 'safe.txt'), 'safe');
  const { files, ids } = await admittedFiles(fx.project);
  const opened = await files.read({ ...ids, path: 'safe.txt' });

  for (const unsafe of ['', '../safe.txt', '/etc/passwd', 'a\\b', 'a\0b']) {
    assert.deepEqual(await files.read({ ...ids, path: unsafe }), { ok: false, error: 'invalid-path' });
  }
  assert.deepEqual(await files.read({ ...ids, path: '.git/config' }), {
    ok: false, error: 'git-metadata-denied',
  });
  for (const request of [
    { content: Buffer.from('no'), expectedRevision: opened.revision, overwrite: false },
    { content: 'no', expectedRevision: 'not-a-revision', overwrite: false },
    { content: 'no', expectedRevision: opened.revision, overwrite: 'yes' },
  ]) {
    assert.deepEqual(await files.write({ ...ids, path: 'safe.txt', ...request }), {
      ok: false, error: 'invalid-request',
    });
  }
  assert.equal(fs.readFileSync(path.join(fx.project, 'safe.txt'), 'utf8'), 'safe');
  assert.deepEqual(documentTemps(fx.project), []);
});

function swappingReadFs(target, external, { armed = true } = {}) {
  let shouldSwap = armed;
  return {
    io: new Proxy(fs, {
      get(source, property) {
        if (property === 'openSync') {
          return (value, flags, mode) => {
            const readable = flags === 'r' || (Number.isInteger(flags)
              && (flags & source.constants.O_ACCMODE) === source.constants.O_RDONLY);
            if (shouldSwap && value === target && readable) {
              shouldSwap = false;
              const original = `${target}.original`;
              source.renameSync(target, original);
              source.symlinkSync(external, target);
              try {
                return source.openSync(target, 'r', mode);
              } finally {
                source.unlinkSync(target);
                source.renameSync(original, target);
              }
            }
            return source.openSync(value, flags, mode);
          };
        }
        return source[property];
      },
    }),
    arm() { shouldSwap = true; },
  };
}

test('binds public reads to the verified file descriptor identity', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const target = path.join(fx.project, 'inside.txt');
  const external = path.join(fx.base, 'external.txt');
  fs.writeFileSync(target, 'inside bytes');
  fs.writeFileSync(external, 'external secret');
  const swapping = swappingReadFs(target, external);
  const { files, ids } = await admittedFiles(fx.project, { fs: swapping.io });

  const result = await files.read({ ...ids, path: 'inside.txt' });
  assert.deepEqual(result, { ok: false, error: 'unreadable' });
  assert.equal(result.content, undefined);
  assert.equal(result.revision, undefined);
  assert.equal(fs.readFileSync(target, 'utf8'), 'inside bytes');
  assert.equal(fs.readFileSync(external, 'utf8'), 'external secret');
});

test('uses descriptor identity binding for the initial write snapshot', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const target = path.join(fx.project, 'inside.txt');
  const external = path.join(fx.base, 'external.txt');
  fs.writeFileSync(target, 'inside bytes');
  fs.writeFileSync(external, 'external secret');
  const swapping = swappingReadFs(target, external, { armed: false });
  const { files, ids } = await admittedFiles(fx.project, { fs: swapping.io });
  const opened = await files.read({ ...ids, path: 'inside.txt' });
  swapping.arm();

  assert.deepEqual(await files.write({
    ...ids, path: 'inside.txt', content: 'local edit',
    expectedRevision: opened.revision, overwrite: false,
  }), { ok: false, error: 'unreadable' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'inside bytes');
  assert.equal(fs.readFileSync(external, 'utf8'), 'external secret');
  assert.deepEqual(documentTemps(fx.project), []);
});

test('never cleans a wx collision path that the write does not own', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const target = path.join(fx.project, 'collision.txt');
  fs.writeFileSync(target, 'original');
  let sentinel;
  const io = new Proxy(fs, {
    get(source, property) {
      if (property === 'openSync') {
        return (value, flags, mode) => {
          if (flags === 'wx') {
            sentinel = value;
            source.writeFileSync(sentinel, 'sentinel bytes');
          }
          return source.openSync(value, flags, mode);
        };
      }
      return source[property];
    },
  });
  const { files, ids } = await admittedFiles(fx.project, { fs: io });
  const opened = await files.read({ ...ids, path: 'collision.txt' });

  assert.deepEqual(await files.write({
    ...ids, path: 'collision.txt', content: 'local',
    expectedRevision: opened.revision, overwrite: false,
  }), { ok: false, error: 'write-failed' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'sentinel bytes');
  fs.unlinkSync(sentinel);
});

test('maps resolver EACCES and EPERM to permission-denied for document operations', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const target = path.join(fx.project, 'permission.txt');
  fs.writeFileSync(target, 'original');

  for (const code of ['EACCES', 'EPERM']) {
    let denied = false;
    const io = new Proxy(fs, {
      get(source, property) {
        if (property === 'realpathSync') {
          return (value, options) => {
            if (denied && value === target) {
              throw Object.assign(new Error(`fixture ${code}`), { code });
            }
            return source.realpathSync(value, options);
          };
        }
        return source[property];
      },
    });
    const { files, ids } = await admittedFiles(fx.project, { fs: io });
    const opened = await files.read({ ...ids, path: 'permission.txt' });

    denied = true;
    assert.deepEqual(await files.read({ ...ids, path: 'permission.txt' }), {
      ok: false, error: 'permission-denied',
    });
    assert.deepEqual(await files.write({
      ...ids, path: 'permission.txt', content: 'blocked',
      expectedRevision: opened.revision, overwrite: false,
    }), { ok: false, error: 'permission-denied' });
    denied = false;
  }
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
});

test('coalesces file watcher hints into opaque relative events', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const scheduler = manualScheduler();
  const watcher = new FakeRootWatcher();
  let watchedPath;
  let watchOptions;
  const files = createProjectFiles({
    watchFactory(root, options) {
      watchedPath = root;
      watchOptions = options;
      return watcher;
    },
    scheduler,
    watchDebounceMs: 25,
  });
  t.after(() => files.close());
  files.admitProject(fx.project, 'configured');
  const ids = await openedRoot(files, fx.project);
  const events = [];

  assert.deepEqual(await files.watch('renderer-1', ids, (event) => events.push(event)), { ok: true });
  assert.equal(watchedPath, fx.project);
  assert.equal(watchOptions.ignoreInitial, true);
  assert.equal(watchOptions.persistent, true);
  assert.equal(watchOptions.followSymlinks, false);
  assert.deepEqual(watchOptions.awaitWriteFinish, { stabilityThreshold: 100, pollInterval: 20 });

  watcher.emit('add', path.join(fx.project, 'nested', 'added.txt'));
  watcher.emit('add', path.join(fx.project, 'nested', 'added.txt'));
  watcher.emit('change', path.join(fx.project, 'changed.txt'));
  watcher.emit('change', path.join(fx.project, 'changed.txt'));
  watcher.emit('unlink', path.join(fx.project, 'removed.txt'));
  watcher.emit('unlink', path.join(fx.project, 'removed.txt'));
  assert.deepEqual(events, []);

  scheduler.flush();
  assert.deepEqual(events, [
    { ...ids, path: 'nested/added.txt', kind: 'added' },
    { ...ids, path: 'changed.txt', kind: 'changed' },
    { ...ids, path: 'removed.txt', kind: 'removed' },
  ]);
  assert.equal(events.every((event) => !path.isAbsolute(event.path)), true);
});

test('watches and normalizes from the verified target of a symlink-spelled root', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const link = path.join(fx.base, 'project-link');
  fs.symlinkSync(fx.project, link, 'dir');
  const nested = path.join(fx.project, 'nested');
  const target = path.join(nested, 'opaque # å.txt');
  fs.mkdirSync(nested);
  fs.writeFileSync(target, 'content');
  const scheduler = manualScheduler();
  const watcher = new FakeRootWatcher();
  let watchedPaths;
  let watchOptions;
  const files = createProjectFiles({
    watchFactory(roots, options) {
      watchedPaths = roots;
      watchOptions = options;
      return watcher;
    },
    scheduler,
  });
  t.after(() => files.close());
  files.admitProject(link, 'configured');
  const ids = await openedRoot(files, link);
  const events = [];

  assert.deepEqual(await files.watch('renderer-1', ids, (event) => events.push(event)), { ok: true });
  assert.deepEqual(watchedPaths, [fx.project, link]);
  assert.equal(watchOptions.followSymlinks, false);
  assert.equal(watchOptions.ignored(link), false);
  assert.equal(watchOptions.ignored(path.join(link, 'nested')), true);
  assert.equal(watchOptions.ignored(path.join(fx.base, 'other-outside')), true);
  watcher.emit('change', target);
  scheduler.flush();

  assert.deepEqual(events, [{ ...ids, path: 'nested/opaque # å.txt', kind: 'changed' }]);
  assert.equal(path.isAbsolute(events[0].path), false);
});

test('fails and closes when a watched logical root symlink is deleted', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const link = path.join(fx.base, 'project-link');
  const target = path.join(fx.project, 'old-target.txt');
  fs.symlinkSync(fx.project, link, 'dir');
  fs.writeFileSync(target, 'content');
  const scheduler = manualScheduler();
  const watcher = new FakeRootWatcher();
  const files = createProjectFiles({ watchFactory: () => watcher, scheduler });
  files.admitProject(link, 'configured');
  const ids = await openedRoot(files, link);
  const events = [];
  await files.watch('renderer-1', ids, (event) => events.push(event));

  watcher.emit('change', target);
  assert.equal(scheduler.size, 1);
  fs.unlinkSync(link);
  watcher.emit('unlink', link);
  watcher.emit('change', target);
  scheduler.flush();

  assert.equal(watcher.closed, true);
  assert.equal(watcher.closeCalls, 1);
  assert.equal(scheduler.size, 0);
  assert.deepEqual(events, [{ ...ids, path: '', kind: 'watch-failed' }]);
  assert.equal(JSON.stringify(events).includes(fx.project), false);
  assert.equal(JSON.stringify(events).includes(link), false);
});

test('revalidates a logical root symlink before emitting a queued real-target hint', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const replacement = path.join(fx.base, 'replacement');
  const link = path.join(fx.base, 'project-link');
  const target = path.join(fx.project, 'old-target.txt');
  fs.mkdirSync(replacement);
  fs.symlinkSync(fx.project, link, 'dir');
  fs.writeFileSync(target, 'content');
  const scheduler = manualScheduler();
  const watcher = new FakeRootWatcher();
  const files = createProjectFiles({ watchFactory: () => watcher, scheduler });
  files.admitProject(link, 'configured');
  const ids = await openedRoot(files, link);
  const events = [];
  await files.watch('renderer-1', ids, (event) => events.push(event));

  watcher.emit('change', target);
  fs.unlinkSync(link);
  fs.symlinkSync(replacement, link, 'dir');
  scheduler.flush();
  watcher.emit('change', target);

  assert.equal(watcher.closed, true);
  assert.equal(watcher.closeCalls, 1);
  assert.equal(scheduler.size, 0);
  assert.deepEqual(events, [{ ...ids, path: '', kind: 'watch-failed' }]);
  assert.equal(JSON.stringify(events).includes(fx.project), false);
  assert.equal(JSON.stringify(events).includes(link), false);
});

test('normalizes directory hints and suppresses unsafe watcher paths', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const scheduler = manualScheduler();
  const watcher = new FakeRootWatcher();
  let watchOptions;
  const files = createProjectFiles({
    watchFactory(_root, options) {
      watchOptions = options;
      return watcher;
    },
    scheduler,
  });
  t.after(() => files.close());
  files.admitProject(fx.project, 'configured');
  const ids = await openedRoot(files, fx.project);
  const events = [];
  await files.watch('renderer-1', ids, (event) => events.push(event));

  fs.mkdirSync(path.join(fx.project, '.git'));
  fs.writeFileSync(path.join(fx.project, '.git', 'config'), 'secret');
  fs.mkdirSync(path.join(fx.project, '.git-archive'));
  fs.writeFileSync(path.join(fx.project, '.git-archive', 'visible.txt'), 'visible');
  const temp = path.join(fx.project, '.draft.txt.tabdesk-123.tmp');
  fs.writeFileSync(temp, 'temporary');
  const metadataAlias = path.join(fx.project, 'metadata-alias');
  fs.symlinkSync('.git', metadataAlias, 'dir');
  const outside = path.join(fx.base, 'outside.txt');
  fs.writeFileSync(outside, 'outside');

  assert.equal(watchOptions.ignored(path.join(fx.project, '.git', 'config')), true);
  assert.equal(watchOptions.ignored(path.join(fx.project, '.git-archive', 'visible.txt')), false);
  assert.equal(watchOptions.ignored(metadataAlias), true);
  assert.equal(watchOptions.ignored(outside), true);
  assert.equal(watchOptions.ignored(temp), true);

  watcher.emit('addDir', path.join(fx.project, 'new directory'));
  watcher.emit('unlinkDir', path.join(fx.project, 'old-directory'));
  watcher.emit('change', path.join(fx.project, '.git-archive', 'visible.txt'));
  watcher.emit('change', path.join(fx.project, 'space # å.txt'));
  watcher.emit('change', path.join(fx.project, '.git', 'config'));
  watcher.emit('add', metadataAlias);
  watcher.emit('change', temp);
  watcher.emit('change', outside);
  scheduler.flush();

  assert.deepEqual(events, [
    { ...ids, path: 'new directory', kind: 'tree-invalidated' },
    { ...ids, path: 'old-directory', kind: 'tree-invalidated' },
    { ...ids, path: '.git-archive/visible.txt', kind: 'changed' },
    { ...ids, path: 'space # å.txt', kind: 'changed' },
  ]);
});

test('does not emit from a candidate whose root fails final validation', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const replacement = path.join(fx.base, 'replacement');
  const link = path.join(fx.base, 'project-link');
  fs.mkdirSync(replacement);
  fs.symlinkSync(fx.project, link, 'dir');
  const scheduler = manualScheduler();
  const watcher = new FakeRootWatcher();
  const files = createProjectFiles({ watchFactory: () => watcher, scheduler });
  files.admitProject(link, 'configured');
  const ids = await openedRoot(files, link);
  const events = [];

  const request = files.watch('renderer-1', ids, (event) => events.push(event));
  await Promise.resolve();
  await Promise.resolve();
  fs.unlinkSync(link);
  fs.symlinkSync(replacement, link, 'dir');
  watcher.emit('change', path.join(fx.project, 'before-install.txt'));
  scheduler.flush();

  assert.deepEqual(await request, { ok: false, error: 'project-unavailable' });
  assert.equal(watcher.closed, true);
  assert.deepEqual(events, []);
});

test('reports but does not emit a watcher error before candidate installation', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const scheduler = manualScheduler();
  const watcher = new FakeRootWatcher();
  const files = createProjectFiles({ watchFactory: () => watcher, scheduler });
  files.admitProject(fx.project, 'configured');
  const ids = await openedRoot(files, fx.project);
  const events = [];

  const request = files.watch('renderer-1', ids, (event) => events.push(event));
  await Promise.resolve();
  await Promise.resolve();
  watcher.emit('error', new Error(`/private/pre-install/${fx.project}`));

  assert.deepEqual(await request, { ok: false, error: 'watch-failed' });
  assert.equal(watcher.closed, true);
  assert.deepEqual(events, []);
});

test('replaces the active watcher owned by one renderer', async (t) => {
  const firstFx = fixture();
  const secondFx = fixture();
  t.after(firstFx.cleanup);
  t.after(secondFx.cleanup);
  const scheduler = manualScheduler();
  const firstWatcher = new FakeRootWatcher();
  const secondWatcher = new FakeRootWatcher();
  const candidates = [firstWatcher, secondWatcher];
  const files = createProjectFiles({ watchFactory: () => candidates.shift(), scheduler });
  t.after(() => files.close());
  files.admitProject(firstFx.project, 'configured');
  files.admitProject(secondFx.project, 'configured');
  const firstIds = await openedRoot(files, firstFx.project);
  const secondIds = await openedRoot(files, secondFx.project);
  const events = [];

  await files.watch('renderer-1', firstIds, (event) => events.push(event));
  await files.watch('renderer-1', secondIds, (event) => events.push(event));
  assert.equal(firstWatcher.closed, true);
  assert.equal(firstWatcher.closeCalls, 1);
  assert.equal(secondWatcher.closed, false);

  firstWatcher.emit('change', path.join(firstFx.project, 'stale.txt'));
  secondWatcher.emit('change', path.join(secondFx.project, 'active.txt'));
  scheduler.flush();
  assert.deepEqual(events, [{ ...secondIds, path: 'active.txt', kind: 'changed' }]);
});

test('keeps only the newest watch request when candidates resolve out of order', async (t) => {
  const firstFx = fixture();
  const secondFx = fixture();
  t.after(firstFx.cleanup);
  t.after(secondFx.cleanup);
  const scheduler = manualScheduler();
  const firstGate = deferred();
  const secondGate = deferred();
  const firstWatcher = new FakeRootWatcher();
  const secondWatcher = new FakeRootWatcher();
  const files = createProjectFiles({
    watchFactory(root) {
      return root === firstFx.project ? firstGate.promise : secondGate.promise;
    },
    scheduler,
  });
  t.after(() => files.close());
  files.admitProject(firstFx.project, 'configured');
  files.admitProject(secondFx.project, 'configured');
  const firstIds = await openedRoot(files, firstFx.project);
  const secondIds = await openedRoot(files, secondFx.project);
  const events = [];

  const firstRequest = files.watch('renderer-1', firstIds, (event) => events.push(event));
  await Promise.resolve();
  const secondRequest = files.watch('renderer-1', secondIds, (event) => events.push(event));
  await Promise.resolve();
  secondGate.resolve(secondWatcher);
  assert.deepEqual(await secondRequest, { ok: true });
  firstGate.resolve(firstWatcher);
  await Promise.resolve();
  firstWatcher.emit('change', path.join(firstFx.project, 'stale-before-close.txt'));
  scheduler.flush();
  await firstRequest;

  assert.equal(firstWatcher.closed, true);
  assert.equal(secondWatcher.closed, false);
  firstWatcher.emit('change', path.join(firstFx.project, 'stale.txt'));
  secondWatcher.emit('change', path.join(secondFx.project, 'newest.txt'));
  scheduler.flush();
  assert.deepEqual(events, [{ ...secondIds, path: 'newest.txt', kind: 'changed' }]);
});

test('unwatch prevents an in-flight candidate from becoming active', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const gate = deferred();
  const watcher = new FakeRootWatcher();
  const scheduler = manualScheduler();
  const files = createProjectFiles({ watchFactory: () => gate.promise, scheduler });
  files.admitProject(fx.project, 'configured');
  const ids = await openedRoot(files, fx.project);
  const events = [];

  const request = files.watch('renderer-1', ids, (event) => events.push(event));
  await Promise.resolve();
  files.unwatch('renderer-1');
  gate.resolve(watcher);
  await request;
  watcher.emit('change', path.join(fx.project, 'resurrected.txt'));
  scheduler.flush();

  assert.equal(watcher.closed, true);
  assert.deepEqual(events, []);
});

test('unwatch and close cancel pending hints and clean watchers idempotently', async (t) => {
  const firstFx = fixture();
  const secondFx = fixture();
  t.after(firstFx.cleanup);
  t.after(secondFx.cleanup);
  const scheduler = manualScheduler();
  const firstWatcher = new FakeRootWatcher();
  const secondWatcher = new FakeRootWatcher();
  const candidates = [firstWatcher, secondWatcher];
  const files = createProjectFiles({ watchFactory: () => candidates.shift(), scheduler });
  files.admitProject(firstFx.project, 'configured');
  files.admitProject(secondFx.project, 'configured');
  const firstIds = await openedRoot(files, firstFx.project);
  const secondIds = await openedRoot(files, secondFx.project);
  const events = [];
  await files.watch('renderer-1', firstIds, (event) => events.push(event));
  await files.watch('renderer-2', secondIds, (event) => events.push(event));

  firstWatcher.emit('change', path.join(firstFx.project, 'pending.txt'));
  secondWatcher.emit('change', path.join(secondFx.project, 'pending.txt'));
  assert.equal(scheduler.size, 2);
  files.unwatch('renderer-1');
  files.unwatch('renderer-1');
  files.close();
  files.close();
  scheduler.flush();

  assert.equal(firstWatcher.closeCalls, 1);
  assert.equal(secondWatcher.closeCalls, 1);
  assert.equal(scheduler.size, 0);
  assert.deepEqual(events, []);
});

test('reports watcher startup, runtime, and root-deletion failures safely', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const startupFiles = createProjectFiles({
    watchFactory() {
      throw new Error(`/private/startup/${fx.project}`);
    },
  });
  startupFiles.admitProject(fx.project, 'configured');
  const startupIds = await openedRoot(startupFiles, fx.project);
  assert.deepEqual(await startupFiles.watch('renderer-startup', startupIds, () => {}), {
    ok: false, error: 'watch-failed',
  });

  const scheduler = manualScheduler();
  const errorWatcher = new FakeRootWatcher();
  const deletionWatcher = new FakeRootWatcher();
  const candidates = [errorWatcher, deletionWatcher];
  const files = createProjectFiles({ watchFactory: () => candidates.shift(), scheduler });
  files.admitProject(fx.project, 'configured');
  const ids = await openedRoot(files, fx.project);
  const events = [];
  await files.watch('renderer-1', ids, (event) => events.push(event));
  errorWatcher.emit('error', new Error(`/private/runtime/${fx.project}`));
  assert.equal(errorWatcher.closed, true);

  await files.watch('renderer-1', ids, (event) => events.push(event));
  deletionWatcher.emit('unlinkDir', fx.project);
  scheduler.flush();

  assert.equal(deletionWatcher.closed, true);
  assert.deepEqual(events, [
    { ...ids, path: '', kind: 'watch-failed' },
    { ...ids, path: '', kind: 'watch-failed' },
  ]);
  assert.equal(JSON.stringify(events).includes(fx.project), false);
});
