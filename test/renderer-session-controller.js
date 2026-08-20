const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

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
      loadedAddons: [],
      selectionDisposes: 0,
      selectionSubscriptions: 0,
      characterJoiners: 0,
      webLinkHandler: null,
      clipboardBase64: null,
      clipboardProvider: null,
      clipboardWrites: [],
      clipboardReads: 0,
      pastes: [],
      imageOptions: null,
      progressListener: null,
      webglContextLoss: null,
      webglDisposes: 0,
      openedUrls: [],
      observers: 0,
      observerDisconnects: 0,
      backendStarts: 0,
      backendKills: 0,
      dataListeners: 0,
      dataListenerCleanups: 0,
      titleListener: null,
      rootLeaveSubscriptions: 0,
      rootLeaveChecks: 0,
      rootLeaveDecision: null,
      allocations: [],
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
      constructor(options) {
        state.terminalCreates += 1;
        this.cols = 80;
        this.rows = 24;
        this.options = options || {};
        this.unicode = { activeVersion: '6' };
        this.parser = { registerOscHandler() {} };
        this._core = { _selectionService: { shouldForceSelection: () => false } };
      }
      loadAddon(addon) {
        state.loadedAddons.push(addon.constructor.name);
        if (addon.activate) addon.activate(this);
      }
      open(element) { this.element = element; }
      getSelection() { return this.selection || ''; }
      onSelectionChange() {
        state.selectionSubscriptions += 1;
        return { dispose: () => { state.selectionDisposes += 1; } };
      }
      attachCustomKeyEventHandler(handler) { state.keyHandler = handler; }
      onData() { return { dispose() {} }; }
      onTitleChange(listener) {
        state.titleListener = listener;
        return { dispose() {} };
      }
      write() {}
      input() {}
      paste(text) { state.pastes.push(text); }
      registerCharacterJoiner() {
        state.characterJoiners += 1;
        return state.characterJoiners;
      }
      deregisterCharacterJoiner() {}
      refresh() {}
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
    window.WebLinksAddon = {
      WebLinksAddon: class TestWebLinksAddon {
        constructor(handler) { state.webLinkHandler = handler; }
      },
    };
    window.ClipboardAddon = {
      Base64: class TestBase64 {
        encodeText(text) { return btoa(unescape(encodeURIComponent(text))); }
        decodeText(text) { return decodeURIComponent(escape(atob(text))); }
      },
      ClipboardAddon: class TestClipboardAddon {
        constructor(base64, provider) {
          state.clipboardBase64 = base64;
          state.clipboardProvider = provider;
        }
      },
    };
    window.ImageAddon = {
      ImageAddon: class TestImageAddon {
        constructor(options) { state.imageOptions = options; }
      },
    };
    window.ProgressAddon = {
      ProgressAddon: class TestProgressAddon {
        onChange(listener) {
          state.progressListener = listener;
          return { dispose() {} };
        }
      },
    };
    window.Unicode11Addon = { Unicode11Addon: class TestUnicode11Addon {} };
    window.WebglAddon = {
      WebglAddon: class TestWebglAddon {
        onContextLoss(listener) {
          state.webglContextLoss = listener;
          return { dispose() {} };
        }
        dispose() { state.webglDisposes += 1; }
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
      listProjects: async () => stage === 'workspace-overview'
        ? [{
          name: 'trading',
          path: '/srv/dev/trading',
          branch: null,
          worktrees: [{
            name: 'risk-fix',
            path: '/srv/dev/trading/.worktrees/risk-fix',
            branch: 'fix/risk',
          }],
          repositories: [{
            kind: 'repository',
            name: 'tradingagents',
            path: '/srv/dev/trading/tradingagents',
            branch: 'codex-subscription',
          }],
        }]
        : [{ name: 'Fixture', path: '/fixture', worktrees: [] }],
      restoreTabs: async () => stage === 'workspace-overview'
        ? [
          {
            session: 'td-shell-tradingagents',
            cwd: '/srv/dev/trading/tradingagents',
            projectPath: '/srv/dev/trading/tradingagents',
            agent: 'shell',
            name: 'Terminal',
          },
          {
            session: 'td-codex-tradingagents',
            cwd: '/srv/dev/trading/tradingagents',
            projectPath: '/srv/dev/trading/tradingagents',
            agent: 'shell',
            name: 'Crypto analysis',
          },
          {
            session: 'td-shell-daily-report',
            cwd: '/srv/dev/trading/reports/daily',
            projectPath: '/srv/dev/trading/reports/daily',
            agent: 'shell',
            name: 'Daily report',
          },
        ]
        : [],
      activityNow: async () => ({}),
      previousSessions: async () => [],
      allocateSession: async (...args) => {
        state.allocations.push(args);
        return { session: 'reserved-session', suffix: 0 };
      },
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
      copySelection: (text) => { state.clipboardWrites.push(text); },
      readClipboard: async () => {
        state.clipboardReads += 1;
        return 'paste from clipboard';
      },
      openExternal: (url) => { state.openedUrls.push(url); },
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
    source('asking.js'),
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
      releases: state.releases,
      releasedSessions: state.releasedSessions,
      generated,
      sessionBeforeClose,
      tabsAfterClose: document.querySelectorAll('.stab:not(.ov):not(.files):not(.add)').length,
    };
  })()`);
}

async function runWorkspaceOverviewScenario() {
  const window = await createRenderer('workspace-overview');
  await waitFor(window, 'tabs.size === 3', 'restored workspace sessions');
  await window.webContents.executeJavaScript("showOverview('/srv/dev/trading')");
  const result = await window.webContents.executeJavaScript(`(() => {
    const workspace = document.querySelector(
      '.ov-workspace[data-path="/srv/dev/trading/tradingagents"]');
    const worktree = document.querySelector(
      '.ov-workspace[data-path="/srv/dev/trading/.worktrees/risk-fix"]');
    const folder = document.querySelector(
      '.ov-workspace[data-path="/srv/dev/trading/reports/daily"]');
    return {
      projects: [...projects.keys()],
      parentSessions: sessionsOf('/srv/dev/trading').map((tab) => ({
        session: tab.session,
        cwd: tab.cwd,
        projectCwd: tab.projectCwd,
      })),
      nestedSessions: sessionsOf('/srv/dev/trading/tradingagents').length,
      workspace: workspace && {
        branch: workspace.querySelector('.ov-branch')?.textContent || '',
        sessions: workspace.querySelectorAll('.ov-row').length,
        open: workspace.open,
      },
      worktree: worktree && {
        branch: worktree.querySelector('.ov-branch')?.textContent || '',
        open: worktree.open,
      },
      folder: folder && {
        kind: folder.querySelector('.ov-kind')?.textContent || '',
        sessions: folder.querySelectorAll('.ov-row').length,
        open: folder.open,
      },
    };
  })()`);
  result.allocation = await window.webContents.executeJavaScript(`(() => {
    document.querySelector(
      '.ov-workspace-start[data-path="/srv/dev/trading/tradingagents"]')?.click();
    return window.__sessionTest.allocations[0] || null;
  })()`);
  return result;
}

async function runProjectStatusScenario() {
  const window = await createRenderer('project-status');
  await waitFor(window, "projects.has('/fixture')", 'fixture project');
  return window.webContents.executeJavaScript(`(async () => {
    showOverview('/fixture');
    const doneId = buildTab({ name: 'Done', cwd: '/fixture', projectCwd: '/fixture' });
    const busyId = buildTab({ name: 'Busy', cwd: '/fixture', projectCwd: '/fixture' });
    const done = tabs.get(doneId);
    done.doneAt = Date.now() - 1000;
    renderProject('/fixture');

    markActivity(busyId, 30);
    const during = projects.get('/fixture').el.className;
    await new Promise((resolve) => setTimeout(resolve, 80));
    const after = projects.get('/fixture').el.className;

    done.doneAt = 0;
    tabs.get(busyId).doneAt = 0;
    renderProject('/fixture');
    const watchedId = buildTab({ name: 'Watched', cwd: '/fixture', projectCwd: '/fixture' });
    const watched = tabs.get(watchedId);
    materialize(watched);
    pinned.add(watchedId);
    markActivity(watchedId, 30);
    const watchedDuring = projects.get('/fixture').el.className;
    clearTabFlag(tabs.get(watchedId));
    const watchedAfterOpen = projects.get('/fixture').el.className;
    await new Promise((resolve) => setTimeout(resolve, 80));
    const watchedAfter = projects.get('/fixture').el.className;

    watched.session = 'td-watched';
    markActivity(watchedId, 30);
    applyActivity({ 'td-watched': { at: 1, asking: true, cwd: '/fixture' } });
    markActivity(watchedId, 30);
    const watchedQuestion = projects.get('/fixture').el.className;
    if (window.__sessionTest.titleListener) window.__sessionTest.titleListener('⠼ fixture');
    markActivity(watchedId, 30);
    const watchedAnswered = projects.get('/fixture').el.className;
    if (window.__sessionTest.titleListener) {
      window.__sessionTest.titleListener('[ ! ] Action Required | fixture');
    }
    markActivity(watchedId, 30);
    const watchedSecondQuestion = projects.get('/fixture').el.className;

    clearTimeout(watched.idleTimer);
    watched.busy = false;
    watched.tabEl.classList.remove('busy');
    pinned.delete(watchedId);
    renderProject('/fixture');
    const pinId = buildTab({ name: 'Pin', cwd: '/fixture', projectCwd: '/fixture' });
    const pin = tabs.get(pinId);
    pin.materialized = true;
    pin.doneAt = Date.now();
    pin.tabEl.classList.add('done');
    renderProject('/fixture');
    pinSession(pinId);
    const pinnedState = projects.get('/fixture').el.className;
    const pinnedDoneAt = pin.doneAt;

    const overflow = [pinId];
    for (let i = 1; i < MAX_PANELS; i += 1) {
      const id = buildTab({ name: 'Pin ' + (i + 1), cwd: '/fixture', projectCwd: '/fixture' });
      pinned.add(id);
      overflow.push(id);
    }
    activeId = watchedId;
    applyLayout();
    const hidden = tabs.get(overflow[overflow.length - 1]);
    hidden.doneAt = Date.now();
    hidden.tabEl.classList.add('done');
    renderProject('/fixture');
    activeId = null;
    applyLayout();
    const reenteredDoneAt = hidden.doneAt;

    for (const id of overflow) {
      const tab = tabs.get(id);
      tab.doneAt = 0;
      tab.tabEl.classList.remove('done');
      pinned.delete(id);
    }
    renderProject('/fixture');
    const closeId = buildTab({ name: 'Close', cwd: '/fixture', projectCwd: '/fixture' });
    const closed = tabs.get(closeId);
    pinned.add(closeId);
    markActivity(closeId, 30);
    closeTab(closeId);
    await new Promise((resolve) => setTimeout(resolve, 80));
    return {
      during, after, watchedDuring, watchedAfterOpen, watchedAfter,
      watchedQuestion, watchedAnswered, watchedSecondQuestion,
      pinnedState, pinnedDoneAt, reenteredDoneAt, closedDoneAt: closed.doneAt,
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
          releases: state.releases,
          terminalDisposes: state.terminalDisposes,
          selectionDisposes: state.selectionDisposes,
          observerDisconnects: state.observerDisconnects,
          backendStarts: state.backendStarts,
          backendKills: state.backendKills,
          dataListenerCleanups: state.dataListenerCleanups,
          rootLeaveSubscriptions: state.rootLeaveSubscriptions,
          rootLeaveChecks: state.rootLeaveChecks,
          rootLeaveDecision: state.rootLeaveDecision,
          beforeClose,
          tabsAfterClose: document.querySelectorAll('.stab:not(.ov):not(.files):not(.add)').length,
        });
      })));
    })()`);
}

async function runAddonScenario(agent = 'codex') {
  const window = await createRenderer('addons');
  return window.webContents.executeJavaScript(`(async () => {
    const state = window.__sessionTest;
    const tabEl = document.createElement('div');
    tabEl.className = 'stab';
    const termEl = document.createElement('div');
    document.body.append(tabEl, termEl);
    const term = new Terminal({ fontFamily: '"Fira Code", monospace' });
    term.open(termEl);
    if (typeof loadTerminalAddons === 'function') {
      await loadTerminalAddons(term, tabEl, termEl, ${JSON.stringify(agent)});
    }
    if (state.webLinkHandler) {
      state.webLinkHandler(new MouseEvent('click'), 'https://example.com/docs');
    }

    term.selection = 'mouse selection';
    termEl.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    const copiesAfterMouseSelection = state.clipboardWrites.length;

    let clipboardRead = null;
    if (state.clipboardBase64 && state.clipboardProvider) {
      const decoded = state.clipboardBase64.decodeText(btoa('safe\\u0000text\\nnext'));
      state.clipboardProvider.writeText('c', decoded);
      const oversized = 'A'.repeat(100 * 1024 + 1);
      state.clipboardProvider.writeText('c', state.clipboardBase64.decodeText(oversized));
      clipboardRead = state.clipboardProvider.readText('c');
    }

    const plainPastePassesThrough = state.keyHandler && state.keyHandler({
      type: 'keydown', code: 'KeyV', ctrlKey: true, shiftKey: false,
      altKey: false, metaKey: false,
    });
    const shiftedPasteHandled = state.keyHandler && state.keyHandler({
      type: 'keydown', code: 'KeyV', ctrlKey: true, shiftKey: true,
      altKey: false, metaKey: false,
    });
    await Promise.resolve();
    if (state.progressListener) state.progressListener({ state: 1, value: 42 });
    const progress = {
      value: tabEl.style.getPropertyValue('--progress'),
      active: tabEl.classList.contains('progress'),
    };
    if (state.progressListener) state.progressListener({ state: 0, value: 0 });
    const progressCleared = !tabEl.classList.contains('progress')
      && tabEl.style.getPropertyValue('--progress') === '';

    if (state.webglContextLoss) state.webglContextLoss();
    return {
      loadedAddons: state.loadedAddons,
      unicodeVersion: term.unicode.activeVersion,
      imageOptions: state.imageOptions,
      openedUrls: state.openedUrls,
      clipboardWrites: state.clipboardWrites,
      clipboardRead,
      clipboardReads: state.clipboardReads,
      pastes: state.pastes,
      copiesAfterMouseSelection,
      selectionSubscriptions: state.selectionSubscriptions,
      plainPastePassesThrough,
      shiftedPasteHandled,
      forceSelection: term._core._selectionService.shouldForceSelection(),
      progress,
      progressCleared,
      webglDisposes: state.webglDisposes,
      characterJoiners: state.characterJoiners,
    };
  })()`);
}

function checkAddonScenario(addons, claudeAddons) {
  ok('official addons are loaded with Unicode 11 and a ligature joiner',
    ['TestWebLinksAddon', 'TestClipboardAddon', 'TestImageAddon',
      'TestProgressAddon', 'TestUnicode11Addon']
      .every((name) => addons.loadedAddons.includes(name))
      && !addons.loadedAddons.includes('TestWebglAddon')
      && addons.unicodeVersion === '11'
      && addons.characterJoiners === 1,
    JSON.stringify(addons));
  ok('plain web links use the validated external-link bridge',
    addons.openedUrls.length === 1
      && addons.openedUrls[0] === 'https://example.com/docs',
    JSON.stringify(addons));
  ok('OSC 52 writes are sanitized and cannot read or clear the clipboard',
    addons.clipboardWrites.length === 2
      && addons.clipboardWrites[1] === 'safetext\nnext'
      && addons.clipboardRead === '',
    JSON.stringify(addons));
  ok('terminal mouse selection copies and Ctrl+V pastes',
    addons.copiesAfterMouseSelection === 1
      && addons.clipboardWrites[0] === 'mouse selection'
      && addons.selectionSubscriptions === 0
      && addons.plainPastePassesThrough === false
      && addons.shiftedPasteHandled === false
      && addons.clipboardReads === 2
      && JSON.stringify(addons.pastes) === JSON.stringify([
        'paste from clipboard', 'paste from clipboard',
      ]),
    JSON.stringify(addons));
  ok('ordinary terminals select in xterm while self-selecting TUIs keep their mouse',
    addons.forceSelection === true && claudeAddons.forceSelection === false,
    JSON.stringify({ codex: addons.forceSelection, claude: claudeAddons.forceSelection }));
  ok('images are capped, progress is visible, and WebGL stays disabled',
    addons.imageOptions?.pixelLimit === 4194304
      && addons.imageOptions.storageLimit === 16
      && addons.imageOptions.sixelSizeLimit === 8388608
      && addons.imageOptions.iipSizeLimit === 8388608
      && addons.progress.value === '42%'
      && addons.progress.active
      && addons.progressCleared
      && addons.webglDisposes === 0,
    JSON.stringify(addons));
}

app.whenReady().then(async () => {
  try {
    const html = source('renderer/index.html')
      .replace('<head>', `<head><base href="${pathToFileURL(path.join(ROOT, 'renderer/')).href}">`)
      .replace(/\s*<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/i, '')
      .replace(/\s*<link[^>]*\/>/gi, '')
      .replace(/\s*<script[^>]*><\/script>/gi, '');
    fs.writeFileSync(FIXTURE, html);
    console.log('== terminal addons ==');
    checkAddonScenario(await runAddonScenario(), await runAddonScenario('claude'));

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
        && late.selectionDisposes === 0
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

    const workspace = await runWorkspaceOverviewScenario();
    ok('restored nested repository sessions appear in the parent Overview without another rail project',
      workspace.projects.length === 1
        && workspace.projects[0] === '/srv/dev/trading'
        && workspace.parentSessions.length === 3
        && workspace.parentSessions.filter((tab) =>
          tab.cwd === '/srv/dev/trading/tradingagents'
            && tab.projectCwd === '/srv/dev/trading').length === 2
        && workspace.parentSessions.some((tab) =>
          tab.cwd === '/srv/dev/trading/reports/daily'
            && tab.projectCwd === '/srv/dev/trading')
        && workspace.nestedSessions === 0
        && workspace.workspace?.branch === 'codex-subscription'
        && workspace.workspace?.sessions === 2
        && workspace.workspace?.open === true,
      JSON.stringify(workspace));
    ok('Overview shows an ordinary nested folder only because it has a restorable session',
      workspace.folder?.kind === 'overview.kind.folder'
        && workspace.folder?.sessions === 1
        && workspace.folder?.open === true,
      JSON.stringify(workspace));
    ok('Overview offers inactive worktrees and starts a repository in its exact cwd',
      workspace.worktree?.branch === 'fix/risk'
        && workspace.worktree?.open === false
        && workspace.allocation?.[0] === '/srv/dev/trading/tradingagents',
      JSON.stringify(workspace));

    const projectStatus = await runProjectStatusScenario();
    ok('current work outranks an older finished session on the project row',
      projectStatus.during.includes('busy') && projectStatus.during.includes('working'),
      JSON.stringify(projectStatus));
    ok('the project row stops working when the current work goes quiet',
      projectStatus.after.includes('done') && !projectStatus.after.includes('working'),
      JSON.stringify(projectStatus));
    ok('the project row follows a watched session from working to quiet',
      projectStatus.watchedDuring.includes('busy')
        && projectStatus.watchedDuring.includes('working')
        && projectStatus.watchedAfterOpen.includes('busy')
        && projectStatus.watchedAfterOpen.includes('working')
        && projectStatus.watchedAfter.includes('open')
        && !projectStatus.watchedAfter.includes('working'),
      JSON.stringify(projectStatus));
    ok('a watched question animation does not look like work',
      projectStatus.watchedQuestion.includes('open')
        && !projectStatus.watchedQuestion.includes('working'),
      JSON.stringify(projectStatus));
    ok('answering a watched question restores live work immediately',
      projectStatus.watchedAnswered.includes('busy')
        && projectStatus.watchedAnswered.includes('working'),
      JSON.stringify(projectStatus));
    ok('a second watched question is not lost between polls',
      projectStatus.watchedSecondQuestion.includes('open')
        && !projectStatus.watchedSecondQuestion.includes('working'),
      JSON.stringify(projectStatus));
    ok('pinning a session clears its finished notice',
      projectStatus.pinnedState.includes('open') && !projectStatus.pinnedDoneAt,
      JSON.stringify(projectStatus));
    ok('a hidden pin clears its notice when it becomes visible again',
      !projectStatus.reenteredDoneAt,
      JSON.stringify(projectStatus));
    ok('closing a working session cancels its idle transition',
      !projectStatus.closedDoneAt,
      JSON.stringify(projectStatus));
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
