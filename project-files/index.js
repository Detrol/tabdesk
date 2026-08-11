const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const { readDocument, writeDocument } = require('./document');
const { createRootWatcher } = require('./watch');

const SOURCES = new Set(['configured', 'picker', 'restored']);

function relativeParts(value, { root = false } = {}) {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\')) return null;
  if ((!root && !value) || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return null;
  if (value && (value.endsWith('/') || value.includes('//'))) return null;
  const parts = value ? value.split('/') : [];
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return parts;
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function hasGitComponent(root, target) {
  return path.relative(root, target).split(path.sep).includes('.git');
}

function relativeGitPath(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

function sameDirectory(left, right) {
  return Boolean(left && right && left.real === right.real && left.dev === right.dev
    && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs);
}

function safeDirectory(io, dir) {
  if (typeof dir !== 'string' || !dir) return null;
  const logical = path.resolve(dir);
  try {
    const stats = io.statSync(logical);
    if (!stats.isDirectory()) return null;
    return {
      logical,
      real: io.realpathSync(logical),
      dev: stats.dev,
      ino: stats.ino,
      birthtimeMs: stats.birthtimeMs,
    };
  } catch (_) {
    return null;
  }
}

function publicRoot(root) {
  return { id: root.id, kind: root.kind, label: root.label };
}

function createProjectFiles(options = {}) {
  const io = options.fs || fs;
  const run = options.execFile || childProcess.execFile;
  const spawn = options.spawn || childProcess.spawn;
  const byPath = new Map();
  const byId = new Map();
  const watcherOwners = new Map();
  let watchersClosed = false;

  function closeOwnedWatchers(projectId, rootId) {
    for (const owner of watcherOwners.values()) {
      if (owner.active?.projectId !== projectId) continue;
      if (rootId !== undefined && owner.active.rootId !== rootId) continue;
      owner.token += 1;
      closeActive(owner);
    }
  }

  function revoke(project) {
    if (byPath.get(project.logical) === project) byPath.delete(project.logical);
    if (byId.get(project.id) === project) byId.delete(project.id);
    closeOwnedWatchers(project.id);
  }

  function invalidateRoot(project, root) {
    if (project.rootsById.get(root.id) !== root) return;
    project.rootsById.delete(root.id);
    for (const [key, candidate] of project.rootsByKey) {
      if (candidate === root) project.rootsByKey.delete(key);
    }
    closeOwnedWatchers(project.id, root.id);
  }

  function admitProject(projectPath, source) {
    if (!SOURCES.has(source)) return { ok: false, error: 'project-unavailable' };
    const dir = safeDirectory(io, projectPath);
    if (!dir) return { ok: false, error: 'project-unavailable' };

    let project = byPath.get(dir.logical);
    if (!project || !sameDirectory(project, dir)) {
      if (project) revoke(project);
      project = {
        id: crypto.randomUUID(),
        logical: dir.logical,
        real: dir.real,
        dev: dir.dev,
        ino: dir.ino,
        birthtimeMs: dir.birthtimeMs,
        sources: new Set(),
        rootsByKey: new Map(),
        rootsById: new Map(),
      };
      byPath.set(dir.logical, project);
      byId.set(project.id, project);
    }
    project.sources.add(source);
    return { ok: true, projectId: project.id };
  }

  function replaceAdmissions(source, paths) {
    if (!SOURCES.has(source)) return;
    for (const project of byPath.values()) project.sources.delete(source);
    for (const projectPath of paths || []) admitProject(projectPath, source);
    for (const project of [...byPath.values()]) {
      if (!project.sources.size) revoke(project);
    }
  }

  function exec(file, args) {
    return new Promise((resolve, reject) => {
      run(file, args, { encoding: 'utf8' }, (error, stdout) => {
        if (error) return reject(error);
        return resolve(String(stdout).trim());
      });
    });
  }

  async function gitCommonDir(directory) {
    try {
      const commonDir = await exec('git', [
        '-C', directory,
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ]);
      return io.realpathSync(commonDir);
    } catch (_) {
      return null;
    }
  }

  async function isGitWorktree(directory, commonDir) {
    try {
      const topLevel = await exec('git', ['-C', directory.logical, 'rev-parse', '--show-toplevel']);
      if (io.realpathSync(topLevel) !== directory.real) return false;
      return (await gitCommonDir(directory.logical)) === commonDir;
    } catch (_) {
      return false;
    }
  }

  function gitRepository(directory) {
    return new Promise((resolve) => {
      run('git', ['-C', directory, 'rev-parse', '--is-inside-work-tree'], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
      }, (error, stdout, stderr) => {
        if (!error) return resolve(String(stdout).trim() === 'true' ? { git: true } : { error: 'git-unavailable' });
        if (error.code === 128 && /not a git repository/i.test(String(stderr))) return resolve({ git: false });
        return resolve({ error: 'git-unavailable' });
      });
    });
  }

  function conventionCandidates(project) {
    const candidates = [];
    for (const folder of ['.worktrees', path.join('.claude', 'worktrees')]) {
      let names;
      try {
        names = io.readdirSync(path.join(project.logical, folder));
      } catch (_) {
        continue;
      }
      for (const name of names) {
        if (name.startsWith('.')) continue;
        const dir = safeDirectory(io, path.join(project.logical, folder, name));
        if (dir) candidates.push({ ...dir, label: name });
      }
    }
    return candidates;
  }

  async function verifiedWorktrees(project, candidates) {
    const projectCommonDir = await gitCommonDir(project.logical);
    if (!projectCommonDir) return [];
    const seen = new Set();
    const worktrees = [];
    for (const candidate of candidates) {
      if (seen.has(candidate.real)) continue;
      if (!await isGitWorktree(candidate, projectCommonDir)) continue;
      seen.add(candidate.real);
      worktrees.push(candidate);
    }
    return worktrees.sort((left, right) => left.label.localeCompare(right.label));
  }

  function refreshProject(project) {
    const current = safeDirectory(io, project.logical);
    if (!sameDirectory(project, current)) {
      revoke(project);
      return null;
    }
    return current;
  }

  function rootsStillValid(project, worktrees) {
    if (!refreshProject(project)) return false;
    for (const worktree of worktrees) {
      const current = safeDirectory(io, worktree.logical);
      if (!sameDirectory(worktree, current)) return false;
    }
    return Boolean(refreshProject(project));
  }

  function refreshRoots(project, worktrees) {
    const rootDirectories = [
      {
        logical: project.logical,
        real: project.real,
        dev: project.dev,
        ino: project.ino,
        birthtimeMs: project.birthtimeMs,
        kind: 'project',
        label: path.basename(project.logical),
      },
      ...worktrees.map((worktree) => ({ ...worktree, kind: 'worktree' })),
    ];
    const nextByKey = new Map();
    const nextById = new Map();

    for (const directory of rootDirectories) {
      const key = `${directory.logical}\0${directory.real}\0${directory.dev}\0${directory.ino}\0${directory.birthtimeMs}`;
      const root = project.rootsByKey.get(key) || { id: crypto.randomUUID(), ...directory };
      nextByKey.set(key, root);
      nextById.set(root.id, root);
    }
    for (const root of project.rootsById.values()) {
      if (!nextById.has(root.id)) invalidateRoot(project, root);
    }
    project.rootsByKey = nextByKey;
    project.rootsById = nextById;
    return rootDirectories.map((directory) => project.rootsByKey.get(
      `${directory.logical}\0${directory.real}\0${directory.dev}\0${directory.ino}\0${directory.birthtimeMs}`,
    ));
  }

  async function openProject(projectPath) {
    const requested = safeDirectory(io, projectPath);
    const project = requested && byPath.get(requested.logical);
    if (!project) return { ok: false, error: 'project-unavailable' };

    for (let attempt = 0; attempt < 2; attempt++) {
      if (!refreshProject(project)) return { ok: false, error: 'project-unavailable' };
      const candidates = conventionCandidates(project);
      const worktrees = await verifiedWorktrees(project, candidates);
      if (!rootsStillValid(project, candidates)) {
        if (!byPath.has(project.logical)) return { ok: false, error: 'project-unavailable' };
        continue;
      }
      const roots = refreshRoots(project, worktrees);
      return { ok: true, projectId: project.id, roots: roots.map(publicRoot) };
    }

    return { ok: false, error: 'project-unavailable' };
  }

  async function describeWorktrees(projectPath) {
    const opened = await openProject(projectPath);
    if (!opened.ok) return [];
    const project = byId.get(opened.projectId);
    return [...project.rootsById.values()]
      .filter((root) => root.kind === 'worktree')
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((root) => ({ name: root.label, path: root.logical }));
  }

  async function admitSelection(selectedPath, source) {
    if (!SOURCES.has(source)) return { ok: false, error: 'project-unavailable' };
    const selected = safeDirectory(io, selectedPath);
    if (!selected) return { ok: false, error: 'project-unavailable' };

    for (const project of [...byPath.values()]) {
      if (!refreshProject(project)) continue;
      const candidate = conventionCandidates(project).find(({ logical }) => logical === selected.logical);
      if (!candidate) continue;
      const projectCommonDir = await gitCommonDir(project.logical);
      if (!projectCommonDir || !await isGitWorktree(selected, projectCommonDir)) continue;
      const admitted = admitProject(project.logical, source);
      if (!admitted.ok) return admitted;
      return { ok: true, projectPath: project.logical, selectedPath: selected.logical };
    }

    const admitted = admitProject(selected.logical, source);
    if (!admitted.ok) return admitted;
    return { ok: true, projectPath: selected.logical, selectedPath: selected.logical };
  }

  async function selectedRoot(projectId, rootId) {
    const project = typeof projectId === 'string' && byId.get(projectId);
    if (!project || !refreshProject(project)) return { error: 'project-unavailable' };
    const root = typeof rootId === 'string' && project.rootsById.get(rootId);
    if (!root) return { error: 'project-unavailable' };
    const current = safeDirectory(io, root.logical);
    if (!sameDirectory(root, current)) {
      invalidateRoot(project, root);
      return { error: 'project-unavailable' };
    }

    if (root.kind === 'worktree') {
      const projectCommonDir = await gitCommonDir(project.logical);
      if (!projectCommonDir || !await isGitWorktree(current, projectCommonDir)) {
        invalidateRoot(project, root);
        return { error: 'project-unavailable' };
      }
      const refreshed = byId.get(projectId);
      const refreshedRoot = refreshed && refreshed.rootsById.get(rootId);
      const refreshedCurrent = refreshedRoot && safeDirectory(io, refreshedRoot.logical);
      if (refreshed !== project || refreshedRoot !== root) {
        return { error: 'project-unavailable' };
      }
      if (!refreshProject(project)) return { error: 'project-unavailable' };
      if (!sameDirectory(root, refreshedCurrent)) {
        invalidateRoot(project, root);
        return { error: 'project-unavailable' };
      }
    }

    return { project, root, real: current.real };
  }

  function resolveContained(root, parts, { missing = 'unreadable', denied = 'unreadable' } = {}) {
    const logical = path.join(root.real, ...parts);
    let real;
    try {
      real = io.realpathSync(logical);
    } catch (error) {
      if (error && error.code === 'ENOENT') return { error: missing };
      if (error && (error.code === 'EACCES' || error.code === 'EPERM')) return { error: denied };
      return { error: 'unreadable' };
    }
    if (!contained(root.real, real)) return { error: 'outside-root' };
    if (hasGitComponent(root.real, real)) return { error: 'git-metadata-denied' };
    return { logical, real };
  }

  function directorySnapshot(root, parts) {
    const target = resolveContained(root, parts);
    if (target.error) return target;
    let stats;
    try {
      stats = io.statSync(target.real);
    } catch (_) {
      return { error: 'unreadable' };
    }
    if (!stats.isDirectory()) return { error: 'not-directory' };
    const current = resolveContained(root, parts);
    if (current.error) return current;
    if (current.real !== target.real) return { error: 'unreadable' };
    let currentStats;
    try {
      currentStats = io.statSync(current.real);
    } catch (_) {
      return { error: 'unreadable' };
    }
    if (!currentStats.isDirectory() || currentStats.dev !== stats.dev || currentStats.ino !== stats.ino
      || currentStats.birthtimeMs !== stats.birthtimeMs) {
      return { error: 'unreadable' };
    }
    return { target, identity: { dev: stats.dev, ino: stats.ino, birthtimeMs: stats.birthtimeMs } };
  }

  function currentDirectory(root, parts, snapshot) {
    const current = directorySnapshot(root, parts);
    if (current.error) return current;
    if (current.target.real !== snapshot.target.real
      || current.identity.dev !== snapshot.identity.dev || current.identity.ino !== snapshot.identity.ino
      || current.identity.birthtimeMs !== snapshot.identity.birthtimeMs) {
      return { error: 'unreadable' };
    }
    return current;
  }

  function inspectEntry(root, directoryParts, directoryReal, name) {
    const parts = [...directoryParts, name];
    if (parts.includes('.git')) return null;
    const logical = path.join(directoryReal, name);
    let link;
    try {
      link = io.lstatSync(logical);
    } catch (_) {
      return null;
    }
    const entry = {
      name,
      path: parts.join('/'),
      kind: 'other',
      hidden: name.startsWith('.'),
      ignored: false,
      symlink: link.isSymbolicLink(),
      unavailable: undefined,
    };
    let real;
    try {
      real = io.realpathSync(logical);
    } catch (_) {
      entry.unavailable = 'unreadable';
      return entry;
    }
    if (!contained(root.real, real)) {
      try {
        const target = io.statSync(real);
        entry.kind = target.isDirectory() ? 'directory' : target.isFile() ? 'file' : 'other';
      } catch (_) {
        entry.kind = 'other';
      }
      entry.unavailable = 'outside-root';
      return entry;
    }
    if (hasGitComponent(root.real, real)) return null;
    try {
      const target = io.statSync(real);
      entry.kind = target.isDirectory() ? 'directory' : target.isFile() ? 'file' : 'other';
      if (entry.kind === 'other') entry.unavailable = 'not-file';
    } catch (_) {
      entry.unavailable = 'unreadable';
    }
    const directoryGitPath = relativeGitPath(root.real, directoryReal);
    entry.gitPath = directoryGitPath ? `${directoryGitPath}/${name}` : name;
    return entry;
  }

  async function gitIgnored(root, paths) {
    if (!paths.length) return Promise.resolve({ ignored: new Set() });
    const repository = await gitRepository(root.real);
    if (repository.error) return repository;
    if (!repository.git) return { ignored: new Set() };
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn('git', ['-C', root.real, 'check-ignore', '--stdin', '-z'], {
          stdio: ['pipe', 'pipe', 'ignore'],
        });
      } catch (_) {
        resolve({ error: 'git-unavailable' });
        return;
      }
      const output = [];
      child.stdout.on('data', (chunk) => output.push(chunk));
      child.on('error', () => resolve({ error: 'git-unavailable' }));
      child.on('close', (code) => {
        if (code !== 0 && code !== 1) return resolve({ error: 'git-unavailable' });
        const ignored = Buffer.concat(output).toString('utf8').split('\0').filter(Boolean);
        return resolve({ ignored: new Set(ignored) });
      });
      child.stdin.end(Buffer.from(`${paths.join('\0')}\0`, 'utf8'));
    });
  }

  async function list({ projectId, rootId, directory, showIgnored } = {}) {
    const parts = relativeParts(directory, { root: true });
    if (!parts) return { ok: false, error: 'invalid-path' };
    if (parts.includes('.git')) return { ok: false, error: 'git-metadata-denied' };
    const selected = await selectedRoot(projectId, rootId);
    if (selected.error) return { ok: false, error: selected.error };
    const snapshot = directorySnapshot(selected, parts);
    if (snapshot.error) return { ok: false, error: snapshot.error };

    let names;
    try {
      names = io.readdirSync(snapshot.target.real);
    } catch (_) {
      return { ok: false, error: 'unreadable' };
    }
    const entries = names
      .map((name) => inspectEntry(selected, parts, snapshot.target.real, name))
      .filter(Boolean);
    const beforeGit = currentDirectory(selected, parts, snapshot);
    if (beforeGit.error) return { ok: false, error: beforeGit.error };
    const ignored = await gitIgnored(selected, [...new Set(entries.map((entry) => entry.gitPath).filter(Boolean))]);
    if (ignored.error) return { ok: false, error: ignored.error };
    const afterGit = currentDirectory(selected, parts, snapshot);
    if (afterGit.error) return { ok: false, error: afterGit.error };
    for (const entry of entries) entry.ignored = Boolean(entry.gitPath && ignored.ignored.has(entry.gitPath));
    entries.sort((left, right) => (left.kind === 'directory') === (right.kind === 'directory')
      ? left.name.localeCompare(right.name)
      : left.kind === 'directory' ? -1 : 1);
    const publicEntries = entries.map(({ gitPath, ...entry }) => entry);
    return {
      ok: true,
      entries: showIgnored === true ? publicEntries : publicEntries.filter((entry) => !entry.ignored),
    };
  }

  function languageHint(relativePath) {
    const extension = path.posix.extname(relativePath).slice(1).toLowerCase();
    return extension || 'text';
  }

  async function resolveDocumentRequest(projectId, rootId, parts) {
    const selected = await selectedRoot(projectId, rootId);
    if (selected.error) return { error: selected.error };
    const target = resolveContained(selected, parts, {
      missing: 'deleted',
      denied: 'permission-denied',
    });
    if (target.error) return target;
    return { selected, target };
  }

  function documentGitPath(selected, parts) {
    const parent = resolveContained(selected, parts.slice(0, -1), { denied: 'permission-denied' });
    if (parent.error) return parent;
    const directory = relativeGitPath(selected.real, parent.real);
    return { path: directory ? `${directory}/${parts.at(-1)}` : parts.at(-1) };
  }

  async function read(request = {}) {
    const parts = relativeParts(request.path);
    if (!parts) return { ok: false, error: 'invalid-path' };
    if (parts.includes('.git')) return { ok: false, error: 'git-metadata-denied' };
    const resolved = await resolveDocumentRequest(request.projectId, request.rootId, parts);
    if (resolved.error) return { ok: false, error: resolved.error };
    const snapshot = await readDocument(resolved.target, {
      fs: io,
      revalidate: async () => {
        const current = await resolveDocumentRequest(request.projectId, request.rootId, parts);
        return current.error ? { error: current.error } : current.target;
      },
    });
    if (!snapshot.ok) return snapshot;

    const candidateGitPath = documentGitPath(resolved.selected, parts);
    if (candidateGitPath.error) return { ok: false, error: candidateGitPath.error };
    const gitPath = candidateGitPath.path;
    const ignored = await gitIgnored(resolved.selected, [gitPath]);
    if (ignored.error) return { ok: false, error: ignored.error };
    const current = await resolveDocumentRequest(request.projectId, request.rootId, parts);
    if (current.error) return { ok: false, error: current.error };
    if (current.target.real !== resolved.target.real) return { ok: false, error: 'unreadable' };

    return {
      ok: true,
      path: request.path,
      content: snapshot.content,
      revision: snapshot.revision,
      ignored: ignored.ignored.has(gitPath),
      language: languageHint(request.path),
      format: snapshot.format,
    };
  }

  async function write(request = {}) {
    const parts = relativeParts(request.path);
    if (!parts) return { ok: false, error: 'invalid-path' };
    if (parts.includes('.git')) return { ok: false, error: 'git-metadata-denied' };
    if (typeof request.content !== 'string' || !/^[0-9a-f]{64}$/i.test(request.expectedRevision)
      || typeof request.overwrite !== 'boolean') {
      return { ok: false, error: 'invalid-request' };
    }
    const resolved = await resolveDocumentRequest(request.projectId, request.rootId, parts);
    if (resolved.error) return { ok: false, error: resolved.error };
    return writeDocument(resolved.target, request, {
      fs: io,
      beforeReplace: options.beforeReplace,
      revalidate: async () => {
        const current = await resolveDocumentRequest(request.projectId, request.rootId, parts);
        return current.error ? { error: current.error } : current.target;
      },
    });
  }

  function watcherOwner(ownerId) {
    if ((typeof ownerId !== 'string' && typeof ownerId !== 'number') || ownerId === '') return null;
    let owner = watcherOwners.get(ownerId);
    if (!owner) {
      owner = { token: 0, active: null };
      watcherOwners.set(ownerId, owner);
    }
    return owner;
  }

  function closeActive(owner) {
    const active = owner.active;
    owner.active = null;
    if (active) active.watcher.close();
  }

  async function watch(ownerId, request = {}, emit) {
    const owner = watcherOwner(ownerId);
    if (!owner || typeof emit !== 'function' || watchersClosed) {
      return { ok: false, error: 'watch-failed' };
    }
    const token = ++owner.token;
    closeActive(owner);

    const selected = await selectedRoot(request.projectId, request.rootId);
    if (owner.token !== token || watchersClosed) return { ok: false, error: 'watch-failed' };
    if (selected.error) return { ok: false, error: selected.error };

    let acceptingEvents = false;
    const candidate = await createRootWatcher(selected.root, (hint) => {
      if (!acceptingEvents || owner.token !== token || watchersClosed) return;
      emit({
        projectId: request.projectId,
        rootId: request.rootId,
        ...hint,
      });
    }, {
      fs: io,
      watchFactory: options.watchFactory,
      scheduler: options.scheduler,
      debounceMs: options.watchDebounceMs,
    });
    if (!candidate.ok) return candidate;

    const current = await selectedRoot(request.projectId, request.rootId);
    if (owner.token !== token || watchersClosed || candidate.failed || current.error
      || current.root !== selected.root || current.real !== selected.real) {
      candidate.close();
      return { ok: false, error: current.error || 'watch-failed' };
    }

    owner.active = {
      watcher: candidate,
      projectId: request.projectId,
      rootId: request.rootId,
    };
    acceptingEvents = true;
    return { ok: true };
  }

  function unwatch(ownerId) {
    const owner = watcherOwners.get(ownerId);
    if (!owner) return;
    owner.token += 1;
    closeActive(owner);
  }

  function close() {
    if (watchersClosed) return;
    watchersClosed = true;
    for (const owner of watcherOwners.values()) {
      owner.token += 1;
      closeActive(owner);
    }
  }

  return {
    admitProject,
    replaceAdmissions,
    admitSelection,
    openProject,
    describeWorktrees,
    list,
    read,
    write,
    watch,
    unwatch,
    close,
  };
}

module.exports = { createProjectFiles };
