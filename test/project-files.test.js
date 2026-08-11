const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
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
    execFile(file, args, options, callback) {
      return execFile(file, args, options, (error, stdout, stderr) => {
        if (!repointed && args.includes('--git-common-dir')) {
          fs.unlinkSync(link);
          fs.symlinkSync(replacement, link, 'dir');
          repointed = true;
        }
        callback(error, stdout, stderr);
      });
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
    execFile(file, args, options, callback) {
      return execFile(file, args, options, (error, stdout, stderr) => {
        if (repointOnGit && !repointed && args.includes('--show-toplevel')) {
          fs.unlinkSync(link);
          fs.symlinkSync(secondWorktree, link, 'dir');
          repointed = true;
        }
        callback(error, stdout, stderr);
      });
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
    execFile(file, args, options, callback) {
      if (repointBeforeGit && !repointed && args.includes('--show-toplevel')) {
        fs.unlinkSync(link);
        fs.symlinkSync(secondWorktree, link, 'dir');
        repointed = true;
      }
      return execFile(file, args, options, callback);
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
  assert.deepEqual(spawns[0].options, { stdio: ['pipe', 'pipe', 'ignore'] });
  assert.equal(spawns[0].input.at(-1), 0);
  assert.match(spawns[0].input.toString('utf8'), /normal\.txt\0/);

  status = 128;
  assert.deepEqual(await files.list({ ...ids, directory: '' }), { ok: false, error: 'git-unavailable' });

  const plain = path.join(fx.base, 'plain');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, 'normal.txt'), 'normal');
  const plainFiles = createProjectFiles({ spawn: () => { throw new Error('must not spawn'); } });
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
    execFile(file, args, options, callback) {
      probeOptions = options;
      const error = Object.assign(new Error('not a repository'), { code: 128 });
      callback(error, '', 'fatal: not a git repository (or any of the parent directories): .git\n');
    },
    spawn: () => { throw new Error('non-Git roots must not check ignore'); },
  });
  nonGitFiles.admitProject(fx.project, 'configured');
  const ids = await openedRoot(nonGitFiles, fx.project);
  assert.equal((await nonGitFiles.list({ ...ids, directory: '' })).ok, true);
  assert.equal(probeOptions.env.LC_ALL, 'C');
  assert.equal(probeOptions.env.PATH, process.env.PATH);

  const fatalFiles = createProjectFiles({
    execFile(file, args, options, callback) {
      const error = Object.assign(new Error('broken Git'), { code: 128 });
      callback(error, '', 'fatal: malformed repository configuration\n');
    },
  });
  fatalFiles.admitProject(fx.project, 'configured');
  const fatalIds = await openedRoot(fatalFiles, fx.project);
  assert.deepEqual(await fatalFiles.list({ ...fatalIds, directory: '' }), {
    ok: false, error: 'git-unavailable',
  });
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

test('denies a worktree root after its Git common-directory relationship changes', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  gitProject(fx.project);
  const worktree = path.join(fx.project, '.worktrees', 'topic');
  fs.mkdirSync(path.dirname(worktree));
  git(fx.project, ['worktree', 'add', '-b', 'topic', worktree]);
  const files = createProjectFiles();
  files.admitProject(fx.project, 'configured');
  const opened = await files.openProject(fx.project);
  const worktreeId = opened.roots.find(({ kind }) => kind === 'worktree').id;

  fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: /definitely-not-a-worktree\n');
  assert.deepEqual(await files.list({ projectId: opened.projectId, rootId: worktreeId, directory: '' }), {
    ok: false, error: 'project-unavailable',
  });
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
          if (value === denied && flags === 'r') {
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
