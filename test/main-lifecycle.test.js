const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

let lifecycle = {};
try { lifecycle = require('../main-lifecycle'); } catch (_) { /* RED: module not implemented yet */ }
let rootChange = {};
try { rootChange = require('../renderer/root-change'); } catch (_) { /* RED: feedback seam not implemented yet */ }

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

function leaveHarness({ decision = 'approve', ack = true, navigation = 'start' } = {}) {
  const ipcMain = new EventEmitter();
  const sender = new EventEmitter();
  const otherSender = new EventEmitter();
  let destroyed = false;
  const sent = [];
  sender.isDestroyed = () => destroyed;
  sender.send = (channel, payload) => {
    sent.push({ channel, payload });
    if (channel === 'projects:root-leave-request' && decision === 'approve') {
      queueMicrotask(() => ipcMain.emit('projects:root-leave-response',
        { sender }, { token: payload.token, approved: true }));
    } else if (channel === 'projects:root-leave-request' && decision === 'cancel') {
      queueMicrotask(() => ipcMain.emit('projects:root-leave-response',
        { sender }, { token: payload.token, approved: false }));
    } else if (channel === 'projects:root-leave-request' && decision === 'wrong-first') {
      queueMicrotask(() => {
        ipcMain.emit('projects:root-leave-response',
          { sender: otherSender }, { token: payload.token, approved: true });
        ipcMain.emit('projects:root-leave-response',
          { sender }, { token: `${payload.token}-wrong`, approved: true });
        ipcMain.emit('projects:root-leave-response',
          { sender }, { token: payload.token, approved: false });
      });
    } else if (channel === 'projects:root-leave-request' && decision === 'destroy') {
      queueMicrotask(() => {
        destroyed = true;
        sender.emit('destroyed');
      });
    } else if (channel === 'projects:root-unload-permit' && ack) {
      queueMicrotask(() => ipcMain.emit('projects:root-unload-ack',
        { sender }, { token: payload.token, armed: true }));
    }
  };
  const reload = () => {
    if (navigation === 'throw') throw new Error('expected reload failure');
    if (navigation === 'start') {
      queueMicrotask(() => sender.emit('did-start-navigation', {
        isMainFrame: true,
        isSameDocument: false,
      }));
    }
  };
  return { ipcMain, sender, sent, reload, destroy: () => { destroyed = true; sender.emit('destroyed'); } };
}

function createGate(harness, tokens = ['leave-token'], timeouts = {}) {
  return lifecycle.createRendererLeaveGate({
    ipcMain: harness.ipcMain,
    decisionTimeoutMs: 30,
    commitTimeoutMs: 30,
    navigationTimeoutMs: 30,
    makeToken: () => tokens.shift(),
    ...timeouts,
  });
}

test('approved root change persists before permit and finalizes only after reload starts navigating', async () => {
  assert.equal(typeof lifecycle.createRendererLeaveGate, 'function');
  const harness = leaveHarness();
  const order = [];
  const originalSend = harness.sender.send;
  harness.sender.send = (...args) => {
    order.push('request');
    originalSend(...args);
  };
  const gate = createGate(harness);

  const result = await gate.run(harness.sender, {
    reload: () => {
      order.push('reload');
      harness.reload();
    },
    commit: () => {
      order.push('commit');
      return { ok: true, path: '/new-root' };
    },
    rollback: () => { order.push('rollback'); },
    finalize: () => { order.push('finalize'); },
  });
  gate.close();

  assert.deepEqual(result, { ok: true, path: '/new-root' });
  assert.deepEqual(order, ['request', 'commit', 'request', 'reload', 'finalize']);
  assert.deepEqual(harness.sent.map(({ channel }) => channel), [
    'projects:root-leave-request',
    'projects:root-unload-permit',
  ]);
});

test('persistence failure never arms unload permit or reloads the dirty renderer', async () => {
  const harness = leaveHarness();
  let root = '/old-root';
  let reloads = 0;
  const gate = createGate(harness);

  const result = await gate.run(harness.sender, {
    commit: () => ({ ok: false, error: 'persist-failed' }),
    rollback: () => { root = '/old-root'; },
    reload: () => { reloads += 1; harness.reload(); },
    finalize: () => { throw new Error('must not finalize'); },
  });
  gate.close();

  assert.deepEqual(result, { ok: false, error: 'persist-failed' });
  assert.equal(root, '/old-root');
  assert.equal(reloads, 0);
  assert.equal(harness.sent.filter(({ channel }) => channel === 'projects:root-unload-permit').length, 0);
});

