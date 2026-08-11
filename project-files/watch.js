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

function contained(root, target) {
  const relative = path.relative(root, target);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..'
    && !path.isAbsolute(relative));
}

function hasGitComponent(root, target) {
  return path.relative(root, target).split(path.sep).includes('.git');
}

function isTemporary(parts) {
  return parts.some((part) => part.includes('.tabdesk-'));
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
  return normalizedWatchPath(root, absolute, io) === null;
}

async function createRootWatcher(root, emit, options = {}) {
  const io = options.fs || fs;
  const scheduler = options.scheduler || globalThis;
  const debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : 100;
  const watchFactory = options.watchFactory || chokidar.watch;
  let watcher;

  try {
    watcher = await Promise.resolve(watchFactory(root.real, {
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
      ignored: (absolute) => blockedWatchPath(root, absolute, io),
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

  function queue(event, absolute) {
    if (closed) return;
    const relative = normalizedWatchPath(root, absolute, io);
    if (relative === null) return;
    if (event === 'unlinkDir' && relative === '') {
      fail();
      return;
    }
    const previous = pending.get(relative);
    if (previous !== undefined) scheduler.clearTimeout(previous);
    const timer = scheduler.setTimeout(() => {
      pending.delete(relative);
      if (!closed) send({ path: relative, kind: EVENT_KINDS[event] });
    }, debounceMs);
    pending.set(relative, timer);
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
