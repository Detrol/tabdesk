'use strict';

const crypto = require('crypto');

const ROOT_LEAVE_REQUEST = 'projects:root-leave-request';
const ROOT_LEAVE_RESPONSE = 'projects:root-leave-response';
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

  function clearTimer(request) {
    clearTimeout(request.timer);
    request.timer = null;
  }

  function sendAbort(request) {
    if (request.sender.isDestroyed()) return;
    try { request.sender.send(ROOT_TRANSITION_ABORT, { token: request.token }); } catch (_) { /* gone */ }
  }

  function complete(request, result, { abort = true } = {}) {
    if (active !== request) return;
    active = null;
    clearTimer(request);
    request.sender.removeListener('destroyed', request.onDestroyed);
    request.sender.removeListener('devtools-reload-page', request.onExternalReload);
    request.sender.removeListener('did-start-navigation', request.onNavigation);
    request.sender.removeListener('will-frame-navigate', request.onFrameNavigate);
    request.sender.removeListener('will-prevent-unload', request.onPreventUnload);
    if (request.ownerWindow) request.ownerWindow.removeListener('close', request.onClose);
    if (request.unloadAllowed) {
      request.navigationAccepted = true;
      result = request.commitResult;
      abort = false;
    }
    if (request.navigationAccepted && !request.finalized) {
      request.finalized = true;
      try { request.finalize(); } catch (_) { /* unload is already committed */ }
    }
    if (request.committed && !request.navigationAccepted) {
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
    if (request.queuedClose && request.ownerWindow) {
      queueMicrotask(() => {
        try {
          if (!request.ownerWindow.isDestroyed()) request.ownerWindow.close();
        } catch (_) { /* owner disappeared with the committed unload */ }
      });
    }
  }

  function startTimer(request, timeoutMs, error) {
    clearTimer(request);
    request.timer = setTimeout(() => complete(request, { ok: false, error }), timeoutMs);
  }

  function onResponse(event, response = {}) {
    const request = active;
    if (!request || request.phase !== 'decision' || !response
      || response.token !== request.token || event.sender !== request.sender) return;
    clearTimer(request);
    if (response.approved !== true) {
      complete(request, { ok: false, canceled: true, error: 'canceled' });
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
      complete(request, {
        ok: false,
        error: error && error.code ? error.code : 'persist-failed',
      });
      return;
    }
    if (result && result.ok === false) {
      complete(request, result);
      return;
    }
    request.committed = true;
    request.commitResult = result && typeof result === 'object' ? result : { ok: true };
    if (request.interrupted) {
      complete(request, { ok: false, error: 'navigation-changed' });
      return;
    }
    try {
      request.expectedUrl = request.sender.getURL();
    } catch (_) {
      complete(request, { ok: false, error: 'renderer-unavailable' });
      return;
    }
    request.phase = 'reload';
    startTimer(request, navigationTimeoutMs, 'reload-start-timeout');
    // Electron delivers the unload/navigation events asynchronously. There is
    // deliberately no await or callback gap between arming this state and the
    // only main-process reload call allowed to own it.
    request.reloadIssued = true;
    try {
      request.sender.reload();
    } catch (_) {
      complete(request, { ok: false, error: 'reload-failed' });
    }
  }

  ipcMain.on(ROOT_LEAVE_RESPONSE, onResponse);

  function run(sender, {
    ownerWindow = null,
    commit,
    rollback = () => ({ ok: true }),
    finalize = () => {},
  } = {}) {
    if (active) return Promise.resolve({ ok: false, error: 'root-change-in-progress' });
    if (!sender || sender.isDestroyed() || typeof sender.getURL !== 'function'
      || typeof sender.reload !== 'function' || typeof commit !== 'function') {
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
        resolve,
        phase: 'decision',
        committed: false,
        commitResult: null,
        expectedUrl: null,
        interrupted: false,
        reloadIssued: false,
        unloadAllowed: false,
        navigationAccepted: false,
        finalized: false,
        queuedClose: false,
        timer: null,
        onDestroyed: null,
        onClose: null,
        onExternalReload: null,
        onFrameNavigate: null,
        onNavigation: null,
        onPreventUnload: null,
      };
      request.onDestroyed = () => complete(request, { ok: false, error: 'renderer-unavailable' });
      request.onClose = (event) => {
        event.preventDefault();
        if (request.unloadAllowed) {
          request.queuedClose = true;
          return;
        }
        if (request.phase === 'committing') {
          request.interrupted = true;
          return;
        }
        complete(request, { ok: false, error: 'navigation-changed' });
      };
      request.onExternalReload = () => {
        if (request.unloadAllowed) return;
        if (request.phase === 'committing') {
          request.interrupted = true;
          return;
        }
        complete(request, { ok: false, error: 'navigation-changed' });
      };
      request.onNavigation = (details = {}) => {
        if (!details.isMainFrame || details.isSameDocument) return;
        if (request.phase === 'committing') {
          request.interrupted = true;
          return;
        }
        const matchesIssuedReload = request.phase === 'reload' && request.reloadIssued
          && details.url === request.expectedUrl;
        if (matchesIssuedReload) {
          clearTimer(request);
          request.navigationAccepted = true;
          complete(request, request.commitResult, { abort: false });
          return;
        }
        if (request.unloadAllowed) {
          // Electron cannot identify which same-tick navigation consumed an
          // already-granted unload. The durable commit is now irreversible.
          complete(request, request.commitResult, { abort: false });
          return;
        }
        complete(request, { ok: false, error: 'navigation-changed' });
      };
      request.onFrameNavigate = (details = {}) => {
        if (!details.isMainFrame) return;
        details.preventDefault();
        if (request.unloadAllowed) return;
        if (request.phase === 'committing') {
          request.interrupted = true;
          return;
        }
        complete(request, { ok: false, error: 'navigation-changed' });
      };
      request.onPreventUnload = (event) => {
        if (request.phase === 'committing') {
          request.interrupted = true;
          return;
        }
        if (request.phase === 'reload' && request.reloadIssued && !request.unloadAllowed) {
          request.unloadAllowed = true;
          request.sender.removeListener('will-prevent-unload', request.onPreventUnload);
          event.preventDefault();
          return;
        }
        complete(request, { ok: false, error: 'navigation-changed' });
      };
      active = request;
      sender.once('destroyed', request.onDestroyed);
      sender.on('devtools-reload-page', request.onExternalReload);
      sender.on('did-start-navigation', request.onNavigation);
      sender.on('will-frame-navigate', request.onFrameNavigate);
      sender.on('will-prevent-unload', request.onPreventUnload);
      if (ownerWindow) ownerWindow.on('close', request.onClose);
      startTimer(request, decisionTimeoutMs, 'leave-timeout');
      try {
        sender.send(ROOT_LEAVE_REQUEST, { token });
      } catch (_) {
        complete(request, { ok: false, error: 'renderer-unavailable' });
      }
    });
  }

  return {
    run,
    close() {
      if (active) complete(active, { ok: false, error: 'gate-closed' });
      ipcMain.removeListener(ROOT_LEAVE_RESPONSE, onResponse);
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
  createRootTransitionFinalizer,
  createShutdownLifecycle,
  rollbackRootTransition,
};
