// Preload for the update window.
//
// Narrow like the picker's and the sync window's: this window may read what the
// last check found, start a download, watch its progress and ask for the
// install. The download and the privileged install both run in main — the
// renderer never sees a file path it could act on beyond displaying it.

const { contextBridge, ipcRenderer } = require('electron');

let boot = { theme: null, i18n: null, settings: {} };
try { boot = ipcRenderer.sendSync('app:boot') || boot; } catch (_) { /* main not ready */ }

contextBridge.exposeInMainWorld('api', {
  boot,

  onThemeChanged: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('theme:changed', listener);
    return () => ipcRenderer.removeListener('theme:changed', listener);
  },
  onLanguageChanged: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('i18n:changed', listener);
    return () => ipcRenderer.removeListener('i18n:changed', listener);
  },

  // The last check's result, or null before the first one has landed.
  getUpdateState: () => ipcRenderer.invoke('update:state'),
  // refresh:true runs `apt-get update` first — a password prompt, so only ever
  // for an explicit "check again", never the background timer.
  checkForUpdate: (refresh) => ipcRenderer.invoke('update:check', { refresh: Boolean(refresh) }),
  // Downloads, verifies and installs; resolves with what happened.
  runUpdate: () => ipcRenderer.invoke('update:run'),
  // Hands the fallback command to a fresh TabDesk terminal tab.
  openInTerminal: (command) => ipcRenderer.invoke('update:terminal', command),
  restartApp: () => ipcRenderer.invoke('update:restart'),

  onProgress: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('update:progress', listener);
    return () => ipcRenderer.removeListener('update:progress', listener);
  },

  close: () => ipcRenderer.send('update:close'),
});
