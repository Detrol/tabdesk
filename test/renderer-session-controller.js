const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'tabdesk-session-test-'));
const FIXTURE = path.join(PROFILE, 'renderer.html');

app.disableHardwareAcceleration();
app.setPath('userData', PROFILE);

let failures = 0;
const windows = [];
function ok(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

const source = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

async function waitFor(window, expression, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function setup(stage) {
  return `(() => {
    const state = window.__sessionTest = {
      releases: 0,
      releasedSessions: [],
      terminalCreates: 0,
      terminalDisposes: 0,
      selectionDisposes: 0,
      observers: 0,
      observerDisconnects: 0,
      backendStarts: 0,
      backendKills: 0,
      dataListeners: 0,
      dataListenerCleanups: 0,
      rootLeaveSubscriptions: 0,
      rootLeaveChecks: 0,
      rootLeaveDecision: null,
      tray: null,
    };
    const stage = ${JSON.stringify(stage)};

    window.t = (key) => key;
    window.ui = { theme: { terminal: {} }, onChange() {} };
    window.TabDeskFiles = {
      createFileView() {
        const element = document.createElement('div');
        element.className = 'panel files-test';
        return {
          element,
          hasUnsavedChanges: () => true,
          canLeave: () => true,
          confirmLeave: () => false,
          deactivate: async () => {},
          activate: async () => {},
          onLanguage() {},
          onTheme() {},
        };
      },
    };

    window.Terminal = class TestTerminal {
      constructor() {
        state.terminalCreates += 1;
        this.cols = 80;
        this.rows = 24;
        this.options = {};
        this.parser = { registerOscHandler() {} };
      }
      loadAddon() {}
      open() {}
      getSelection() { return ''; }
      onSelectionChange() {
        return { dispose: () => { state.selectionDisposes += 1; } };
      }
      attachCustomKeyEventHandler() {}
      onData() { return { dispose() {} }; }
      write() {}
      focus() {}
      dispose() { state.terminalDisposes += 1; }
    };
    window.FitAddon = {
      FitAddon: class TestFitAddon {
        constructor() {
          if (stage === 'after-terminal') throw new Error('expected fit failure');
        }
        fit() {}
      },
    };
    window.ResizeObserver = class TestResizeObserver {
      constructor() { state.observers += 1; }
      observe() {}
      disconnect() { state.observerDisconnects += 1; }
    };

    const events = () => () => {};
    const asyncNull = async () => null;
    const api = {
      boot: {
        projectsRoot: { configured: true },
        agents: {
          list: [{ id: 'shell', label: 'Shell', command: null }],
          byProject: {},
          fallback: 'shell',
        },
      },
      listProjects: async () => [{ name: 'Fixture', path: '/fixture', worktrees: [] }],
      restoreTabs: async () => [],
      activityNow: async () => ({}),
      previousSessions: async () => [],
      allocateSession: async () => ({ session: 'reserved-session', suffix: 0 }),
      getModel: async () => 'default',
      getEffort: async () => 'default',
      releaseSession: (session) => {
        state.releases += 1;
        state.releasedSessions.push(session);
      },
      createTerminal: () => { state.backendStarts += 1; },
      killTerminal: () => { state.backendKills += 1; },
      onData: () => {
        state.dataListeners += 1;
        return () => { state.dataListenerCleanups += 1; };
      },
      onExit: () => {
        if (stage === 'after-listener') throw new Error('expected listener failure');
        return () => {};
      },
      onTerminalDeclined: (callback) => {
        window.__declineTerminal = callback;
        return () => { window.__declineTerminal = null; };
      },
      syncTray: (snapshot) => { state.tray = snapshot; },
      onProjectsRootLeaveRequested: (callback) => {
        state.rootLeaveSubscriptions += 1;
        state.rootLeaveDecision = callback();
        state.rootLeaveChecks += 1;
        return () => {};
      },
      getUsageLimits: async () => ({ ok: false, reason: 'network' }),
      getUsageStats: async () => null,
      getSystemStats: async () => null,
      listModels: async () => ({ list: [], global: 'default' }),
      getGlobalModel: async () => 'default',
      listEfforts: async () => ({ list: [], global: 'default' }),
      gitBranch: async () => null,
    };
    window.api = new Proxy(api, {
      get(target, property) {
        if (property in target) return target[property];
        if (property === 'consumeProjectsRootUnloadPermit') return undefined;
        if (String(property).startsWith('on')) return events;
        return asyncNull;
      },
    });
  })();`;
}

async function createRenderer(stage) {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false },
  });
  windows.push(window);
  await window.loadFile(FIXTURE, { query: { stage } });
  await window.webContents.executeJavaScript([
    setup(stage),
    source('renderer/tab-order.js'),
    source('renderer/navigation.js'),
    source('renderer/renderer.js'),
    'void 0;',
  ].join('\n'));
  return window;
}

