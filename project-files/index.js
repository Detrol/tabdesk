const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const { MAX_BYTES, readDocument, writeDocument } = require('./document');
const { createRootWatcher } = require('./watch');

const SOURCES = new Set(['configured', 'picker', 'restored']);
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_ACTIVE = 4;
const GIT_MAX_QUEUED = 16;
const GIT_MAX_INPUT_BYTES = 4 * 1024 * 1024;
const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;
const GIT_KILL_FALLBACK_MS = 250;
const DIRECTORY_MAX_ENTRIES = 4096;
const WORKTREE_MAX_CANDIDATES = 64;
const OPERATION_TIMEOUT_MS = 10_000;

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

function hasGitMetadataComponent(value) {
  const absolute = path.resolve(value);
  const parts = absolute.slice(path.parse(absolute).root.length).split(path.sep);
  // Windows paths are case-insensitive by default; POSIX component names are not.
  return parts.some((part) => (process.platform === 'win32' ? part.toLowerCase() : part) === '.git');
}

function safeDirectory(io, dir) {
  if (typeof dir !== 'string' || !dir) return null;
  const logical = path.resolve(dir);
  if (hasGitMetadataComponent(logical)) return null;
  try {
    const stats = io.statSync(logical);
    if (!stats.isDirectory()) return null;
    const real = io.realpathSync(logical);
    if (hasGitMetadataComponent(real)) return null;
    return {
      logical,
      real,
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
  const spawnGit = options.spawn || childProcess.spawn;
  const gitTimeoutMs = Number.isInteger(options.gitTimeoutMs) && options.gitTimeoutMs > 0
    ? options.gitTimeoutMs : GIT_TIMEOUT_MS;
  const gitMaxActive = Number.isInteger(options.gitMaxActive) && options.gitMaxActive > 0
    ? options.gitMaxActive : GIT_MAX_ACTIVE;
  const gitMaxQueued = Number.isInteger(options.gitMaxQueued) && options.gitMaxQueued >= 0
    ? options.gitMaxQueued : GIT_MAX_QUEUED;
  const gitMaxInputBytes = Number.isInteger(options.gitMaxInputBytes) && options.gitMaxInputBytes >= 0
    ? options.gitMaxInputBytes : GIT_MAX_INPUT_BYTES;
  const gitMaxOutputBytes = Number.isInteger(options.gitMaxOutputBytes) && options.gitMaxOutputBytes >= 0
    ? options.gitMaxOutputBytes : GIT_MAX_OUTPUT_BYTES;
  const gitKillFallbackMs = Number.isInteger(options.gitKillFallbackMs) && options.gitKillFallbackMs > 0
    ? options.gitKillFallbackMs : GIT_KILL_FALLBACK_MS;
  const operationTimeoutMs = Number.isInteger(options.operationTimeoutMs) && options.operationTimeoutMs > 0
    ? options.operationTimeoutMs : OPERATION_TIMEOUT_MS;
  const byPath = new Map();
  const byId = new Map();
  const watcherOwners = new Map();
  const gitQueue = [];
  const activeGitJobs = new Set();
  let activeGit = 0;
  let gitClosed = false;
  let watchersClosed = false;

  function createOperation() {
    return { deadline: Date.now() + operationTimeoutMs };
  }

  function operationRemaining(operation) {
    return operation ? Math.max(0, operation.deadline - Date.now()) : Infinity;
  }

  function operationExpired(operation) {
    return operationRemaining(operation) <= 0;
  }

  function operationFailure() {
    return Object.assign(new Error('Operation timed out'), { code: 'TABDESK_OPERATION_TIMEOUT' });
  }

  function operationError(error) {
    return error?.code === 'TABDESK_OPERATION_TIMEOUT' ? 'operation-timeout' : 'git-unavailable';
  }

  function withOperation(run) {
    const operation = createOperation();
    let timeout;
    const result = Promise.resolve(run(operation));
    const expired = new Promise((resolve) => {
      timeout = setTimeout(() => resolve({ ok: false, error: 'operation-timeout' }), operationTimeoutMs);
    });
    return Promise.race([result, expired]).finally(() => clearTimeout(timeout));
  }

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

  function gitFailure(reason) {
    return Object.assign(new Error(`Git execution ${reason}`), { code: 'TABDESK_GIT_UNAVAILABLE' });
  }

  function startQueuedGit(job) {
    if (gitClosed || job.closed) {
      job.reject(job.failure || gitFailure('runner closed'));
      return;
    }
    activeGit += 1;
    activeGitJobs.add(job);
    Promise.resolve()
      .then(() => {
        if (gitClosed || job.closed) throw job.failure || gitFailure('runner closed');
        return job.start((cancel) => {
          job.cancel = cancel;
          if (gitClosed || job.closed) cancel(job.failure || gitFailure('runner closed'));
        });
      })
      .then(job.resolve, job.reject)
      .finally(() => {
        activeGit -= 1;
        activeGitJobs.delete(job);
        if (gitClosed) return;
        const next = gitQueue.shift();
        if (next) startQueuedGit(next);
      });
  }

  function scheduleGit(start, operation) {
    return new Promise((resolve, reject) => {
      if (gitClosed) {
        reject(gitFailure('runner closed'));
        return;
      }
      if (operationExpired(operation)) {
        reject(operationFailure());
        return;
      }
      let deadlineTimer;
      let settled = false;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        callback(value);
      };
      const job = {
        start,
        resolve: (value) => settle(resolve, value),
        reject: (error) => settle(reject, error),
        cancel: null,
        closed: false,
        failure: null,
      };
      if (operation) {
        deadlineTimer = setTimeout(() => {
          job.closed = true;
          job.failure = operationFailure();
          const queued = gitQueue.indexOf(job);
          if (queued >= 0) gitQueue.splice(queued, 1);
          job.cancel?.(job.failure);
          job.reject(job.failure);
        }, Math.max(0, operationRemaining(operation) - 1));
      }
      if (activeGit < gitMaxActive) {
        startQueuedGit(job);
      } else if (gitQueue.length < gitMaxQueued) {
        gitQueue.push(job);
      } else {
        job.reject(gitFailure('queue saturated'));
      }
    });
  }

  function closeGitRunner() {
    if (gitClosed) return;
    gitClosed = true;
    for (const job of gitQueue.splice(0)) {
      job.closed = true;
      job.failure = gitFailure('runner closed');
      job.reject(job.failure);
    }
    for (const job of activeGitJobs) {
      job.closed = true;
      job.failure = gitFailure('runner closed');
      job.cancel?.(job.failure);
      job.reject(job.failure);
    }
  }

  function killGit(child) {
    if (!child) return;
    if (process.platform !== 'win32' && Number.isInteger(child.pid)) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    }
    try { child.kill('SIGKILL'); } catch (_) {}
  }

  function executeGit(args, { input, operation } = {}) {
    const inputBytes = input === undefined ? 0 : Buffer.byteLength(input);
    if (inputBytes > gitMaxInputBytes) return Promise.reject(gitFailure('input too large'));
    if (operationExpired(operation)) return Promise.reject(operationFailure());
    return scheduleGit((setCancel) => new Promise((resolve, reject) => {
      let child;
      let killTimer;
      let settled = false;
      let terminatingError;
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(killTimer);
        callback(value);
      };
      const terminate = (error) => {
        if (settled) {
          killGit(child);
          return;
        }
        if (!terminatingError) terminatingError = error;
        clearTimeout(timeout);
        killGit(child);
        if (!child) {
          finish(reject, terminatingError);
        } else if (!killTimer) {
          killTimer = setTimeout(() => finish(reject, terminatingError), gitKillFallbackMs);
        }
      };
      const collect = (chunks, chunk, stream) => {
        if (settled || terminatingError) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const nextSize = (stream === 'stdout' ? stdoutBytes : stderrBytes) + bytes.length;
        if (nextSize > gitMaxOutputBytes) {
          terminate(gitFailure(`${stream} too large`));
          return;
        }
        if (stream === 'stdout') stdoutBytes = nextSize;
        else stderrBytes = nextSize;
        chunks.push(bytes);
      };
      const timeout = setTimeout(() => {
        terminate(gitFailure('timed out'));
      }, gitTimeoutMs);
      setCancel((error) => {
        terminate(error || gitFailure('runner closed'));
      });

      try {
        child = spawnGit('git', args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, LC_ALL: 'C' },
          detached: process.platform !== 'win32',
        });
        const failStream = () => {
          terminate(gitFailure('stream failed'));
        };
        child.stdout?.on('data', (chunk) => collect(stdout, chunk, 'stdout'));
        child.stdout?.on('error', failStream);
        child.stderr?.on('data', (chunk) => collect(stderr, chunk, 'stderr'));
        child.stderr?.on('error', failStream);
        child.stdin?.on?.('error', failStream);
        child.on('error', () => {
          terminate(gitFailure('failed to start'));
        });
        child.on('close', (code, signal) => {
          if (terminatingError) {
            finish(reject, terminatingError);
            return;
          }
          finish(resolve, {
            error: code === 0 ? null : { code, signal },
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
          });
        });
        if (!child?.stdin || typeof child.stdin.end !== 'function') {
          terminate(gitFailure('has no stdin'));
          return;
        }
        child.stdin.end(input);
      } catch (_) {
        terminate(gitFailure('failed to start'));
      }
    }), operation);
  }

  function isNotGitRepository(result) {
    return result.error && Number(result.error.code) === 128
      && /not a git repository/i.test(result.stderr);
  }

  async function gitCommonDir(directory, operation) {
    try {
      const result = await executeGit([
        '-C', directory,
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ], { operation });
      if (result.error) {
        return isNotGitRepository(result) ? { git: false } : { error: 'git-unavailable' };
      }
      return { git: true, commonDir: io.realpathSync(result.stdout.trim()) };
    } catch (error) {
      return { error: operationError(error) };
    }
  }

  async function isGitWorktree(directory, commonDir, operation) {
    try {
      const result = await executeGit(
        ['-C', directory.logical, 'rev-parse', '--show-toplevel'], { operation },
      );
      if (result.error) {
        return isNotGitRepository(result) ? { worktree: false } : { error: 'git-unavailable' };
      }
      if (io.realpathSync(result.stdout.trim()) !== directory.real) return { worktree: false };
      const candidateCommonDir = await gitCommonDir(directory.logical, operation);
      if (candidateCommonDir.error) return candidateCommonDir;
      return { worktree: candidateCommonDir.git && candidateCommonDir.commonDir === commonDir };
    } catch (error) {
      return { error: operationError(error) };
    }
  }

  async function gitRepository(directory, operation) {
    let result;
    try {
      result = await executeGit(
        ['-C', directory, 'rev-parse', '--is-inside-work-tree'], { operation },
      );
    } catch (error) {
      return { error: operationError(error) };
    }
    if (!result.error) {
      return result.stdout.trim() === 'true' ? { git: true } : { error: 'git-unavailable' };
    }
    return isNotGitRepository(result) ? { git: false } : { error: 'git-unavailable' };
  }

  function boundedDirectoryNames(directory) {
    const names = [];
    let opened;
    try {
      opened = io.opendirSync(directory);
      for (;;) {
        const entry = opened.readSync();
        if (!entry) return { names };
        if (names.length === DIRECTORY_MAX_ENTRIES) return { error: 'directory-too-large' };
        names.push(entry.name);
      }
    } catch (_) {
      return { error: 'unreadable' };
    } finally {
      try { opened?.closeSync(); } catch (_) { /* best effort after enumeration */ }
    }
  }

  function conventionCandidates(project, operation) {
    const candidates = [];
    for (const folder of ['.worktrees', path.join('.claude', 'worktrees')]) {
      const listed = boundedDirectoryNames(path.join(project.logical, folder));
      if (listed.error === 'directory-too-large') return { error: 'worktree-limit' };
      if (listed.error) continue;
      for (const name of listed.names) {
        if (operationExpired(operation)) return { error: 'operation-timeout' };
        if (name.startsWith('.')) continue;
        const dir = safeDirectory(io, path.join(project.logical, folder, name));
        if (!dir) continue;
        if (candidates.length === WORKTREE_MAX_CANDIDATES) return { error: 'worktree-limit' };
        candidates.push({ ...dir, label: name });
      }
    }
    return { candidates };
  }

  async function verifiedWorktrees(project, candidates, operation) {
    const projectCommonDir = await gitCommonDir(project.logical, operation);
    if (projectCommonDir.error) return projectCommonDir;
    if (!projectCommonDir.git) return { worktrees: [] };
    const seen = new Set();
    const worktrees = [];
    for (const candidate of candidates) {
      if (operationExpired(operation)) return { error: 'operation-timeout' };
      if (seen.has(candidate.real)) continue;
      const verified = await isGitWorktree(candidate, projectCommonDir.commonDir, operation);
      if (verified.error) return verified;
      if (!verified.worktree) continue;
      seen.add(candidate.real);
      worktrees.push(candidate);
    }
    return { worktrees: worktrees.sort((left, right) => left.label.localeCompare(right.label)) };
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

  async function openProject(projectPath, operation) {
    if (!operation) return withOperation((active) => openProject(projectPath, active));
    const requested = safeDirectory(io, projectPath);
    const project = requested && byPath.get(requested.logical);
    if (!project) return { ok: false, error: 'project-unavailable' };

    for (let attempt = 0; attempt < 2; attempt++) {
      if (operationExpired(operation)) return { ok: false, error: 'operation-timeout' };
      if (!refreshProject(project)) return { ok: false, error: 'project-unavailable' };
      const discovered = conventionCandidates(project, operation);
      if (discovered.error) return { ok: false, error: discovered.error };
      const candidates = discovered.candidates;
      const verified = await verifiedWorktrees(project, candidates, operation);
      if (verified.error) return {
        ok: false,
        error: verified.error === 'operation-timeout' ? verified.error : 'project-unavailable',
      };
      if (operationExpired(operation)) return { ok: false, error: 'operation-timeout' };
      if (!rootsStillValid(project, candidates)) {
        if (!byPath.has(project.logical)) return { ok: false, error: 'project-unavailable' };
        continue;
      }
      const roots = refreshRoots(project, verified.worktrees);
      return { ok: true, projectId: project.id, roots: roots.map(publicRoot) };
    }

    return { ok: false, error: 'project-unavailable' };
  }

  async function describeWorktrees(projectPath, operation) {
    if (!operation) return withOperation((active) => describeWorktrees(projectPath, active));
    const opened = await openProject(projectPath, operation);
    if (!opened.ok) return [];
    const project = byId.get(opened.projectId);
    return [...project.rootsById.values()]
      .filter((root) => root.kind === 'worktree')
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((root) => ({ name: root.label, path: root.logical }));
  }

  function currentAdmission(project) {
    return project?.sources?.size > 0
      && byPath.get(project.logical) === project
      && byId.get(project.id) === project;
  }

  async function verifiedOwnerForSelection(project, selected, { admitted = false, operation } = {}) {
    if (admitted && !currentAdmission(project)) {
      return { ok: false, error: 'project-unavailable' };
    }
    if (!refreshProject(project)) return { ok: false, error: 'project-unavailable' };
    if (project.logical === selected.logical && sameDirectory(project, selected)) {
      return { ok: true, project };
    }

    const discovered = conventionCandidates(project, operation);
    if (discovered.error) return { ok: false, error: discovered.error };
    const candidate = discovered.candidates.find(({ logical }) => logical === selected.logical);
    if (!candidate || !sameDirectory(candidate, selected)) {
      return { ok: false, error: 'project-unavailable' };
    }
    const projectCommonDir = await gitCommonDir(project.logical, operation);
    if (projectCommonDir.error) {
      if (projectCommonDir.error === 'operation-timeout') {
        return { ok: false, error: projectCommonDir.error };
      }
      return { ok: false, error: 'project-unavailable', verificationFailed: true };
    }
    if (!projectCommonDir.git) {
      return { ok: false, error: 'project-unavailable' };
    }
    const verified = await isGitWorktree(selected, projectCommonDir.commonDir, operation);
    if (verified.error) {
      if (verified.error === 'operation-timeout') return { ok: false, error: verified.error };
      return { ok: false, error: 'project-unavailable', verificationFailed: true };
    }
    if (!verified.worktree) {
      return { ok: false, error: 'project-unavailable' };
    }

    const currentSelected = safeDirectory(io, selected.logical);
    if (operationExpired(operation)) return { ok: false, error: 'operation-timeout' };
    const currentCandidates = conventionCandidates(project, operation);
    if (currentCandidates.error) return { ok: false, error: currentCandidates.error };
    const currentCandidate = currentCandidates.candidates.find(({ logical }) => logical === selected.logical);
    if ((admitted && !currentAdmission(project)) || !refreshProject(project)
      || !sameDirectory(selected, currentSelected)
      || !sameDirectory(selected, currentCandidate)) {
      return { ok: false, error: 'project-unavailable', verificationFailed: true };
    }
    return { ok: true, project };
  }

  async function resolveOwner(selectedPath, operation) {
    if (!operation) return withOperation((active) => resolveOwner(selectedPath, active));
    const selected = safeDirectory(io, selectedPath);
    if (!selected) return { ok: false, error: 'project-unavailable' };

    const exact = byPath.get(selected.logical);
    if (exact) {
      const resolved = await verifiedOwnerForSelection(exact, selected, { admitted: true, operation });
      if (resolved.ok) {
        return { ok: true, projectPath: exact.logical, selectedPath: selected.logical };
      }
      if (resolved.error === 'operation-timeout' || resolved.error === 'worktree-limit') return resolved;
      if (resolved.verificationFailed) {
        return { ok: false, error: 'project-unavailable', verificationFailed: true };
      }
    }

    for (const project of [...byPath.values()]) {
      if (project === exact) continue;
      const resolved = await verifiedOwnerForSelection(project, selected, { admitted: true, operation });
      if (resolved.error === 'operation-timeout' || resolved.error === 'worktree-limit') return resolved;
      if (resolved.verificationFailed) {
        return { ok: false, error: 'project-unavailable', verificationFailed: true };
      }
      if (!resolved.ok) continue;
      return { ok: true, projectPath: project.logical, selectedPath: selected.logical };
    }
    return { ok: false, error: 'project-unavailable' };
  }

  async function verifySelectionOwner(candidateProjectPath, selectedPath, operation) {
    if (!operation) {
      return withOperation((active) => verifySelectionOwner(candidateProjectPath, selectedPath, active));
    }
    const project = safeDirectory(io, candidateProjectPath);
    const selected = safeDirectory(io, selectedPath);
    if (!project || !selected) return { ok: false, error: 'project-unavailable' };

    const resolved = await verifiedOwnerForSelection(project, selected, { operation });
    if (!resolved.ok) {
      if (resolved.error === 'operation-timeout' || resolved.error === 'worktree-limit') return resolved;
      return {
        ok: false,
        error: 'project-unavailable',
        ...(resolved.verificationFailed ? { verificationFailed: true } : {}),
      };
    }
    return { ok: true, projectPath: project.logical, selectedPath: selected.logical };
  }

  async function restoreSelection(storedProjectPath, selectedPath, operation) {
    if (!operation) {
      return withOperation((active) => restoreSelection(storedProjectPath, selectedPath, active));
    }
    const verified = await verifySelectionOwner(storedProjectPath, selectedPath, operation);
    if (!verified.ok) {
      if (verified.error === 'operation-timeout' || verified.error === 'worktree-limit') return verified;
      return { ok: false, error: 'project-unavailable' };
    }
    if (operationExpired(operation)) return { ok: false, error: 'operation-timeout' };
    const admitted = admitProject(verified.projectPath, 'restored');
    if (!admitted.ok) return admitted;
    return verified;
  }

  async function admitSelection(selectedPath, source, operation) {
    if (!operation) return withOperation((active) => admitSelection(selectedPath, source, active));
    if (!SOURCES.has(source)) return { ok: false, error: 'project-unavailable' };
    const selected = safeDirectory(io, selectedPath);
    if (!selected) return { ok: false, error: 'project-unavailable' };

    for (const project of [...byPath.values()]) {
      const resolved = await verifiedOwnerForSelection(project, selected, { admitted: true, operation });
      if (resolved.error === 'operation-timeout' || resolved.error === 'worktree-limit') return resolved;
      if (resolved.verificationFailed) return { ok: false, error: 'project-unavailable' };
      if (!resolved.ok || project.logical === selected.logical) continue;
      if (operationExpired(operation)) return { ok: false, error: 'operation-timeout' };
      const admitted = admitProject(project.logical, source);
      if (!admitted.ok) return admitted;
      return { ok: true, projectPath: project.logical, selectedPath: selected.logical };
    }

    if (operationExpired(operation)) return { ok: false, error: 'operation-timeout' };
    const admitted = admitProject(selected.logical, source);
    if (!admitted.ok) return admitted;
    return { ok: true, projectPath: selected.logical, selectedPath: selected.logical };
  }

  async function selectedRoot(projectId, rootId, operation) {
    if (operationExpired(operation)) return { error: 'operation-timeout' };
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
      const projectCommonDir = await gitCommonDir(project.logical, operation);
      const verified = !projectCommonDir.error && projectCommonDir.git
        ? await isGitWorktree(current, projectCommonDir.commonDir, operation)
        : { error: projectCommonDir.error || 'project-unavailable' };
      if (verified.error || !verified.worktree) {
        if (verified.error === 'operation-timeout') return { error: verified.error };
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
    const directoryGitPath = relativeGitPath(root.real, directoryReal);
    entry.gitPath = directoryGitPath ? `${directoryGitPath}/${name}` : name;
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

  async function gitIgnored(root, paths, operation) {
    if (!paths.length) return Promise.resolve({ ignored: new Set() });
    const repository = await gitRepository(root.real, operation);
    if (repository.error) return repository;
    if (!repository.git) return { ignored: new Set() };
    let result;
    try {
      result = await executeGit(['-C', root.real, 'check-ignore', '--stdin', '-z'], {
        input: Buffer.from(`${paths.join('\0')}\0`, 'utf8'),
        operation,
      });
    } catch (error) {
      return { error: operationError(error) };
    }
    if (result.error && Number(result.error.code) !== 1) return { error: 'git-unavailable' };
    const ignored = result.stdout.split('\0').filter(Boolean);
    return { ignored: new Set(ignored) };
  }

  async function list(request = {}, operation) {
    if (!operation) return withOperation((active) => list(request, active));
    const { projectId, rootId, directory, showIgnored } = request;
    const parts = relativeParts(directory, { root: true });
    if (!parts) return { ok: false, error: 'invalid-path' };
    if (parts.includes('.git')) return { ok: false, error: 'git-metadata-denied' };
    const selected = await selectedRoot(projectId, rootId, operation);
    if (selected.error) return { ok: false, error: selected.error };
    const snapshot = directorySnapshot(selected, parts);
    if (snapshot.error) return { ok: false, error: snapshot.error };

    const listed = boundedDirectoryNames(snapshot.target.real);
    if (listed.error) return { ok: false, error: listed.error };
    const entries = listed.names
      .map((name) => inspectEntry(selected, parts, snapshot.target.real, name))
      .filter(Boolean);
    const beforeGit = currentDirectory(selected, parts, snapshot);
    if (beforeGit.error) return { ok: false, error: beforeGit.error };
    const ignored = await gitIgnored(
      selected,
      [...new Set(entries.map((entry) => entry.gitPath).filter(Boolean))],
      operation,
    );
    if (ignored.error) return { ok: false, error: ignored.error };
    if (operationExpired(operation)) return { ok: false, error: 'operation-timeout' };
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

  async function resolveDocumentRequest(projectId, rootId, parts, operation) {
    const selected = await selectedRoot(projectId, rootId, operation);
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

  async function read(request = {}, operation) {
    if (!operation) return withOperation((active) => read(request, active));
    const parts = relativeParts(request.path);
    if (!parts) return { ok: false, error: 'invalid-path' };
    if (parts.includes('.git')) return { ok: false, error: 'git-metadata-denied' };
    const resolved = await resolveDocumentRequest(request.projectId, request.rootId, parts, operation);
    if (resolved.error) return { ok: false, error: resolved.error };
    const snapshot = await readDocument(resolved.target, {
      fs: io,
      revalidate: async () => {
        const current = await resolveDocumentRequest(request.projectId, request.rootId, parts, operation);
        return current.error ? { error: current.error } : current.target;
      },
    });
    if (!snapshot.ok) return snapshot;

    const candidateGitPath = documentGitPath(resolved.selected, parts);
    if (candidateGitPath.error) return { ok: false, error: candidateGitPath.error };
    const gitPath = candidateGitPath.path;
    const ignored = await gitIgnored(resolved.selected, [gitPath], operation);
    if (ignored.error) return { ok: false, error: ignored.error };
    const current = await resolveDocumentRequest(request.projectId, request.rootId, parts, operation);
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

  async function write(request = {}, operation) {
    if (!operation) return withOperation((active) => write(request, active));
    const parts = relativeParts(request.path);
    if (!parts) return { ok: false, error: 'invalid-path' };
    if (parts.includes('.git')) return { ok: false, error: 'git-metadata-denied' };
    if (typeof request.content !== 'string' || !/^[0-9a-f]{64}$/i.test(request.expectedRevision)
      || typeof request.overwrite !== 'boolean') {
      return { ok: false, error: 'invalid-request' };
    }
    if (request.content.length > MAX_BYTES) return { ok: false, error: 'too-large' };
    const resolved = await resolveDocumentRequest(request.projectId, request.rootId, parts, operation);
    if (resolved.error) return { ok: false, error: resolved.error };
    return writeDocument(resolved.target, request, {
      fs: io,
      root: {
        real: resolved.selected.real,
        dev: resolved.selected.root.dev,
        ino: resolved.selected.root.ino,
        birthtimeMs: resolved.selected.root.birthtimeMs,
      },
      beforeReplace: options.beforeReplace,
      revalidate: async () => {
        const current = await resolveDocumentRequest(request.projectId, request.rootId, parts, operation);
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
    closeGitRunner();
    for (const owner of watcherOwners.values()) {
      owner.token += 1;
      closeActive(owner);
    }
  }

  return {
    admitProject,
    replaceAdmissions,
    admitSelection,
    resolveOwner,
    verifySelectionOwner,
    restoreSelection,
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
