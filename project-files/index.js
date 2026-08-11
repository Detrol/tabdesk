const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

const SOURCES = new Set(['configured', 'picker', 'restored']);

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

  return {
    admitProject,
    replaceAdmissions,
    admitSelection,
    openProject,
    describeWorktrees,
  };
}

module.exports = { createProjectFiles };
