const { contextBridge, ipcRenderer } = require('electron');
// NOTE: this preload runs sandboxed — only 'electron' is requireable here.
// Anything needing Node core modules (path, fs, …) must live in the main process.

contextBridge.exposeInMainWorld('api', {
  getPreviewPreloadUrl: () => ipcRenderer.invoke('preview:preload-url'),
  startPreview: (cwd) => ipcRenderer.invoke('preview:start', cwd),
  stopPreview: () => ipcRenderer.invoke('preview:stop'),
  onPreviewEvent: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('preview:event', listener);
    return () => ipcRenderer.removeListener('preview:event', listener);
  },
  listProjects: () => ipcRenderer.invoke('projects:list'),
  getUsageStats: () => ipcRenderer.invoke('usage:stats'),
  getSystemStats: () => ipcRenderer.invoke('system:stats'),
  captureTerminal: (rect, name) => ipcRenderer.invoke('screenshot:capture', { rect, name }),
  createTerminal: (id, cols, rows, cwd, startCmd) => ipcRenderer.send('term:create', { id, cols, rows, cwd, startCmd }),

  // Embedded xfce4-terminal (native X11 window reparented into a panel).
  createXfceTerminal: (id, cwd, startCmd) => ipcRenderer.send('xfce:create', { id, cwd, startCmd }),
  placeXfceTerminal: (id, rect) => ipcRenderer.send('xfce:place', { id, rect }),
  hideXfceTerminal: (id) => ipcRenderer.send('xfce:hide', { id }),
  killXfceTerminal: (id) => ipcRenderer.send('xfce:kill', { id }),

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
