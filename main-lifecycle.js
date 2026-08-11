'use strict';

const crypto = require('crypto');

const ROOT_LEAVE_REQUEST = 'projects:root-leave-request';
const ROOT_LEAVE_RESPONSE = 'projects:root-leave-response';

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
  timeoutMs = 15000,
  makeToken = () => crypto.randomUUID(),
} = {}) {
  const pending = new Map();

  function settle(token, approved) {
    const request = pending.get(token);
    if (!request) return;
    pending.delete(token);
    clearTimeout(request.timer);
    request.sender.removeListener('destroyed', request.onDestroyed);
    request.resolve(approved === true);
  }

  function onResponse(event, response = {}) {
    const request = pending.get(response.token);
    if (!request || event.sender !== request.sender) return;
    settle(response.token, response.approved);
  }

  ipcMain.on(ROOT_LEAVE_RESPONSE, onResponse);

  function request(sender) {
    if (!sender || sender.isDestroyed()) return Promise.resolve(false);
    const token = makeToken();
    return new Promise((resolve) => {
      const onDestroyed = () => settle(token, false);
      const timer = setTimeout(() => settle(token, false), timeoutMs);
      pending.set(token, { sender, resolve, timer, onDestroyed });
      sender.once('destroyed', onDestroyed);
      try {
        sender.send(ROOT_LEAVE_REQUEST, { token });
      } catch (_) {
        settle(token, false);
      }
    });
  }

  return {
    async run(sender, action) {
      if (!(await request(sender)) || sender.isDestroyed()) {
        return { ok: false, canceled: true };
      }
      return action();
    },
    close() {
      for (const token of [...pending.keys()]) settle(token, false);
      ipcMain.removeListener(ROOT_LEAVE_RESPONSE, onResponse);
    },
  };
}

module.exports = { createRendererLeaveGate, createShutdownLifecycle };
