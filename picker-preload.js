// Preload for the "new tab" project picker window.
//
// Deliberately narrow: the picker may list projects, create one under
// ~/claude-projects, browse for a folder, and hand back a single answer. It has
// no reach into terminals, previews or settings.

const { contextBridge, ipcRenderer } = require('electron');

// Same synchronous boot as the main renderer: theme and strings have to be in
// hand before first paint, or the dialog flashes in the wrong colours.
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

  listProjects: () => ipcRenderer.invoke('projects:list'),
  createProject: (name) => ipcRenderer.invoke('projects:create', name),
  browseFolder: () => ipcRenderer.invoke('projects:browse'),

  // The one answer this window exists to give. Main closes it afterwards.
  done: (choice) => ipcRenderer.send('picker:done', choice),
});
