// Preload for the settings window.
//
// Narrow like the picker's and the update window's. Theme and language are the
// only things this window can change so far; the sync configuration lands here
// in a later phase and gets its own handles rather than a generic setter, so
// nothing in the renderer can write arbitrary keys into settings.json.

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

  // Both lists are re-read on open rather than taken from boot: a theme file
  // dropped into themes/ while TabDesk runs should turn up without a restart.
  listThemes: () => ipcRenderer.invoke('theme:list'),
  setTheme: (id) => ipcRenderer.invoke('theme:set', id),
  listLanguages: () => ipcRenderer.invoke('i18n:list'),
  setLanguage: (code) => ipcRenderer.invoke('language:set', code),

  // ---- sync ----
  // getSyncConfig never returns the stored secret, only whether there is one;
  // saveSync sends it one way. There is deliberately no getter for it.
  getSyncConfig: () => ipcRenderer.invoke('sync:config'),
  saveSync: (patch) => ipcRenderer.invoke('sync:save', patch),
  probeSync: (patch) => ipcRenderer.invoke('sync:probe', patch),
  pinHostKey: (hostKey) => ipcRenderer.invoke('sync:pin', hostKey),
  testSync: () => ipcRenderer.invoke('sync:test'),
  pickKeyFile: () => ipcRenderer.invoke('sync:pick-key'),

  // ---- project files ----
  listProjects: () => ipcRenderer.invoke('projects:list'),
  filesList: () => ipcRenderer.invoke('sync:files-list'),
  filesPush: (slug, root) => ipcRenderer.invoke('sync:files-push', { slug, root }),
  watchStart: (slug, root) => ipcRenderer.invoke('sync:watch-start', { slug, root }),
  watchStop: (slug) => ipcRenderer.invoke('sync:watch-stop', slug),
  watching: () => ipcRenderer.invoke('sync:watching'),
  onSyncEvent: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('sync:event', listener);
    return () => ipcRenderer.removeListener('sync:event', listener);
  },

  close: () => ipcRenderer.send('settings:close'),
});
