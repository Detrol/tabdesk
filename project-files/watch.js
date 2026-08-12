const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

const EVENT_KINDS = {
  add: 'added',
  change: 'changed',
  unlink: 'removed',
  addDir: 'tree-invalidated',
  unlinkDir: 'tree-invalidated',
};
const MAX_PENDING_PATHS = 256;
const MAX_WATCH_ENTRIES = 4096;
const MAX_WATCH_DEPTH = 64;
const TEMPORARY_NAME = /^\.[\s\S]+\.tabdesk-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;

function contained(root, target) {
  const relative = path.relative(root, target);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..'
    && !path.isAbsolute(relative));
}

function hasGitComponent(root, target) {
  return path.relative(root, target).split(path.sep).includes('.git');
}

function isTemporary(parts) {
  return parts.some((part) => TEMPORARY_NAME.test(part));
}

function isLogicalRoot(root, value) {
  return root.logical !== root.real && typeof value === 'string' && path.isAbsolute(value)
    && !value.includes('\0') && path.resolve(value) === root.logical;
}

function withinWatchBudget(root, io, maxEntries, maxDepth) {
  const pending = [{ directory: root.real, depth: 0 }];
  let entries = 0;
  while (pending.length) {
    const { directory, depth } = pending.pop();
    let opened;
    try {
      const real = io.realpathSync(directory);
      if (!contained(root.real, real) || hasGitComponent(root.real, real)) return false;
      const link = io.lstatSync(directory);
      if (link.isSymbolicLink() || !link.isDirectory()) return false;
      opened = io.opendirSync(directory);
      for (;;) {
        const entry = opened.readSync();
        if (!entry) break;
        entries += 1;
        if (entries > maxEntries) return false;
        if (entry.name === '.git' || isTemporary([entry.name]) || !entry.isDirectory()) continue;
        if (depth >= maxDepth) return false;
        const child = path.join(directory, entry.name);
        const childLink = io.lstatSync(child);
        if (!childLink.isSymbolicLink()) pending.push({ directory: child, depth: depth + 1 });
      }
    } catch (_) {
      return false;
    } finally {
      try { opened?.closeSync(); } catch (_) { /* bounded preflight cleanup */ }
    }
  }
  return true;
}

function sameRootIdentity(root, io = fs) {
  try {
    const stats = io.statSync(root.logical);
    return stats.isDirectory() && io.realpathSync(root.logical) === root.real
      && stats.dev === root.dev && stats.ino === root.ino && stats.birthtimeMs === root.birthtimeMs;
  } catch (_) {
    return false;
  }
}

function normalizedWatchPath(root, value, io = fs) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) return null;
  const absolute = path.resolve(value);
  if (!contained(root.real, absolute)) return null;
  const relative = path.relative(root.real, absolute);
  const parts = relative ? relative.split(path.sep) : [];
  if (parts.includes('.git') || isTemporary(parts)) return null;

  try {
    const real = io.realpathSync(absolute);
    if (!contained(root.real, real) || hasGitComponent(root.real, real)) return null;
  } catch (error) {
    if (!error || error.code !== 'ENOENT') return null;
  }

  return parts.join('/');
}

function blockedWatchPath(root, absolute, io = fs) {
  if (isLogicalRoot(root, absolute)) return false;
  return normalizedWatchPath(root, absolute, io) === null;
}

async function createRootWatcher(root, emit, options = {}) {
  const io = options.fs || fs;
  const scheduler = options.scheduler || globalThis;
  const debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : 100;
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries : MAX_WATCH_ENTRIES;
  const maxDepth = Number.isInteger(options.maxDepth) && options.maxDepth > 0
    ? options.maxDepth : MAX_WATCH_DEPTH;
  const watchFactory = options.watchFactory || chokidar.watch;
  let watcher;
  let budgetExceeded = false;
  let onBudgetExceeded = null;

  if (!withinWatchBudget(root, io, maxEntries, maxDepth)) {
    return { ok: false, error: 'watch-failed' };
  }

  try {
    const watchPaths = root.logical === root.real ? root.real : [root.real, root.logical];
    watcher = await Promise.resolve(watchFactory(watchPaths, {
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      depth: maxDepth,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
      ignored: (() => {
        const observed = new Set();
        return (absolute) => {
          if (blockedWatchPath(root, absolute, io)) return true;
          const relative = path.relative(root.real, path.resolve(absolute));
          if (!relative || observed.has(relative)) return false;
          if (observed.size >= maxEntries) {
            budgetExceeded = true;
            if (onBudgetExceeded) onBudgetExceeded();
            return true;
          }
          observed.add(relative);
          return false;
        };
      })(),
    }));
  } catch (_) {
    return { ok: false, error: 'watch-failed' };
  }

  if (!watcher || typeof watcher.on !== 'function' || typeof watcher.close !== 'function') {
    return { ok: false, error: 'watch-failed' };
  }

  const pending = new Map();
  const listeners = [];
  let closed = false;
  let failed = false;
  let collapsed = false;

  function send(event) {
    try {
      emit(event);
    } catch (_) {
      // Renderer delivery is best effort and must not break the filesystem watcher.
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const timer of pending.values()) scheduler.clearTimeout(timer);
    pending.clear();
    for (const [event, listener] of listeners) watcher.removeListener(event, listener);
    try {
      const closing = watcher.close();
      if (closing && typeof closing.catch === 'function') closing.catch(() => {});
    } catch (_) {
      // Cleanup stays idempotent even if the dependency rejects shutdown.
    }
  }

  function fail() {
    if (closed) return;
    failed = true;
    send({ path: '', kind: 'watch-failed' });
    close();
  }

  onBudgetExceeded = fail;
  if (budgetExceeded) {
    fail();
    return { ok: false, error: 'watch-failed' };
  }

  function queue(event, absolute) {
    if (closed) return;
    if (!sameRootIdentity(root, io)) {
      fail();
      return;
    }
    if (isLogicalRoot(root, absolute)) return;
    const relative = normalizedWatchPath(root, absolute, io);
    if (relative === null) return;
    if (event === 'unlinkDir' && relative === '') {
      fail();
      return;
    }
    const scheduleHint = (key, hint) => {
      const previous = pending.get(key);
      if (previous !== undefined) scheduler.clearTimeout(previous);
      const timer = scheduler.setTimeout(() => {
        pending.delete(key);
        if (key === '') collapsed = false;
        if (closed) return;
        if (!sameRootIdentity(root, io)) {
          fail();
          return;
        }
        send(hint);
      }, debounceMs);
      pending.set(key, timer);
    };
    if (collapsed) {
      scheduleHint('', { path: '', kind: 'tree-invalidated' });
      return;
    }
    const previous = pending.get(relative);
    if (previous === undefined && pending.size >= MAX_PENDING_PATHS) {
      for (const timer of pending.values()) scheduler.clearTimeout(timer);
      pending.clear();
      collapsed = true;
      scheduleHint('', { path: '', kind: 'tree-invalidated' });
      return;
    }
    scheduleHint(relative, { path: relative, kind: EVENT_KINDS[event] });
  }

  for (const event of Object.keys(EVENT_KINDS)) {
    const listener = (absolute) => queue(event, absolute);
    listeners.push([event, listener]);
    watcher.on(event, listener);
  }
  listeners.push(['error', fail]);
  watcher.on('error', fail);

  return {
    ok: true,
    close,
    get failed() {
      return failed;
    },
  };
}

module.exports = { createRootWatcher };
