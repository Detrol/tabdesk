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

function leaveHarness({
  decision = 'approve',
  navigation = 'start',
  url = 'file:///tabdesk/renderer/index.html',
} = {}) {
  const ipcMain = new EventEmitter();
  const sender = new EventEmitter();
  const otherSender = new EventEmitter();
  let destroyed = false;
  let reloads = 0;
  let allowedUnloads = 0;
  const sent = [];
  sender.isDestroyed = () => destroyed;
  sender.getURL = () => url;
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
    }
  };
  sender.reload = () => {
    reloads += 1;
    if (navigation === 'throw') throw new Error('expected reload failure');
    if (navigation === 'deferred') return;
    const unloadEvent = {
      preventDefault() { allowedUnloads += 1; },
    };
    sender.emit('will-prevent-unload', unloadEvent);
    if (navigation === 'start') {
      sender.emit('did-start-navigation', {
        url,
        isMainFrame: true,
        isSameDocument: false,
      });
    }
  };
  return {
    ipcMain,
    sender,
    sent,
    reloads: () => reloads,
    allowedUnloads: () => allowedUnloads,
    destroy: () => { destroyed = true; sender.emit('destroyed'); },
  };
}

test('only the gate-owned reload may override dirty unload and finalize its target', async () => {
  const harness = leaveHarness();
  const effects = [];
  const gate = createGate(harness);

  const result = await gate.run(harness.sender, {
    commit: () => { effects.push('persist'); return { ok: true, path: '/new-root' }; },
    rollback: () => { effects.push('rollback'); return { ok: true }; },
    finalize: () => { effects.push('finalize'); },
  });
  gate.close();

  assert.deepEqual(result, { ok: true, path: '/new-root' });
  assert.equal(harness.reloads(), 1);
  assert.equal(harness.allowedUnloads(), 1);
  assert.deepEqual(effects, ['persist', 'finalize']);
  assert.deepEqual(harness.sent.map(({ channel }) => channel), ['projects:root-leave-request']);
});

