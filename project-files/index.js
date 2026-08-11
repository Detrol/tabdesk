const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

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

function safeDirectory(io, dir) {
  if (typeof dir !== 'string' || !dir) return null;
  const logical = path.resolve(dir);
  try {
    if (!io.statSync(logical).isDirectory()) return null;
    return { logical, real: io.realpathSync(logical) };
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

  function revoke(project) {
    byPath.delete(project.logical);
    byId.delete(project.id);
  }

  function admitProject(projectPath, source) {
    if (!SOURCES.has(source)) return { ok: false, error: 'project-unavailable' };
    const dir = safeDirectory(io, projectPath);
    if (!dir) return { ok: false, error: 'project-unavailable' };

    let project = byPath.get(dir.logical);
    if (!project || project.real !== dir.real) {
      if (project) byId.delete(project.id);
      project = {
        id: crypto.randomUUID(),
        logical: dir.logical,
        real: dir.real,
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
    if (!current || current.real !== project.real) {
      revoke(project);
      return null;
    }
    return current;
  }

  function rootsStillValid(project, worktrees) {
    if (!refreshProject(project)) return false;
    for (const worktree of worktrees) {
      const current = safeDirectory(io, worktree.logical);
      if (!current || current.real !== worktree.real) return false;
    }
    return Boolean(refreshProject(project));
  }

  function refreshRoots(project, worktrees) {
    const rootDirectories = [
      { logical: project.logical, real: project.real, kind: 'project', label: path.basename(project.logical) },
      ...worktrees.map((worktree) => ({ ...worktree, kind: 'worktree' })),
    ];
    const nextByKey = new Map();
    const nextById = new Map();

    for (const directory of rootDirectories) {
      const key = `${directory.logical}\0${directory.real}`;
      const root = project.rootsByKey.get(key) || { id: crypto.randomUUID(), ...directory };
      nextByKey.set(key, root);
      nextById.set(root.id, root);
    }
    project.rootsByKey = nextByKey;
    project.rootsById = nextById;
    return rootDirectories.map((directory) => project.rootsByKey.get(`${directory.logical}\0${directory.real}`));
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
    if (!current || current.real !== root.real) return { error: 'project-unavailable' };

    if (root.kind === 'worktree') {
      const projectCommonDir = await gitCommonDir(project.logical);
      if (!projectCommonDir || !await isGitWorktree(current, projectCommonDir)) {
        return { error: 'project-unavailable' };
      }
      const refreshed = byId.get(projectId);
      const refreshedRoot = refreshed && refreshed.rootsById.get(rootId);
      const refreshedCurrent = refreshedRoot && safeDirectory(io, refreshedRoot.logical);
      if (refreshed !== project || refreshedRoot !== root || !refreshProject(project)
        || !refreshedCurrent || refreshedCurrent.real !== root.real) {
        return { error: 'project-unavailable' };
      }
    }

    return { project, root, real: current.real };
  }

  function resolveContained(root, parts) {
    const logical = path.join(root.real, ...parts);
    let real;
    try {
      real = io.realpathSync(logical);
    } catch (_) {
      return { error: 'unreadable' };
    }
    if (!contained(root.real, real)) return { error: 'outside-root' };
    if (hasGitComponent(root.real, real)) return { error: 'git-metadata-denied' };
    return { logical, real };
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
    return entry;
  }

  function gitIgnored(root, paths) {
    if (!paths.length) return Promise.resolve(new Set());
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn('git', ['-C', root.real, 'check-ignore', '--stdin', '-z'], {
          stdio: ['pipe', 'pipe', 'ignore'],
        });
      } catch (_) {
        resolve(new Set());
        return;
      }
      const output = [];
      child.stdout.on('data', (chunk) => output.push(chunk));
      child.on('error', () => resolve(new Set()));
      child.on('close', (code) => {
        if (code !== 0 && code !== 1) return resolve(new Set());
        const ignored = Buffer.concat(output).toString('utf8').split('\0').filter(Boolean);
        return resolve(new Set(ignored));
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
    const target = resolveContained(selected, parts);
    if (target.error) return { ok: false, error: target.error };
    let directoryStats;
    try {
      directoryStats = io.statSync(target.real);
    } catch (_) {
      return { ok: false, error: 'unreadable' };
    }
    if (!directoryStats.isDirectory()) return { ok: false, error: 'not-directory' };

    let names;
    try {
      names = io.readdirSync(target.real);
    } catch (_) {
      return { ok: false, error: 'unreadable' };
    }
    const entries = names
      .map((name) => inspectEntry(selected, parts, target.real, name))
      .filter(Boolean);
    const ignored = await gitIgnored(selected, entries.map((entry) => entry.path));
    for (const entry of entries) entry.ignored = ignored.has(entry.path);
    entries.sort((left, right) => (left.kind === 'directory') === (right.kind === 'directory')
      ? left.name.localeCompare(right.name)
      : left.kind === 'directory' ? -1 : 1);
    return {
      ok: true,
      entries: showIgnored === true ? entries : entries.filter((entry) => !entry.ignored),
    };
  }

  return {
    admitProject,
    replaceAdmissions,
    admitSelection,
    openProject,
    describeWorktrees,
    list,
  };
}

module.exports = { createProjectFiles };
