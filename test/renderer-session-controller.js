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
      rootUnloadPermitConsumes: 0,
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
      releaseSession: () => { state.releases += 1; },
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
      syncTray: (snapshot) => { state.tray = snapshot; },
      onProjectsRootLeaveRequested: (callback) => {
        state.rootLeaveSubscriptions += 1;
        state.rootLeaveDecision = callback();
        state.rootLeaveChecks += 1;
        return () => {};
      },
      consumeProjectsRootUnloadPermit: () => {
        state.rootUnloadPermitConsumes += 1;
        return state.rootUnloadPermitConsumes === 1;
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
        if (String(property).startsWith('on')) return events;
        return asyncNull;
      },
    });
  })();`;
}

async function runScenario(stage) {
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
        rootUnloadPermitted: !rootUnload.defaultPrevented,
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
    ok('matching root unload permit bypasses the dirty beforeunload exactly once',
      early.rootUnloadPermitConsumes === 2
        && early.beforeClose.rootUnloadPermitted
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