test('a renderer-initiated navigation cannot consume the armed reload exception', async () => {
  const harness = leaveHarness({ navigation: 'deferred' });
  const effects = [];
  let navigationPrevented = false;
  let wrongUnloadAllowed = false;
  const gate = createGate(harness, ['leave-token'], { navigationTimeoutMs: 30 });

  const resultPromise = gate.run(harness.sender, {
    commit: () => { effects.push('persist'); return { ok: true }; },
    rollback: () => { effects.push('rollback'); return { ok: true }; },
    finalize: () => { effects.push('finalize'); },
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.sender.emit('will-frame-navigate', {
    url: 'file:///wrong.html',
    isMainFrame: true,
    preventDefault() { navigationPrevented = true; },
  });
  harness.sender.emit('will-prevent-unload', {
    preventDefault() { wrongUnloadAllowed = true; },
  });
  const result = await resultPromise;
  gate.close();

  assert.deepEqual(result, { ok: false, error: 'navigation-changed' });
  assert.equal(navigationPrevented, true);
  assert.equal(wrongUnloadAllowed, false);
  assert.deepEqual(effects, ['persist', 'rollback']);
});

test('a different main-frame target cannot finalize the issued root reload', async () => {
  const harness = leaveHarness({ navigation: 'deferred' });
  const effects = [];
  const gate = createGate(harness);
  const resultPromise = gate.run(harness.sender, {
    commit: () => { effects.push('persist'); return { ok: true }; },
    rollback: () => { effects.push('rollback'); return { ok: true }; },
    finalize: () => { effects.push('finalize'); },
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.sender.emit('did-start-navigation', {
    url: 'file:///unrelated.html',
    isMainFrame: true,
    isSameDocument: false,
  });
  const result = await resultPromise;
  gate.close();

  assert.deepEqual(result, { ok: false, error: 'navigation-changed' });
  assert.deepEqual(effects, ['persist', 'rollback']);
});

test('a devtools reload disarms the root reload exception before unload', async () => {
  const harness = leaveHarness({ navigation: 'deferred' });
  const effects = [];
  let wrongUnloadAllowed = false;
  const gate = createGate(harness);
  const resultPromise = gate.run(harness.sender, {
    commit: () => { effects.push('persist'); return { ok: true }; },
    rollback: () => { effects.push('rollback'); return { ok: true }; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.sender.emit('devtools-reload-page');
  harness.sender.emit('will-prevent-unload', {
    preventDefault() { wrongUnloadAllowed = true; },
  });
  const result = await resultPromise;
  gate.close();

  assert.deepEqual(result, { ok: false, error: 'navigation-changed' });
  assert.equal(wrongUnloadAllowed, false);
  assert.deepEqual(effects, ['persist', 'rollback']);
});

test('window close or app quit during the root commit is blocked and rolls back before reload', async () => {
  const harness = leaveHarness();
  const ownerWindow = new EventEmitter();
  let closePrevented = false;
  const effects = [];
  const gate = createGate(harness);

  const result = await gate.run(harness.sender, {
    ownerWindow,
    commit: () => {
      effects.push('persist');
      ownerWindow.emit('close', { preventDefault() { closePrevented = true; } });
      return { ok: true };
    },
    rollback: () => { effects.push('rollback'); return { ok: true }; },
    finalize: () => { effects.push('finalize'); },
  });
  gate.close();

  assert.deepEqual(result, { ok: false, error: 'navigation-changed' });
  assert.equal(closePrevented, true);
  assert.equal(harness.reloads(), 0);
  assert.deepEqual(effects, ['persist', 'rollback']);
});

test('window close after the root reload is issued cannot consume its unload exception', async () => {
  const harness = leaveHarness({ navigation: 'deferred' });
  const ownerWindow = new EventEmitter();
  const effects = [];
  let closePrevented = false;
  let closeUnloadAllowed = false;
  const gate = createGate(harness);
  const resultPromise = gate.run(harness.sender, {
    ownerWindow,
    commit: () => { effects.push('persist'); return { ok: true }; },
    rollback: () => { effects.push('rollback'); return { ok: true }; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  ownerWindow.emit('close', { preventDefault() { closePrevented = true; } });
  harness.sender.emit('will-prevent-unload', {
    preventDefault() { closeUnloadAllowed = true; },
  });
  const result = await resultPromise;
  gate.close();

  assert.deepEqual(result, { ok: false, error: 'navigation-changed' });
  assert.equal(closePrevented, true);
  assert.equal(closeUnloadAllowed, false);
  assert.deepEqual(effects, ['persist', 'rollback']);
});

test('post-override terminal paths keep the durable root committed and finalize once', async (t) => {
  for (const scenario of ['close/app-quit', 'devtools-reload', 'gate-close', 'timeout', 'destroyed', 'wrong-navigation']) {
    await t.test(scenario, async () => {
      const harness = leaveHarness({ navigation: 'deferred' });
      const ownerWindow = new EventEmitter();
      let replayedCloses = 0;
      let closePrevented = false;
      let unloadAllowed = false;
      ownerWindow.close = () => { replayedCloses += 1; };
      ownerWindow.isDestroyed = () => false;
      const effects = [];
      const gate = createGate(harness, ['leave-token'], {
        navigationTimeoutMs: scenario === 'timeout' ? 5 : 30,
      });
      const resultPromise = gate.run(harness.sender, {
        ownerWindow,
        commit: () => { effects.push('persist'); return { ok: true, path: '/new-root' }; },
        rollback: () => { effects.push('rollback'); return { ok: true }; },
        finalize: () => { effects.push('finalize'); },
      });
      await new Promise((resolve) => setImmediate(resolve));
      harness.sender.emit('will-prevent-unload', {
        preventDefault() { unloadAllowed = true; },
      });

      if (scenario === 'close/app-quit') {
        // BrowserWindow.close() and app.quit() converge on the same owner close
        // event. Repeated attempts must queue only one close replay.
        ownerWindow.emit('close', { preventDefault() { closePrevented = true; } });
        ownerWindow.emit('close', { preventDefault() { closePrevented = true; } });
      } else if (scenario === 'devtools-reload') {
        harness.sender.emit('devtools-reload-page');
      } else if (scenario === 'gate-close') {
        gate.close();
      } else if (scenario === 'destroyed') {
        harness.destroy();
      }

      if (scenario === 'close/app-quit' || scenario === 'devtools-reload') {
        harness.sender.emit('did-start-navigation', {
          url: harness.sender.getURL(),
          isMainFrame: true,
          isSameDocument: false,
        });
      } else if (scenario === 'wrong-navigation') {
        harness.sender.emit('did-start-navigation', {
          url: 'file:///unrelated.html',
          isMainFrame: true,
          isSameDocument: false,
        });
      }
      const result = await resultPromise;
      await new Promise((resolve) => setImmediate(resolve));
      gate.close();

      assert.equal(unloadAllowed, true);
      assert.deepEqual(result, { ok: true, path: '/new-root' });
      assert.deepEqual(effects, ['persist', 'finalize']);
      assert.equal(closePrevented, scenario === 'close/app-quit');
      assert.equal(replayedCloses, scenario === 'close/app-quit' ? 1 : 0);
    });
  }
});

function createGate(harness, tokens = ['leave-token'], timeouts = {}) {
  return lifecycle.createRendererLeaveGate({
    ipcMain: harness.ipcMain,
    decisionTimeoutMs: 30,
    navigationTimeoutMs: 30,
    makeToken: () => tokens.shift(),
    ...timeouts,
  });
}

test('approved root change persists before its main-owned reload and finalizes on that navigation', async () => {
  assert.equal(typeof lifecycle.createRendererLeaveGate, 'function');
  const harness = leaveHarness();
  const order = [];
  const originalSend = harness.sender.send;
  harness.sender.send = (...args) => {
    order.push('request');
    originalSend(...args);
  };
  const originalReload = harness.sender.reload;
  harness.sender.reload = () => {
    order.push('reload');
    originalReload();
  };
  const gate = createGate(harness);

  const result = await gate.run(harness.sender, {
    commit: () => {
      order.push('commit');
      return { ok: true, path: '/new-root' };
    },
    rollback: () => { order.push('rollback'); },
    finalize: () => { order.push('finalize'); },
  });
  gate.close();

  assert.deepEqual(result, { ok: true, path: '/new-root' });
  assert.deepEqual(order, ['request', 'commit', 'reload', 'finalize']);
  assert.deepEqual(harness.sent.map(({ channel }) => channel), ['projects:root-leave-request']);
});

test('persistence failure never arms unload permit or reloads the dirty renderer', async () => {
  const harness = leaveHarness();
  let root = '/old-root';
  const gate = createGate(harness);

  const result = await gate.run(harness.sender, {
    commit: () => ({ ok: false, error: 'persist-failed' }),
    rollback: () => { root = '/old-root'; },
    finalize: () => { throw new Error('must not finalize'); },
  });
  gate.close();

  assert.deepEqual(result, { ok: false, error: 'persist-failed' });
  assert.equal(root, '/old-root');
  assert.equal(harness.reloads(), 0);
  assert.equal(harness.sent.filter(({ channel }) => channel === 'projects:root-unload-permit').length, 0);
});

test('reload start failure rolls back persisted root without finalizing admissions or children', async () => {
  const harness = leaveHarness({ navigation: 'deferred' });
  let root = '/old-root';
  const effects = [];
  const gate = createGate(harness, ['leave-token'], { navigationTimeoutMs: 5 });

  const result = await gate.run(harness.sender, {
    commit: () => { root = '/new-root'; effects.push('persist'); return { ok: true, path: root }; },
    rollback: () => { root = '/old-root'; effects.push('rollback'); return { ok: true }; },
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
    { name: 'reload timeout', harness: leaveHarness({ navigation: 'deferred' }), error: 'reload-start-timeout' },
    { name: 'reload failure', harness: leaveHarness({ navigation: 'throw' }), error: 'reload-failed' },
  ]) {
    await t.test(scenario.name, async () => {
      const effects = [];
      let root = '/old-root';
      const gate = createGate(scenario.harness, ['leave-token'], {
        navigationTimeoutMs: 5,
      });
      const result = await gate.run(scenario.harness.sender, {
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

test('unexpected navigation or destruction after persistence rolls the active transition back', async (t) => {
  for (const scenario of ['navigation', 'destroyed']) {
    await t.test(scenario, async () => {
      const harness = leaveHarness({ navigation: 'deferred' });
      const effects = [];
      let root = '/old-root';
      const gate = createGate(harness, ['leave-token']);
      const resultPromise = gate.run(harness.sender, {
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
    commit: () => { commits += 1; return { ok: true }; },
  });
  const second = await gate.run(harness.sender, {
    commit: () => { commits += 1; return { ok: true }; },
  });
  assert.deepEqual(second, { ok: false, error: 'root-change-in-progress' });
  harness.ipcMain.emit('projects:root-leave-response',
    { sender: harness.sender }, { token: 'first-token', approved: true });
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

test('preload exposes only the semantic root leave decision, never an unload permit', async () => {
  const { api, ipcRenderer, sent } = loadPreloadApi();
  assert.equal(api.consumeProjectsRootUnloadPermit, undefined);
  const unsubscribe = api.onProjectsRootLeaveRequested(() => true);
  ipcRenderer.emit('projects:root-leave-request', {}, { token: 'decision-token' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{
    channel: 'projects:root-leave-response',
    payload: { token: 'decision-token', approved: true },
  }]);
  assert.equal(ipcRenderer.listenerCount('projects:root-unload-permit'), 0);
  unsubscribe();
});

test('preload abort suppresses a late leave decision', async () => {
  const { api, ipcRenderer, sent } = loadPreloadApi();
  let resolveDecision;
  const decision = new Promise((resolve) => { resolveDecision = resolve; });
  const unsubscribe = api.onProjectsRootLeaveRequested(() => decision);
  ipcRenderer.emit('projects:root-leave-request', {}, { token: 'late-token' });
  ipcRenderer.emit('projects:root-transition-abort', {}, { token: 'late-token' });
  resolveDecision(true);
  await new Promise((resolve) => setImmediate(resolve));

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