test('reload start failure rolls back persisted root without finalizing admissions or children', async () => {
  const harness = leaveHarness({ navigation: 'none' });
  let root = '/old-root';
  const effects = [];
  const gate = createGate(harness, ['leave-token'], { navigationTimeoutMs: 5 });

  const result = await gate.run(harness.sender, {
    commit: () => { root = '/new-root'; effects.push('persist'); return { ok: true, path: root }; },
    rollback: () => { root = '/old-root'; effects.push('rollback'); return { ok: true }; },
    reload: harness.reload,
    finalize: () => { effects.push('finalize'); },
  });
  gate.close();

  assert.deepEqual(result, { ok: false, error: 'reload-start-timeout' });
  assert.equal(root, '/old-root');
  assert.deepEqual(effects, ['persist', 'rollback']);
});

test('cancel stays non-mutating while post-decision failures roll persisted root back', async (t) => {
  assert.equal(typeof lifecycle.createRendererLeaveGate, 'function');
  for (const scenario of [
    { name: 'cancel', harness: leaveHarness({ decision: 'cancel' }), error: 'canceled' },
    { name: 'reload timeout', harness: leaveHarness({ navigation: 'none' }), error: 'reload-start-timeout' },
    { name: 'reload failure', harness: leaveHarness({ navigation: 'throw' }), error: 'reload-failed' },
    { name: 'commit ack timeout', harness: leaveHarness({ ack: false }), error: 'commit-timeout' },
  ]) {
    await t.test(scenario.name, async () => {
      const effects = [];
      let root = '/old-root';
      const gate = createGate(scenario.harness, ['leave-token'], {
        commitTimeoutMs: 5,
        navigationTimeoutMs: 5,
      });
      const result = await gate.run(scenario.harness.sender, {
        reload: scenario.harness.reload,
        commit: () => { root = '/new-root'; effects.push('persist'); return { ok: true }; },
        rollback: () => { root = '/old-root'; effects.push('rollback'); return { ok: true }; },
        finalize: () => { effects.push('finalize'); },
      });
      gate.close();
      assert.equal(result.ok, false);
      assert.equal(result.error, scenario.error);
      assert.equal(root, '/old-root');
      assert.deepEqual(effects, scenario.name === 'cancel' ? [] : ['persist', 'rollback']);
      assert.equal(scenario.harness.sent.at(-1).channel, 'projects:root-transition-abort');
    });
  }
});

test('wrong sender and wrong token cannot approve a root mutation', async () => {
  assert.equal(typeof lifecycle.createRendererLeaveGate, 'function');
  const harness = leaveHarness({ decision: 'wrong-first' });
  let mutations = 0;
  const gate = createGate(harness);

  const result = await gate.run(harness.sender, {
    reload: harness.reload,
    commit: () => { mutations += 1; },
  });
  gate.close();

  assert.equal(result.error, 'canceled');
  assert.equal(mutations, 0);
});

test('navigation or destruction during a pending decision invalidates late approval', async (t) => {
  assert.equal(typeof lifecycle.createRendererLeaveGate, 'function');
  for (const scenario of ['navigation', 'destroyed']) {
    await t.test(scenario, async () => {
      const harness = leaveHarness({ decision: 'pending' });
      let mutations = 0;
      const gate = createGate(harness, ['leave-token']);
      const resultPromise = gate.run(harness.sender, {
        reload: harness.reload,
        commit: () => { mutations += 1; },
      });
      if (scenario === 'navigation') {
        harness.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      } else harness.destroy();
      harness.ipcMain.emit('projects:root-leave-response',
        { sender: harness.sender }, { token: 'leave-token', approved: true });
      const result = await resultPromise;
      gate.close();
      assert.equal(result.error, scenario === 'navigation' ? 'navigation-changed' : 'renderer-unavailable');
      assert.equal(mutations, 0);
    });
  }
});

