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
  let gate;
  let interleavedGate;
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
    interleavedGate = createRendererLeaveGate({
      ipcMain,
      decisionTimeoutMs: 1000,
      navigationTimeoutMs: 1000,
      makeToken: () => 'real-close-token',
    });
    const interleavedResultPromise = interleavedGate.run(interleavedWindow.webContents, {
      ownerWindow: interleavedWindow,
      commit: () => { interleavedEffects.push('persist'); return { ok: true, path: '/close-root' }; },
      rollback: () => { interleavedEffects.push('rollback'); return { ok: true }; },
      finalize: () => { interleavedEffects.push('finalize'); },
    });
    // The gate listener was registered synchronously by run(), so this listener
    // executes after its preventDefault() has made the reload irreversible but
    // before Electron emits did-start-navigation for the accepted reload.
    interleavedWindow.webContents.once('will-prevent-unload', () => {
      interleavedGate.close();
    });
    const interleavedResult = await interleavedResultPromise;
    ok('a real gate close inside the post-override interval keeps the reload committed',
      interleavedResult.ok === true
        && interleavedResult.path === '/close-root'
        && interleavedEffects.join(',') === 'persist,finalize',
      JSON.stringify({ interleavedResult, interleavedEffects }));
  } catch (error) {
    failures += 1;
    console.error(error && error.stack ? error.stack : error);
  } finally {
    if (gate) gate.close();
    if (interleavedGate) interleavedGate.close();
    if (window && !window.isDestroyed()) window.destroy();
    if (interleavedWindow && !interleavedWindow.isDestroyed()) interleavedWindow.destroy();
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) { /* gone */ }
    app.exit(failures ? 1 : 0);
  }
});
