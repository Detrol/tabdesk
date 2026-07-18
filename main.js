const { app, BrowserWindow, ipcMain } = require('electron');
const { Worker } = require('worker_threads');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');
const previewRunner = require('./preview-runner');
const xfceEmbed = require('./xfce-embed');

const PROJECTS_DIR = '/home/jonaz/claude-projects';

// Aggregate Claude Code usage off the main thread.
function scanUsage() {
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(path.join(__dirname, 'usage-worker.js'), {
        workerData: { dir: path.join(os.homedir(), '.claude', 'projects') },
      });
    } catch (_) { return resolve(null); }
    worker.once('message', (msg) => { resolve(msg); worker.terminate(); });
    worker.once('error', () => resolve(null));
  });
}

// Live CPU% via idle/total deltas between calls.
let prevCpu = os.cpus();
function cpuPercent() {
  const now = os.cpus();
  let idleD = 0, totalD = 0;
  for (let i = 0; i < now.length; i++) {
    const a = prevCpu[i].times, b = now[i].times;
    idleD += b.idle - a.idle;
    totalD += (b.user + b.nice + b.sys + b.idle + b.irq) -
              (a.user + a.nice + a.sys + a.idle + a.irq);
  }
  prevCpu = now;
  return totalD > 0 ? Math.round(100 * (1 - idleD / totalD)) : 0;
}

// Track one pty per terminal id.
const terminals = new Map();

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    // Launch windowed, NOT fullscreen (per requirement).
    fullscreen: false,
    backgroundColor: '#1e1e2e',
    title: 'TabDesk',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // for the interactive project preview
    },
  });

  // Hide the default menu bar for a cleaner look; F11 still toggles fullscreen below.
  win.setMenuBarVisibility(false);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // F11 toggles fullscreen.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
  });

  return win;
}

app.whenReady().then(() => {
  const win = createWindow();

  // Embedded xfce4-terminal windows reparent into this window (X11).
  win.once('ready-to-show', () => xfceEmbed.init(win));
  xfceEmbed.init(win);

  // ---- Embedded xfce4-terminal lifecycle ----
  ipcMain.on('xfce:create', (event, { id, cwd, startCmd }) => xfceEmbed.create(id, { cwd, startCmd }));
  ipcMain.on('xfce:place', (event, { id, rect }) => xfceEmbed.place(id, rect));
  ipcMain.on('xfce:hide', (event, { id }) => xfceEmbed.hide(id));
  ipcMain.on('xfce:kill', (event, { id }) => xfceEmbed.kill(id));

  // ---- Terminal lifecycle over IPC ----

  // List project directories under PROJECTS_DIR, most-recently-modified first.
  ipcMain.handle('projects:list', () => {
    try {
      return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
          const full = path.join(PROJECTS_DIR, e.name);
          let mtime = 0;
          try { mtime = fs.statSync(full).mtimeMs; } catch (_) { /* skip */ }
          return { name: e.name, path: full, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch (_) {
      return [];
    }
  });

  ipcMain.handle('usage:stats', () => scanUsage());

  ipcMain.handle('system:stats', () => ({
    cpu: cpuPercent(),
    memUsed: os.totalmem() - os.freemem(),
    memTotal: os.totalmem(),
    uptime: os.uptime(),
  }));

  // Capture a region of the window (the focused terminal) to a PNG file.
  ipcMain.handle('screenshot:capture', async (event, { rect, name }) => {
    try {
      const image = await win.webContents.capturePage({
        x: Math.max(0, Math.round(rect.x)),
        y: Math.max(0, Math.round(rect.y)),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
      const pics = path.join(os.homedir(), 'Pictures');
      const dir = fs.existsSync(pics) ? pics : os.homedir();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const safe = String(name || 'terminal').replace(/[^a-z0-9._-]/gi, '_');
      const file = path.join(dir, `tabdesk-${safe}-${stamp}.png`);
      fs.writeFileSync(file, image.toPNG());
      return { ok: true, path: file };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('preview:preload-url', () =>
    'file://' + path.join(__dirname, 'preview-preload.js'));

  // Launch a live preview for a project (static HTML or a running app) and
  // stream its lifecycle events back to the renderer.
  ipcMain.handle('preview:start', (event, projectPath) => {
    previewRunner.start(projectPath, (type, payload) => {
      if (!win.isDestroyed()) win.webContents.send('preview:event', { type, ...payload });
    });
    return true;
  });

  // Tear down the currently running preview process (if any).
  ipcMain.handle('preview:stop', () => { previewRunner.stop(); return true; });

  ipcMain.on('term:create', (event, { id, cols, rows, cwd, startCmd }) => {
    if (terminals.has(id)) return;
    const shell = os.platform() === 'win32'
      ? 'powershell.exe'
      : (process.env.SHELL || '/bin/bash');

    const startDir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    const term = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: startDir,
      env: process.env,
    });

    // Optionally auto-run a command (e.g. launch Claude Code in the project).
    if (startCmd) {
      setTimeout(() => { try { term.write(startCmd + '\r'); } catch (_) {} }, 350);
    }

    term.onData((data) => {
      if (!win.isDestroyed()) win.webContents.send(`term:data:${id}`, data);
    });
    term.onExit(() => {
      terminals.delete(id);
      if (!win.isDestroyed()) win.webContents.send(`term:exit:${id}`);
    });

    terminals.set(id, term);
  });

  ipcMain.on('term:input', (event, { id, data }) => {
    const term = terminals.get(id);
    if (term) term.write(data);
  });

  ipcMain.on('term:resize', (event, { id, cols, rows }) => {
    const term = terminals.get(id);
    if (term && cols > 0 && rows > 0) {
      try { term.resize(cols, rows); } catch (_) { /* ignore transient resize errors */ }
    }
  });

  ipcMain.on('term:kill', (event, { id }) => {
    const term = terminals.get(id);
    if (term) {
      term.kill();
      terminals.delete(id);
    }
  });

  ipcMain.on('window:toggle-fullscreen', () => {
    win.setFullScreen(!win.isFullScreen());
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const term of terminals.values()) term.kill();
  terminals.clear();
  xfceEmbed.killAll();
  previewRunner.stop();
  if (process.platform !== 'darwin') app.quit();
});