test('navigation or destruction after persistence rolls the active transition back', async (t) => {
  for (const scenario of ['navigation', 'destroyed']) {
    await t.test(scenario, async () => {
      const harness = leaveHarness({ ack: false });
      const effects = [];
      let root = '/old-root';
      const gate = createGate(harness, ['leave-token']);
      const resultPromise = gate.run(harness.sender, {
        reload: harness.reload,
        commit: () => { root = '/new-root'; effects.push('persist'); return { ok: true }; },
        rollback: () => { root = '/old-root'; effects.push('rollback'); return { ok: true }; },
      });
      await new Promise((resolve) => setImmediate(resolve));
      if (scenario === 'navigation') {
        harness.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      } else harness.destroy();
      const result = await resultPromise;
      gate.close();

      assert.equal(result.error, scenario === 'navigation' ? 'navigation-changed' : 'renderer-unavailable');
      assert.equal(root, '/old-root');
      assert.deepEqual(effects, ['persist', 'rollback']);
    });
  }
});

test('overlapping root changes are blocked and only the active token can commit', async () => {
  const harness = leaveHarness({ decision: 'pending' });
  let commits = 0;
  const gate = createGate(harness, ['first-token', 'second-token']);
  const first = gate.run(harness.sender, {
    reload: harness.reload,
    commit: () => { commits += 1; return { ok: true }; },
  });
  const second = await gate.run(harness.sender, {
    reload: harness.reload,
    commit: () => { commits += 1; return { ok: true }; },
  });
  assert.deepEqual(second, { ok: false, error: 'root-change-in-progress' });
  harness.ipcMain.emit('projects:root-leave-response',
    { sender: harness.sender }, { token: 'first-token', approved: true });
  await new Promise((resolve) => setImmediate(resolve));
  harness.ipcMain.emit('projects:root-unload-ack',
    { sender: harness.sender }, { token: 'first-token', armed: true });
  assert.deepEqual(await first, { ok: true });
  gate.close();
  assert.equal(commits, 1);
  assert.equal(harness.sent.filter(({ channel }) => channel === 'projects:root-leave-request').length, 1);
});

test('decision timeout is distinct and ignores a late approval safely', async () => {
  const harness = leaveHarness({ decision: 'pending' });
  let commits = 0;
  const gate = createGate(harness, ['late-token'], { decisionTimeoutMs: 5 });
  const result = await gate.run(harness.sender, {
    reload: harness.reload,
    commit: () => { commits += 1; },
  });
  harness.ipcMain.emit('projects:root-leave-response',
    { sender: harness.sender }, { token: 'late-token', approved: true });
  await new Promise((resolve) => setImmediate(resolve));
  gate.close();
  assert.deepEqual(result, { ok: false, error: 'leave-timeout' });
  assert.equal(commits, 0);
});

test('root commit reports persistence failure before admissions or child windows change', () => {
  assert.equal(typeof lifecycle.commitRootTransition, 'function');
  const effects = [];
  const result = lifecycle.commitRootTransition({
    commit() {
      const error = new Error('disk full');
      error.code = 'persist-failed';
      throw error;
    },
    rollback() { effects.push('rollback'); },
  }, {
    replaceAdmissions() { effects.push('admissions'); },
    closeChildren() { effects.push('children'); },
    path: () => '/new-root',
  });

  assert.deepEqual(result, { ok: false, error: 'persist-failed' });
  assert.deepEqual(effects, []);
});

test('root commit returns the path published by the transaction itself', () => {
  const result = lifecycle.commitRootTransition({
    commit() { return '/new-root'; },
  });

  assert.deepEqual(result, { ok: true, path: '/new-root' });
});

