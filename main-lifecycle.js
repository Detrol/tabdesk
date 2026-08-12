'use strict';

const crypto = require('crypto');

const ROOT_LEAVE_REQUEST = 'projects:root-leave-request';
const ROOT_LEAVE_RESPONSE = 'projects:root-leave-response';
const ROOT_LEAVE_READY = 'projects:root-leave-ready';
const ROOT_TRANSITION_ABORT = 'projects:root-transition-abort';

function createShutdownLifecycle() {
  let preserveSessions = false;

  return {
    observeMainWindow(window) {
      preserveSessions = false;
      window.once('closed', () => { preserveSessions = true; });
    },
    shouldForgetSession() {
      return !preserveSessions;
    },
  };
}

function createRendererLeaveGate({
  ipcMain,
  decisionTimeoutMs = 5 * 60 * 1000,
  navigationTimeoutMs = 10000,
  makeToken = () => crypto.randomUUID(),
} = {}) {
  let active = null;
  const readySenders = new WeakSet();
  const readinessListeners = new Map();

  function untrackReadySender(sender) {
    readySenders.delete(sender);
    const listeners = readinessListeners.get(sender);
    if (!listeners) return;
    sender.removeListener('did-start-navigation', listeners.onNavigation);
    sender.removeListener('render-process-gone', listeners.onRenderProcessGone);
    sender.removeListener('destroyed', listeners.onDestroyed);
    readinessListeners.delete(sender);
  }

  function onReady(event) {
    const sender = event?.sender;
    if (!sender || typeof sender.on !== 'function' || sender.isDestroyed()) return;
    if (!readinessListeners.has(sender)) {
      const listeners = {
        onNavigation(details = {}) {
          if (details.isMainFrame && !details.isSameDocument) readySenders.delete(sender);
        },
        onRenderProcessGone() { readySenders.delete(sender); },
        onDestroyed() { untrackReadySender(sender); },
      };
      readinessListeners.set(sender, listeners);
      sender.on('did-start-navigation', listeners.onNavigation);
      sender.on('render-process-gone', listeners.onRenderProcessGone);
      sender.once('destroyed', listeners.onDestroyed);
    }
    readySenders.add(sender);
  }

  function clearTimer(request) {
    clearTimeout(request.timer);
    request.timer = null;
  }

  function sendAbort(request) {
    if (request.sender.isDestroyed()) return;
    try { request.sender.send(ROOT_TRANSITION_ABORT, { token: request.token }); } catch (_) { /* gone */ }
  }

  function detach(request) {
    request.sender.removeListener('destroyed', request.onDestroyed);
    request.sender.removeListener('render-process-gone', request.onRenderProcessGone);
    request.sender.removeListener('devtools-reload-page', request.onExternalReload);
    request.sender.removeListener('did-start-navigation', request.onNavigation);
    request.sender.removeListener('will-frame-navigate', request.onFrameNavigate);
    request.sender.removeListener('will-prevent-unload', request.onPreventUnload);
    if (request.ownerWindow) {
      request.ownerWindow.removeListener('close', request.onClose);
      request.ownerWindow.removeListener('closed', request.onOwnerClosed);
    }
  }

  function settleCommitted(request) {
    if (active !== request) return;
    active = null;
    clearTimer(request);
    detach(request);
    try { request.finalize(); } catch (_) { /* renderer replacement is already committed */ }
    request.resolve(request.commitResult);
  }

  function fail(request, result, { abort = true } = {}) {
    if (active !== request) return;
    if (request.unloadAllowed) {
      beginRendererRecovery(request);
      return;
    }
    active = null;
    clearTimer(request);
    detach(request);
    if (request.committed) {
      request.committed = false;
      try {
        const rollback = request.rollback();
        if (rollback && rollback.ok === false) result = rollback;
      } catch (error) {
        result = { ok: false, error: error && error.code ? error.code : 'rollback-failed' };
      }
    }
    if (abort) sendAbort(request);
    request.resolve(result);
  }

  function startTimer(request, timeoutMs, onTimeout) {
    clearTimer(request);
    request.timer = setTimeout(() => {
      request.timer = null;
      if (active === request) onTimeout();
    }, timeoutMs);
  }

  function beginForcedClose(request) {
    if (active !== request || request.phase === 'closing') return;
    request.phase = 'closing';
    clearTimer(request);
    setImmediate(() => {
      if (active !== request) return;
      const owner = request.ownerWindow;
      if (owner) {
        try {
          if (owner.isDestroyed()) {
            settleCommitted(request);
            return;
          }
          owner.destroy();
          if (active === request && owner.isDestroyed()) settleCommitted(request);
          return;
        } catch (_) { /* fall through to force-close the web contents */ }
      }
      try {
        if (request.sender.isDestroyed()) {
          settleCommitted(request);
          return;
        }
        request.sender.close({ waitForBeforeUnload: false });
        if (active === request && request.sender.isDestroyed()) settleCommitted(request);
      } catch (_) { /* destroyed event remains the terminal signal */ }
    });
  }

  function beginRendererRecovery(request, { rendererGone = false } = {}) {
    if (active !== request || request.phase === 'recovering' || request.phase === 'closing') return;
    request.phase = 'recovering';
    startTimer(request, navigationTimeoutMs, () => beginForcedClose(request));
    try {
      if (!rendererGone) request.sender.forcefullyCrashRenderer();
      if (active !== request) return;
      request.sender.reload();
    } catch (_) {
      beginForcedClose(request);
    }
  }

  function awaitsOwnerClose(request) {
    if (request.phase !== 'closing' || !request.ownerWindow) return false;
    try { return !request.ownerWindow.isDestroyed(); } catch (_) { return false; }
  }

  function onResponse(event, response = {}) {
    const request = active;
    if (!request || request.phase !== 'decision' || !response
      || response.token !== request.token || event.sender !== request.sender) return;
    clearTimer(request);
    if (response.approved !== true) {
      fail(request, { ok: false, canceled: true, error: 'canceled' });
      return;
    }
    if (request.decisionOnly) {
      active = null;
      clearTimer(request);
      detach(request);
      request.resolve({ ok: true });
      return;
    }
    request.phase = 'committing';
    let result;
    try {
      result = request.commit();
      if (result && typeof result.then === 'function') {
        throw new Error('root transition commit must be synchronous');
      }
    } catch (error) {
      fail(request, {
        ok: false,
        error: error && error.code ? error.code : 'persist-failed',
      });
      return;
    }
    if (result && result.ok === false) {
      fail(request, result);
      return;
    }
    request.committed = true;
    request.commitResult = result && typeof result === 'object' ? result : { ok: true };
    if (request.interrupted) {
      fail(request, { ok: false, error: 'navigation-changed' });
      return;
    }
    try {
      request.expectedUrl = request.sender.getURL();
    } catch (_) {
      fail(request, { ok: false, error: 'renderer-unavailable' });
      return;
    }
    request.phase = 'reload';
    startTimer(request, navigationTimeoutMs, () => {
      if (request.unloadAllowed) beginRendererRecovery(request);
      else fail(request, { ok: false, error: 'reload-start-timeout' });
    });
    // Electron delivers the unload/navigation events asynchronously. There is
    // deliberately no await or callback gap between arming the reload phase and
    // the only main-process reload call allowed to own it.
    try {
      request.sender.reload();
    } catch (_) {
      fail(request, { ok: false, error: 'reload-failed' });
    }
  }

  ipcMain.on(ROOT_LEAVE_RESPONSE, onResponse);
  ipcMain.on(ROOT_LEAVE_READY, onReady);

  function run(sender, {
    ownerWindow = null,
    commit,
    rollback = () => ({ ok: true }),
    finalize = () => {},
    decisionOnly = false,
  } = {}) {
    if (active) return Promise.resolve({ ok: false, error: 'root-change-in-progress' });
    if (!sender || sender.isDestroyed() || typeof sender.getURL !== 'function'
      || typeof sender.reload !== 'function' || (!decisionOnly && typeof commit !== 'function')) {
      return Promise.resolve({ ok: false, error: 'renderer-unavailable' });
    }
    const token = makeToken();
    return new Promise((resolve) => {
      const request = {
        token,
        sender,
        ownerWindow,
        commit,
        rollback,
        finalize,
        decisionOnly,
        resolve,
        phase: 'decision',
        committed: false,
        commitResult: null,
        expectedUrl: null,
        interrupted: false,
        unloadAllowed: false,
        timer: null,
        onDestroyed: null,
        onRenderProcessGone: null,
        onOwnerClosed: null,
        onClose: null,
        onExternalReload: null,
        onFrameNavigate: null,
        onNavigation: null,
        onPreventUnload: null,
      };
      request.onDestroyed = () => {
        if (awaitsOwnerClose(request)) return;
        if (request.unloadAllowed) settleCommitted(request);
        else fail(request, { ok: false, error: 'renderer-unavailable' });
      };
      request.onRenderProcessGone = () => {
        if (!request.unloadAllowed) {
          fail(request, { ok: false, error: 'renderer-unavailable' });
          return;
        }
        if (request.phase === 'recovering' || request.phase === 'closing') return;
        beginRendererRecovery(request, { rendererGone: true });
      };
      request.onOwnerClosed = () => {
        if (request.unloadAllowed) settleCommitted(request);
        else fail(request, { ok: false, error: 'navigation-changed' });
      };
      request.onClose = (event) => {
        event.preventDefault();
        if (request.unloadAllowed) {
          beginForcedClose(request);
          return;
        }
        if (request.phase === 'committing') {
          request.interrupted = true;
          return;
        }
        fail(request, { ok: false, error: 'navigation-changed' });
      };
      request.onExternalReload = () => {
        if (request.unloadAllowed) return;
        if (request.phase === 'committing') {
          request.interrupted = true;
          return;
        }
        fail(request, { ok: false, error: 'navigation-changed' });
      };
      request.onNavigation = (details = {}) => {
        if (!details.isMainFrame || details.isSameDocument) return;
        if (request.phase === 'committing') {
          request.interrupted = true;
          return;
        }
        const matchesIssuedReload = (request.phase === 'reload' || request.phase === 'recovering')
          && details.url === request.expectedUrl;
        if (matchesIssuedReload) {
          settleCommitted(request);
          return;
        }
        if (request.unloadAllowed) {
          beginRendererRecovery(request);
          return;
        }
        fail(request, { ok: false, error: 'navigation-changed' });
      };
      request.onFrameNavigate = (details = {}) => {
        if (!details.isMainFrame) return;
        details.preventDefault();
        if (request.unloadAllowed) return;
        if (request.phase === 'committing') {
          request.interrupted = true;
          return;
        }
        fail(request, { ok: false, error: 'navigation-changed' });
      };
      request.onPreventUnload = (event) => {
        if (request.phase === 'committing') {
          request.interrupted = true;
          return;
        }
        if (request.phase === 'reload' && !request.unloadAllowed) {
          request.unloadAllowed = true;
          request.sender.removeListener('will-prevent-unload', request.onPreventUnload);
          startTimer(request, navigationTimeoutMs, () => beginRendererRecovery(request));
          event.preventDefault();
          return;
        }
        fail(request, { ok: false, error: 'navigation-changed' });
      };
      active = request;
      sender.once('destroyed', request.onDestroyed);
      sender.on('render-process-gone', request.onRenderProcessGone);
      sender.on('devtools-reload-page', request.onExternalReload);
      sender.on('did-start-navigation', request.onNavigation);
      sender.on('will-frame-navigate', request.onFrameNavigate);
      sender.on('will-prevent-unload', request.onPreventUnload);
      if (ownerWindow) ownerWindow.on('close', request.onClose);
      if (ownerWindow) ownerWindow.once('closed', request.onOwnerClosed);
      startTimer(request, decisionTimeoutMs,
        () => fail(request, { ok: false, error: 'leave-timeout' }));
      try {
        sender.send(ROOT_LEAVE_REQUEST, { token });
      } catch (_) {
        fail(request, { ok: false, error: 'renderer-unavailable' });
      }
    });
  }

  return {
    run,
    isReady(sender) {
      return Boolean(sender && !sender.isDestroyed() && readySenders.has(sender));
    },
    decide(sender) {
      if (!sender || sender.isDestroyed() || !readySenders.has(sender)) {
        return Promise.resolve({ ok: false, error: 'renderer-unavailable' });
      }
      return run(sender, { decisionOnly: true });
    },
    close() {
      if (active) {
        if (active.unloadAllowed) beginForcedClose(active);
        else fail(active, { ok: false, error: 'gate-closed' });
      }
      ipcMain.removeListener(ROOT_LEAVE_RESPONSE, onResponse);
      ipcMain.removeListener(ROOT_LEAVE_READY, onReady);
      for (const trackedSender of readinessListeners.keys()) untrackReadySender(trackedSender);
    },
  };
}

