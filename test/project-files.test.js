const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
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