test('navigation finalization is idempotent and isolates each child close failure', () => {
  assert.equal(typeof lifecycle.createRootTransitionFinalizer, 'function');
  const mainWindow = {};
  const destroyed = { isDestroyed: () => true, close: () => { throw new Error('destroyed'); } };
  let admissions = 0;
  let failedCloseAttempts = 0;
  let successfulCloses = 0;
  const finalize = lifecycle.createRootTransitionFinalizer({
    mainWindow,
    replaceAdmissions: () => { admissions += 1; },
    getWindows: () => [
      mainWindow,
      destroyed,
      { isDestroyed: () => false, close: () => { failedCloseAttempts += 1; throw new Error('gone'); } },
      { isDestroyed: () => false, close: () => { successfulCloses += 1; } },
    ],
  });

  assert.doesNotThrow(() => finalize());
  assert.doesNotThrow(() => finalize());
  assert.equal(admissions, 1);
  assert.equal(failedCloseAttempts, 1);
  assert.equal(successfulCloses, 1);
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

test('preload arms and consumes only the matching root unload permit once', async () => {
  const { api, ipcRenderer, sent } = loadPreloadApi();
  assert.equal(typeof api.consumeProjectsRootUnloadPermit, 'function');
  const unsubscribe = api.onProjectsRootLeaveRequested(() => true);
  ipcRenderer.emit('projects:root-leave-request', {}, { token: 'permit-token' });
  await new Promise((resolve) => setImmediate(resolve));
  ipcRenderer.emit('projects:root-unload-permit', {}, { token: 'sibling-token' });
  ipcRenderer.emit('projects:root-unload-permit', {}, { token: 'permit-token' });

  assert.equal(api.consumeProjectsRootUnloadPermit(), true);
  assert.equal(api.consumeProjectsRootUnloadPermit(), false);
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
    {
      channel: 'projects:root-leave-response',
      payload: { token: 'permit-token', approved: true },
    },
    {
      channel: 'projects:root-unload-ack',
      payload: { token: 'sibling-token', armed: false },
    },
    {
      channel: 'projects:root-unload-ack',
      payload: { token: 'permit-token', armed: true },
    },
  ]);
  unsubscribe();
});

test('preload abort disarms a permit and suppresses a late decision', async () => {
  const { api, ipcRenderer, sent } = loadPreloadApi();
  let resolveDecision;
  const decision = new Promise((resolve) => { resolveDecision = resolve; });
  const unsubscribe = api.onProjectsRootLeaveRequested(() => decision);
  ipcRenderer.emit('projects:root-leave-request', {}, { token: 'late-token' });
  ipcRenderer.emit('projects:root-transition-abort', {}, { token: 'late-token' });
  resolveDecision(true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(api.consumeProjectsRootUnloadPermit(), false);
  assert.deepEqual(sent, []);
  unsubscribe();
});

test('root change feedback distinguishes human timeout, busy, and commit failures', () => {
  assert.equal(typeof rootChange.message, 'function');
  const t = (key) => key;
  assert.equal(rootChange.message({ ok: false, error: 'leave-timeout' }, t),
    'projects.root.error.leaveTimeout');
  assert.equal(rootChange.message({ ok: false, error: 'root-change-in-progress' }, t),
    'projects.root.error.busy');
  assert.equal(rootChange.message({ ok: false, error: 'persist-failed' }, t),
    'projects.root.error.persist');
  assert.equal(rootChange.message({ ok: false, error: 'reload-start-timeout' }, t),
    'projects.root.error.reload');
  assert.equal(rootChange.message({ ok: false, canceled: true, error: 'canceled' }, t), null);
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'i18n', 'en.json'), 'utf8'));
  const sv = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'i18n', 'sv.json'), 'utf8'));
  for (const key of [
    'projects.root.error.leaveTimeout',
    'projects.root.error.busy',
    'projects.root.error.invalid',
    'projects.root.error.persist',
    'projects.root.error.reload',
    'projects.root.error.generic',
  ]) {
    assert.equal(typeof en[key], 'string', `missing English ${key}`);
    assert.equal(typeof sv[key], 'string', `missing Swedish ${key}`);
  }
});

test('root picker binding blocks overlap and shows localized failure feedback', async () => {
  assert.equal(typeof rootChange.bindPicker, 'function');
  let click;
  let chooseCalls = 0;
  let resolveChoice;
  const button = {
    disabled: false,
    addEventListener(type, callback) { if (type === 'click') click = callback; },
  };
  const error = {
    textContent: '',
    hidden: true,
    classList: { toggle(_name, hidden) { error.hidden = hidden; } },
  };
  rootChange.bindPicker({
    button,
    error,
    choose: () => {
      chooseCalls += 1;
      return new Promise((resolve) => { resolveChoice = resolve; });
    },
    t: (key) => key,
  });

  const first = click();
  const overlap = click();
  assert.equal(button.disabled, true);
  assert.equal(chooseCalls, 1);
  resolveChoice({ ok: false, error: 'leave-timeout' });
  await Promise.all([first, overlap]);

  assert.equal(button.disabled, false);
  assert.equal(error.textContent, 'projects.root.error.leaveTimeout');
  assert.equal(error.hidden, false);
});
