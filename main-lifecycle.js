'use strict';

const crypto = require('crypto');

const ROOT_LEAVE_REQUEST = 'projects:root-leave-request';
const ROOT_LEAVE_RESPONSE = 'projects:root-leave-response';
const ROOT_UNLOAD_PERMIT = 'projects:root-unload-permit';
const ROOT_UNLOAD_ACK = 'projects:root-unload-ack';
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
  commitTimeoutMs = 10000,
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
    request.sender.removeListener('did-start-navigation', request.onNavigation);
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
    request.phase = 'permit';
    startTimer(request, commitTimeoutMs, 'commit-timeout');
    try {
      request.sender.send(ROOT_UNLOAD_PERMIT, { token: request.token });
    } catch (_) {
      complete(request, { ok: false, error: 'renderer-unavailable' });
    }
  }

  function onUnloadAck(event, response = {}) {
    const request = active;
    if (!request || request.phase !== 'permit' || !response
      || response.token !== request.token || event.sender !== request.sender) return;
    clearTimer(request);
    if (response.armed !== true) {
      complete(request, { ok: false, error: 'commit-rejected' });
      return;
    }
    request.phase = 'navigation';
    startTimer(request, navigationTimeoutMs, 'reload-start-timeout');
    try {
      request.reload();
    } catch (_) {
      complete(request, { ok: false, error: 'reload-failed' });
    }
  }

  ipcMain.on(ROOT_LEAVE_RESPONSE, onResponse);
  ipcMain.on(ROOT_UNLOAD_ACK, onUnloadAck);

  function run(sender, {
    reload,
    commit,
    rollback = () => ({ ok: true }),
    finalize = () => {},
  } = {}) {
    if (active) return Promise.resolve({ ok: false, error: 'root-change-in-progress' });
    if (!sender || sender.isDestroyed() || typeof reload !== 'function' || typeof commit !== 'function') {
      return Promise.resolve({ ok: false, error: 'renderer-unavailable' });
    }
    const token = makeToken();
    return new Promise((resolve) => {
      const request = {
        token,
        sender,
        reload,
        commit,
        rollback,
        finalize,
        resolve,
        phase: 'decision',
        committed: false,
        commitResult: null,
        navigationAccepted: false,
        timer: null,
        onDestroyed: null,
        onNavigation: null,
      };
      request.onDestroyed = () => complete(request, { ok: false, error: 'renderer-unavailable' });
      request.onNavigation = (details = {}) => {
        if (!details.isMainFrame || details.isSameDocument) return;
        if (request.phase !== 'navigation') {
          complete(request, { ok: false, error: 'navigation-changed' });
          return;
        }
        clearTimer(request);
        request.navigationAccepted = true;
        try { request.finalize(); } catch (_) { /* navigation is already committed */ }
        complete(request, request.commitResult, { abort: false });
      };
      active = request;
      sender.once('destroyed', request.onDestroyed);
      sender.on('did-start-navigation', request.onNavigation);
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
      ipcMain.removeListener(ROOT_UNLOAD_ACK, onUnloadAck);
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
