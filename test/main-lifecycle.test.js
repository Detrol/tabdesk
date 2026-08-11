const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

let lifecycle = {};
try { lifecycle = require('../main-lifecycle'); } catch (_) { /* RED: module not implemented yet */ }

test('an aborted quit still forgets a later natural terminal exit', () => {
  assert.equal(typeof lifecycle.createShutdownLifecycle, 'function');

  const shutdown = lifecycle.createShutdownLifecycle();
  const mainWindow = new EventEmitter();
  const forgotten = [];
  shutdown.observeMainWindow(mainWindow);

  // before-quit is deliberately absent: a renderer beforeunload may still
  // cancel the window close, so only the non-cancellable `closed` event may
  // commit session preservation.
  if (shutdown.shouldForgetSession()) forgotten.push('td-codex-project');

  assert.deepEqual(forgotten, ['td-codex-project']);
});

test('a closed main window preserves sessions during committed shutdown', () => {
  assert.equal(typeof lifecycle.createShutdownLifecycle, 'function');

  const shutdown = lifecycle.createShutdownLifecycle();
  const mainWindow = new EventEmitter();
  const forgotten = [];
  shutdown.observeMainWindow(mainWindow);
  mainWindow.emit('closed');

  if (shutdown.shouldForgetSession()) forgotten.push('td-codex-project');

  assert.deepEqual(forgotten, []);
});

function leaveHarness({ response = 'approve', timeoutMs = 30 } = {}) {
  const ipcMain = new EventEmitter();
  const sender = new EventEmitter();
  const otherSender = new EventEmitter();
  let destroyed = false;
  const sent = [];
  sender.isDestroyed = () => destroyed;
  sender.send = (channel, payload) => {
    sent.push({ channel, payload });
    if (response === 'approve') {
      queueMicrotask(() => ipcMain.emit('projects:root-leave-response',
        { sender }, { token: payload.token, approved: true }));
    } else if (response === 'cancel') {
      queueMicrotask(() => ipcMain.emit('projects:root-leave-response',
        { sender }, { token: payload.token, approved: false }));
    } else if (response === 'wrong-first') {
      queueMicrotask(() => {
        ipcMain.emit('projects:root-leave-response',
          { sender: otherSender }, { token: payload.token, approved: true });
        ipcMain.emit('projects:root-leave-response',
          { sender }, { token: `${payload.token}-wrong`, approved: true });
        ipcMain.emit('projects:root-leave-response',
          { sender }, { token: payload.token, approved: false });
      });
    } else if (response === 'destroy') {
      queueMicrotask(() => {
        destroyed = true;
        sender.emit('destroyed');
      });
    }
  };
  return { ipcMain, sender, sent, timeoutMs };
}

test('approved renderer leave runs root mutation only after the response', async () => {
  assert.equal(typeof lifecycle.createRendererLeaveGate, 'function');
  const harness = leaveHarness();
  const order = [];
  const originalSend = harness.sender.send;
  harness.sender.send = (...args) => {
    order.push('request');
    originalSend(...args);
  };
  const gate = lifecycle.createRendererLeaveGate({
    ipcMain: harness.ipcMain,
    timeoutMs: harness.timeoutMs,
    makeToken: () => 'leave-token',
  });

  const result = await gate.run(harness.sender, () => {
    order.push('mutate');
    return { ok: true, path: '/new-root' };
  });
  gate.close();

  assert.deepEqual(result, { ok: true, path: '/new-root' });
  assert.deepEqual(order, ['request', 'mutate']);
  assert.deepEqual(harness.sent, [{
    channel: 'projects:root-leave-request',
    payload: { token: 'leave-token' },
  }]);
});

test('renderer cancellation leaves root state untouched', async () => {
  assert.equal(typeof lifecycle.createRendererLeaveGate, 'function');
  const harness = leaveHarness({ response: 'cancel' });
  let mutations = 0;
  const gate = lifecycle.createRendererLeaveGate({
    ipcMain: harness.ipcMain,
    timeoutMs: harness.timeoutMs,
    makeToken: () => 'leave-token',
  });

  const result = await gate.run(harness.sender, () => { mutations += 1; });
  gate.close();

  assert.deepEqual(result, { ok: false, canceled: true });
  assert.equal(mutations, 0);
});

test('wrong sender and wrong token cannot approve a root mutation', async () => {
  assert.equal(typeof lifecycle.createRendererLeaveGate, 'function');
  const harness = leaveHarness({ response: 'wrong-first' });
  let mutations = 0;
  const gate = lifecycle.createRendererLeaveGate({
    ipcMain: harness.ipcMain,
    timeoutMs: harness.timeoutMs,
    makeToken: () => 'leave-token',
  });

  const result = await gate.run(harness.sender, () => { mutations += 1; });
  gate.close();

  assert.deepEqual(result, { ok: false, canceled: true });
  assert.equal(mutations, 0);
});

test('timeout or destroyed renderer leaves root state untouched', async (t) => {
  assert.equal(typeof lifecycle.createRendererLeaveGate, 'function');

  for (const response of ['timeout', 'destroy']) {
    await t.test(response, async () => {
      const harness = leaveHarness({ response, timeoutMs: 5 });
      let mutations = 0;
      const gate = lifecycle.createRendererLeaveGate({
        ipcMain: harness.ipcMain,
        timeoutMs: harness.timeoutMs,
        makeToken: () => `leave-${response}`,
      });

      const result = await gate.run(harness.sender, () => { mutations += 1; });
      gate.close();

      assert.deepEqual(result, { ok: false, canceled: true });
      assert.equal(mutations, 0);
    });
  }
});

function loadPreloadApi() {
  const ipcRenderer = new EventEmitter();
  const sent = [];
  ipcRenderer.sendSync = () => null;
  ipcRenderer.invoke = async () => null;
  ipcRenderer.send = (channel, payload) => { sent.push({ channel, payload }); };
  let api;
  const contextBridge = {
    exposeInMainWorld(name, value) {
      if (name === 'api') api = value;
    },
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  vm.runInNewContext(source, {
    require(specifier) {
      assert.equal(specifier, 'electron');
      return { contextBridge, ipcRenderer, webUtils: { getPathForFile: () => '' } };
    },
  }, { filename: 'preload.js' });
  return { api, ipcRenderer, sent };
}

test('preload exposes no renderer-controlled projects root setter', () => {
  const { api } = loadPreloadApi();
  assert.equal(api.setProjectsRoot, undefined);
});

test('preload answers root leave requests through one semantic callback', async () => {
  const { api, ipcRenderer, sent } = loadPreloadApi();
  assert.equal(typeof api.onProjectsRootLeaveRequested, 'function');
  const decisions = [];
  const unsubscribe = api.onProjectsRootLeaveRequested(() => {
    decisions.push('asked');
    return false;
  });

  ipcRenderer.emit('projects:root-leave-request', {}, { token: 'renderer-token' });
  await new Promise((resolve) => setImmediate(resolve));
  unsubscribe();

  assert.deepEqual(decisions, ['asked']);
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{
    channel: 'projects:root-leave-response',
    payload: { token: 'renderer-token', approved: false },
  }]);
  assert.equal(ipcRenderer.listenerCount('projects:root-leave-request'), 0);
});
