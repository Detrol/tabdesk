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
