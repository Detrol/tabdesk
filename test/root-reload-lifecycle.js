const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRendererLeaveGate } = require('../main-lifecycle');

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'tabdesk-root-reload-test-'));
const FIXTURE = path.join(PROFILE, 'dirty.html');

app.disableHardwareAcceleration();
app.setPath('userData', PROFILE);

let failures = 0;
function ok(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

app.whenReady().then(async () => {
  let window;
  let interleavedWindow;
  let closeWindow;
  let gate;
  let interleavedGate;
  let closeGate;
  try {
    fs.writeFileSync(FIXTURE, `<!doctype html><meta charset="utf-8"><script>
      const { ipcRenderer } = require('electron');
      ipcRenderer.on('projects:root-leave-request', (_event, { token }) => {
        ipcRenderer.send('projects:root-leave-response', { token, approved: true });
      });
      window.addEventListener('beforeunload', (event) => {
        event.preventDefault();
        event.returnValue = '';
      });
      window.__dirtyInstalled = true;
    </script>`);
    window = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: false, nodeIntegration: true },
    });
    await window.loadFile(FIXTURE);
    await window.webContents.executeJavaScript('document.body.click(); true', true);

    const effects = [];
    const events = [];
    let blockedUnloads = 0;
    window.webContents.on('will-prevent-unload', () => {
      blockedUnloads += 1;
      events.push({ type: 'will-prevent-unload' });
    });
    window.webContents.on('did-start-navigation', (details) => {
      events.push({
        type: 'did-start-navigation',
        url: details.url,
        isMainFrame: details.isMainFrame,
        isSameDocument: details.isSameDocument,
      });
    });
    const dirtyInstalled = await window.webContents.executeJavaScript('window.__dirtyInstalled === true');
    gate = createRendererLeaveGate({
      ipcMain,
      decisionTimeoutMs: 1000,
      navigationTimeoutMs: 1000,
      makeToken: () => 'real-reload-token',
    });
    const reloaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
    const result = await gate.run(window.webContents, {
      commit: () => { effects.push('persist'); return { ok: true, path: '/new-root' }; },
      rollback: () => { effects.push('rollback'); return { ok: true }; },
      finalize: () => { effects.push('finalize'); },
    });

    ok('main-owned reload overrides the dirty unload and reaches its own navigation',
      result.ok === true && result.path === '/new-root'
        && blockedUnloads === 1
        && effects.join(',') === 'persist,finalize',
      JSON.stringify({ result, blockedUnloads, dirtyInstalled, currentUrl: window.webContents.getURL(), events, effects }));

    await reloaded;
    await window.webContents.executeJavaScript('document.body.click(); true', true);
    window.webContents.close({ waitForBeforeUnload: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    ok('a later close is protected by the ordinary dirty guard',
      !window.isDestroyed() && blockedUnloads === 2,
      JSON.stringify({ destroyed: window.isDestroyed(), blockedUnloads }));

    interleavedWindow = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: false, nodeIntegration: true },
    });
    await interleavedWindow.loadFile(FIXTURE);
    await interleavedWindow.webContents.executeJavaScript('document.body.click(); true', true);
    const interleavedEffects = [];
    let matchingNavigations = 0;
    let rendererDeaths = 0;
    interleavedWindow.webContents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) matchingNavigations += 1;
    });
    interleavedWindow.webContents.on('render-process-gone', () => { rendererDeaths += 1; });
    interleavedGate = createRendererLeaveGate({
      ipcMain,
      decisionTimeoutMs: 1000,
      navigationTimeoutMs: 50,
      makeToken: () => 'real-timeout-token',
    });
    const interleavedResultPromise = interleavedGate.run(interleavedWindow.webContents, {
      ownerWindow: interleavedWindow,
      commit: () => { interleavedEffects.push('persist'); return { ok: true, path: '/timeout-root' }; },
      rollback: () => { interleavedEffects.push('rollback'); return { ok: true }; },
      finalize: () => { interleavedEffects.push('finalize'); },
    });
    let timeoutOverrideObserved = false;
    interleavedWindow.webContents.once('will-prevent-unload', () => {
      timeoutOverrideObserved = true;
      interleavedWindow.webContents.stop();
    });
    const interleavedResult = await interleavedResultPromise;
    ok('post-override timeout replaces the real renderer before reporting success',
      interleavedResult.ok === true
        && interleavedResult.path === '/timeout-root'
        && timeoutOverrideObserved
        && matchingNavigations === 0
        && (rendererDeaths > 0 || interleavedWindow.webContents.isDestroyed())
        && interleavedEffects.join(',') === 'persist,finalize',
      JSON.stringify({ interleavedResult, interleavedEffects, timeoutOverrideObserved,
        matchingNavigations, rendererDeaths, destroyed: interleavedWindow.webContents.isDestroyed() }));

    closeWindow = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: false, nodeIntegration: true },
    });
    await closeWindow.loadFile(FIXTURE);
    await closeWindow.webContents.executeJavaScript('document.body.click(); true', true);
    const closeEffects = [];
    let closed = false;
    closeWindow.once('closed', () => { closed = true; });
    closeGate = createRendererLeaveGate({
      ipcMain,
      decisionTimeoutMs: 1000,
      navigationTimeoutMs: 100,
      makeToken: () => 'real-close-token',
    });
    const closeResultPromise = closeGate.run(closeWindow.webContents, {
      ownerWindow: closeWindow,
      commit: () => { closeEffects.push('persist'); return { ok: true, path: '/close-root' }; },
      rollback: () => { closeEffects.push('rollback'); return { ok: true }; },
      finalize: () => { closeEffects.push('finalize'); },
    });
    closeWindow.webContents.once('will-prevent-unload', () => {
      closeWindow.webContents.stop();
      setTimeout(() => {
        if (!closeWindow.isDestroyed()) closeWindow.close();
      }, 10);
    });
    const closeResult = await closeResultPromise;
    await new Promise((resolve) => setTimeout(resolve, 50));
    ok('queued real BrowserWindow close reaches closed after the approved unload',
      closeResult.ok === true
        && closeResult.path === '/close-root'
        && closed
        && closeWindow.isDestroyed()
        && closeEffects.join(',') === 'persist,finalize',
      JSON.stringify({ closeResult, closeEffects, closed, destroyed: closeWindow.isDestroyed() }));
  } catch (error) {
    failures += 1;
    console.error(error && error.stack ? error.stack : error);
  } finally {
    if (gate) gate.close();
    if (interleavedGate) interleavedGate.close();
    if (closeGate) closeGate.close();
    if (window && !window.isDestroyed()) window.destroy();
    if (interleavedWindow && !interleavedWindow.isDestroyed()) interleavedWindow.destroy();
    if (closeWindow && !closeWindow.isDestroyed()) closeWindow.destroy();
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) { /* gone */ }
    app.exit(failures ? 1 : 0);
  }
});
