const { contextBridge, ipcRenderer } = require('electron');
// NOTE: this preload runs sandboxed — only 'electron' is requireable here.
// Anything needing Node core modules (path, fs, …) must live in the main process.

// Theme + strings are fetched synchronously: the renderer applies them before
// its first paint, so the UI never flashes in the wrong colours or language.
let boot = { theme: null, i18n: null, settings: {} };
try { boot = ipcRenderer.sendSync('app:boot') || boot; } catch (_) { /* main not ready */ }

contextBridge.exposeInMainWorld('api', {
  boot,

  // ---- Theme / language (backing for the future theme manager) ----
  listThemes: () => ipcRenderer.invoke('theme:list'),
  setTheme: (id) => ipcRenderer.invoke('theme:set', id),
  onThemeChanged: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('theme:changed', listener);
    return () => ipcRenderer.removeListener('theme:changed', listener);
  },
  listLanguages: () => ipcRenderer.invoke('i18n:list'),
  setLanguage: (code) => ipcRenderer.invoke('language:set', code),
  onLanguageChanged: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('i18n:changed', listener);
    return () => ipcRenderer.removeListener('i18n:changed', listener);
  },

  // ---- Claude model, chosen per project ----
  listModels: () => ipcRenderer.invoke('model:list'),
  getGlobalModel: () => ipcRenderer.invoke('model:global'),
  getModel: (projectPath) => ipcRenderer.invoke('model:get', projectPath),
  setModel: (projectPath, id) => ipcRenderer.invoke('model:set', { path: projectPath, id }),
  onGlobalModelChanged: (cb) => {
    const listener = (_event, id) => cb(id);
    ipcRenderer.on('model:global-changed', listener);
    return () => ipcRenderer.removeListener('model:global-changed', listener);
  },

  getPreviewPreloadUrl: () => ipcRenderer.invoke('preview:preload-url'),
  startPreview: (cwd) => ipcRenderer.invoke('preview:start', cwd),
  stopPreview: () => ipcRenderer.invoke('preview:stop'),
  onPreviewEvent: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('preview:event', listener);
    return () => ipcRenderer.removeListener('preview:event', listener);
  },

  // Run the project natively (own window / dev server), separate from preview.
  runApp: (cwd) => ipcRenderer.invoke('app:run', cwd),
  stopApp: (cwd) => ipcRenderer.invoke('app:stop', cwd),
  isAppRunning: (cwd) => ipcRenderer.invoke('app:running', cwd),
  onAppEvent: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('app:event', listener);
    return () => ipcRenderer.removeListener('app:event', listener);
  },
  openExternal: (url) => ipcRenderer.invoke('site:open-external', url),

  listProjects: () => ipcRenderer.invoke('projects:list'),
  // Opens the "new tab" picker window; resolves with the choice, or null.
  pickProject: () => ipcRenderer.invoke('projects:pick'),
  getUsageStats: () => ipcRenderer.invoke('usage:stats'),
  getSystemStats: () => ipcRenderer.invoke('system:stats'),
  captureTerminal: (rect, name) => ipcRenderer.invoke('screenshot:capture', { rect, name }),
  createTerminal: (id, cols, rows, cwd, startCmd) => ipcRenderer.send('term:create', { id, cols, rows, cwd, startCmd }),

  // Embedded native terminal (xterm as a real X11 window reparented into a panel).
  createEmbedTerminal: (id, cwd, startCmd) => ipcRenderer.send('embed:create', { id, cwd, startCmd }),
  placeEmbedTerminal: (id, rect) => ipcRenderer.send('embed:place', { id, rect }),
  hideEmbedTerminal: (id) => ipcRenderer.send('embed:hide', { id }),
  killEmbedTerminal: (id) => ipcRenderer.send('embed:kill', { id }),
  onEmbedReady: (cb) => {
    const listener = (_event, { id }) => cb(id);
    ipcRenderer.on('embed:ready', listener);
    return () => ipcRenderer.removeListener('embed:ready', listener);
  },

  sendInput: (id, data) => ipcRenderer.send('term:input', { id, data }),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('term:resize', { id, cols, rows }),
  killTerminal: (id) => ipcRenderer.send('term:kill', { id }),
  toggleFullscreen: () => ipcRenderer.send('window:toggle-fullscreen'),

  onData: (id, cb) => {
    const channel = `term:data:${id}`;
    const listener = (_event, data) => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onExit: (id, cb) => {
    const channel = `term:exit:${id}`;
    const listener = () => cb();
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
