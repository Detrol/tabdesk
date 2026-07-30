// Preload for the export/import window.
//
// Narrow like the picker's: this window may inspect what's exportable, write a
// bundle, open one and ask for its diff, and apply it. It never touches
// terminals or previews, and the bundle itself stays in the main process — the
// renderer only ever sees the inventory and the plan.

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

  // ---- export ----
  scanPortable: () => ipcRenderer.invoke('portable:scan'),
  exportPortable: (slugs) => ipcRenderer.invoke('portable:export', slugs),

  // ---- import ----
  // Opens a file, parses it and returns the diff. The bundle stays in main.
  openBundle: () => ipcRenderer.invoke('portable:open-bundle'),
  // Re-diff the open bundle, without going back through the file dialog.
  replanBundle: () => ipcRenderer.invoke('portable:replan'),
  applyBundle: (options) => ipcRenderer.invoke('portable:apply', options),

  // ---- the same bundle, over the network ----
  // pullBundle returns a plan in exactly the shape openBundle does, so the
  // review UI does not need to know where the bundle came from.
  syncReady: () => ipcRenderer.invoke('sync:ready'),
  pushBundle: (slugs) => ipcRenderer.invoke('sync:push-bundle', slugs),
  syncPeers: () => ipcRenderer.invoke('sync:peers'),
  pullBundle: (deviceId) => ipcRenderer.invoke('sync:pull-bundle', deviceId),

  close: () => ipcRenderer.send('portable:close'),
});