function createWindowLeaveGuard({ leaveGate } = {}) {
  if (!leaveGate || typeof leaveGate.decide !== 'function'
    || typeof leaveGate.isReady !== 'function') {
    throw new TypeError('leaveGate is required');
  }
  let owner = null;
  let sender = null;
  let allowing = false;
  let pending = null;

  async function requestClose(action) {
    if (pending) return { ok: false, error: 'root-change-in-progress' };
    pending = Promise.resolve(leaveGate.decide(sender));
    let result;
    try {
      result = await pending;
    } finally {
      pending = null;
    }
    if (!result?.ok) return result || { ok: false, error: 'renderer-unavailable' };
    allowing = true;
    try {
      action();
    } catch (_) {
      allowing = false;
      return { ok: false, error: 'renderer-unavailable' };
    }
    return { ok: true };
  }

  function onClose(event) {
    if (allowing || !leaveGate.isReady(sender)) return;
    event.preventDefault();
    requestClose(() => owner.close()).catch(() => {});
  }

  function onPreventUnload(event) {
    if (allowing) {
      allowing = false;
      event.preventDefault();
      return;
    }
    if (!leaveGate.isReady(sender)) return;
    requestClose(() => sender.reload()).catch(() => {});
  }

  return {
    observe(window) {
      if (owner) throw new Error('window leave guard already observed');
      owner = window;
      sender = window.webContents;
      owner.on('close', onClose);
      sender.on('will-prevent-unload', onPreventUnload);
    },
    requestClose(action) {
      if (!owner || !sender || owner.isDestroyed() || sender.isDestroyed()) {
        return Promise.resolve({ ok: false, error: 'renderer-unavailable' });
      }
      return requestClose(action);
    },
    close() {
      if (owner) owner.removeListener('close', onClose);
      if (sender) sender.removeListener('will-prevent-unload', onPreventUnload);
      owner = null;
      sender = null;
      allowing = false;
    },
  };
}

function commitRootTransition(transaction) {
  let committedPath;
  try {
    committedPath = transaction.commit();
  } catch (error) {
    return { ok: false, error: error && error.code ? error.code : 'persist-failed' };
  }

  return { ok: true, path: committedPath };
}

function rollbackRootTransition(transaction) {
  try {
    transaction.rollback();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error && error.code ? error.code : 'rollback-failed' };
  }
}

function createRootTransitionFinalizer({
  replaceAdmissions,
  getWindows,
  mainWindow,
}) {
  let finalized = false;
  return function finalize() {
    if (finalized) return;
    finalized = true;
    try { replaceAdmissions(); } catch (_) { /* navigation already committed */ }
    let windows = [];
    try { windows = getWindows(); } catch (_) { /* navigation already committed */ }
    for (const window of windows) {
      if (window === mainWindow) continue;
      try {
        if (!window.isDestroyed()) window.close();
      } catch (_) { /* isolate stale/failed child windows */ }
    }
  };
}

module.exports = {
  commitRootTransition,
  createRendererLeaveGate,
  createWindowLeaveGuard,
  createRootTransitionFinalizer,
  createShutdownLifecycle,
  rollbackRootTransition,
};