async function runGeneratedDeclineScenario() {
  const window = await createRenderer('declined-generated');
  return window.webContents.executeJavaScript(`(() => {
    const state = window.__sessionTest;
    const generated = 'td-shell-main-generated';
    const id = buildTab({ name: 'Shell', cwd: '/fixture', projectCwd: '/fixture', agent: 'shell' });
    const tab = tabs.get(id);
    tab.materialized = true;
    window.__declineTerminal({ id, session: generated });
    const sessionBeforeClose = tab && tab.session;
    const close = tab && tab.tabEl.querySelector('.close');
    if (close) close.click();
    return {
      ...state,
      generated,
      sessionBeforeClose,
      tabsAfterClose: document.querySelectorAll('.stab:not(.ov):not(.files):not(.add)').length,
    };
  })()`);
}

async function runScenario(stage) {
  const window = await createRenderer(stage);
    await waitFor(window, "document.querySelector('.ov-chip') !== null", 'overview start chip');
    await window.webContents.executeJavaScript("document.querySelector('.ov-chip').click();");
    await waitFor(window, 'window.__sessionTest.releases === 1', 'failed start release');
    await new Promise((resolve) => setTimeout(resolve, 30));

    return await window.webContents.executeJavaScript(`(() => {
      const state = window.__sessionTest;
      const rootUnload = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(rootUnload);
      const nextUnload = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(nextUnload);
      const beforeClose = {
        tabs: document.querySelectorAll('.stab:not(.ov):not(.files):not(.add)').length,
        terminalPanels: document.querySelectorAll('#panels > .panel:not(.overview):not(.files-test)').length,
        projectCount: document.querySelector('.tab.project .count').textContent,
        overviewShown: document.querySelector('.overview').classList.contains('shown'),
        trayTabs: state.tray ? state.tray.tabs.length : -1,
        rootUnloadPrevented: rootUnload.defaultPrevented,
        nextUnloadPrevented: nextUnload.defaultPrevented,
      };
      const close = document.querySelector('.stab .close');
      if (close) close.click();
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
        resolve({
          ...state,
          beforeClose,
          tabsAfterClose: document.querySelectorAll('.stab:not(.ov):not(.files):not(.add)').length,
        });
      })));
    })()`);
}

app.whenReady().then(async () => {
  try {
    const html = source('renderer/index.html')
      .replace(/\s*<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/i, '')
      .replace(/\s*<link[^>]*\/>/gi, '')
      .replace(/\s*<script[^>]*><\/script>/gi, '');
    fs.writeFileSync(FIXTURE, html);
    console.log('== renderer failed-session rollback ==');
    const early = await runScenario('after-terminal');
    ok('failure after panel and Terminal removes the tab',
      early.beforeClose.tabs === 0, JSON.stringify(early));
    ok('failure after panel and Terminal removes the panel',
      early.beforeClose.terminalPanels === 0, JSON.stringify(early));
    ok('failure after panel and Terminal disposes Terminal', early.terminalDisposes === 1, JSON.stringify(early));
    ok('failure before backend start does not kill a backend', early.backendKills === 0, JSON.stringify(early));
    ok('failed start releases its reservation exactly once', early.releases === 1, JSON.stringify(early));
    ok('failed start restores project and tray membership',
      early.beforeClose.projectCount === '' && early.beforeClose.trayTabs === 0,
      JSON.stringify(early));
    ok('failed start preserves the prior overview layout',
      early.beforeClose.overviewShown, JSON.stringify(early));
    ok('renderer answers the main-owned root leave request through the file guard',
      early.rootLeaveSubscriptions === 1
        && early.rootLeaveChecks === 1
        && early.rootLeaveDecision === false,
      JSON.stringify(early));
    ok('renderer dirty guard protects every unload without a generic permit',
      early.beforeClose.rootUnloadPrevented
        && early.beforeClose.nextUnloadPrevented,
      JSON.stringify(early));

    const late = await runScenario('after-listener');
    ok('failure after backend setup removes tab and panel',
      late.beforeClose.tabs === 0 && late.beforeClose.terminalPanels === 0,
      JSON.stringify(late));
    ok('failure after backend setup disposes terminal resources',
      late.terminalDisposes === 1
        && late.selectionDisposes === 1
        && late.observerDisconnects === 1
        && late.dataListenerCleanups === 1,
      JSON.stringify(late));
    ok('failure after backend setup kills only the started backend',
      late.backendStarts === 1 && late.backendKills === 1, JSON.stringify(late));
    ok('later close cannot release the rolled-back reservation again',
      late.releases === 1, JSON.stringify(late));
    ok('late failed start restores project, tray, and overview layout',
      late.beforeClose.projectCount === ''
        && late.beforeClose.trayTabs === 0
        && late.beforeClose.overviewShown,
      JSON.stringify(late));

    const declined = await runGeneratedDeclineScenario();
    ok('main-generated failed session remains attached to the retryable tab',
      declined.sessionBeforeClose === declined.generated, JSON.stringify(declined));
    ok('closing a declined generated session releases that exact reservation once',
      declined.releases === 1
        && declined.releasedSessions[0] === declined.generated
        && declined.tabsAfterClose === 0,
      JSON.stringify(declined));
  } catch (error) {
    failures += 1;
    console.error(error && error.stack ? error.stack : error);
  } finally {
    for (const window of windows) {
      if (!window.isDestroyed()) window.destroy();
    }
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) { /* gone */ }
    app.exit(failures ? 1 : 0);
  }
});
